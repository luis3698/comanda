/**
 * KDS de cocina y barra.  RF-14, RF-15, RF-16  ·  Vistas 15-17.
 *
 * FSD 5.6:
 *  - "Cada estacion solo ve las lineas de su destino (cocina/barra)."
 *  - "El monitor consolidado agrega unidades pendientes por producto."
 *  - "Agotado (requiere kds.marcar_agotado): producto.disponible = FALSE,
 *     difusion inmediata; los platos ya comandados permanecen en cola."
 */
import { Router } from 'express';
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';
import { avanzarEstadoLinea } from '../servicios/ordenes.js';
import { publicar, EVENTOS } from '../realtime.js';

const router = Router();
router.use(requiereAutenticacion);

const ESTACIONES = ['cocina', 'barra'];

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

function validarEstacion(valor) {
  const estacion = String(valor ?? 'cocina');
  if (!ESTACIONES.includes(estacion)) {
    throw errores.peticionInvalida(`Estación inválida. Opciones: ${ESTACIONES.join(', ')}.`);
  }
  return estacion;
}

/**
 * GET /api/v1/kds/comandas?estacion=cocina
 * Cola de la estacion, ordenada por antiguedad (FSD 4.3 vista 15: "mas antigua
 * a la izquierda").
 */
router.get('/comandas', requierePermiso('kds.ver'), asyncHandler(async (req, res) => {
  const estacion = validarEstacion(req.query.estacion);

  const filas = await consultar(
    `SELECT od.id_orden_detalle, od.id_orden, od.cantidad, od.notas,
            od.estado_preparacion, od.enviado_en, od.tiempo_salida,
            TIMESTAMPDIFF(SECOND, od.enviado_en, NOW()) AS segundos_espera,
            p.nombre AS producto,
            o.id_mesa, m.numero AS mesa, u.nombre_completo AS mesero,
            o.abierta_en
       FROM orden_detalle od
       JOIN producto p  ON p.id_producto = od.id_producto
       JOIN categoria c ON c.id_categoria = p.id_categoria
       JOIN orden o     ON o.id_orden = od.id_orden
       JOIN mesa m      ON m.id_mesa = o.id_mesa
       JOIN usuario u   ON u.id_usuario = o.id_mesero
      WHERE c.destino_preparacion = ?
        AND od.enviado_en IS NOT NULL
        AND od.estado_preparacion IN ('en_cola','preparando')
        AND o.estado NOT IN ('cerrada','anulada')
      ORDER BY od.enviado_en ASC, od.tiempo_salida ASC`,
    [estacion]
  );

  const modificadores = filas.length
    ? await consultar(
        `SELECT odm.id_orden_detalle, m.nombre
           FROM orden_detalle_modificador odm
           JOIN modificador m ON m.id_modificador = odm.id_modificador
          WHERE odm.id_orden_detalle IN (${filas.map(() => '?').join(',')})`,
        filas.map((f) => f.id_orden_detalle)
      )
    : [];

  // Se agrupa por comanda: el KDS muestra una tarjeta por mesa, no por plato.
  const tarjetas = new Map();
  for (const f of filas) {
    if (!tarjetas.has(f.id_orden)) {
      tarjetas.set(f.id_orden, {
        idOrden: f.id_orden,
        mesa: f.mesa,
        mesero: f.mesero,
        enviadoEn: f.enviado_en,
        // El cronometro y su codigo de color se calculan en el cliente a
        // partir de este valor (verde < 10 min, ambar 10-20, rojo > 20).
        segundosEspera: Number(f.segundos_espera),
        lineas: [],
      });
    }
    tarjetas.get(f.id_orden).lineas.push({
      id: f.id_orden_detalle,
      producto: f.producto,
      cantidad: f.cantidad,
      notas: f.notas,
      tiempoSalida: f.tiempo_salida,
      estado: f.estado_preparacion,
      modificadores: modificadores
        .filter((m) => m.id_orden_detalle === f.id_orden_detalle)
        .map((m) => m.nombre),
    });
  }

  return res.json({ estacion, comandas: [...tarjetas.values()] });
}));

