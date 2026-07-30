/**
 * Reservas de mesa.
 *
 * El cliente reserva desde la aplicacion y la reserva aparece EN VIVO en la
 * pantalla de Caja, que es quien la confirma asignando una mesa concreta.
 *
 * POR QUE CONFIRMA CAJA Y NO EL SISTEMA
 * Seria facil asignar la mesa automaticamente buscando una libre de la
 * capacidad adecuada. Seria tambien un error: el estado de `mesa` refleja el
 * momento presente, no las dos de la tarde del jueves que viene. Una asignacion
 * automatica reservaria mesas que a esa hora estaran ocupadas por otro
 * servicio, o rechazaria reservas para las que si habria sitio. Quien conoce el
 * ritmo real del salon es el cajero; el sistema le lleva la peticion y le deja
 * decidir.
 *
 * MAQUINA DE ESTADOS
 *
 *   pendiente ──confirmar──> confirmada ──cumplida──> cumplida
 *       │                        │
 *       │                        └──no_asistio──> no_asistio
 *       ├──rechazar──> rechazada
 *       └──cancelar──> cancelada      (tambien desde confirmada)
 *
 * Los estados finales (rechazada, cancelada, cumplida, no_asistio) no admiten
 * mas transiciones: una reserva cerrada no se reabre, se crea otra.
 */
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores } from '../middleware/errores.js';
import { obtener } from './parametros.js';
import { notificar } from './push.js';
import { auditar } from './auditoria.js';

/** Transiciones permitidas. Cualquier otra es un error de regla de negocio. */
const TRANSICIONES = {
  pendiente:  ['confirmada', 'rechazada', 'cancelada'],
  confirmada: ['cumplida', 'no_asistio', 'cancelada'],
  rechazada:  [],
  cancelada:  [],
  cumplida:   [],
  no_asistio: [],
};

/** Estados en los que la reserva sigue viva. */
export const ESTADOS_VIVOS = ['pendiente', 'confirmada'];

/** Consecutivo legible, correlativo y sin huecos (mismo patron que la factura). */
async function siguienteCodigo(cx) {
  // El UPDATE bloquea la fila: dos reservas simultaneas se serializan y nunca
  // obtienen el mismo codigo.
  await cx.execute("UPDATE secuencia SET valor = valor + 1 WHERE nombre = 'reserva'");
  const [[fila]] = await cx.execute("SELECT valor FROM secuencia WHERE nombre = 'reserva'");
  return `R-${String(fila.valor).padStart(6, '0')}`;
}

/** Forma con la que se devuelve una reserva. */
function comoDto(r) {
  return {
    id: r.id_reserva,
    codigo: r.codigo,
    idCliente: r.id_cliente,
    cliente: r.cliente ?? null,
    telefono: r.telefono ?? null,
    idMesa: r.id_mesa,
    mesa: r.mesa ?? null,
    zona: r.zona ?? null,
    fechaHora: r.fecha_hora,
    numPersonas: r.num_personas,
    notas: r.notas,
    estado: r.estado,
    gestionadaPor: r.gestionada_por ?? null,
    gestionadaEn: r.gestionada_en,
    motivoGestion: r.motivo_gestion,
    creadoEn: r.creado_en,
  };
}

const SQL_RESERVA = `
  SELECT r.id_reserva, r.codigo, r.id_cliente, r.id_mesa, r.fecha_hora,
         r.num_personas, r.notas, r.estado, r.gestionada_en, r.motivo_gestion,
         r.creado_en,
         c.nombre_completo AS cliente, c.telefono,
         m.numero AS mesa, z.nombre AS zona,
         u.nombre_completo AS gestionada_por
    FROM reserva r
    JOIN cliente c      ON c.id_cliente = r.id_cliente
    LEFT JOIN mesa m    ON m.id_mesa = r.id_mesa
    LEFT JOIN zona z    ON z.id_zona = m.id_zona
    LEFT JOIN usuario u ON u.id_usuario = r.id_usuario_gestion
`;

/**
 * Valida la fecha pedida contra las reglas configurables del restaurante.
 * Devuelve el `Date` ya parseado.
 */
