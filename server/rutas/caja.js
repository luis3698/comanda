/**
 * Caja y facturación (POS).  RF-17 a RF-20  ·  Vistas 18-21.
 * Rutas según el catálogo de API del FSD 8.
 */
import { Router } from 'express';
import { consultar, consultarUno } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { publicar, EVENTOS } from '../realtime.js';
import {
  turnoAbiertoDe, abrirTurno, resumenTurno, registrarMovimiento, cerrarTurnoArqueo,
  calcularCuenta, cobrar, validarDivision,
} from '../servicios/caja.js';

const router = Router();
router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/* =====================================================================
   Turnos
   ===================================================================== */

/** GET /api/v1/caja/turno-activo — turno abierto del cajero autenticado. */
router.get('/turno-activo', requierePermiso('caja.cobrar', 'caja.turno.abrir'), asyncHandler(async (req, res) => {
  const turno = await turnoAbiertoDe(req.usuario.id);
  if (!turno) return res.json({ turno: null });

  // Se devuelve el resumen de ventas, pero NUNCA el esperado del arqueo (CA-07).
  const resumen = await resumenTurno(turno.id_turno);
  return res.json({ turno: resumen });
}));

/** POST /api/v1/caja/turnos  { fondoInicial } */
router.post('/turnos', requierePermiso('caja.turno.abrir'), asyncHandler(async (req, res) => {
  const r = await abrirTurno({
    idCajero: req.usuario.id,
    fondoInicial: req.body?.fondoInicial ?? 0,
    ipOrigen: ipDe(req),
  });
  return res.status(201).json(r);
}));

/** POST /api/v1/caja/turnos/:id/movimientos  { tipo, monto, motivo } */
router.post('/turnos/:id/movimientos', requierePermiso('caja.registrar_salida'), asyncHandler(async (req, res) => {
  const idTurno = Number(req.params.id);
  const { tipo, monto, motivo } = req.body ?? {};

  // Verificar que el turno es del cajero.
  const turno = await consultarUno('SELECT id_cajero FROM turno_caja WHERE id_turno = ?', [idTurno]);
  if (!turno) throw errores.noEncontrado('El turno');
  if (turno.id_cajero !== req.usuario.id) throw errores.sinPermiso('Solo el cajero del turno puede registrar movimientos');

  await registrarMovimiento({ idTurno, tipo, monto, motivo, idUsuario: req.usuario.id, ipOrigen: ipDe(req) });
  return res.json({ ok: true });
}));

/**
 * POST /api/v1/caja/turnos/:id/cierre  { totalContado, comentario? }   CA-07
 * El arqueo ciego: el esperado se revela SOLO en la respuesta de este cierre.
 */
router.post('/turnos/:id/cierre', requierePermiso('caja.turno.cerrar'), asyncHandler(async (req, res) => {
  const idTurno = Number(req.params.id);
  const { totalContado, comentario } = req.body ?? {};

  if (totalContado == null) {
    throw errores.peticionInvalida('Indique el total contado en el arqueo.');
  }

  const r = await cerrarTurnoArqueo({
    idTurno,
    idCajero: req.usuario.id,
    totalContado,
    comentario,
    ipOrigen: ipDe(req),
  });

  return res.json(r);
}));

/* =====================================================================
   Cuentas
   ===================================================================== */

/**
 * GET /api/v1/caja/cuentas — cuentas activas para el panel del cajero (vista 18).
 * Las pre-cuentas solicitadas se marcan para destacarlas.
 */
