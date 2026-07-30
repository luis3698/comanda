/**
 * API de la aplicacion movil de clientes.   /api/v1/app
 *
 * Es la unica superficie del sistema pensada para internet abierto, y por eso
 * juega con reglas distintas al resto de la API:
 *
 *   - Autenticacion por token Bearer, no por cookie (middleware/authCliente.js).
 *   - NINGUN `requierePermiso`. Los clientes no tienen rol ni matriz: la
 *     autorizacion es pertenencia, y se implementa filtrando por
 *     `req.cliente.id` en cada consulta.
 *   - Todo el router esta detras de `requiereAppActiva`, salvo GET /estado.
 *   - El registro y el login llevan limite por IP (middleware/limite.js).
 *
 * LA REGLA QUE NO SE PUEDE ROMPER AL ANADIR UN ENDPOINT AQUI
 * El id del cliente sale SIEMPRE de `req.cliente.id`, es decir del token.
 * Nunca del body, ni de la query, ni de un parametro de ruta. Si algun dia
 * aparece un `?idCliente=` en este archivo, es un fallo de seguridad: cualquiera
 * podria leer los pedidos de otra persona cambiando un numero.
 */
import { Router } from 'express';
import { consultar } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { cargarCliente, requiereCliente, crearSesionCliente, destruirSesionCliente }
  from '../middleware/authCliente.js';
import { requiereAppActiva, requiereReservasActivas, requiereDomiciliosActivos }
  from '../middleware/appActiva.js';
import { limiteAutenticacion, limiteApiCliente } from '../middleware/limite.js';
import { publicar, EVENTOS } from '../realtime.js';
import { obtener, obtenerGrupo } from '../servicios/parametros.js';
import { resolverPrecio } from '../servicios/precios.js';
import { cotizar, listarZonas } from '../servicios/entregas.js';
import { recibirImagen, guardarImagen } from '../servicios/imagenes.js';
import * as clientes from '../servicios/clientes.js';
import * as reservas from '../servicios/reservas.js';
import * as domicilios from '../servicios/domicilios.js';
import * as push from '../servicios/push.js';
import * as pagos from '../servicios/pagos.js';

const router = Router();

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/* =====================================================================
   Estado del servicio  --  SIN autenticacion y SIN interruptor
   ===================================================================== */

/**
 * GET /api/v1/app/estado
 *
 * Deliberadamente fuera de `requiereAppActiva`. Si tambien respondiera 503, la
 * aplicacion solo podria ensenar un error de red generico; abierto, lee el
 * motivo y pinta la pantalla de mantenimiento con el texto que escribio el
 * administrador. Es el unico endpoint que la app puede llamar siempre.
 */
router.get('/estado', asyncHandler(async (_req, res) => {
  const activa = await obtener('app.movil.activa', true);
  return res.json({
    activa,
    mensaje: activa ? null : await obtener('app.movil.mensaje_inactiva', ''),
    reservas: await obtener('app.movil.reservas_activas', true),
    domicilios: await obtener('app.movil.domicilios_activos', true),
    versionMinima: await obtener('app.movil.version_minima', 1),
  });
}));

// A partir de aqui, todo pasa por el interruptor general y por la carga del
// token. `cargarCliente` no rechaza si no hay token: eso lo decide
// `requiereCliente` en cada ruta que lo necesite.
router.use(requiereAppActiva);
router.use(limiteApiCliente);
router.use(cargarCliente);

/* =====================================================================
   Registro y autenticacion
   ===================================================================== */

/** POST /api/v1/app/registro */
router.post('/registro', limiteAutenticacion, asyncHandler(async (req, res) => {
  const { nombreCompleto, correo, telefono, documento, password } = req.body ?? {};

  const cliente = await clientes.registrar({ nombreCompleto, correo, telefono, documento, password });

  // Se abre sesion de inmediato: obligar a iniciar sesion justo despues de
  // registrarse es una friccion sin ninguna contrapartida de seguridad.
  const sesion = await crearSesionCliente(cliente.id, {
    ip: ipDe(req),
    dispositivo: req.get('user-agent'),
  });

  return res.status(201).json({ cliente, ...sesion });
}));

