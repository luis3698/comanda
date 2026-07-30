/**
 * Configuracion del sistema (tabla `parametro`).
 *
 * AMPLIACION AL FSD. El sistema no tenia ningun almacen de configuracion:
 * todo era constante en codigo o variable de entorno. El canal digital
 * necesita ajustes que el Administrador cambia en caliente -- el interruptor
 * de la aplicacion movil, la ficha publica del restaurante, las reglas de
 * reserva -- sin reiniciar el proceso ni tocar el .env.
 *
 * POR QUE HAY CACHE
 * `requiereAppActiva` consulta 'app.movil.activa' en CADA peticion de la API
 * del cliente. Sin cache eso es un SELECT extra por peticion para leer un
 * booleano que cambia una vez al mes. Con 30 s de TTL, el administrador ve el
 * efecto de su cambio casi al instante (y de forma inmediata en el proceso que
 * hizo la escritura, porque fijar() invalida la cache) y la base se ahorra el
 * trabajo.
 *
 * La cache es POR PROCESO. Con varias instancias de la API detras de un
 * balanceador, apagar la aplicacion tardaria hasta 30 s en propagarse a todas.
 * Es aceptable para un interruptor de mantenimiento; si algun dia hace falta
 * que sea inmediato, el camino es publicar un evento por el canal de tiempo
 * real, no bajar el TTL.
 */
import { consultar, consultarUno, pool } from '../db.js';
import { errores } from '../middleware/errores.js';

/** Milisegundos que se considera fresca la cache. */
const TTL_MS = 30_000;

/** clave -> { valor, tipo } */
let cache = null;
let cacheExpiraEn = 0;

/** Convierte el valor almacenado (siempre texto) al tipo que declara la fila. */
function convertir(valor, tipo) {
  if (tipo === 'booleano') return valor === 'true' || valor === '1';
  if (tipo === 'numero') {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }
  return valor;
}

/** Serializa un valor de JS al texto que se guarda en la columna. */
function serializar(valor, tipo) {
  if (tipo === 'booleano') {
    // Se acepta tanto el booleano real como las cadenas que llegan de un
    // formulario o de un JSON mal tipado.
    const activo = valor === true || valor === 'true' || valor === 1 || valor === '1';
    return activo ? 'true' : 'false';
  }
  if (tipo === 'numero') {
    const n = Number(valor);
    if (!Number.isFinite(n)) throw errores.peticionInvalida('El valor debe ser un numero.');
    return String(n);
  }
  return String(valor ?? '');
}

async function refrescarCache() {
  const filas = await consultar('SELECT clave, valor, tipo FROM parametro');
  cache = new Map(filas.map((f) => [f.clave, { valor: f.valor, tipo: f.tipo }]));
  cacheExpiraEn = Date.now() + TTL_MS;
  return cache;
}

/** Fuerza la relectura en la siguiente consulta. */
export function invalidarCache() {
  cache = null;
  cacheExpiraEn = 0;
}

async function cacheVigente() {
  if (!cache || Date.now() > cacheExpiraEn) return refrescarCache();
  return cache;
}

/**
 * Valor de un parametro, ya convertido a su tipo.
 *
 * @param {string} clave
 * @param {*} [porDefecto]  Que devolver si la clave no existe. Importante:
 *   permite que el codigo funcione contra una base a la que todavia no se le
 *   aplico db/05_movil.sql, en vez de reventar.
 */
export async function obtener(clave, porDefecto = null) {
  const c = await cacheVigente();
  const fila = c.get(clave);
  if (!fila) return porDefecto;
  return convertir(fila.valor, fila.tipo);
}

/**
 * Todos los parametros cuya clave empieza por un prefijo, como objeto plano
 * SIN el prefijo. Util para armar de una vez la ficha del restaurante:
 *   obtenerGrupo('restaurante.')  ->  { nombre, direccion, telefono, ... }
 */
export async function obtenerGrupo(prefijo) {
  const c = await cacheVigente();
  const salida = {};
  for (const [clave, fila] of c) {
    if (clave.startsWith(prefijo)) {
      salida[clave.slice(prefijo.length)] = convertir(fila.valor, fila.tipo);
    }
  }
  return salida;
}

/** Todos los parametros con sus metadatos, para la pantalla de configuracion. */
export async function listarTodos() {
  const filas = await consultar(
    `SELECT clave, valor, tipo, descripcion, editable, actualizado_en
       FROM parametro ORDER BY clave`
  );
  return filas.map((f) => ({
    clave: f.clave,
    valor: convertir(f.valor, f.tipo),
    tipo: f.tipo,
    descripcion: f.descripcion,
    editable: Boolean(f.editable),
    actualizadoEn: f.actualizado_en,
  }));
}

/**
 * Escribe un parametro existente.
 *
 * No crea claves nuevas a proposito: el catalogo de parametros lo define
 * db/05_movil.sql, no la peticion HTTP. Si un endpoint pudiera inventar claves,
 * un error de tecleo en el cliente crearia configuracion fantasma que nadie
 * lee y que ensucia la pantalla de administracion.
 */
export async function fijar(clave, valor) {
  const fila = await consultarUno(
    'SELECT clave, tipo, editable FROM parametro WHERE clave = ?',
    [clave]
  );
  if (!fila) throw errores.noEncontrado(`El parametro "${clave}"`);
  if (!fila.editable) {
    throw errores.reglaDeNegocio(`El parametro "${clave}" no se puede modificar.`);
  }

  const texto = serializar(valor, fila.tipo);
  if (texto.length > 500) {
    throw errores.peticionInvalida('El valor no puede superar los 500 caracteres.');
  }

  await pool.execute('UPDATE parametro SET valor = ? WHERE clave = ?', [texto, clave]);
  invalidarCache();

  return { clave, valor: convertir(texto, fila.tipo) };
}

/**
 * Escribe varios parametros de una vez.
 * @param {object} cambios  { clave: valor }
 * @returns {Promise<object[]>}
 */
export async function fijarVarios(cambios) {
  const salida = [];
  for (const [clave, valor] of Object.entries(cambios ?? {})) {
    salida.push(await fijar(clave, valor));
  }
  return salida;
}
