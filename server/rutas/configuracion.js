/**
 * Configuracion del canal digital.   /api/v1/configuracion
 *
 * Es el respaldo de las dos pantallas nuevas del modulo Administrador:
 *   - Zonas de entrega: los circulos de cobertura con su radio y su precio.
 *   - Aplicacion movil: los interruptores, la ficha del restaurante y las
 *     promociones.
 *
 * Todo exige permiso del modulo `canal_digital`. El cajero opera reservas y
 * domicilios pero NO llega aqui: parametrizar cobertura y precios de envio es
 * decision del Administrador.
 */
import { Router } from 'express';
import { consultar, consultarUno, pool } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';
import { listarTodos, fijarVarios } from '../servicios/parametros.js';
import { cotizar, zonaPara, distanciaMetros } from '../servicios/entregas.js';
import { estadisticasCache } from '../servicios/teselas.js';
import { difundirPromocion, pushConfigurado } from '../servicios/push.js';
import { listarParaBackoffice } from '../servicios/clientes.js';
import { metodosParaAdmin, guardarMetodo } from '../servicios/pagos.js';

const router = Router();

router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/* =====================================================================
   Parametros
   ===================================================================== */

router.get('/parametros', requierePermiso('config.app.ver'), asyncHandler(async (_req, res) => {
  return res.json({ parametros: await listarTodos() });
}));

/**
 * PUT /api/v1/configuracion/parametros   { clave: valor, ... }
 *
 * Se audita porque apagar la aplicacion movil o cambiar el telefono publico
 * son acciones con consecuencias visibles para todos los clientes, y conviene
 * saber quien las hizo.
 */
router.put('/parametros', requierePermiso('config.app.gestionar'), asyncHandler(async (req, res) => {
  const cambios = req.body ?? {};
  if (!Object.keys(cambios).length) {
    throw errores.peticionInvalida('No se envio ningun cambio.');
  }

  const aplicados = await fijarVarios(cambios);

  await auditar(null, {
    idUsuario: req.usuario.id,
    accion: 'config.parametros',
    entidad: 'parametro',
    detalle: `Parametros actualizados: ${aplicados.map((p) => `${p.clave}=${p.valor}`).join(', ')}.`,
    ipOrigen: ipDe(req),
  });

  return res.json({ parametros: aplicados });
}));

/* =====================================================================
   Zonas de entrega
   ===================================================================== */

function comoDto(z) {
  return {
    id: z.id_zona_entrega,
    nombre: z.nombre,
    centroLat: Number(z.centro_lat),
    centroLng: Number(z.centro_lng),
    radioM: z.radio_m,
    costoEnvio: z.costo_envio,
    pedidoMinimo: z.pedido_minimo,
    tiempoEstimadoMin: z.tiempo_estimado_min,
    color: z.color,
    prioridad: z.prioridad,
    activa: Boolean(z.activa),
  };
}

/** Valida los campos de una zona. Devuelve { campo: mensaje }. */
function validarZona({ nombre, centroLat, centroLng, radioM, costoEnvio, pedidoMinimo, tiempoEstimadoMin, color }) {
  const fallos = {};

  if (!nombre || String(nombre).trim().length < 2) {
    fallos.nombre = 'Indique un nombre para la zona.';
  } else if (String(nombre).trim().length > 60) {
    fallos.nombre = 'El nombre no puede superar 60 caracteres.';
  }

  const lat = Number(centroLat);
  const lng = Number(centroLng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180) {
    fallos.centro = 'Marque el centro de la zona en el mapa.';
  }

  const radio = Number(radioM);
  // Los mismos limites que el CHECK de la tabla: 100 m es el minimo con
  // sentido para una entrega, 50 km el maximo razonable en ciudad.
  if (!Number.isInteger(radio) || radio < 100 || radio > 50000) {
    fallos.radioM = 'El radio debe estar entre 100 y 50.000 metros.';
  }

  if (costoEnvio != null && (!Number.isFinite(Number(costoEnvio)) || Number(costoEnvio) < 0)) {
    fallos.costoEnvio = 'El costo de envio no puede ser negativo.';
  }
  if (pedidoMinimo != null && (!Number.isFinite(Number(pedidoMinimo)) || Number(pedidoMinimo) < 0)) {
    fallos.pedidoMinimo = 'El pedido minimo no puede ser negativo.';
  }
  if (tiempoEstimadoMin != null &&
      (!Number.isInteger(Number(tiempoEstimadoMin)) || Number(tiempoEstimadoMin) < 1)) {
    fallos.tiempoEstimadoMin = 'El tiempo estimado debe ser al menos 1 minuto.';
  }
  if (color != null && !/^#[0-9a-fA-F]{6}$/.test(String(color))) {
    fallos.color = 'El color debe ser un hexadecimal como #0f766e.';
  }

  return fallos;
}

