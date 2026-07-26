/**
 * Comandas.  RF-10 a RF-13  ·  Vistas 11-14.
 * Rutas segun el catalogo de API del FSD 8.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { consultar, consultarUno } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso, tienePermiso } from '../middleware/permisos.js';
import { publicar, EVENTOS } from '../realtime.js';
import {
  abrirOrden, detalleOrden, agregarLinea, enviarACocina,
  anularLinea, solicitarPrecuenta,
} from '../servicios/ordenes.js';

const router = Router();
router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/**
 * Verifica el PIN de un administrador que autoriza una operacion sensible.
 * FSD 5.5 y CA-08: la anulacion de una linea enviada exige permiso propio o
 * autorizacion con PIN del Administrador.
 *
 * @returns {Promise<number>} id del autorizador.
 */
async function verificarPinAutorizador(pin) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) {
    throw errores.peticionInvalida('El PIN de autorización debe tener 4 dígitos.');
  }

  // Solo quien tenga el permiso de autorizar puede desbloquear la operacion.
  const candidatos = await consultar(
    `SELECT u.id_usuario, u.hash_pin
       FROM usuario u
       JOIN rol_permiso rp ON rp.id_rol = u.id_rol
       JOIN permiso p      ON p.id_permiso = rp.id_permiso
      WHERE p.codigo = 'descuentos.autorizar' AND u.activo = TRUE
        AND (u.bloqueado_hasta IS NULL OR u.bloqueado_hasta <= NOW())`
  );

  // Se comparan todos y no se corta al primer acierto: parar antes filtraria
  // por tiempo de respuesta qué PIN va acercandose.
  let autorizador = null;
  for (const c of candidatos) {
    if (await bcrypt.compare(String(pin), c.hash_pin)) autorizador = c.id_usuario;
  }

  if (!autorizador) {
    throw errores.sinPermiso('Autorización de administrador');
  }
  return autorizador;
}

/* =====================================================================
   Consulta
   ===================================================================== */

/**
 * GET /api/v1/ordenes/activas
 * Comandas vivas. Alimenta el mapa del mesero (vista 11) y el panel del
 * cajero (vista 18).
 */
router.get('/activas', requierePermiso('salon.ver'), asyncHandler(async (req, res) => {
  // Un mesero ve solo lo suyo salvo que tenga ordenes.ver_todas
  // (FSD 4.2 vista 11: "mesas de otros meseros aparecen atenuadas").
  const verTodas = tienePermiso(req, 'ordenes.ver_todas');
  const params = verTodas ? [] : [req.usuario.id];

  const filas = await consultar(
    `SELECT o.id_orden, o.id_mesa, o.id_mesero, o.num_comensales, o.estado,
            o.abierta_en, m.numero AS mesa, u.nombre_completo AS mesero,
            TIMESTAMPDIFF(MINUTE, o.abierta_en, NOW()) AS minutos_abierta,
            (SELECT COUNT(*) FROM orden_detalle od
              WHERE od.id_orden = o.id_orden AND od.estado_preparacion <> 'anulado') AS lineas,
            (SELECT COUNT(*) FROM orden_detalle od
              WHERE od.id_orden = o.id_orden AND od.estado_preparacion = 'listo') AS listas
       FROM orden o
       JOIN mesa m    ON m.id_mesa = o.id_mesa
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE o.estado IN ('abierta','enviada','precuenta')
        ${verTodas ? '' : 'AND o.id_mesero = ?'}
      ORDER BY o.abierta_en`,
    params
  );

  return res.json({
    ordenes: filas.map((o) => ({
      id: o.id_orden,
      idMesa: o.id_mesa,
      mesa: o.mesa,
      idMesero: o.id_mesero,
      mesero: o.mesero,
      numComensales: o.num_comensales,
      estado: o.estado,
      abiertaEn: o.abierta_en,
      minutosAbierta: o.minutos_abierta,
      lineas: o.lineas,
      listas: o.listas,
      propia: o.id_mesero === req.usuario.id,
    })),
  });
}));

