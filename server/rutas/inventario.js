/**
 * Proveedores, compras e inventario.  RF-08, RF-09  ·  Vista 7.
 * Rutas según el catálogo de API del FSD 8.
 */
import { Router } from 'express';
import { consultar } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { publicar, EVENTOS } from '../realtime.js';
import {
  listarProveedores, guardarProveedor, listarCompras, detalleCompra,
  guardarCompra, recibirCompra, anularCompra, ajustarInventario, kardexDe,
} from '../servicios/compras.js';

const router = Router();
router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/* =====================================================================
   Proveedores
   ===================================================================== */

router.get('/proveedores', requierePermiso('inventario.ver', 'inventario.gestionar_compras'),
  asyncHandler(async (req, res) => {
    const proveedores = await listarProveedores({ soloActivos: req.query.todos !== '1' });
    return res.json({ proveedores });
  }));

router.post('/proveedores', requierePermiso('inventario.gestionar_compras'), asyncHandler(async (req, res) => {
  const r = await guardarProveedor({ ...req.body, idUsuario: req.usuario.id, ipOrigen: ipDe(req) });
  return res.status(201).json(r);
}));

router.put('/proveedores/:id', requierePermiso('inventario.gestionar_compras'), asyncHandler(async (req, res) => {
  const r = await guardarProveedor({
    ...req.body, id: Number(req.params.id), idUsuario: req.usuario.id, ipOrigen: ipDe(req),
  });
  return res.json(r);
}));

/* =====================================================================
   Compras
   ===================================================================== */

router.get('/compras', requierePermiso('inventario.ver', 'inventario.gestionar_compras'),
  asyncHandler(async (req, res) => {
    const compras = await listarCompras({
      idProveedor: req.query.idProveedor,
      desde: req.query.desde,
      hasta: req.query.hasta,
      estado: req.query.estado,
    });
    return res.json({ compras });
  }));

router.get('/compras/:id', requierePermiso('inventario.ver', 'inventario.gestionar_compras'),
  asyncHandler(async (req, res) => {
    const compra = await detalleCompra(Number(req.params.id));
    if (!compra) throw errores.noEncontrado('La compra');
    return res.json(compra);
  }));

router.post('/compras', requierePermiso('inventario.gestionar_compras'), asyncHandler(async (req, res) => {
  const r = await guardarCompra({ ...req.body, idUsuario: req.usuario.id, ipOrigen: ipDe(req) });
  return res.status(201).json(r);
}));

router.put('/compras/:id', requierePermiso('inventario.gestionar_compras'), asyncHandler(async (req, res) => {
  const r = await guardarCompra({
    ...req.body, id: Number(req.params.id), idUsuario: req.usuario.id, ipOrigen: ipDe(req),
  });
  return res.json(r);
}));

/** POST /compras/:id/recibir — la transacción que mueve stock y costo (RF-08). */
router.post('/compras/:id/recibir', requierePermiso('inventario.gestionar_compras'),
  asyncHandler(async (req, res) => {
    const r = await recibirCompra({
      idCompra: Number(req.params.id), idUsuario: req.usuario.id, ipOrigen: ipDe(req),
    });

    // Al entrar mercancía, algunos insumos pueden dejar de estar críticos: el
    // dashboard debe reflejarlo sin recargar.
    publicar(EVENTOS.STOCK_CRITICO, { motivo: 'compra_recibida', idCompra: r.idCompra },
      { permiso: 'inventario.ver' });

    return res.json(r);
  }));

/** POST /compras/:id/anular — contra-asientos, nunca borra el kárdex. */
router.post('/compras/:id/anular', requierePermiso('inventario.gestionar_compras'),
  asyncHandler(async (req, res) => {
    const r = await anularCompra({
      idCompra: Number(req.params.id), motivo: req.body?.motivo,
      idUsuario: req.usuario.id, ipOrigen: ipDe(req),
    });
    return res.json(r);
  }));

/* =====================================================================
   Existencias y kárdex
   ===================================================================== */

/** GET /inventario/existencias — con semáforo de estado (FSD 4.1 vista 7). */
router.get('/existencias', requierePermiso('inventario.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT i.id_insumo, i.nombre, i.unidad_medida, i.stock_actual, i.stock_minimo,
            i.costo_promedio,
            (SELECT COUNT(*) FROM receta r WHERE r.id_insumo = i.id_insumo) AS usado_en
       FROM insumo i
      ORDER BY (i.stock_actual <= i.stock_minimo) DESC, i.nombre`
  );

  return res.json({
    insumos: filas.map((i) => {
      const actual = Number(i.stock_actual);
      const minimo = Number(i.stock_minimo);
      // Semáforo: rojo si negativo, ámbar si está en o bajo el mínimo, verde si no.
      const estado = actual < 0 ? 'negativo' : (actual <= minimo ? 'critico' : 'normal');
      return {
        id: i.id_insumo,
        nombre: i.nombre,
        unidadMedida: i.unidad_medida,
        stockActual: String(i.stock_actual),
        stockMinimo: String(i.stock_minimo),
        costoPromedio: String(i.costo_promedio),
        valorInventario: (actual * Number(i.costo_promedio)).toFixed(2),
        usadoEn: i.usado_en,
        estado,
      };
    }),
  });
}));

router.get('/kardex/:idInsumo', requierePermiso('inventario.ver'), asyncHandler(async (req, res) => {
  const k = await kardexDe(Number(req.params.idInsumo), { limite: req.query.limite });
  if (!k) throw errores.noEncontrado('El insumo');
  return res.json(k);
}));

/** POST /inventario/ajustes — exige motivo y queda auditado (FSD 5.4, 8). */
router.post('/ajustes', requierePermiso('inventario.ajustar'), asyncHandler(async (req, res) => {
  const r = await ajustarInventario({
    idInsumo: req.body?.idInsumo,
    cantidad: req.body?.cantidad,
    tipo: req.body?.tipo ?? 'ajuste',
    motivo: req.body?.motivo,
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });

  if (r.critico) {
    publicar(EVENTOS.STOCK_CRITICO, { idInsumo: r.idInsumo, stockActual: r.stockActual },
      { permiso: 'inventario.ver' });
  }

  return res.json(r);
}));

/** PUT /inventario/insumos/:id/minimo — umbral de alerta (RF-09). */
router.put('/insumos/:id/minimo', requierePermiso('inventario.ajustar'), asyncHandler(async (req, res) => {
  const stockMinimo = Number(req.body?.stockMinimo);
  if (!Number.isFinite(stockMinimo) || stockMinimo < 0) {
    throw errores.peticionInvalida('El stock mínimo no puede ser negativo.');
  }
  const { pool } = await import('../db.js');
  await pool.execute('UPDATE insumo SET stock_minimo = ? WHERE id_insumo = ?',
    [stockMinimo, Number(req.params.id)]);
  return res.json({ ok: true });
}));

export default router;
