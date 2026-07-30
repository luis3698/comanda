/**
 * Reservas de mesa vistas desde el backoffice.   /api/v1/reservas
 *
 * Las crea el cliente desde la aplicacion (rutas/app.js); aqui el personal las
 * consulta y las resuelve. El publico natural es Caja: el FSD 3.1 pone al
 * cajero al frente del mostrador, y es quien conoce el estado real del salon.
 *
 * Cada cambio de estado se difunde por WebSocket para que las demas pantallas
 * abiertas se enteren: dos cajeros mirando la misma lista no deben poder
 * confirmar la misma reserva dos veces sin verlo.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { publicar, EVENTOS } from '../realtime.js';
import { consultar } from '../db.js';
import * as reservas from '../servicios/reservas.js';

const router = Router();

router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/** Difunde el cambio a quien pueda ver reservas. */
function difundir(reserva) {
  publicar(EVENTOS.RESERVA_ACTUALIZADA, {
    idReserva: reserva.id,
    codigo: reserva.codigo,
    estado: reserva.estado,
    cliente: reserva.cliente,
    mesa: reserva.mesa,
    fechaHora: reserva.fechaHora,
  }, { permisos: ['reservas.ver'] });
}

/**
 * GET /api/v1/reservas
 * ?estado=vivas|pendiente|confirmada|...  &desde=YYYY-MM-DD  &hasta=YYYY-MM-DD
 *
 * Sin filtro de estado devuelve todo; 'vivas' es lo que usa la pantalla de
 * Caja por defecto, porque lo que necesita un cajero es lo que todavia tiene
 * pendiente de resolver.
 */
router.get('/', requierePermiso('reservas.ver'), asyncHandler(async (req, res) => {
  const { estado, desde, hasta, limite } = req.query;
  return res.json({
    reservas: await reservas.listar({ estado, desde, hasta, limite }),
    pendientes: await reservas.contarPendientes(),
  });
}));

/**
 * GET /api/v1/reservas/mesas-disponibles?personas=4
 *
 * Mesas que caben para el grupo, para el desplegable de confirmacion.
 *
 * NO se filtra por `mesa.estado`: ese campo describe el AHORA, y la reserva es
 * para mas tarde. Que una mesa este ocupada en este momento no dice nada sobre
 * si lo estara el jueves a las dos. Se devuelve el estado actual como dato
 * informativo y decide el cajero, que es quien conoce el ritmo del salon.
 */
router.get('/mesas-disponibles', requierePermiso('reservas.ver'), asyncHandler(async (req, res) => {
  const personas = Math.max(1, Number(req.query.personas) || 1);

  const filas = await consultar(
    `SELECT m.id_mesa, m.numero, m.capacidad, m.estado, z.nombre AS zona
       FROM mesa m
       JOIN zona z ON z.id_zona = m.id_zona
      WHERE m.activa = TRUE AND z.activa = TRUE AND m.capacidad >= ?
      ORDER BY m.capacidad ASC, z.orden_visual, m.numero`,
    [personas]
  );

  return res.json({
    mesas: filas.map((m) => ({
      id: m.id_mesa,
      numero: m.numero,
      zona: m.zona,
      capacidad: m.capacidad,
      estadoActual: m.estado,
    })),
  });
}));

router.get('/:id', requierePermiso('reservas.ver'), asyncHandler(async (req, res) => {
  const reserva = await reservas.detalle(Number(req.params.id));
  if (!reserva) return res.status(404).json({ error: 'no_encontrado', mensaje: 'La reserva no existe.' });
  return res.json({ reserva });
}));

/** POST /api/v1/reservas/:id/confirmar  { idMesa } */
router.post('/:id/confirmar', requierePermiso('reservas.gestionar'), asyncHandler(async (req, res) => {
  const reserva = await reservas.cambiarEstado(Number(req.params.id), 'confirmada', {
    idUsuario: req.usuario.id,
    idMesa: req.body?.idMesa,
    ipOrigen: ipDe(req),
  });
  difundir(reserva);
  return res.json({ reserva });
}));

/** POST /api/v1/reservas/:id/rechazar  { motivo } -- el motivo es obligatorio. */
router.post('/:id/rechazar', requierePermiso('reservas.gestionar'), asyncHandler(async (req, res) => {
  const reserva = await reservas.cambiarEstado(Number(req.params.id), 'rechazada', {
    idUsuario: req.usuario.id,
    motivo: req.body?.motivo,
    ipOrigen: ipDe(req),
  });
  difundir(reserva);
  return res.json({ reserva });
}));

/** POST /api/v1/reservas/:id/cancelar */
router.post('/:id/cancelar', requierePermiso('reservas.gestionar'), asyncHandler(async (req, res) => {
  const reserva = await reservas.cambiarEstado(Number(req.params.id), 'cancelada', {
    idUsuario: req.usuario.id,
    motivo: req.body?.motivo,
    ipOrigen: ipDe(req),
  });
  difundir(reserva);
  return res.json({ reserva });
}));

/** POST /api/v1/reservas/:id/cumplida -- el cliente llego y se sento. */
router.post('/:id/cumplida', requierePermiso('reservas.gestionar'), asyncHandler(async (req, res) => {
  const reserva = await reservas.cambiarEstado(Number(req.params.id), 'cumplida', {
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });
  difundir(reserva);
  return res.json({ reserva });
}));

/**
 * POST /api/v1/reservas/:id/no-asistio
 * Se registra en vez de borrarse: un historial de ausencias es informacion
 * util para el restaurante, y borrar la reserva la haria desaparecer.
 */
router.post('/:id/no-asistio', requierePermiso('reservas.gestionar'), asyncHandler(async (req, res) => {
  const reserva = await reservas.cambiarEstado(Number(req.params.id), 'no_asistio', {
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });
  difundir(reserva);
  return res.json({ reserva });
}));

export default router;