/** POST /api/v1/app/auth/login  -- acepta correo o cedula en `identificador`. */
router.post('/auth/login', limiteAutenticacion, asyncHandler(async (req, res) => {
  const { identificador, correo, documento, password } = req.body ?? {};

  const cliente = await clientes.autenticar({
    identificador: identificador ?? correo ?? documento,
    password,
  });

  const sesion = await crearSesionCliente(cliente.id, {
    ip: ipDe(req),
    dispositivo: req.get('user-agent'),
  });

  return res.json({ cliente, ...sesion });
}));

/** POST /api/v1/app/auth/logout */
router.post('/auth/logout', requiereCliente, asyncHandler(async (req, res) => {
  // El token FCM se retira antes de cerrar: si no, el movil seguiria
  // recibiendo notificaciones de una cuenta con la sesion cerrada.
  const { tokenFcm } = req.body ?? {};
  if (tokenFcm) await push.borrarDispositivo(req.cliente.id, tokenFcm);

  await destruirSesionCliente(req.cliente.sesion.id);
  return res.status(204).end();
}));

/* =====================================================================
   Perfil
   ===================================================================== */

router.get('/perfil', requiereCliente, asyncHandler(async (req, res) => {
  return res.json({ cliente: await clientes.perfil(req.cliente.id) });
}));

/** PUT /api/v1/app/perfil -- solo nombre, telefono y aviso de promociones. */
router.put('/perfil', requiereCliente, asyncHandler(async (req, res) => {
  const { nombreCompleto, telefono, aceptaPromociones } = req.body ?? {};
  const cliente = await clientes.actualizarPerfil(req.cliente.id, {
    nombreCompleto, telefono, aceptaPromociones,
  });
  return res.json({ cliente });
}));

router.put('/perfil/correo', requiereCliente, asyncHandler(async (req, res) => {
  const { correo, password } = req.body ?? {};
  return res.json({ cliente: await clientes.cambiarCorreo(req.cliente.id, { correo, password }) });
}));

/** PUT /api/v1/app/perfil/password -- cierra TODAS las sesiones al terminar. */
router.put('/perfil/password', requiereCliente, asyncHandler(async (req, res) => {
  const { passwordActual, passwordNueva } = req.body ?? {};
  await clientes.cambiarPassword(req.cliente.id, { passwordActual, passwordNueva });
  return res.json({
    actualizada: true,
    mensaje: 'Contrasena actualizada. Vuelva a iniciar sesion en sus dispositivos.',
  });
}));

/**
 * POST /api/v1/app/perfil/foto  (multipart, campo `imagen`)
 *
 * Reutiliza tal cual el pipeline de las fotos de los platos: multer en
 * memoria, validacion por magic bytes y renombrado aleatorio
 * (servicios/imagenes.js). El envoltorio traduce el error de tamano de multer
 * a un mensaje en espanol, igual que hace rutas/catalogo.js.
 */
router.post('/perfil/foto', requiereCliente,
  (req, res, next) => {
    recibirImagen(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(errores.peticionInvalida('La imagen supera el maximo de 2 MB.'));
      }
      return next(error);
    });
  },
  asyncHandler(async (req, res) => {
    // guardarImagen ya rechaza un buffer vacio con un mensaje claro.
    const ruta = await guardarImagen(req.file?.buffer);
    return res.json({ cliente: await clientes.cambiarFoto(req.cliente.id, ruta) });
  }));

/** DELETE /api/v1/app/perfil -- anonimiza la cuenta (ver servicios/clientes.js). */
router.delete('/perfil', requiereCliente, asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  await clientes.eliminarCuenta(req.cliente.id, { password });
  return res.json({ eliminada: true });
}));

/* =====================================================================
   Direcciones de entrega
   ===================================================================== */

router.get('/direcciones', requiereCliente, asyncHandler(async (req, res) => {
  return res.json({ direcciones: await clientes.listarDirecciones(req.cliente.id) });
}));

