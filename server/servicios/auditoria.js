/**
 * Registro de auditoria.
 *
 * FSD 2.4.7: tabla de solo insercion.
 * FSD 5.8: "opcionalmente cada registro encadena un hash del anterior para
 *           evidenciar manipulacion."
 * FSD 6.1: "Registro inalterable de acciones de riesgo con usuario,
 *           autorizador, IP y timestamp de milisegundos."
 *
 * DOS CAPAS DE PROTECCION
 *  1. Privilegios del motor (db/04_privilegios.sql): el usuario de aplicacion
 *     no tiene UPDATE ni DELETE sobre log_auditoria. Verificado: MySQL
 *     rechaza el intento aunque el codigo lo pida.
 *  2. Cadena de hashes (este modulo): cada registro incluye el hash del
 *     anterior. Alterar una fila desde fuera de la aplicacion (por ejemplo con
 *     acceso root a la base) rompe la cadena de todas las siguientes y la
 *     manipulacion queda en evidencia.
 */
import crypto from 'node:crypto';
import { pool } from '../db.js';

// Nombre del lock que serializa la construccion de la cadena.
const LOCK_CADENA = 'sigr_auditoria_cadena';
const LOCK_TIMEOUT_S = 10;

/**
 * Calcula el hash de un registro a partir de su contenido y del hash previo.
 * Cualquier cambio en un campo o en el orden de la cadena altera el resultado.
 */
function calcularHash({ hashAnterior, idUsuario, idAutorizador, accion, entidad, idEntidad, detalle, ipOrigen, fecha }) {
  const material = [
    hashAnterior ?? 'GENESIS',
    idUsuario,
    idAutorizador ?? '',
    accion,
    entidad,
    idEntidad ?? '',
    detalle,
    ipOrigen ?? '',
    fecha,
  ].join('|');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Devuelve la fecha actual con milisegundos en el formato DATETIME(3) de MySQL. */
function ahoraConMilisegundos() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Escribe un evento de auditoria.
 *
 * @param {object} ejecutor  Conexion de una transaccion en curso, o el pool.
 *   Pasar SIEMPRE la conexion cuando el evento pertenece a una transaccion
 *   (anulacion, cobro, cierre): si la operacion hace rollback, su rastro de
 *   auditoria debe desaparecer con ella. Un evento auditado de algo que no
 *   ocurrio es peor que no auditarlo.
 * @param {object} evento
 * @param {number} evento.idUsuario      Autor de la accion.
 * @param {number} [evento.idAutorizador] Supervisor que autorizo (CA-08).
 * @param {string} evento.accion         Codigo: 'orden.anulacion', 'cajon.apertura_manual'...
 * @param {string} evento.entidad        Tabla afectada.
 * @param {number} [evento.idEntidad]    Registro afectado.
 * @param {string} evento.detalle        Descripcion legible.
 * @param {string} [evento.ipOrigen]     IP del dispositivo.
 */
export async function auditar(ejecutor, evento) {
  const cx = ejecutor ?? pool;

  // La cadena de hashes se construye leyendo el ultimo registro. Sin
  // serializar, dos inserciones concurrentes leerian el mismo "anterior" y la
  // cadena se bifurcaria, invalidando la verificacion.
  //
  // Se usa GET_LOCK y no SELECT ... FOR UPDATE porque MySQL exige el
  // privilegio UPDATE/DELETE para bloquear filas, y el usuario de aplicacion
  // deliberadamente no lo tiene sobre esta tabla.
  await cx.execute('SELECT GET_LOCK(?, ?) AS obtenido', [LOCK_CADENA, LOCK_TIMEOUT_S]);
  try {
    const [previos] = await cx.execute(
      'SELECT hash_actual FROM log_auditoria ORDER BY id_log DESC LIMIT 1'
    );
    const hashAnterior = previos.length ? previos[0].hash_actual : null;

    const registro = {
      hashAnterior,
      idUsuario: evento.idUsuario,
      idAutorizador: evento.idAutorizador ?? null,
      accion: evento.accion,
      entidad: evento.entidad,
      idEntidad: evento.idEntidad ?? null,
      detalle: evento.detalle,
      ipOrigen: evento.ipOrigen ?? null,
      fecha: ahoraConMilisegundos(),
    };
    const hashActual = calcularHash(registro);

    await cx.execute(
      `INSERT INTO log_auditoria
         (id_usuario, id_autorizador, accion, entidad, id_entidad, detalle,
          ip_origen, hash_anterior, hash_actual, fecha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [registro.idUsuario, registro.idAutorizador, registro.accion, registro.entidad,
       registro.idEntidad, registro.detalle, registro.ipOrigen,
       registro.hashAnterior, hashActual, registro.fecha]
    );

    return hashActual;
  } finally {
    await cx.execute('SELECT RELEASE_LOCK(?)', [LOCK_CADENA]);
  }
}

/**
 * Recorre la cadena completa y comprueba que ningun registro fue alterado.
 * Uso previsto: verificacion forense desde el modulo de auditoria (vista 9).
 *
 * Distingue las dos formas de romper la cadena, porque la accion correctiva es
 * distinta:
 *  - 'contenido_alterado': el hash del propio registro no recalcula -> alguien
 *    edito uno de sus campos (detalle, importe, usuario...) con acceso directo.
 *  - 'eslabon_roto': el hash del registro recalcula bien, pero su hash_anterior
 *    no apunta al registro previo -> se ELIMINO (o reordeno) al menos un
 *    registro intermedio. En un sistema en produccion esto no puede pasar por la
 *    aplicacion: el usuario de BD no tiene DELETE sobre la tabla. Si aparece, fue
 *    un acceso root directo a la base.
 *
 * @returns {{integra: boolean, revisados: number, rotoEn: number|null,
 *            motivo: 'contenido_alterado'|'eslabon_roto'|null}}
 */
export async function verificarCadena() {
  const [registros] = await pool.execute(
    `SELECT id_log, id_usuario, id_autorizador, accion, entidad, id_entidad,
            detalle, ip_origen, hash_anterior, hash_actual, fecha
       FROM log_auditoria ORDER BY id_log ASC`
  );

  let hashEsperadoPrevio = null;
  for (const r of registros) {
    const recalculado = calcularHash({
      hashAnterior: r.hash_anterior,
      idUsuario: r.id_usuario,
      idAutorizador: r.id_autorizador,
      accion: r.accion,
      entidad: r.entidad,
      idEntidad: r.id_entidad,
      detalle: r.detalle,
      ipOrigen: r.ip_origen,
      fecha: r.fecha,
    });

    // Primero el contenido: si el propio hash no recalcula, el registro fue
    // editado. Se comprueba antes que el eslabon para no confundir una edicion
    // con una eliminacion.
    if (recalculado !== r.hash_actual) {
      return { integra: false, revisados: registros.length, rotoEn: r.id_log, motivo: 'contenido_alterado' };
    }
    // El registro esta intacto, pero ¿engancha con el anterior? Si no, se
    // elimino o reordeno algo antes de el.
    if (r.hash_anterior !== hashEsperadoPrevio) {
      return { integra: false, revisados: registros.length, rotoEn: r.id_log, motivo: 'eslabon_roto' };
    }
    hashEsperadoPrevio = r.hash_actual;
  }

  return { integra: true, revisados: registros.length, rotoEn: null, motivo: null };
}