async function validarFecha(fechaHora) {
  const fecha = new Date(fechaHora);
  if (Number.isNaN(fecha.getTime())) {
    throw errores.peticionInvalida('Indique una fecha y hora validas.',
      { campos: { fechaHora: 'Fecha u hora no valida.' } });
  }

  const anticipacionH = await obtener('reservas.anticipacion_min_horas', 2);
  const diasMax = await obtener('reservas.dias_max', 30);

  const minima = new Date(Date.now() + anticipacionH * 60 * 60 * 1000);
  const maxima = new Date(Date.now() + diasMax * 24 * 60 * 60 * 1000);

  if (fecha < minima) {
    throw errores.reglaDeNegocio(
      `Las reservas necesitan al menos ${anticipacionH} hora(s) de antelacion. ` +
      'Para algo mas inmediato, llame al restaurante.',
      { campos: { fechaHora: `Reserve con al menos ${anticipacionH} hora(s) de antelacion.` } }
    );
  }
  if (fecha > maxima) {
    throw errores.reglaDeNegocio(
      `Solo se puede reservar hasta ${diasMax} dias por adelantado.`,
      { campos: { fechaHora: `Como maximo ${diasMax} dias por adelantado.` } }
    );
  }

  return fecha;
}

/** Convierte un Date al formato DATETIME de MySQL en hora local del servidor. */
function aDatetimeMysql(fecha) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())} ` +
         `${p(fecha.getHours())}:${p(fecha.getMinutes())}:00`;
}

/**
 * Crea una reserva (la pide el cliente desde la app).
 * Queda en 'pendiente' hasta que Caja la confirme.
 */
export async function crear(idCliente, { fechaHora, numPersonas, notas }) {
  const fecha = await validarFecha(fechaHora);

  const personasMax = await obtener('reservas.personas_max', 12);
  const personas = Number(numPersonas);
  if (!Number.isInteger(personas) || personas < 1) {
    throw errores.peticionInvalida('Indique cuantas personas asistiran.',
      { campos: { numPersonas: 'Indique al menos 1 persona.' } });
  }
  if (personas > personasMax) {
    throw errores.reglaDeNegocio(
      `Para grupos de mas de ${personasMax} personas, llame al restaurante para organizarlo.`,
      { campos: { numPersonas: `Maximo ${personasMax} personas por la aplicacion.` } }
    );
  }

  // Una reserva pendiente sin resolver por cada fecha ya es suficiente: sin
  // este limite, un cliente puede llenar la pantalla de Caja de peticiones
  // duplicadas por impaciencia.
  const duplicada = await consultarUno(
    `SELECT id_reserva FROM reserva
      WHERE id_cliente = ? AND estado IN ('pendiente','confirmada') AND DATE(fecha_hora) = DATE(?)`,
    [idCliente, aDatetimeMysql(fecha)]
  );
  if (duplicada) {
    throw errores.conflicto('Ya tiene una reserva activa para ese dia.');
  }

  const creada = await transaccion(async (cx) => {
    const codigo = await siguienteCodigo(cx);
    const [r] = await cx.execute(
      `INSERT INTO reserva (codigo, id_cliente, fecha_hora, num_personas, notas)
       VALUES (?, ?, ?, ?, ?)`,
      [codigo, idCliente, aDatetimeMysql(fecha), personas,
       notas ? String(notas).slice(0, 255) : null]
    );
    return { id: r.insertId, codigo };
  });

  const fila = await consultarUno(`${SQL_RESERVA} WHERE r.id_reserva = ?`, [creada.id]);
  return comoDto(fila);
}

/** Una reserva concreta, o null. */
export async function detalle(idReserva) {
  const fila = await consultarUno(`${SQL_RESERVA} WHERE r.id_reserva = ?`, [idReserva]);
  return fila ? comoDto(fila) : null;
}

/** Reservas del cliente, mas recientes primero. */
export async function listarDeCliente(idCliente, { soloActivas = false } = {}) {
  const filtro = soloActivas ? "AND r.estado IN ('pendiente','confirmada')" : '';
  const filas = await consultar(
    `${SQL_RESERVA} WHERE r.id_cliente = ? ${filtro} ORDER BY r.fecha_hora DESC LIMIT 100`,
    [idCliente]
  );
  return filas.map(comoDto);
}

/**
 * Listado para el backoffice (Caja y Administrador).
 *
 * @param {object} filtros
 * @param {string} [filtros.estado]  Un estado concreto, o 'vivas' para las que
 *   siguen en juego. Es el filtro por defecto de la pantalla de Caja: lo que
 *   necesita ver un cajero es lo que todavia tiene que resolver.
 * @param {string} [filtros.desde]   Fecha ISO inclusive.
 * @param {string} [filtros.hasta]   Fecha ISO inclusive.
 */
export async function listar({ estado, desde, hasta, limite = 100 } = {}) {
  const condiciones = [];
  const params = [];

  if (estado === 'vivas') {
    condiciones.push("r.estado IN ('pendiente','confirmada')");
  } else if (estado) {
    condiciones.push('r.estado = ?');
    params.push(estado);
  }
  if (desde) { condiciones.push('r.fecha_hora >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { condiciones.push('r.fecha_hora <= ?'); params.push(`${hasta} 23:59:59`); }

  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const l = Math.min(500, Math.max(1, Number(limite) || 100));

  const filas = await consultar(
    `${SQL_RESERVA} ${donde} ORDER BY r.fecha_hora ASC LIMIT ${l}`,
    params
  );
  return filas.map(comoDto);
}

/** Cuantas reservas hay pendientes de resolver. Alimenta el globo de Caja. */
export async function contarPendientes() {
  const fila = await consultarUno(
    "SELECT COUNT(*) AS n FROM reserva WHERE estado = 'pendiente'"
  );
  return Number(fila.n);
}

/** Comprueba que la transicion es legal antes de intentarla. */
function exigirTransicion(actual, destino) {
  if (!TRANSICIONES[actual]?.includes(destino)) {
    throw errores.reglaDeNegocio(
      `Una reserva ${actual} no puede pasar a ${destino}.`,
      { estadoActual: actual }
    );
  }
}

/**
 * Cambia el estado de una reserva desde el backoffice.
 *
 * Todo ocurre dentro de una transaccion con la fila bloqueada: dos cajeros
 * mirando la misma pantalla podrian confirmar la misma reserva a la vez, y sin
 * el bloqueo ambos creerian haberla asignado a mesas distintas.
 *
 * @param {number} idReserva
 * @param {string} destino  Estado al que se pasa.
 * @param {object} opciones
 * @param {number} opciones.idUsuario   Quien lo hace.
 * @param {number} [opciones.idMesa]    Obligatorio al confirmar.
 * @param {string} [opciones.motivo]    Obligatorio al rechazar.
 * @param {string} [opciones.ipOrigen]
 */
export async function cambiarEstado(idReserva, destino, { idUsuario, idMesa, motivo, ipOrigen } = {}) {
  const resultado = await transaccion(async (cx) => {
    const [filas] = await cx.execute(
      'SELECT id_reserva, codigo, id_cliente, estado, fecha_hora, num_personas FROM reserva WHERE id_reserva = ? FOR UPDATE',
      [idReserva]
    );
    if (!filas.length) throw errores.noEncontrado('La reserva');
    const reserva = filas[0];

    exigirTransicion(reserva.estado, destino);

    let mesaAsignada = null;

    if (destino === 'confirmada') {
      if (!Number.isInteger(Number(idMesa))) {
        throw errores.peticionInvalida('Elija la mesa que se asigna a la reserva.',
          { campos: { idMesa: 'Seleccione una mesa.' } });
      }
      const [mesas] = await cx.execute(
        `SELECT m.id_mesa, m.numero, m.capacidad, m.activa, z.nombre AS zona
           FROM mesa m JOIN zona z ON z.id_zona = m.id_zona
          WHERE m.id_mesa = ?`,
        [idMesa]
      );
      if (!mesas.length) throw errores.noEncontrado('La mesa');
      if (!mesas[0].activa) throw errores.reglaDeNegocio('Esa mesa esta dada de baja.');

      // No se comprueba mesa.estado: ese campo describe el AHORA, y la reserva
      // es para mas tarde. Que la mesa este ocupada en este momento no dice
      // nada sobre si lo estara el jueves a las dos.
      if (mesas[0].capacidad < reserva.num_personas) {
        throw errores.reglaDeNegocio(
          `La mesa ${mesas[0].numero} admite ${mesas[0].capacidad} personas y la reserva es para ${reserva.num_personas}.`,
          { capacidad: mesas[0].capacidad }
        );
      }
      mesaAsignada = mesas[0];
    }

    if (destino === 'rechazada' && !String(motivo ?? '').trim()) {
      throw errores.peticionInvalida('Explique por que se rechaza la reserva.',
        { campos: { motivo: 'Indique el motivo.' } });
    }

    await cx.execute(
      `UPDATE reserva
          SET estado = ?, id_mesa = COALESCE(?, id_mesa),
              id_usuario_gestion = ?, gestionada_en = NOW(),
              motivo_gestion = COALESCE(?, motivo_gestion)
        WHERE id_reserva = ?`,
      [destino, mesaAsignada?.id_mesa ?? null, idUsuario,
       motivo ? String(motivo).slice(0, 255) : null, idReserva]
    );

    await auditar(cx, {
      idUsuario,
      accion: `reserva.${destino}`,
      entidad: 'reserva',
      idEntidad: idReserva,
      detalle: `Reserva ${reserva.codigo} -> ${destino}` +
        (mesaAsignada ? `, mesa ${mesaAsignada.numero}` : '') +
        (motivo ? `. Motivo: ${motivo}` : '.'),
      ipOrigen,
    });

    return { reserva, mesaAsignada };
  });

  // La notificacion va DESPUES del commit: si la transaccion hubiera fallado,
  // el cliente no puede haber recibido un aviso de algo que no ocurrio.
  const { reserva, mesaAsignada } = resultado;
  const avisos = {
    confirmada: {
      titulo: 'Reserva confirmada',
      cuerpo: `Su reserva ${reserva.codigo} quedo confirmada` +
              (mesaAsignada ? ` en la mesa ${mesaAsignada.numero}.` : '.'),
    },
    rechazada: {
      titulo: 'Reserva no disponible',
      cuerpo: `No pudimos confirmar su reserva ${reserva.codigo}. ${motivo ?? ''}`.trim(),
    },
    cancelada: {
      titulo: 'Reserva cancelada',
      cuerpo: `Su reserva ${reserva.codigo} fue cancelada.`,
    },
  };

  if (avisos[destino]) {
    await notificar(reserva.id_cliente, {
      tipo: 'reserva',
      referencia: reserva.codigo,
      ...avisos[destino],
    }).catch((e) => console.error('[reservas] no se pudo notificar:', e.message));
  }

  return detalle(idReserva);
}

/**
 * Cancelacion pedida por el propio cliente.
 *
 * Separada de cambiarEstado porque la autorizacion es distinta: aqui no hay
 * usuario del personal, y hay que comprobar que la reserva es SUYA. El filtro
 * por id_cliente es lo que impide cancelar la reserva de otro cambiando el id
 * de la URL.
 */
export async function cancelarPorCliente(idCliente, idReserva) {
  const resultado = await transaccion(async (cx) => {
    const [filas] = await cx.execute(
      'SELECT id_reserva, codigo, estado FROM reserva WHERE id_reserva = ? AND id_cliente = ? FOR UPDATE',
      [idReserva, idCliente]
    );
    if (!filas.length) throw errores.noEncontrado('La reserva');

    exigirTransicion(filas[0].estado, 'cancelada');

    await cx.execute(
      `UPDATE reserva SET estado = 'cancelada', gestionada_en = NOW(),
              motivo_gestion = 'Cancelada por el cliente desde la aplicacion.'
        WHERE id_reserva = ?`,
      [idReserva]
    );
    return filas[0];
  });

  return { cancelada: true, codigo: resultado.codigo, idReserva };
}
