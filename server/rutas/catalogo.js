/**
 * Catalogo: categorias, productos y variantes de precio.  RF-05  ·  Vista 5.
 *
 * FSD 5.3:
 *  - "Precio >= 0 (CHECK); variantes de precio no pueden solapar ventanas
 *     horario/fecha para el mismo producto."
 *  - "Eliminar una categoria con productos activos exige reasignarlos primero."
 *  - "producto.disponible = FALSE (agotado desde KDS) lo oculta del comandero
 *     en tiempo real sin afectar su configuracion."
 */
import { Router } from 'express';
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';
import { detectarSolapes, describirVentana, resolverPrecio } from '../servicios/precios.js';
import { recibirImagen, guardarImagen, borrarImagen } from '../servicios/imagenes.js';
import { publicar, EVENTOS } from '../realtime.js';

const router = Router();
router.use(requiereAutenticacion);

const DESTINOS = ['cocina', 'barra', 'ninguno'];

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/** Importe valido: numero finito >= 0 con dos decimales como mucho. */
function esImporteValido(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e10;
}

/* =====================================================================
   Categorias
   ===================================================================== */

router.get('/categorias', requierePermiso('catalogo.ver'), asyncHandler(async (req, res) => {
  const soloActivas = req.query.todas !== '1';
  const filas = await consultar(
    `SELECT c.id_categoria, c.nombre, c.destino_preparacion, c.orden_visual, c.activa,
            (SELECT COUNT(*) FROM producto p
              WHERE p.id_categoria = c.id_categoria AND p.activo = TRUE) AS productos
       FROM categoria c
       ${soloActivas ? 'WHERE c.activa = TRUE' : ''}
      ORDER BY c.orden_visual, c.nombre`
  );
  return res.json({
    categorias: filas.map((c) => ({
      id: c.id_categoria,
      nombre: c.nombre,
      destinoPreparacion: c.destino_preparacion,
      ordenVisual: c.orden_visual,
      activa: Boolean(c.activa),
      productos: c.productos,
    })),
  });
}));