/** GET /api/v1/ordenes/:id */
router.get('/:id', requierePermiso('salon.ver'), asyncHandler(async (req, res) => {
  const orden = await detalleOrden(Number(req.params.id));
  if (!orden) throw errores.noEncontrado('La comanda');

  // Una comanda ajena no se muestra a un mesero sin permiso de verlas todas.
  if (orden.idMesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  return res.json(orden);
}));

/* =====================================================================
   Ciclo de vida
   ===================================================================== */

/** POST /api/v1/ordenes  { idMesa, numComensales }   CA-09 */
router.post('/', requierePermiso('ordenes.abrir'), asyncHandler(async (req, res) => {
  const { idMesa, numComensales } = req.body ?? {};
  if (!Number.isInteger(Number(idMesa))) {
    throw errores.peticionInvalida('Indique la mesa.');
  }

  const r = await abrirOrden({
    idMesa: Number(idMesa),
    idMesero: req.usuario.id,
    numComensales,
    ipOrigen: ipDe(req),
  });

  // Los eventos se publican tras el commit: si la transaccion hubiera fallado,
  // nadie debe haber visto la mesa ocuparse.
  publicar(EVENTOS.MESA_ESTADO, { idMesa: r.idMesa, estado: 'ocupada', mesa: r.numeroMesa },
    { permiso: 'salon.ver' });
  publicar(EVENTOS.ORDEN_CREADA, { idOrden: r.idOrden, idMesa: r.idMesa, mesa: r.numeroMesa },
    { permiso: 'salon.ver' });

  return res.status(201).json(r);
}));

/** POST /api/v1/ordenes/:id/lineas */
router.post('/:id/lineas', requierePermiso('ordenes.tomar'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.id);
  const { idProducto, cantidad, notas, tiempoSalida, modificadores } = req.body ?? {};

  const orden = await consultarUno('SELECT id_mesero FROM orden WHERE id_orden = ?', [idOrden]);
  if (!orden) throw errores.noEncontrado('La comanda');
  if (orden.id_mesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  const r = await agregarLinea({
    idOrden,
    idProducto: Number(idProducto),
    cantidad: Number(cantidad ?? 1),
    notas,
    tiempoSalida: Number(tiempoSalida ?? 1),
    modificadores: modificadores ?? [],
    idUsuario: req.usuario.id,
  });

  publicar(EVENTOS.ORDEN_ACTUALIZADA, { idOrden, motivo: "linea.agregada" },
    { permiso: "salon.ver", idMesero: orden.id_mesero });

  return res.status(201).json(r);
}));

/** DELETE /api/v1/ordenes/:id/lineas/:idLinea — línea NO enviada. */
router.delete('/:id/lineas/:idLinea', requierePermiso('ordenes.tomar'), asyncHandler(async (req, res) => {
  const idLinea = Number(req.params.idLinea);

  const linea = await consultarUno(
    `SELECT od.id_orden_detalle, od.enviado_en, o.id_mesero
       FROM orden_detalle od JOIN orden o ON o.id_orden = od.id_orden
      WHERE od.id_orden_detalle = ?`,
    [idLinea]
  );
  if (!linea) throw errores.noEncontrado('La línea');
  if (linea.id_mesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  // FSD 5.5: "Lineas enviadas son inmutables para el mesero". Quitar una linea
  // ya enviada es otra operacion (anular), con permiso y auditoria propios.
  if (linea.enviado_en) {
    throw errores.reglaDeNegocio(
      'Esa línea ya está en cocina. Para quitarla hay que anularla, y eso requiere autorización.',
      { requiereAnulacion: true }
    );
  }

  const { pool } = await import('../db.js');
  await pool.execute('DELETE FROM orden_detalle WHERE id_orden_detalle = ?', [idLinea]);

  publicar(EVENTOS.ORDEN_ACTUALIZADA,
    { idOrden: Number(req.params.id), motivo: "linea.quitada" },
    { permiso: "salon.ver", idMesero: linea.id_mesero });

  return res.json({ ok: true });
}));

/** PUT /api/v1/ordenes/:id/tiempos  { lineas: [{id, tiempoSalida}] }  RF-12 */
router.put('/:id/tiempos', requierePermiso('ordenes.tomar'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.id);
  const lineas = req.body?.lineas;

  if (!Array.isArray(lineas)) {
    throw errores.peticionInvalida('Envíe el arreglo "lineas" con los tiempos de salida.');
  }

  const orden = await consultarUno('SELECT id_mesero FROM orden WHERE id_orden = ?', [idOrden]);
  if (!orden) throw errores.noEncontrado('La comanda');
  if (orden.id_mesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  const { transaccion } = await import('../db.js');
  await transaccion(async (cx) => {
    for (const l of lineas) {
      const tiempo = Number(l.tiempoSalida);
      if (!Number.isInteger(tiempo) || tiempo < 1 || tiempo > 9) {
        throw errores.peticionInvalida('El tiempo de salida debe estar entre 1 y 9.');
      }
      // Solo se reordenan las lineas aun no enviadas: mover de tiempo algo que
      // ya esta en la plancha no tiene sentido.
      await cx.execute(
        `UPDATE orden_detalle SET tiempo_salida = ?
          WHERE id_orden_detalle = ? AND id_orden = ? AND enviado_en IS NULL`,
        [tiempo, Number(l.id), idOrden]
      );
    }
  });

  publicar(EVENTOS.ORDEN_ACTUALIZADA, { idOrden, motivo: "tiempos.reordenados" },
    { permiso: "salon.ver", idMesero: orden.id_mesero });

  return res.json({ ok: true });
}));

/**
 * POST /api/v1/ordenes/:id/enviar
 * La transaccion critica.  CA-01, CA-03, CA-04.
 */
