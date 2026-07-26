/**
 * Acceso a la base de datos.
 *
 * FSD 6.1: "Prohibida la concatenacion de SQL con entrada de usuario. Toda
 * consulta usa sentencias preparadas / parametrizadas."
 * Por eso este modulo expone unicamente helpers que reciben (sql, parametros)
 * y usan execute() -- sentencias preparadas reales del protocolo MySQL.
 * Nunca construyas SQL interpolando valores.
 */
import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'sigr_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sigr',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 10),
  queueLimit: 0,
  // Las fechas se manejan como string 'YYYY-MM-DD HH:mm:ss' en la zona del
  // servidor, sin la conversion automatica a Date de JS: evita corrimientos
  // de zona horaria entre el contenedor y el navegador.
  dateStrings: true,
  // decimalNumbers se deja en false (por defecto): mysql2 devuelve DECIMAL
  // como string. Convertirlo a Number perderia precision y descuadraria el
  // arqueo de caja. Los importes se calculan en SQL o con dinero.js.
  timezone: 'Z',
  charset: 'utf8mb4_general_ci',
});

/**
 * Ejecuta una consulta parametrizada y devuelve las filas.
 * @param {string} sql  SQL con marcadores ?
 * @param {Array}  params  valores para los marcadores
 */
export async function consultar(sql, params = []) {
  const [filas] = await pool.execute(sql, params);
  return filas;
}

/**
 * Igual que consultar() pero devuelve la primera fila o null.
 */
export async function consultarUno(sql, params = []) {
  const filas = await consultar(sql, params);
  return filas.length ? filas[0] : null;
}

/**
 * Ejecuta fn dentro de una transaccion ACID.
 *
 * FSD 2.2: "Toda operacion critica (envio de comanda, cobro, cierre de turno)
 * se ejecuta dentro de una transaccion para garantizar atomicidad."
 *
 * fn recibe la conexion y DEBE usarla para todas sus consultas; si usara el
 * pool tomaria otra conexion y quedaria fuera de la transaccion.
 *
 * REINTENTO ANTE DEADLOCK
 * Bajo concurrencia alta, dos transacciones que bloquean las mismas filas en
 * distinto orden pueden entrar en deadlock; MySQL aborta una y devuelve
 * ER_LOCK_DEADLOCK con el mensaje literal "try restarting transaction". No es
 * un error de logica: es una condicion transitoria, y la respuesta correcta es
 * reintentar, no propagar un 500 al usuario. Lo mismo con el lock-wait-timeout.
 * Se reintenta con una pequena espera aleatoria (backoff) para que las dos
 * transacciones en conflicto no vuelvan a chocar en el mismo instante.
 *
 * Se detectó en la prueba de carga de la fase 6: con 50 dispositivos
 * concurrentes aparecían deadlocks esporádicos al agregar líneas.
 *
 * fn debe ser idempotente respecto a su propio efecto: el reintento la ejecuta
 * de nuevo entera. Todas las operaciones de este sistema lo son, porque parten
 * de leer el estado con FOR UPDATE dentro de la misma transacción.
 *
 * @example
 *   await transaccion(async (cx) => {
 *     await cx.execute('UPDATE mesa SET estado=? WHERE id_mesa=?', ['ocupada', 5]);
 *     await cx.execute('INSERT INTO orden ...');
 *   });
 */
const ERRORES_REINTENTABLES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const MAX_REINTENTOS = 3;

export async function transaccion(fn) {
  let ultimoError;

  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    const cx = await pool.getConnection();
    try {
      await cx.beginTransaction();
      const resultado = await fn(cx);
      await cx.commit();
      return resultado;
    } catch (error) {
      await cx.rollback().catch(() => {});
      ultimoError = error;

      // Solo se reintenta un choque de bloqueos transitorio; cualquier otro
      // error (regla de negocio, restriccion, etc.) se propaga de inmediato.
      if (!ERRORES_REINTENTABLES.has(error?.code) || intento === MAX_REINTENTOS) {
        throw error;
      }
      // Backoff con jitter: 10-40 ms crecientes, para desincronizar a las dos
      // transacciones que se estaban pisando.
      const espera = intento * 10 + Math.floor(Math.random() * 20);
      await new Promise((r) => setTimeout(r, espera));
    } finally {
      cx.release();
    }
  }

  throw ultimoError;
}

/**
 * Comprueba que la base responde. Se usa al arrancar para fallar rapido y
 * con un mensaje claro en vez de morir en la primera peticion.
 */
export async function verificarConexion() {
  const cx = await pool.getConnection();
  try {
    await cx.ping();
  } finally {
    cx.release();
  }
}

export async function cerrarPool() {
  await pool.end();
}