router.post('/direcciones', requiereCliente, asyncHandler(async (req, res) => {
  const creada = await clientes.crearDireccion(req.cliente.id, req.body ?? {});
  return res.status(201).json(creada);
}));

router.put('/direcciones/:id', requiereCliente, asyncHandler(async (req, res) => {
  const r = await clientes.actualizarDireccion(req.cliente.id, Number(req.params.id), req.body ?? {});
  return res.json(r);
}));

router.delete('/direcciones/:id', requiereCliente, asyncHandler(async (req, res) => {
  await clientes.borrarDireccion(req.cliente.id, Number(req.params.id));
  return res.status(204).end();
}));

/* =====================================================================
   Informacion publica: restaurante, carta y cobertura
   ===================================================================== */

/** GET /api/v1/app/restaurante -- ficha publica, desde la tabla `parametro`. */
router.get('/restaurante', asyncHandler(async (_req, res) => {
  const ficha = await obtenerGrupo('restaurante.');
  return res.json({ restaurante: ficha });
}));

/**
 * GET /api/v1/app/menu
 *
 * La carta visible para el comensal. Filtra por `activa`/`activo` y
 * `disponible`: lo que el cocinero marco agotado en el KDS desaparece de la
 * aplicacion igual que desaparece del comandero (CA-02).
 *
 * El precio se resuelve con `resolverPrecio`, la MISMA funcion del comandero,
 * asi que una variante de "happy hour" se aplica en los dos canales por igual.
 * Duplicar aqui la logica habria significado cobrar distinto segun por donde
 * se pida.
 */
router.get('/menu', asyncHandler(async (_req, res) => {
  const categorias = await consultar(
    `SELECT id_categoria, nombre, orden_visual
       FROM categoria WHERE activa = TRUE ORDER BY orden_visual, nombre`
  );

  const filas = await consultar(
    `SELECT p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.url_imagen,
            p.precio_base, p.tasa_impuesto,
            pp.id_precio, pp.nombre AS nombre_precio, pp.precio,
            pp.hora_inicio, pp.hora_fin, pp.fecha_inicio, pp.fecha_fin, pp.dias_semana
       FROM producto p
       JOIN categoria c ON c.id_categoria = p.id_categoria
       LEFT JOIN producto_precio pp
              ON pp.id_producto = p.id_producto AND pp.activo = TRUE
      WHERE p.activo = TRUE AND p.disponible = TRUE AND c.activa = TRUE
      ORDER BY p.nombre`
  );

  // Las filas vienen multiplicadas por el LEFT JOIN de variantes: se agrupan
  // por producto antes de resolver el precio.
  const porProducto = new Map();
  for (const f of filas) {
    if (!porProducto.has(f.id_producto)) porProducto.set(f.id_producto, { base: f, variantes: [] });
    if (f.id_precio !== null) porProducto.get(f.id_producto).variantes.push(f);
  }

  const productos = [...porProducto.values()].map(({ base, variantes }) => {
    const { precio } = resolverPrecio(base, variantes);
    return {
      id: base.id_producto,
      idCategoria: base.id_categoria,
      nombre: base.nombre,
      descripcion: base.descripcion,
      urlImagen: base.url_imagen,
      precio,                              // string DECIMAL, sin pasar por Number
      tasaImpuesto: String(base.tasa_impuesto),
    };
  });

  return res.json({
    categorias: categorias.map((c) => ({ id: c.id_categoria, nombre: c.nombre })),
    productos,
  });
}));