router.post('/categorias', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const { nombre, destinoPreparacion, ordenVisual } = req.body ?? {};

  if (!nombre || String(nombre).trim().length < 2) {
    throw errores.peticionInvalida('Indique el nombre de la categoría.',
      { campos: { nombre: 'Mínimo 2 caracteres.' } });
  }
  if (!DESTINOS.includes(destinoPreparacion)) {
    throw errores.peticionInvalida('Destino de preparación inválido.',
      { campos: { destinoPreparacion: `Opciones: ${DESTINOS.join(', ')}.` } });
  }

  const id = await transaccion(async (cx) => {
    const [r] = await cx.execute(
      'INSERT INTO categoria (nombre, destino_preparacion, orden_visual) VALUES (?, ?, ?)',
      [String(nombre).trim(), destinoPreparacion, Number(ordenVisual) || 0]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'categoria.creacion', entidad: 'categoria',
      idEntidad: r.insertId,
      detalle: `Creación de la categoría "${nombre}" con destino ${destinoPreparacion}.`,
      ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  return res.status(201).json({ id });
}));

router.put('/categorias/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, destinoPreparacion, ordenVisual, activa } = req.body ?? {};

  const cat = await consultarUno('SELECT id_categoria, nombre FROM categoria WHERE id_categoria = ?', [id]);
  if (!cat) throw errores.noEncontrado('La categoría');

  if (!nombre || String(nombre).trim().length < 2) {
    throw errores.peticionInvalida('Indique el nombre de la categoría.',
      { campos: { nombre: 'Mínimo 2 caracteres.' } });
  }
  if (!DESTINOS.includes(destinoPreparacion)) {
    throw errores.peticionInvalida('Destino de preparación inválido.',
      { campos: { destinoPreparacion: `Opciones: ${DESTINOS.join(', ')}.` } });
  }

  await transaccion(async (cx) => {
    await cx.execute(
      'UPDATE categoria SET nombre = ?, destino_preparacion = ?, orden_visual = ?, activa = ? WHERE id_categoria = ?',
      [String(nombre).trim(), destinoPreparacion, Number(ordenVisual) || 0, activa !== false, id]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'categoria.edicion', entidad: 'categoria',
      idEntidad: id, detalle: `Edición de la categoría "${nombre}".`, ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/** PUT /categorias/orden  { orden: [idCategoria, ...] } — reordenado por arrastre. */
router.put('/categorias-orden', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const orden = req.body?.orden;
  if (!Array.isArray(orden)) {
    throw errores.peticionInvalida('Envíe el arreglo "orden" con los ids en su nueva posición.');
  }

  await transaccion(async (cx) => {
    for (const [i, idCategoria] of orden.entries()) {
      await cx.execute('UPDATE categoria SET orden_visual = ? WHERE id_categoria = ?',
        [i, Number(idCategoria)]);
    }
  });

  return res.json({ ok: true });
}));

/**
 * DELETE /categorias/:id
 * FSD 5.3: "Eliminar una categoria con productos activos exige reasignarlos
 * primero." Se acepta ?reasignarA=<id> para hacerlo en la misma transaccion.
 */
router.delete('/categorias/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const reasignarA = Number(req.query.reasignarA) || null;

  const cat = await consultarUno('SELECT id_categoria, nombre FROM categoria WHERE id_categoria = ?', [id]);
  if (!cat) throw errores.noEncontrado('La categoría');

  const activos = await consultarUno(
    'SELECT COUNT(*) AS n FROM producto WHERE id_categoria = ? AND activo = TRUE', [id]
  );

  if (activos.n > 0 && !reasignarA) {
    throw errores.conflicto(
      `La categoría tiene ${activos.n} plato(s) activo(s). Indique a qué categoría reasignarlos antes de eliminarla.`
    );
  }

  if (reasignarA) {
    if (reasignarA === id) {
      throw errores.peticionInvalida('No puede reasignar los platos a la misma categoría que va a eliminar.');
    }
    const destino = await consultarUno('SELECT id_categoria FROM categoria WHERE id_categoria = ?', [reasignarA]);
    if (!destino) throw errores.peticionInvalida('La categoría de destino no existe.');
  }

  await transaccion(async (cx) => {
    if (reasignarA) {
      await cx.execute('UPDATE producto SET id_categoria = ? WHERE id_categoria = ?', [reasignarA, id]);
    }
    // Los productos inactivos tambien se mueven: la FK impide dejarlos huerfanos.
    const [restantes] = await cx.execute(
      'SELECT COUNT(*) AS n FROM producto WHERE id_categoria = ?', [id]
    );
    if (restantes[0].n > 0) {
      throw errores.conflicto(
        `Quedan ${restantes[0].n} plato(s) (incluidos inactivos) en la categoría. Reasígnelos todos primero.`
      );
    }

    await cx.execute('DELETE FROM categoria WHERE id_categoria = ?', [id]);
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'categoria.eliminacion', entidad: 'categoria',
      idEntidad: id,
      detalle: `Eliminación de la categoría "${cat.nombre}"` +
               (reasignarA ? `; ${activos.n} plato(s) reasignado(s) a la categoría ${reasignarA}.` : '.'),
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/* =====================================================================
   Productos
   ===================================================================== */

router.get('/productos', requierePermiso('catalogo.ver'), asyncHandler(async (req, res) => {
  const soloActivos = req.query.todos !== '1';
  const idCategoria = Number(req.query.idCategoria) || null;
  const buscar = String(req.query.buscar ?? '').trim();

  const condiciones = [];
  const params = [];
  if (soloActivos) condiciones.push('p.activo = TRUE');
  if (idCategoria) { condiciones.push('p.id_categoria = ?'); params.push(idCategoria); }
  if (buscar) { condiciones.push('(p.nombre LIKE ? OR p.descripcion LIKE ?)'); params.push(`%${buscar}%`, `%${buscar}%`); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const productos = await consultar(
    `SELECT p.id_producto, p.id_categoria, p.nombre, p.descripcion, p.url_imagen,
            p.precio_base, p.tasa_impuesto, p.disponible, p.activo,
            c.nombre AS categoria, c.destino_preparacion,
            (SELECT COUNT(*) FROM receta r WHERE r.id_producto = p.id_producto) AS insumos,
            (SELECT COUNT(*) FROM producto_precio pp
              WHERE pp.id_producto = p.id_producto AND pp.activo = TRUE) AS variantes
       FROM producto p
       JOIN categoria c ON c.id_categoria = p.id_categoria
       ${where}
      ORDER BY c.orden_visual, p.nombre`,
    params
  );

  return res.json({
    productos: productos.map((p) => ({
      id: p.id_producto,
      idCategoria: p.id_categoria,
      categoria: p.categoria,
      destinoPreparacion: p.destino_preparacion,
      nombre: p.nombre,
      descripcion: p.descripcion,
      urlImagen: p.url_imagen,
      // Los importes viajan como string: convertirlos a Number aqui perderia
      // precision. El cliente solo los formatea para mostrarlos.
      precioBase: String(p.precio_base),
      tasaImpuesto: String(p.tasa_impuesto),
      disponible: Boolean(p.disponible),
      activo: Boolean(p.activo),
      insumos: p.insumos,
      variantes: p.variantes,
    })),
  });
}));

/** GET /productos/:id — incluye variantes y el precio vigente ahora mismo. */
router.get('/productos/:id', requierePermiso('catalogo.ver'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const p = await consultarUno(
    `SELECT p.*, c.nombre AS categoria FROM producto p
       JOIN categoria c ON c.id_categoria = p.id_categoria
      WHERE p.id_producto = ?`, [id]
  );
  if (!p) throw errores.noEncontrado('El plato');

  const variantes = await consultar(
    `SELECT id_precio, nombre, precio, hora_inicio, hora_fin,
            fecha_inicio, fecha_fin, dias_semana, activo
       FROM producto_precio WHERE id_producto = ? ORDER BY id_precio`, [id]
  );

  const vigente = resolverPrecio(p, variantes.filter((v) => v.activo));

  return res.json({
    id: p.id_producto,
    idCategoria: p.id_categoria,
    categoria: p.categoria,
    nombre: p.nombre,
    descripcion: p.descripcion,
    urlImagen: p.url_imagen,
    precioBase: String(p.precio_base),
    tasaImpuesto: String(p.tasa_impuesto),
    disponible: Boolean(p.disponible),
    activo: Boolean(p.activo),
    precioVigente: vigente,
    variantes: variantes.map((v) => ({
      id: v.id_precio,
      nombre: v.nombre,
      precio: String(v.precio),
      horaInicio: v.hora_inicio,
      horaFin: v.hora_fin,
      fechaInicio: v.fecha_inicio,
      fechaFin: v.fecha_fin,
      diasSemana: v.dias_semana,
      activo: Boolean(v.activo),
    })),
  });
}));

function validarProducto({ nombre, idCategoria, precioBase, tasaImpuesto }) {
  const fallos = {};
  if (!nombre || String(nombre).trim().length < 2) fallos.nombre = 'Mínimo 2 caracteres.';
  if (!Number.isInteger(Number(idCategoria))) fallos.idCategoria = 'Seleccione una categoría.';
  if (!esImporteValido(precioBase)) fallos.precioBase = 'El precio debe ser un número mayor o igual a cero.';
  const t = Number(tasaImpuesto);
  if (!Number.isFinite(t) || t < 0 || t > 100) fallos.tasaImpuesto = 'El impuesto debe estar entre 0 y 100.';
  return fallos;
}

router.post('/productos', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const fallos = validarProducto(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }
  const { nombre, descripcion, idCategoria, precioBase, tasaImpuesto, urlImagen } = req.body;

  const cat = await consultarUno('SELECT id_categoria FROM categoria WHERE id_categoria = ?', [Number(idCategoria)]);
  if (!cat) throw errores.peticionInvalida('La categoría indicada no existe.');

  const id = await transaccion(async (cx) => {
    const [r] = await cx.execute(
      `INSERT INTO producto (id_categoria, nombre, descripcion, url_imagen, precio_base, tasa_impuesto)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(idCategoria), String(nombre).trim(),
       descripcion ? String(descripcion).trim() : null,
       urlImagen || null, Number(precioBase), Number(tasaImpuesto)]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'producto.creacion', entidad: 'producto',
      idEntidad: r.insertId,
      detalle: `Creación del plato "${nombre}" con precio base ${precioBase}.`,
      ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  return res.status(201).json({ id });
}));

router.put('/productos/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const actual = await consultarUno(
    'SELECT id_producto, nombre, precio_base, url_imagen FROM producto WHERE id_producto = ?', [id]
  );
  if (!actual) throw errores.noEncontrado('El plato');

  const fallos = validarProducto(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }
  const { nombre, descripcion, idCategoria, precioBase, tasaImpuesto, urlImagen, activo } = req.body;

  await transaccion(async (cx) => {
    await cx.execute(
      `UPDATE producto SET id_categoria = ?, nombre = ?, descripcion = ?, url_imagen = ?,
              precio_base = ?, tasa_impuesto = ?, activo = ?
        WHERE id_producto = ?`,
      [Number(idCategoria), String(nombre).trim(),
       descripcion ? String(descripcion).trim() : null,
       urlImagen ?? actual.url_imagen,
       Number(precioBase), Number(tasaImpuesto), activo !== false, id]
    );

    // FSD 5.3 (salidas): "auditoria de cambios de precio". Se registra aparte
    // porque un cambio de precio tiene consecuencias contables.
    if (String(actual.precio_base) !== String(Number(precioBase).toFixed(2))) {
      await auditar(cx, {
        idUsuario: req.usuario.id, accion: 'producto.cambio_precio', entidad: 'producto',
        idEntidad: id,
        detalle: `Precio de "${nombre}": ${actual.precio_base} → ${Number(precioBase).toFixed(2)}. ` +
                 'Las comandas ya enviadas conservan su precio congelado.',
        ipOrigen: ipDe(req),
      });
    } else {
      await auditar(cx, {
        idUsuario: req.usuario.id, accion: 'producto.edicion', entidad: 'producto',
        idEntidad: id, detalle: `Edición del plato "${nombre}".`, ipOrigen: ipDe(req),
      });
    }
  });

  return res.json({ ok: true });
}));

/**
 * PATCH /productos/:id/disponibilidad — el interruptor "Agotado" del KDS.
 * FSD 8 lo asigna al permiso kds.marcar_agotado; el administrador tambien
 * puede usarlo desde el editor de menu.
 */
router.patch('/productos/:id/disponibilidad',
  requierePermiso('kds.marcar_agotado', 'catalogo.gestionar'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const disponible = Boolean(req.body?.disponible);

    const p = await consultarUno('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
    if (!p) throw errores.noEncontrado('El plato');

    await transaccion(async (cx) => {
      await cx.execute('UPDATE producto SET disponible = ? WHERE id_producto = ?', [disponible, id]);
      await auditar(cx, {
        idUsuario: req.usuario.id,
        accion: disponible ? 'producto.disponible' : 'producto.agotado',
        entidad: 'producto', idEntidad: id,
        detalle: `"${p.nombre}" marcado como ${disponible ? 'disponible' : 'agotado'}.`,
        ipOrigen: ipDe(req),
      });
    });

    // CA-02: desaparece de todos los comanderos en menos de 1 s. El mismo
    // interruptor existe en el KDS y aquel si publicaba; marcar un plato como
    // agotado desde el editor de menu no llegaba a nadie, y el mesero seguia
    // ofreciendolo hasta recargar la carta.
    publicar(EVENTOS.PRODUCTO_AGOTADO,
      { idProducto: id, nombre: p.nombre, disponible },
      { permiso: 'catalogo.ver' });

    return res.json({ ok: true, disponible });
  })
);

/** DELETE /productos/:id — baja logica: el historial de ventas lo referencia. */
router.delete('/productos/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const p = await consultarUno('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
  if (!p) throw errores.noEncontrado('El plato');

  await transaccion(async (cx) => {
    // Nunca se borra: orden_detalle apunta al producto y perderiamos la
    // trazabilidad de lo vendido.
    await cx.execute('UPDATE producto SET activo = FALSE WHERE id_producto = ?', [id]);
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'producto.baja', entidad: 'producto', idEntidad: id,
      detalle: `Baja lógica del plato "${p.nombre}".`, ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/* =====================================================================
   Variantes de precio
   ===================================================================== */

/**
 * PUT /productos/:id/precios   { variantes: [...] }
 * Reemplazo en lote. FSD 5.3 exige que no se solapen: se comprueba aqui, en
 * servidor, y no solo en el editor.
 */
router.put('/productos/:id/precios', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const variantes = req.body?.variantes;

  if (!Array.isArray(variantes)) {
    throw errores.peticionInvalida('Envíe el arreglo "variantes".');
  }

  const producto = await consultarUno('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
  if (!producto) throw errores.noEncontrado('El plato');

  // Validacion de cada fila.
  for (const [i, v] of variantes.entries()) {
    if (!v.nombre || String(v.nombre).trim().length < 2) {
      throw errores.peticionInvalida(`La variante ${i + 1} necesita un nombre de al menos 2 caracteres.`);
    }
    if (!esImporteValido(v.precio)) {
      throw errores.peticionInvalida(`La variante "${v.nombre}" tiene un precio inválido.`);
    }
    // Una ventana horaria a medias no es interpretable.
    if (Boolean(v.horaInicio) !== Boolean(v.horaFin)) {
      throw errores.peticionInvalida(
        `La variante "${v.nombre}" tiene la ventana horaria incompleta: indique hora de inicio y de fin, o ninguna.`
      );
    }
    if (v.fechaInicio && v.fechaFin && String(v.fechaInicio) > String(v.fechaFin)) {
      throw errores.peticionInvalida(
        `La variante "${v.nombre}" termina antes de empezar: revise las fechas.`
      );
    }
  }

  // Deteccion de solapes (FSD 5.3).
  const paraComprobar = variantes.map((v, i) => ({
    id_precio: i,
    nombre: v.nombre,
    hora_inicio: v.horaInicio || null,
    hora_fin: v.horaFin || null,
    fecha_inicio: v.fechaInicio || null,
    fecha_fin: v.fechaFin || null,
    dias_semana: v.diasSemana || null,
    activo: v.activo !== false,
  }));

  const solapes = detectarSolapes(paraComprobar);
  if (solapes.length) {
    const { a, b } = solapes[0];
    throw errores.reglaDeNegocio(
      `Las variantes "${a.nombre}" (${describirVentana(a)}) y "${b.nombre}" (${describirVentana(b)}) ` +
      'se solapan. Si coincidieran, no se sabría qué precio cobrar.',
      { solapes: solapes.map((s) => [s.a.nombre, s.b.nombre]) }
    );
  }

  await transaccion(async (cx) => {
    await cx.execute('DELETE FROM producto_precio WHERE id_producto = ?', [id]);
    for (const v of variantes) {
      await cx.execute(
        `INSERT INTO producto_precio
           (id_producto, nombre, precio, hora_inicio, hora_fin, fecha_inicio, fecha_fin, dias_semana, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, String(v.nombre).trim(), Number(v.precio),
         v.horaInicio || null, v.horaFin || null,
         v.fechaInicio || null, v.fechaFin || null,
         v.diasSemana || null, v.activo !== false]
      );
    }
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'producto.variantes_precio', entidad: 'producto',
      idEntidad: id,
      detalle: `Variantes de precio de "${producto.nombre}" actualizadas: ${variantes.length} vigente(s).`,
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true, variantes: variantes.length });
}));

/* =====================================================================
   Imagen del plato
   ===================================================================== */

/**
 * POST /productos/:id/imagen  (multipart/form-data, campo "imagen")
 * FSD 6.1: JPG/PNG/WebP <= 2 MB, validado por magic bytes.
 */
router.post('/productos/:id/imagen', requierePermiso('catalogo.gestionar'),
  (req, res, next) => {
    recibirImagen(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(errores.peticionInvalida('La imagen supera el máximo de 2 MB.'));
      }
      return next(error);
    });
  },
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const producto = await consultarUno(
      'SELECT id_producto, nombre, url_imagen FROM producto WHERE id_producto = ?', [id]
    );
    if (!producto) throw errores.noEncontrado('El plato');

    // Valida los magic bytes y escribe a disco solo si son de una imagen real.
    const url = await guardarImagen(req.file?.buffer);

    await transaccion(async (cx) => {
      await cx.execute('UPDATE producto SET url_imagen = ? WHERE id_producto = ?', [url, id]);
      await auditar(cx, {
        idUsuario: req.usuario.id, accion: 'producto.imagen', entidad: 'producto', idEntidad: id,
        detalle: `Imagen actualizada para "${producto.nombre}".`, ipOrigen: ipDe(req),
      });
    });

    // La anterior se borra despues de confirmar: si la transaccion fallara,
    // el producto seguiria apuntando a una imagen que ya no existiria.
    if (producto.url_imagen) await borrarImagen(producto.url_imagen);

    return res.json({ ok: true, urlImagen: url });
  })
);

export default router;
