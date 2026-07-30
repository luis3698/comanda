/**
 * Sesiones del cliente de la aplicacion movil.
 *
 * DOS SISTEMAS DE SESION EN EL MISMO SERVIDOR
 * `middleware/auth.js` gestiona al PERSONAL: cookie HttpOnly, token CSRF,
 * permisos releidos por peticion, re-autenticacion por PIN. Este modulo
 * gestiona al CLIENTE, y es deliberadamente mas simple:
 *
 *   - Token Bearer, no cookie. El cliente es un OkHttp nativo de Android: no
 *     hay almacen de cookies del navegador ni politica de mismo origen que
 *     aprovechar. La app guarda el token en su DataStore cifrado.
 *
 *   - Sin CSRF. El ataque CSRF existe porque el navegador adjunta la cookie
 *     sola en una peticion originada por otro sitio. Un token que la app tiene
 *     que anadir a mano no se adjunta solo, asi que no hay nada que falsificar.
 *
 *   - Sin permisos. Un cliente no tiene rol ni matriz: la autorizacion es
 *     pertenencia. Cada consulta filtra por `id_cliente`, y ese id sale del
 *     token, NUNCA de la peticion. Es la unica regla que hay que respetar al
 *     escribir un endpoint nuevo: si un id de cliente llega por body o por
 *     query, esta mal.
 *
 *   - Duracion en dias, no en horas. La regla de 12 h del FSD 5.1 protege
 *     dispositivos COMPARTIDOS (comandero, KDS, POS) que pasan de mano en
 *     mano. Un movil es personal: obligar a reautenticar cada 12 h solo
 *     conseguiria que la gente eligiera contrasenas mas cortas.
 */
import crypto from 'node:crypto';
import { consultarUno, pool } from '../db.js';
import { errores } from './errores.js';

const DIAS_SESION = Number(process.env.SESION_CLIENTE_DIAS || 30);

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Crea una sesion de cliente y devuelve el token en claro.
 *
 * El token se guarda tal cual como clave primaria, igual que en la tabla
 * `sesion` del personal. Es un valor aleatorio de 256 bits sin estructura ni
 * derivacion de la contrasena: quien lea la base ya tiene acceso a todo lo
 * demas, asi que hashearlo no anadiria proteccion real y si complicaria la
 * consulta de cada peticion.
 */
export async function crearSesionCliente(idCliente, { ip, dispositivo } = {}) {
  const idSesion = generarToken();

  await pool.execute(
    `INSERT INTO sesion_cliente (id_sesion, id_cliente, dispositivo, ip_origen, expira_en)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [idSesion, idCliente, (dispositivo ?? '').slice(0, 120) || null, ip ?? null, DIAS_SESION]
  );

  const expiraEn = new Date(Date.now() + DIAS_SESION * 24 * 60 * 60 * 1000);
  return { token: idSesion, expiraEn: expiraEn.toISOString() };
}

export async function destruirSesionCliente(idSesion) {
  await pool.execute('DELETE FROM sesion_cliente WHERE id_sesion = ?', [idSesion]);
}

/** Cierra la sesion en todos los dispositivos. Se usa al cambiar la contrasena. */
export async function destruirSesionesDeCliente(idCliente) {
  await pool.execute('DELETE FROM sesion_cliente WHERE id_cliente = ?', [idCliente]);
}

/** Purga sesiones vencidas. La invoca el barrido periodico de index.js. */
export async function limpiarSesionesClienteVencidas() {
  const [r] = await pool.execute('DELETE FROM sesion_cliente WHERE expira_en < NOW()');
  return r.affectedRows;
}

/** Extrae el token de la cabecera Authorization. */
function tokenDe(req) {
  const cabecera = req.get('authorization');
  if (!cabecera) return null;
  const [esquema, valor] = cabecera.split(' ');
  if (!valor || esquema.toLowerCase() !== 'bearer') return null;
  return valor.trim() || null;
}

/**
 * Carga el cliente si el token es valido. NO rechaza cuando falta: de eso se
 * encarga requiereCliente. Asi las rutas publicas de la app (estado, menu,
 * ficha del restaurante) conviven con las privadas en el mismo router.
 *
 * Deja en req.cliente: { id, nombre, correo, documento, telefono, urlFoto, sesion }
 */
export async function cargarCliente(req, _res, next) {
  try {
    const token = tokenDe(req);
    if (!token) return next();

    const fila = await consultarUno(
      `SELECT s.id_sesion, s.expira_en, s.expira_en < NOW() AS vencida,
              c.id_cliente, c.documento, c.nombre_completo, c.correo, c.telefono,
              c.url_foto, c.activo, c.acepta_promociones
         FROM sesion_cliente s
         JOIN cliente c ON c.id_cliente = s.id_cliente
        WHERE s.id_sesion = ?`,
      [token]
    );

    if (!fila) return next();

    if (Number(fila.vencida) === 1) {
      await destruirSesionCliente(token);
      return next(errores.sesionExpirada());
    }

    // La cuenta se dio de baja (el propio cliente la elimino) en mitad de una
    // sesion viva: se corta el acceso igual que con un empleado desactivado.
    if (!fila.activo) {
      await destruirSesionCliente(token);
      return next(errores.cuentaInactiva());
    }

    req.cliente = {
      id: fila.id_cliente,
      documento: fila.documento,
      nombre: fila.nombre_completo,
      correo: fila.correo,
      telefono: fila.telefono,
      urlFoto: fila.url_foto,
      aceptaPromociones: Boolean(fila.acepta_promociones),
      sesion: { id: fila.id_sesion, expiraEn: fila.expira_en },
    };

    // Refresco de actividad sin bloquear la respuesta, igual que en auth.js:
    // no debe sumar latencia a cada peticion ni tumbarla si falla.
    pool
      .execute('UPDATE sesion_cliente SET ultima_actividad = NOW() WHERE id_sesion = ?', [token])
      .catch((e) => console.error('[app] no se pudo refrescar la actividad del cliente:', e.message));

    return next();
  } catch (error) {
    return next(error);
  }
}

/** Exige sesion de cliente iniciada. */
export function requiereCliente(req, _res, next) {
  if (!req.cliente) return next(errores.clienteNoAutenticado());
  return next();
}