router.post('/:id/enviar', requierePermiso('ordenes.enviar'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.id);

  const orden = await consultarUno('SELECT id_mesero FROM orden WHERE id_orden = ?', [idOrden]);
  if (!orden) throw errores.noEncontrado('La comanda');
  if (orden.id_mesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  const r = await enviarACocina({
    idOrden,
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });

  // ---- CA-01: la comanda debe aparecer en el KDS en menos de 1 segundo ----
  // Se publica justo despues del commit. Cada estacion recibe solo sus lineas.
  for (const destino of ['cocina', 'barra']) {
    const suyas = r.lineas.filter((l) => l.destino === destino);
    if (!suyas.length) continue;

    publicar(EVENTOS.ORDEN_ENVIADA, {
      idOrden: r.idOrden,
      mesa: r.mesa,
      lineas: suyas.map((l) => ({
        id: l.idLinea, producto: l.producto, cantidad: l.cantidad, notas: l.notas,
      })),
    }, { permiso: 'kds.ver', estacion: destino });
  }

  // El mesero ve su monitor de seguimiento actualizarse (vista 14).
  publicar(EVENTOS.MESA_ESTADO, { idMesa: r.idMesa, estado: 'ocupada', mesa: r.mesa },
    { permiso: 'salon.ver' });

  // Alerta de stock critico al administrador (RF-09).
  if (r.criticos.length) {
    publicar(EVENTOS.STOCK_CRITICO, { insumos: r.criticos }, { permiso: 'inventario.ver' });
  }

  return res.json({
    ok: true,
    lineasEnviadas: r.lineas.length,
    aCocina: r.lineas.filter((l) => l.destino === 'cocina').length,
    aBarra: r.lineas.filter((l) => l.destino === 'barra').length,
    stockCritico: r.criticos,
  });
}));

/** POST /api/v1/ordenes/:id/precuenta */
router.post('/:id/precuenta', requierePermiso('ordenes.precuenta'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.id);

  const orden = await consultarUno('SELECT id_mesero FROM orden WHERE id_orden = ?', [idOrden]);
  if (!orden) throw errores.noEncontrado('La comanda');
  if (orden.id_mesero !== req.usuario.id && !tienePermiso(req, 'ordenes.ver_todas')) {
    throw errores.sinPermiso('ordenes.ver_todas');
  }

  const r = await solicitarPrecuenta({
    idOrden, idUsuario: req.usuario.id, ipOrigen: ipDe(req),
  });

  // Notificacion al POS: la mesa sube al inicio de su lista en amarillo.
  publicar(EVENTOS.PRECUENTA_SOLICITADA, { idOrden: r.idOrden, idMesa: r.idMesa, mesa: r.mesa },
    { permiso: 'caja.cobrar' });
  publicar(EVENTOS.MESA_ESTADO, { idMesa: r.idMesa, estado: 'precuenta', mesa: r.mesa },
    { permiso: 'salon.ver' });

  return res.json({ ok: true });
}));

/**
 * POST /api/v1/ordenes/:id/lineas/:idLinea/anular   CA-08
 * Body: { motivo, pinAutorizador? }
 *
 * Dos caminos: tener ordenes.anular_enviada, o que un administrador teclee su
 * PIN (FSD 5.5). En ambos casos queda auditado con autor y autorizador.
 */
router.post('/:id/lineas/:idLinea/anular', asyncHandler(async (req, res) => {
  const idLinea = Number(req.params.idLinea);
  const { motivo, pinAutorizador } = req.body ?? {};

  if (!motivo || String(motivo).trim().length < 3) {
    throw errores.peticionInvalida('Indique el motivo de la anulación.',
      { campos: { motivo: 'Mínimo 3 caracteres.' } });
  }

  let idAutorizador = null;
  if (!tienePermiso(req, 'ordenes.anular_enviada')) {
    if (!pinAutorizador) {
      throw errores.sinPermiso('ordenes.anular_enviada');
    }
    idAutorizador = await verificarPinAutorizador(pinAutorizador);
  }

  const r = await anularLinea({
    idLinea,
    idUsuario: req.usuario.id,
    idAutorizador,
    motivo: String(motivo).trim(),
    ipOrigen: ipDe(req),
  });

  // A cocina, para que el plato desaparezca de la pantalla, y a la sala, porque
  // la comanda que el mesero tiene abierta acaba de cambiar. Antes solo iba al
  // KDS y el mesero seguia viendo la línea anulada hasta recargar.
  publicar(EVENTOS.LINEA_ESTADO, {
    idLinea, idOrden: r.idOrden, idMesero: r.idMesero,
    estado: 'anulado', producto: r.producto, mesa: r.mesa,
  }, { permisos: ['kds.ver', 'salon.ver'] });

  return res.json({ ok: true, ...r });
}));

export default router;