/** Listado completo, incluidas las inactivas (el Admin necesita verlas). */
router.get('/zonas-entrega', requierePermiso('config.entregas.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT * FROM zona_entrega ORDER BY prioridad ASC, radio_m ASC, nombre`
  );
  return res.json({ zonas: filas.map(comoDto) });
}));

router.post('/zonas-entrega', requierePermiso('config.entregas.gestionar'), asyncHandler(async (req, res) => {
  const datos = req.body ?? {};
  const fallos = validarZona(datos);
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const [r] = await pool.execute(
    `INSERT INTO zona_entrega
       (nombre, centro_lat, centro_lng, radio_m, costo_envio, pedido_minimo,
        tiempo_estimado_min, color, prioridad, activa)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(datos.nombre).trim(),
      Number(datos.centroLat), Number(datos.centroLng), Number(datos.radioM),
      Number(datos.costoEnvio ?? 0), Number(datos.pedidoMinimo ?? 0),
      Number(datos.tiempoEstimadoMin ?? 30),
      datos.color ?? '#0f766e', Number(datos.prioridad ?? 0),
      datos.activa === false ? 0 : 1,
    ]
  );

  await auditar(null, {
    idUsuario: req.usuario.id,
    accion: 'config.zona_entrega.creada',
    entidad: 'zona_entrega',
    idEntidad: r.insertId,
    detalle: `Zona de entrega "${datos.nombre}": radio ${datos.radioM} m, envio ${datos.costoEnvio ?? 0}.`,
    ipOrigen: ipDe(req),
  });

  const fila = await consultarUno('SELECT * FROM zona_entrega WHERE id_zona_entrega = ?', [r.insertId]);
  return res.status(201).json({ zona: comoDto(fila) });
}));

router.put('/zonas-entrega/:id', requierePermiso('config.entregas.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const datos = req.body ?? {};

  const actual = await consultarUno('SELECT * FROM zona_entrega WHERE id_zona_entrega = ?', [id]);
  if (!actual) throw errores.noEncontrado('La zona de entrega');

  const fallos = validarZona(datos);
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  await pool.execute(
    `UPDATE zona_entrega
        SET nombre = ?, centro_lat = ?, centro_lng = ?, radio_m = ?,
            costo_envio = ?, pedido_minimo = ?, tiempo_estimado_min = ?,
            color = ?, prioridad = ?, activa = ?
      WHERE id_zona_entrega = ?`,
    [
      String(datos.nombre).trim(),
      Number(datos.centroLat), Number(datos.centroLng), Number(datos.radioM),
      Number(datos.costoEnvio ?? 0), Number(datos.pedidoMinimo ?? 0),
      Number(datos.tiempoEstimadoMin ?? 30),
      datos.color ?? '#0f766e', Number(datos.prioridad ?? 0),
      datos.activa === false ? 0 : 1,
      id,
    ]
  );

  await auditar(null, {
    idUsuario: req.usuario.id,
    accion: 'config.zona_entrega.editada',
    entidad: 'zona_entrega',
    idEntidad: id,
    detalle: `Zona "${actual.nombre}" -> "${datos.nombre}": radio ${datos.radioM} m, envio ${datos.costoEnvio ?? 0}.`,
    ipOrigen: ipDe(req),
  });

  const fila = await consultarUno('SELECT * FROM zona_entrega WHERE id_zona_entrega = ?', [id]);
  return res.json({ zona: comoDto(fila) });
}));

/**
 * DELETE /api/v1/configuracion/zonas-entrega/:id
 *
 * Se borra de verdad solo si nunca se uso. Si hay pedidos que la referencian,
 * se desactiva: un DELETE dejaria esos pedidos sin zona y el historico sin
 * explicar por que se cobro ese envio.
 */
router.delete('/zonas-entrega/:id', requierePermiso('config.entregas.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const zona = await consultarUno('SELECT nombre FROM zona_entrega WHERE id_zona_entrega = ?', [id]);
  if (!zona) throw errores.noEncontrado('La zona de entrega');

  const usos = await consultarUno(
    'SELECT COUNT(*) AS n FROM pedido_domicilio WHERE id_zona_entrega = ?', [id]
  );

  if (Number(usos.n) > 0) {
    await pool.execute('UPDATE zona_entrega SET activa = FALSE WHERE id_zona_entrega = ?', [id]);
    await auditar(null, {
      idUsuario: req.usuario.id,
      accion: 'config.zona_entrega.desactivada',
      entidad: 'zona_entrega',
      idEntidad: id,
      detalle: `Zona "${zona.nombre}" desactivada (tiene ${usos.n} pedido(s) asociados).`,
      ipOrigen: ipDe(req),
    });
    return res.json({
      desactivada: true,
      mensaje: `La zona tiene ${usos.n} pedido(s) en el historico, asi que se desactivo en vez de borrarla.`,
    });
  }

  await pool.execute('DELETE FROM zona_entrega WHERE id_zona_entrega = ?', [id]);
  await auditar(null, {
    idUsuario: req.usuario.id,
    accion: 'config.zona_entrega.borrada',
    entidad: 'zona_entrega',
    idEntidad: id,
    detalle: `Zona "${zona.nombre}" eliminada.`,
    ipOrigen: ipDe(req),
  });
  return res.status(204).end();
}));

/**
 * POST /api/v1/configuracion/zonas-entrega/previsualizar   { lat, lng, subtotal }
 *
 * Contesta que zona cubre una coordenada y a que precio, LLAMANDO A LA MISMA
 * FUNCION que usa la aplicacion al cotizar (servicios/entregas.js). Es lo que
 * garantiza que lo que el administrador ve mientras dibuja es exactamente lo
 * que el cliente pagara. Si esto se hubiera calculado aparte en el navegador,
 * tarde o temprano los dos numeros dejarian de coincidir.
 */
router.post('/zonas-entrega/previsualizar', requierePermiso('config.entregas.ver'),
  asyncHandler(async (req, res) => {
    const { lat, lng, subtotal } = req.body ?? {};
    const cotizacion = await cotizar({ lat: Number(lat), lng: Number(lng), subtotal });
    const zona = await zonaPara(Number(lat), Number(lng));

    return res.json({
      ...cotizacion,
      // Distancia a cada zona activa: ayuda a entender por que gano una y no
      // otra cuando los circulos se solapan.
      distancias: (await consultar(
        'SELECT id_zona_entrega, nombre, centro_lat, centro_lng, radio_m FROM zona_entrega WHERE activa = TRUE'
      )).map((z) => ({
        id: z.id_zona_entrega,
        nombre: z.nombre,
        distanciaM: distanciaMetros(Number(lat), Number(lng), Number(z.centro_lat), Number(z.centro_lng)),
        radioM: z.radio_m,
        dentro: distanciaMetros(Number(lat), Number(lng), Number(z.centro_lat), Number(z.centro_lng)) <= z.radio_m,
        gana: zona?.id === z.id_zona_entrega,
      })),
    });
  }));

/* =====================================================================
   Promociones
   ===================================================================== */

router.get('/promociones', requierePermiso('promociones.gestionar'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT p.*, u.nombre_completo AS creada_por
       FROM promocion p
       LEFT JOIN usuario u ON u.id_usuario = p.id_usuario_creo
      ORDER BY p.creado_en DESC LIMIT 100`
  );
  return res.json({
    pushConfigurado: pushConfigurado(),
    promociones: filas.map((p) => ({
      id: p.id_promocion,
      titulo: p.titulo,
      cuerpo: p.cuerpo,
      urlImagen: p.url_imagen,
      vigenteDesde: p.vigente_desde,
      vigenteHasta: p.vigente_hasta,
      activa: Boolean(p.activa),
      enviadaEn: p.enviada_en,
      totalEnviados: p.total_enviados,
      creadaPor: p.creada_por,
      creadoEn: p.creado_en,
    })),
  });
}));

