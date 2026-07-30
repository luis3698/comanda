/**
 * Pedidos a domicilio vistos desde el backoffice.   /api/v1/domicilios
 *
 * Los crea el cliente desde la aplicacion (rutas/app.js) y quedan en
 * 'pendiente'. Aqui el personal los acepta -- y ACEPTAR ES LA OPERACION
 * IMPORTANTE: convierte el pedido en una `orden` real y la manda a cocina, de
 * modo que a partir de ese momento el domicilio recorre exactamente el mismo
 * camino que una comanda de sala (KDS, tiempos de salida, cobro en caja).
 * Toda esa mecanica esta en servicios/domicilios.js.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { publicar, EVENTOS } from '../realtime.js';
import * as domicilios from '../servicios/domicilios.js';
import * as pagos from '../servicios/pagos.js';

const router = Router();

router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/** Difunde el cambio a quien pueda ver domicilios. */
function difundir(pedido) {
  publicar(EVENTOS.DOMICILIO_ACTUALIZADO, {
    idPedido: pedido.id,
    codigo: pedido.codigo,
    estado: pedido.estado,
    cliente: pedido.cliente,
    total: pedido.total,
    mesa: pedido.mesa,
  }, { permisos: ['domicilios.ver'] });
}

/**
 * GET /api/v1/domicilios?estado=vivos|pendiente|en_camino|...
 * 'vivos' es el filtro por defecto de la pantalla de Caja.
 */
router.get('/', requierePermiso('domicilios.ver'), asyncHandler(async (req, res) => {
  const { estado, limite } = req.query;
  return res.json({
    pedidos: await domicilios.listar({ estado, limite }),
    pendientes: await domicilios.contarPendientes(),
    // Los comprobantes sin revisar se cuentan aparte: son una cola distinta
    // de la de pedidos por aceptar, y la de pago va primero.
    pagosPorVerificar: await pagos.contarPorVerificar(),
  });
}));

router.get('/:id', requierePermiso('domicilios.ver'), asyncHandler(async (req, res) => {
  const pedido = await domicilios.detalle(Number(req.params.id));
  if (!pedido) return res.status(404).json({ error: 'no_encontrado', mensaje: 'El pedido no existe.' });
  return res.json({ pedido });
}));

/**
 * POST /api/v1/domicilios/:id/aceptar
 *
 * Crea la comanda sobre una posicion virtual de domicilio (D1..D30) y la envia
 * a cocina. Si no queda ninguna libre, o si falta inventario para alguna
 * receta, responde 422 con el motivo y NO deja nada a medias: el servicio
 * revierte la comanda y el pedido vuelve a 'pendiente'.
 *
 * Se publica tambien ORDEN_CREADA y MESA_ESTADO para que el KDS y las vistas
 * de salon reaccionen igual que ante cualquier comanda nueva.
 */
router.post('/:id/aceptar', requierePermiso('domicilios.gestionar'), asyncHandler(async (req, res) => {
  const pedido = await domicilios.aceptar(Number(req.params.id), {
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });

  difundir(pedido);
  publicar(EVENTOS.ORDEN_CREADA, {
    idOrden: pedido.idOrden, mesa: pedido.numeroMesa ?? pedido.mesa, domicilio: pedido.codigo,
  }, { permiso: 'salon.ver' });

  return res.json({ pedido });
}));

/* =====================================================================
   Verificacion del pago

   Va ANTES de poder aceptar: `servicios/domicilios.js` bloquea la apertura
   de la comanda mientras el pago no este verificado. Un pedido pagado por
   adelantado cuyo comprobante resulte falso ya habria gastado el producto.
   ===================================================================== */

/** POST /api/v1/domicilios/:id/pago/verificar -- el comprobante es bueno. */
router.post('/:id/pago/verificar', requierePermiso('domicilios.verificar_pago'),
  asyncHandler(async (req, res) => {
    const r = await pagos.decidirPago(Number(req.params.id), 'verificado', {
      idUsuario: req.usuario.id,
      ipOrigen: ipDe(req),
    });

    const pedido = await domicilios.detalle(Number(req.params.id));
    difundir(pedido);
    return res.json({ pedido, ...r });
  }));

/**
 * POST /api/v1/domicilios/:id/pago/rechazar  { motivo }
 *
 * El motivo es obligatorio y lo lee el cliente en su movil para corregirlo.
 * El pedido vuelve a "esperando comprobante", no a un estado final: casi
 * siempre es que se equivoco de captura.
 */
router.post('/:id/pago/rechazar', requierePermiso('domicilios.verificar_pago'),
  asyncHandler(async (req, res) => {
    const r = await pagos.decidirPago(Number(req.params.id), 'rechazado', {
      idUsuario: req.usuario.id,
      motivo: req.body?.motivo,
      ipOrigen: ipDe(req),
    });

    const pedido = await domicilios.detalle(Number(req.params.id));
    difundir(pedido);
    return res.json({ pedido, ...r });
  }));

/** POST /api/v1/domicilios/:id/rechazar  { motivo } -- el motivo es obligatorio. */
router.post('/:id/rechazar', requierePermiso('domicilios.gestionar'), asyncHandler(async (req, res) => {
  const pedido = await domicilios.cambiarEstado(Number(req.params.id), 'rechazado', {
    idUsuario: req.usuario.id,
    motivo: req.body?.motivo,
    ipOrigen: ipDe(req),
  });
  difundir(pedido);
  return res.json({ pedido });
}));

/**
 * POST /api/v1/domicilios/:id/estado  { estado }
 * Avance del reparto: en_preparacion -> en_camino -> entregado.
 * Las transiciones validas las impone el servicio, no esta ruta.
 */
router.post('/:id/estado', requierePermiso('domicilios.gestionar'), asyncHandler(async (req, res) => {
  const pedido = await domicilios.cambiarEstado(Number(req.params.id), String(req.body?.estado ?? ''), {
    idUsuario: req.usuario.id,
    motivo: req.body?.motivo,
    ipOrigen: ipDe(req),
  });
  difundir(pedido);
  return res.json({ pedido });
}));

export default router;