/** GET /api/v1/app/menu/:id -- detalle con grupos de modificadores. */
router.get('/menu/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const filas = await consultar(
    `SELECT p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.url_imagen,
            p.precio_base, p.tasa_impuesto, c.nombre AS categoria,
            pp.id_precio, pp.nombre AS nombre_precio, pp.precio,
            pp.hora_inicio, pp.hora_fin, pp.fecha_inicio, pp.fecha_fin, pp.dias_semana
       FROM producto p
       JOIN categoria c ON c.id_categoria = p.id_categoria
       LEFT JOIN producto_precio pp
              ON pp.id_producto = p.id_producto AND pp.activo = TRUE
      WHERE p.id_producto = ? AND p.activo = TRUE AND p.disponible = TRUE AND c.activa = TRUE`,
    [id]
  );
  if (!filas.length) throw errores.noEncontrado('El plato');

  const base = filas[0];
  const { precio } = resolverPrecio(base, filas.filter((f) => f.id_precio !== null));

  // OJO: `grupo_modificador` NO tiene columna `activo` -- solo la tiene
  // `modificador`. Un grupo se retira quitandolo del producto en
  // producto_grupo_modificador, no marcandolo inactivo. Filtrar aqui por
  // g.activo reventaba la consulta con ER_BAD_FIELD_ERROR.
  const grupos = await consultar(
    `SELECT g.id_grupo_mod, g.nombre, g.seleccion_min, g.seleccion_max
       FROM grupo_modificador g
       JOIN producto_grupo_modificador pgm ON pgm.id_grupo_mod = g.id_grupo_mod
      WHERE pgm.id_producto = ?
      ORDER BY g.nombre`,
    [id]
  );

  const opciones = grupos.length
    ? await consultar(
        `SELECT id_modificador, id_grupo_mod, nombre, precio_extra
           FROM modificador
          WHERE activo = TRUE AND id_grupo_mod IN (${grupos.map(() => '?').join(',')})
          ORDER BY nombre`,
        grupos.map((g) => g.id_grupo_mod)
      )
    : [];

  return res.json({
    producto: {
      id: base.id_producto,
      nombre: base.nombre,
      descripcion: base.descripcion,
      urlImagen: base.url_imagen,
      categoria: base.categoria,
      precio,
      tasaImpuesto: String(base.tasa_impuesto),
      grupos: grupos.map((g) => ({
        id: g.id_grupo_mod,
        nombre: g.nombre,
        min: g.seleccion_min,
        max: g.seleccion_max,
        opciones: opciones
          .filter((o) => o.id_grupo_mod === g.id_grupo_mod)
          .map((o) => ({ id: o.id_modificador, nombre: o.nombre, precioExtra: o.precio_extra })),
      })),
    },
  });
}));

/** GET /api/v1/app/zonas-entrega -- circulos de cobertura, para el mapa. */
router.get('/zonas-entrega', asyncHandler(async (_req, res) => {
  return res.json({ zonas: await listarZonas() });
}));

/**
 * GET /api/v1/app/metodos-pago
 *
 * Los metodos activos con la llave a la que transferir. Exige sesion: son
 * datos que el restaurante publica a proposito para cobrar, pero no hay
 * ningun motivo para dejarlos accesibles a cualquier robot que pase.
 */
router.get('/metodos-pago', requiereCliente, asyncHandler(async (_req, res) => {
  return res.json({ metodos: await pagos.metodosParaCliente() });
}));

/* =====================================================================
   Reservas
   ===================================================================== */

router.get('/reservas', requiereCliente, asyncHandler(async (req, res) => {
  const soloActivas = String(req.query.activas ?? '') === 'true';
  return res.json({ reservas: await reservas.listarDeCliente(req.cliente.id, { soloActivas }) });
}));

/**
 * POST /api/v1/app/reservas
 *
 * AQUI ESTA LA NOTIFICACION AUTOMATICA AL ROL DE CAJA que pedia el enunciado.
 * `publicar` filtra por permiso, asi que la reserva llega a las pantallas de
 * Caja y del Administrador y NO a las de cocina, sin escribir ni una linea de
 * enrutamiento. Se publica despues de que la reserva este guardada: nadie debe
 * ver en pantalla algo que la base todavia no confirmo.
 */
router.post('/reservas', requiereCliente, requiereReservasActivas, asyncHandler(async (req, res) => {
  const { fechaHora, numPersonas, notas } = req.body ?? {};

  const reserva = await reservas.crear(req.cliente.id, { fechaHora, numPersonas, notas });

  publicar(EVENTOS.RESERVA_CREADA, {
    idReserva: reserva.id,
    codigo: reserva.codigo,
    cliente: reserva.cliente,
    telefono: reserva.telefono,
    fechaHora: reserva.fechaHora,
    personas: reserva.numPersonas,
    notas: reserva.notas,
  }, { permisos: ['reservas.ver'] });

  return res.status(201).json({ reserva });
}));