/**
 * GET /api/v1/kds/comandas/:idOrden
 * Detalle COMPLETO de una comanda para el KDS: todas sus lineas, sean de
 * cocina o de barra, con su estado de preparacion. La cola por estacion
 * (GET /comandas) muestra solo las lineas de una estacion; al tocar una tarjeta
 * el cocinero necesita ver la comanda entera para no perder de vista lo que se
 * esta preparando en la otra estacion (una bebida que acompana el plato).
 */
router.get('/comandas/:idOrden', requierePermiso('kds.ver'), asyncHandler(async (req, res) => {
  const idOrden = Number(req.params.idOrden);

  const orden = await consultarUno(
    `SELECT o.id_orden, o.estado, o.num_comensales, o.abierta_en,
            m.numero AS mesa, u.nombre_completo AS mesero
       FROM orden o
       JOIN mesa m    ON m.id_mesa = o.id_mesa
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE o.id_orden = ?`,
    [idOrden]
  );
  if (!orden) throw errores.noEncontrado('La comanda');

  const filas = await consultar(
    `SELECT od.id_orden_detalle, od.cantidad, od.notas, od.estado_preparacion,
            od.enviado_en, p.nombre AS producto, c.destino_preparacion AS destino
       FROM orden_detalle od
       JOIN producto p  ON p.id_producto = od.id_producto
       JOIN categoria c ON c.id_categoria = p.id_categoria
      WHERE od.id_orden = ? AND od.estado_preparacion <> 'anulado'
      ORDER BY od.tiempo_salida, od.id_orden_detalle`,
    [idOrden]
  );

  const modificadores = filas.length
    ? await consultar(
        `SELECT odm.id_orden_detalle, m.nombre
           FROM orden_detalle_modificador odm
           JOIN modificador m ON m.id_modificador = odm.id_modificador
          WHERE odm.id_orden_detalle IN (${filas.map(() => '?').join(',')})`,
        filas.map((f) => f.id_orden_detalle)
      )
    : [];

  return res.json({
    idOrden: orden.id_orden,
    mesa: orden.mesa,
    mesero: orden.mesero,
    numComensales: orden.num_comensales,
    estado: orden.estado,
    lineas: filas.map((f) => ({
      id: f.id_orden_detalle,
      producto: f.producto,
      cantidad: f.cantidad,
      notas: f.notas,
      destino: f.destino,                       // 'cocina' | 'barra' | 'ninguno'
      estado: f.enviado_en ? f.estado_preparacion : 'sin_enviar',
      modificadores: modificadores
        .filter((m) => m.id_orden_detalle === f.id_orden_detalle)
        .map((m) => m.nombre),
    })),
  });
}));

/**
 * GET /api/v1/kds/produccion?estacion=cocina   RF-15
 * Monitor consolidado: unidades pendientes por producto en toda la sala.
 * FSD 5.6: "consulta agrupada en vivo, sin alterar los estados individuales".
 */