router.post('/promociones', requierePermiso('promociones.gestionar'), asyncHandler(async (req, res) => {
  const { titulo, cuerpo, urlImagen, vigenteDesde, vigenteHasta } = req.body ?? {};

  const fallos = {};
  if (!titulo || String(titulo).trim().length < 3) fallos.titulo = 'Indique un titulo.';
  if (!cuerpo || String(cuerpo).trim().length < 3) fallos.cuerpo = 'Escriba el mensaje.';
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const [r] = await pool.execute(
    `INSERT INTO promocion (titulo, cuerpo, url_imagen, vigente_desde, vigente_hasta, id_usuario_creo)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      String(titulo).trim().slice(0, 120),
      String(cuerpo).trim().slice(0, 255),
      urlImagen || null,
      vigenteDesde || null,
      vigenteHasta || null,
      req.usuario.id,
    ]
  );

  return res.status(201).json({ id: r.insertId });
}));

router.put('/promociones/:id', requierePermiso('promociones.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { titulo, cuerpo, urlImagen, vigenteDesde, vigenteHasta, activa } = req.body ?? {};

  const actual = await consultarUno('SELECT id_promocion FROM promocion WHERE id_promocion = ?', [id]);
  if (!actual) throw errores.noEncontrado('La promocion');

  await pool.execute(
    `UPDATE promocion
        SET titulo = ?, cuerpo = ?, url_imagen = ?, vigente_desde = ?,
            vigente_hasta = ?, activa = ?
      WHERE id_promocion = ?`,
    [
      String(titulo ?? '').trim().slice(0, 120),
      String(cuerpo ?? '').trim().slice(0, 255),
      urlImagen || null,
      vigenteDesde || null,
      vigenteHasta || null,
      activa === false ? 0 : 1,
      id,
    ]
  );

  return res.json({ actualizada: true });
}));

router.delete('/promociones/:id', requierePermiso('promociones.gestionar'), asyncHandler(async (req, res) => {
  await pool.execute('DELETE FROM promocion WHERE id_promocion = ?', [Number(req.params.id)]);
  return res.status(204).end();
}));

/**
 * POST /api/v1/configuracion/promociones/:id/enviar
 *
 * UNA SOLA VEZ. `enviada_en` no vuelve a NULL nunca: es lo que impide que un
 * doble clic bombardee a todos los clientes dos veces con el mismo mensaje.
 * La comprobacion esta aqui, en el servidor, no en el boton del navegador.
 */
router.post('/promociones/:id/enviar', requierePermiso('promociones.gestionar'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    const promo = await consultarUno(
      'SELECT id_promocion, titulo, cuerpo, activa, enviada_en FROM promocion WHERE id_promocion = ?',
      [id]
    );
    if (!promo) throw errores.noEncontrado('La promocion');
    if (promo.enviada_en) {
      throw errores.conflicto('Esa promocion ya se envio. Cree una nueva si quiere volver a avisar.');
    }
    if (!promo.activa) {
      throw errores.reglaDeNegocio('La promocion esta desactivada. Activela antes de enviarla.');
    }

    const resultado = await difundirPromocion({
      titulo: promo.titulo,
      cuerpo: promo.cuerpo,
      referencia: `PROMO-${id}`,
    });

    await pool.execute(
      'UPDATE promocion SET enviada_en = NOW(), total_enviados = ? WHERE id_promocion = ?',
      [resultado.clientes, id]
    );

    await auditar(null, {
      idUsuario: req.usuario.id,
      accion: 'promocion.enviada',
      entidad: 'promocion',
      idEntidad: id,
      detalle: `Promocion "${promo.titulo}" enviada a ${resultado.clientes} cliente(s); ` +
               `${resultado.enviados} envio(s) push aceptados.`,
      ipOrigen: ipDe(req),
    });

    return res.json({
      enviada: true,
      clientes: resultado.clientes,
      pushEnviados: resultado.enviados,
      // Si no hay credenciales de FCM la promocion igualmente queda en la
      // bandeja de cada cliente. Conviene que el administrador lo sepa.
      pushConfigurado: pushConfigurado(),
    });
  }));

/* =====================================================================
   Metodos de pago de la aplicacion
   ===================================================================== */

router.get('/metodos-pago', requierePermiso('config.pagos.gestionar'),
  asyncHandler(async (_req, res) => {
    return res.json({ metodos: await metodosParaAdmin() });
  }));

/**
 * PUT /api/v1/configuracion/metodos-pago/:codigo
 *
 * El servicio impide activar un metodo digital sin llave ni titular: publicar
 * "Nequi" sin numero mandaria al cliente a transferir al vacio.
 */
router.put('/metodos-pago/:codigo', requierePermiso('config.pagos.gestionar'),
  asyncHandler(async (req, res) => {
    const metodo = await guardarMetodo(String(req.params.codigo), req.body ?? {}, {
      idUsuario: req.usuario.id,
      ipOrigen: ipDe(req),
    });
    return res.json({ metodo });
  }));

/* =====================================================================
   Clientes registrados  (solo lectura)
   ===================================================================== */

router.get('/clientes', requierePermiso('clientes.ver'), asyncHandler(async (req, res) => {
  const { buscar, pagina, limite } = req.query;
  return res.json(await listarParaBackoffice({ buscar, pagina, limite }));
}));

/** GET /api/v1/configuracion/resumen -- contadores del panel de control. */
router.get('/resumen', requierePermiso('config.app.ver'), asyncHandler(async (_req, res) => {
  const fila = await consultarUno(
    `SELECT
       (SELECT COUNT(*) FROM cliente WHERE activo = TRUE)                          AS clientes,
       (SELECT COUNT(*) FROM dispositivo_cliente WHERE activo = TRUE)              AS dispositivos,
       (SELECT COUNT(*) FROM reserva WHERE estado = 'pendiente')                   AS reservasPendientes,
       (SELECT COUNT(*) FROM pedido_domicilio WHERE estado = 'pendiente')          AS pedidosPendientes,
       (SELECT COUNT(*) FROM zona_entrega WHERE activa = TRUE)                     AS zonasActivas`
  );

  return res.json({
    clientes: Number(fila.clientes),
    dispositivos: Number(fila.dispositivos),
    reservasPendientes: Number(fila.reservasPendientes),
    pedidosPendientes: Number(fila.pedidosPendientes),
    zonasActivas: Number(fila.zonasActivas),
    pushConfigurado: pushConfigurado(),
    cacheMapa: await estadisticasCache(),
  });
}));

export default router;