router.get('/reservas/:id', requiereCliente, asyncHandler(async (req, res) => {
  const reserva = await reservas.detalle(Number(req.params.id));
  // La comprobacion de pertenencia es la autorizacion. Se responde 404 y no
  // 403 a proposito: un 403 confirmaria que esa reserva existe.
  if (!reserva || reserva.idCliente !== req.cliente.id) throw errores.noEncontrado('La reserva');
  return res.json({ reserva });
}));

router.post('/reservas/:id/cancelar', requiereCliente, asyncHandler(async (req, res) => {
  const r = await reservas.cancelarPorCliente(req.cliente.id, Number(req.params.id));

  publicar(EVENTOS.RESERVA_ACTUALIZADA, {
    idReserva: r.idReserva, codigo: r.codigo, estado: 'cancelada',
  }, { permisos: ['reservas.ver'] });

  return res.json(r);
}));

/* =====================================================================
   Domicilios
   ===================================================================== */

/**
 * POST /api/v1/app/domicilios/cotizar
 *
 * Responde 200 tambien cuando NO hay cobertura. El cliente necesita distinguir
 * "no llegamos hasta ahi" (mover el pin) de "te falta pedido minimo" (anadir
 * platos), y cada caso se resuelve de forma distinta. Un 4xx para ambos
 * obligaria a leer codigos de error para pintar la pantalla.
 */
router.post('/domicilios/cotizar', asyncHandler(async (req, res) => {
  const { lat, lng, subtotal } = req.body ?? {};
  return res.json(await cotizar({ lat: Number(lat), lng: Number(lng), subtotal }));
}));

router.get('/domicilios', requiereCliente, asyncHandler(async (req, res) => {
  const soloActivos = String(req.query.activos ?? '') === 'true';
  return res.json({ pedidos: await domicilios.listarDeCliente(req.cliente.id, { soloActivos }) });
}));

/** POST /api/v1/app/domicilios -- el pedido queda pendiente hasta que Caja lo acepte. */
router.post('/domicilios', requiereCliente, requiereDomiciliosActivos, asyncHandler(async (req, res) => {
  const pedido = await domicilios.crear(req.cliente.id, req.body ?? {});

  publicar(EVENTOS.DOMICILIO_CREADO, {
    idPedido: pedido.id,
    codigo: pedido.codigo,
    cliente: pedido.cliente,
    telefono: pedido.telefono,
    direccion: pedido.direccion,
    total: pedido.total,
    lineas: pedido.lineas.length,
  }, { permisos: ['domicilios.ver'] });

  return res.status(201).json({ pedido });
}));

router.get('/domicilios/:id', requiereCliente, asyncHandler(async (req, res) => {
  const pedido = await domicilios.detalle(Number(req.params.id));
  if (!pedido || pedido.idCliente !== req.cliente.id) throw errores.noEncontrado('El pedido');
  return res.json({ pedido });
}));

/**
 * POST /api/v1/app/domicilios/:id/comprobante   (multipart, campo `imagen`)
 *
 * El cliente sube la captura de su transferencia. Mismo pipeline que las fotos
 * de los platos: multer en memoria, validacion por magic bytes y renombrado
 * aleatorio, asi que un archivo que no sea una imagen real nunca llega al
 * disco (servicios/imagenes.js).
 *
 * El pedido pasa a `por_verificar` y se avisa a Caja por el canal de tiempo
 * real: hay un comprobante esperando revision.
 */
router.post('/domicilios/:id/comprobante', requiereCliente,
  (req, res, next) => {
    recibirImagen(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(errores.peticionInvalida(
          'La imagen supera el maximo de 2 MB. Pruebe con una captura mas pequena.'));
      }
      return next(error);
    });
  },
  asyncHandler(async (req, res) => {
    const ruta = await guardarImagen(req.file?.buffer);
    const r = await pagos.subirComprobante(req.cliente.id, Number(req.params.id), ruta);

    publicar(EVENTOS.DOMICILIO_ACTUALIZADO, {
      idPedido: Number(req.params.id),
      codigo: r.codigo,
      estadoPago: 'por_verificar',
      motivo: 'comprobante_subido',
      cliente: req.cliente.nombre,
    }, { permisos: ['domicilios.ver'] });

    return res.json({ ...r, urlComprobante: ruta });
  }));