router.get('/cuentas', requierePermiso('caja.cobrar'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT o.id_orden, o.id_mesa, o.estado, o.num_comensales, o.abierta_en,
            m.numero AS mesa, z.nombre AS zona, u.nombre_completo AS mesero,
            TIMESTAMPDIFF(MINUTE, o.abierta_en, NOW()) AS minutos,
            (SELECT COUNT(*) FROM orden_detalle od
              WHERE od.id_orden = o.id_orden AND od.estado_preparacion <> 'anulado') AS items
       FROM orden o
       JOIN mesa m    ON m.id_mesa = o.id_mesa
       JOIN zona z    ON z.id_zona = m.id_zona
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE o.estado IN ('abierta','enviada','precuenta')
      ORDER BY (o.estado = 'precuenta') DESC, o.abierta_en`,
    []
  );

  return res.json({
    cuentas: filas.map((o) => ({
      idOrden: o.id_orden,
      idMesa: o.id_mesa,
      mesa: o.mesa,
      zona: o.zona,
      mesero: o.mesero,
      numComensales: o.num_comensales,
      estado: o.estado,
      // FSD 4.4 vista 18: las pre-cuentas se destacan y suben al inicio.
      precuenta: o.estado === 'precuenta',
      minutos: o.minutos,
      items: o.items,
    })),
  });
}));

/** GET /api/v1/caja/cuentas/:idOrden — desglose calculado en el servidor (vista 19). */
router.get('/cuentas/:idOrden', requierePermiso('caja.cobrar'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.idOrden);

  // Sub-cuenta de la división: ?lineas=1,2,3 restringe el desglose a esas líneas.
  const idsDetalle = String(req.query.lineas ?? '')
    .split(',').map(Number).filter(Boolean);

  const orden = await consultarUno(
    `SELECT o.id_orden, o.estado, o.num_comensales, m.numero AS mesa, u.nombre_completo AS mesero
       FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE o.id_orden = ?`,
    [idOrden]
  );
  if (!orden) throw errores.noEncontrado('La cuenta');

  const cuenta = await calcularCuenta(idOrden, idsDetalle.length ? idsDetalle : null);
  if (!cuenta) throw errores.reglaDeNegocio('La cuenta no tiene líneas cobrables.');

  // Ya cobrado (para la división: qué líneas quedan pendientes).
  const cobradas = await consultar(
    `SELECT fd.id_orden_detalle, SUM(fd.cantidad_asignada) AS cobrada
       FROM factura_detalle fd JOIN factura f ON f.id_factura = fd.id_factura
      WHERE f.id_orden = ? AND f.estado = 'emitida'
      GROUP BY fd.id_orden_detalle`,
    [idOrden]
  );
  const yaCobrado = new Map(cobradas.map((c) => [c.id_orden_detalle, Number(c.cobrada)]));

  return res.json({
    idOrden,
    mesa: orden.mesa,
    mesero: orden.mesero,
    numComensales: orden.num_comensales,
    estado: orden.estado,
    ...cuenta,
    // Se quitan los campos internos en centavos antes de responder.
    subtotalCentavos: undefined,
    impuestosCentavos: undefined,
    lineas: cuenta.lineas.map((l) => ({ ...l, cobrada: yaCobrado.get(l.id) ?? 0 })),
  });
}));

/** GET /api/v1/caja/motivos-descuento — catálogo para el selector (vista 19). */
router.get('/motivos-descuento', requierePermiso('caja.cobrar'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    'SELECT id_motivo, nombre, porcentaje_max FROM motivo_descuento WHERE activo = TRUE ORDER BY nombre'
  );
  return res.json({
    motivos: filas.map((m) => ({ id: m.id_motivo, nombre: m.nombre, porcentajeMax: String(m.porcentaje_max) })),
  });
}));

/* =====================================================================
   Cobro
   ===================================================================== */

/**
 * POST /api/v1/caja/cuentas/:idOrden/cobrar   CA-05
 * Body: { pagos:[{metodo,monto,recibido?,referencia?}], propina?, descuento?,
 *         idMotivoDescuento?, idsDetalle? }
 */
router.post('/cuentas/:idOrden/cobrar', requierePermiso('caja.cobrar'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const { pagos, propina, descuento, idMotivoDescuento, idsDetalle } = req.body ?? {};

  // Debe haber un turno abierto del cajero (FSD 5.7).
  const turno = await turnoAbiertoDe(req.usuario.id);
  if (!turno) {
    throw errores.reglaDeNegocio('Debe abrir un turno de caja antes de cobrar.', { requiereTurno: true });
  }

  const r = await cobrar({
    idOrden,
    idTurno: turno.id_turno,
    idsDetalle: Array.isArray(idsDetalle) && idsDetalle.length ? idsDetalle.map(Number) : null,
    pagos,
    propina,
    descuento,
    idMotivoDescuento,
    idCajero: req.usuario.id,
    ipOrigen: ipDe(req),
  });

  // Si se liberó la mesa, se avisa a todos (comandero, otros cajeros).
  if (r.mesaLiberada) {
    publicar(EVENTOS.MESA_ESTADO, { idMesa: r.idMesa, estado: 'libre', mesa: r.mesa },
      { permiso: 'salon.ver' });
  }

  return res.json(r);
}));

/**
 * POST /api/v1/caja/cuentas/:idOrden/validar-division   CA-06
 * Body: { subcuentas: [{ lineas:[{id,cantidad}] }, ...] }
 * Comprueba que la suma de las sub-cuentas iguale la orden ANTES de cobrar.
 */
router.post('/cuentas/:idOrden/validar-division', requierePermiso('caja.dividir'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const subcuentas = req.body?.subcuentas;

  if (!Array.isArray(subcuentas) || !subcuentas.length) {
    throw errores.peticionInvalida('Envíe el arreglo "subcuentas".');
  }

  const r = await validarDivision(idOrden, subcuentas);
  return res.json(r);
}));

export default router;