router.get('/produccion', requierePermiso('kds.ver'), asyncHandler(async (req, res) => {
  const estacion = validarEstacion(req.query.estacion);

  const filas = await consultar(
    `SELECT p.id_producto, p.nombre AS producto,
            SUM(od.cantidad) AS unidades,
            COUNT(DISTINCT od.id_orden) AS comandas
       FROM orden_detalle od
       JOIN producto p  ON p.id_producto = od.id_producto
       JOIN categoria c ON c.id_categoria = p.id_categoria
       JOIN orden o     ON o.id_orden = od.id_orden
      WHERE c.destino_preparacion = ?
        AND od.enviado_en IS NOT NULL
        AND od.estado_preparacion IN ('en_cola','preparando')
        AND o.estado NOT IN ('cerrada','anulada')
      GROUP BY p.id_producto, p.nombre
      ORDER BY unidades DESC, p.nombre`,
    [estacion]
  );

  // Desglose de modificadores por producto: "7 término medio / 5 tres cuartos"
  // (FSD 4.3 vista 16).
  const desglose = await consultar(
    `SELECT p.id_producto, m.nombre AS modificador, SUM(od.cantidad) AS unidades
       FROM orden_detalle od
       JOIN producto p  ON p.id_producto = od.id_producto
       JOIN categoria c ON c.id_categoria = p.id_categoria
       JOIN orden o     ON o.id_orden = od.id_orden
       JOIN orden_detalle_modificador odm ON odm.id_orden_detalle = od.id_orden_detalle
       JOIN modificador m ON m.id_modificador = odm.id_modificador
      WHERE c.destino_preparacion = ?
        AND od.enviado_en IS NOT NULL
        AND od.estado_preparacion IN ('en_cola','preparando')
        AND o.estado NOT IN ('cerrada','anulada')
      GROUP BY p.id_producto, m.nombre
      ORDER BY unidades DESC`,
    [estacion]
  );

  return res.json({
    estacion,
    productos: filas.map((f) => ({
      idProducto: f.id_producto,
      producto: f.producto,
      unidades: Number(f.unidades),
      comandas: f.comandas,
      modificadores: desglose
        .filter((d) => d.id_producto === f.id_producto)
        .map((d) => ({ nombre: d.modificador, unidades: Number(d.unidades) })),
    })),
  });
}));

/**
 * GET /api/v1/kds/comandas/:idOrden/detalle
 * Comandas individuales que componen una tarjeta del consolidado
 * (FSD 4.3 vista 16: "tocar una tarjeta expande la lista").
 */
router.get('/produccion/:idProducto', requierePermiso('kds.ver'), asyncHandler(async (req, res) => {
  const idProducto = Number(req.params.idProducto);

  const filas = await consultar(
    `SELECT od.id_orden_detalle, od.cantidad, od.notas, od.estado_preparacion,
            m.numero AS mesa, u.nombre_completo AS mesero,
            TIMESTAMPDIFF(SECOND, od.enviado_en, NOW()) AS segundos_espera
       FROM orden_detalle od
       JOIN orden o   ON o.id_orden = od.id_orden
       JOIN mesa m    ON m.id_mesa = o.id_mesa
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE od.id_producto = ?
        AND od.enviado_en IS NOT NULL
        AND od.estado_preparacion IN ('en_cola','preparando')
        AND o.estado NOT IN ('cerrada','anulada')
      ORDER BY od.enviado_en`,
    [idProducto]
  );

  return res.json({
    lineas: filas.map((f) => ({
      id: f.id_orden_detalle,
      mesa: f.mesa,
      mesero: f.mesero,
      cantidad: f.cantidad,
      notas: f.notas,
      estado: f.estado_preparacion,
      segundosEspera: Number(f.segundos_espera),
    })),
  });
}));

/**
 * PATCH /api/v1/kds/lineas/:id/estado   RF-14
 * Avanza un paso el estado de preparacion. El destino lo decide el servidor.
 */
router.patch('/lineas/:id/estado', requierePermiso('kds.avanzar_estado'), asyncHandler(async (req, res) => {
  const idLinea = Number(req.params.id);

  const r = await avanzarEstadoLinea({
    idLinea,
    estadoDestino: req.body?.estado,
    idUsuario: req.usuario.id,
    ipOrigen: ipDe(req),
  });

  // El mesero recibe el aviso en su monitor: cuando pasa a "listo", su
  // dispositivo vibra (FSD 4.2 vista 14).
  publicar(EVENTOS.LINEA_ESTADO, {
    idLinea: r.idLinea,
    idOrden: r.idOrden,
    // Va a toda la sala para que cualquiera vea el plano al dia, pero lleva el
    // dueno de la mesa: solo su dispositivo vibra. Sin esto, cada plato listo
    // haria sonar las tabletas de todos los meseros del turno.
    idMesero: r.idMesero,
    mesa: r.mesa,
    producto: r.producto,
    estado: r.estado,
    estadoAnterior: r.estadoAnterior,
  }, { permiso: 'salon.ver' });

  return res.json({ ok: true, estado: r.estado });
}));