router.post('/domicilios/:id/cancelar', requiereCliente, asyncHandler(async (req, res) => {
  const r = await domicilios.cancelarPorCliente(req.cliente.id, Number(req.params.id));

  publicar(EVENTOS.DOMICILIO_ACTUALIZADO, {
    idPedido: r.idPedido, codigo: r.codigo, estado: 'cancelado',
  }, { permisos: ['domicilios.ver'] });

  return res.json(r);
}));

/* =====================================================================
   Notificaciones y dispositivos
   ===================================================================== */

router.get('/notificaciones', requiereCliente, asyncHandler(async (req, res) => {
  return res.json({
    notificaciones: await push.listarNotificaciones(req.cliente.id),
    noLeidas: await push.contarNoLeidas(req.cliente.id),
  });
}));

router.post('/notificaciones/:id/leida', requiereCliente, asyncHandler(async (req, res) => {
  return res.json(await push.marcarLeida(req.cliente.id, Number(req.params.id)));
}));

router.post('/notificaciones/leidas', requiereCliente, asyncHandler(async (req, res) => {
  return res.json(await push.marcarTodasLeidas(req.cliente.id));
}));

/**
 * DELETE /api/v1/app/notificaciones/leidas
 *
 * Vacia la bandeja conservando lo no leido. Va ANTES que la ruta con :id: si se
 * declarara despues, Express casaria "leidas" con el parametro, Number() daria
 * NaN y la peticion moriria con un 400 que no explica nada.
 */
router.delete('/notificaciones/leidas', requiereCliente, asyncHandler(async (req, res) => {
  return res.json(await push.borrarLeidas(req.cliente.id));
}));

/**
 * DELETE /api/v1/app/notificaciones/:id
 *
 * Lo usa el gesto de deslizar de la aplicacion. Devuelve 200 aunque la
 * notificacion ya no estuviera: el cliente pide que desaparezca y ha
 * desaparecido, que es lo que importa. Un 404 obligaria a la app a distinguir
 * "no existia" de "no se pudo" para acabar haciendo lo mismo -- quitarla de la
 * lista -- y ademas se dispararia solo al deslizar dos veces rapido.
 */
router.delete('/notificaciones/:id', requiereCliente, asyncHandler(async (req, res) => {
  return res.json(await push.borrarNotificacion(req.cliente.id, Number(req.params.id)));
}));

/** POST /api/v1/app/dispositivos -- registra el token FCM del movil. */
router.post('/dispositivos', requiereCliente, asyncHandler(async (req, res) => {
  const { token, plataforma, modelo } = req.body ?? {};
  return res.json(await push.registrarDispositivo(req.cliente.id, { token, plataforma, modelo }));
}));

router.delete('/dispositivos/:token', requiereCliente, asyncHandler(async (req, res) => {
  await push.borrarDispositivo(req.cliente.id, req.params.token);
  return res.status(204).end();
}));

/* =====================================================================
   Promociones vigentes  --  para la pantalla de inicio
   ===================================================================== */

router.get('/promociones', asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT id_promocion, titulo, cuerpo, url_imagen, vigente_desde, vigente_hasta
       FROM promocion
      WHERE activa = TRUE
        AND (vigente_desde IS NULL OR vigente_desde <= CURDATE())
        AND (vigente_hasta IS NULL OR vigente_hasta >= CURDATE())
      ORDER BY creado_en DESC
      LIMIT 20`
  );
  return res.json({
    promociones: filas.map((p) => ({
      id: p.id_promocion,
      titulo: p.titulo,
      cuerpo: p.cuerpo,
      urlImagen: p.url_imagen,
      vigenteHasta: p.vigente_hasta,
    })),
  });
}));

export default router;