/**
 * PATCH /api/v1/kds/lineas/:id/servido
 * El mesero cierra el plato de su monitor (FSD 4.2 vista 14).
 */
router.patch('/lineas/:id/servido', requierePermiso('ordenes.tomar'), asyncHandler(async (req, res) => {
  const idLinea = Number(req.params.id);

  const r = await avanzarEstadoLinea({
    idLinea, estadoDestino: 'servido', idUsuario: req.usuario.id, ipOrigen: ipDe(req),
  });

  publicar(EVENTOS.LINEA_ESTADO, {
    idLinea: r.idLinea, idOrden: r.idOrden, idMesero: r.idMesero, mesa: r.mesa,
    producto: r.producto, estado: r.estado,
  }, { permiso: 'salon.ver' });

  return res.json({ ok: true, estado: r.estado });
}));

/**
 * GET /api/v1/kds/menu?estacion=cocina   Vista 17
 * Menu de la estacion con su disponibilidad.
 */
router.get('/menu', requierePermiso('kds.ver'), asyncHandler(async (req, res) => {
  const estacion = validarEstacion(req.query.estacion);

  const filas = await consultar(
    `SELECT p.id_producto, p.nombre, p.disponible, c.nombre AS categoria,
            (SELECT COUNT(*) FROM orden_detalle od
               JOIN orden o ON o.id_orden = od.id_orden
              WHERE od.id_producto = p.id_producto
                AND od.estado_preparacion IN ('en_cola','preparando')
                AND o.estado NOT IN ('cerrada','anulada')) AS en_cola
       FROM producto p
       JOIN categoria c ON c.id_categoria = p.id_categoria
      WHERE c.destino_preparacion = ? AND p.activo = TRUE
      ORDER BY p.disponible ASC, c.orden_visual, p.nombre`,
    [estacion]
  );

  return res.json({
    estacion,
    productos: filas.map((p) => ({
      id: p.id_producto,
      nombre: p.nombre,
      categoria: p.categoria,
      disponible: Boolean(p.disponible),
      // FSD 4.3 vista 17: "confirmación previa si el plato tiene unidades ya
      // comandadas en cola".
      enCola: p.en_cola,
    })),
  });
}));

/**
 * PATCH /api/v1/kds/productos/:id/disponibilidad   RF-16  ·  CA-02
 * FSD 4.3 vista 17: "el cambio se propaga por WebSocket y el plato desaparece
 * instantáneamente de todos los comanderos".
 */
router.patch('/productos/:id/disponibilidad', requierePermiso('kds.marcar_agotado'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const disponible = Boolean(req.body?.disponible);

  const producto = await consultarUno(
    'SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]
  );
  if (!producto) throw errores.noEncontrado('El plato');

  await transaccion(async (cx) => {
    await cx.execute('UPDATE producto SET disponible = ? WHERE id_producto = ?', [disponible, id]);
    // FSD 5.6: cada cambio de disponibilidad queda auditado.
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: disponible ? 'producto.disponible' : 'producto.agotado',
      entidad: 'producto',
      idEntidad: id,
      detalle: `"${producto.nombre}" marcado como ${disponible ? 'disponible' : 'agotado'} desde el KDS.`,
      ipOrigen: ipDe(req),
    });
  });

  // ---- CA-02: debe desaparecer de todos los comanderos en menos de 1 s ----
  // Va a quien pueda ver el catalogo: meseros, cajeros y el resto del KDS.
  const alcanzados = publicar(EVENTOS.PRODUCTO_AGOTADO, {
    idProducto: id,
    nombre: producto.nombre,
    disponible,
  }, { permiso: 'catalogo.ver' });

  return res.json({ ok: true, disponible, clientesNotificados: alcanzados });
}));

export default router;
