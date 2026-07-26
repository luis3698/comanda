/**
 * Modificadores y recetario.  RF-06, RF-07  ·  Vista 6.
 *
 * FSD 5.3:
 *  - "Grupos obligatorios: el comandero no permite agregar el plato sin
 *     cumplir seleccion_min."
 *  - "Receta: FK compuesta producto + insumo (PK evita duplicados);
 *     cantidad > 0."
 *  - Salidas: "costo teorico de receta y % de costo mostrados al administrador".
 *
 * FSD 4.1 vista 6: "alerta visual si el costo supera el 40 % del precio de venta".
 *
 * La receta es lo que conecta el catalogo con el inventario: al enviar una
 * comanda (fase 3) se descuenta receta.cantidad x cantidad vendida de cada
 * insumo, y eso es lo que verifica CA-03.
 */
import { Router } from 'express';
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';

const router = Router();
router.use(requiereAutenticacion);

/** FSD 4.1 vista 6: umbral a partir del cual se avisa del costo. */
const UMBRAL_COSTO = 0.40;

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/* =====================================================================
   Grupos de modificadores
   ===================================================================== */

router.get('/modificadores', requierePermiso('catalogo.ver'), asyncHandler(async (_req, res) => {
  const grupos = await consultar(
    `SELECT g.id_grupo_mod, g.nombre, g.obligatorio, g.seleccion_min, g.seleccion_max,
            (SELECT COUNT(*) FROM producto_grupo_modificador pgm
              WHERE pgm.id_grupo_mod = g.id_grupo_mod) AS productos
       FROM grupo_modificador g
      ORDER BY g.nombre`
  );

  const opciones = await consultar(
    `SELECT id_modificador, id_grupo_mod, nombre, precio_extra, activo
       FROM modificador ORDER BY id_modificador`
  );

  const asociaciones = await consultar(
    `SELECT pgm.id_grupo_mod, pgm.id_producto, p.nombre AS producto
       FROM producto_grupo_modificador pgm
       JOIN producto p ON p.id_producto = pgm.id_producto
      ORDER BY p.nombre`
  );

  return res.json({
    grupos: grupos.map((g) => ({
      id: g.id_grupo_mod,
      nombre: g.nombre,
      obligatorio: Boolean(g.obligatorio),
      seleccionMin: g.seleccion_min,
      seleccionMax: g.seleccion_max,
      productos: g.productos,
      opciones: opciones
        .filter((o) => o.id_grupo_mod === g.id_grupo_mod)
        .map((o) => ({
          id: o.id_modificador,
          nombre: o.nombre,
          precioExtra: String(o.precio_extra),
          activo: Boolean(o.activo),
        })),
      asociados: asociaciones
        .filter((a) => a.id_grupo_mod === g.id_grupo_mod)
        .map((a) => ({ id: a.id_producto, nombre: a.producto })),
    })),
  });
}));

/** Valida las reglas de seleccion de un grupo (FSD 2.4.3 y 5.3). */
function validarGrupo({ nombre, obligatorio, seleccionMin, seleccionMax }) {
  const fallos = {};
  if (!nombre || String(nombre).trim().length < 2) fallos.nombre = 'Mínimo 2 caracteres.';

  const min = Number(seleccionMin);
  const max = Number(seleccionMax);

  if (!Number.isInteger(min) || min < 0 || min > 20) fallos.seleccionMin = 'Entre 0 y 20.';
  if (!Number.isInteger(max) || max < 1 || max > 20) fallos.seleccionMax = 'Entre 1 y 20.';
  // El CHECK del esquema exige max >= min; se comprueba antes para dar un
  // mensaje entendible en vez de un error de base de datos.
  if (Number.isInteger(min) && Number.isInteger(max) && max < min) {
    fallos.seleccionMax = 'El máximo no puede ser menor que el mínimo.';
  }
  // Un grupo obligatorio con mínimo 0 no obliga a nada: es una contradicción
  // que dejaría al comandero sin saber qué exigir.
  if (obligatorio && min < 1) {
    fallos.seleccionMin = 'Un grupo obligatorio debe exigir al menos una opción.';
  }
  return fallos;
}

router.post('/modificadores', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const fallos = validarGrupo(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }
  const { nombre, obligatorio, seleccionMin, seleccionMax } = req.body;

  const id = await transaccion(async (cx) => {
    const [r] = await cx.execute(
      `INSERT INTO grupo_modificador (nombre, obligatorio, seleccion_min, seleccion_max)
       VALUES (?, ?, ?, ?)`,
      [String(nombre).trim(), Boolean(obligatorio), Number(seleccionMin), Number(seleccionMax)]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'modificador.grupo_creacion', entidad: 'grupo_modificador',
      idEntidad: r.insertId,
      detalle: `Grupo de modificadores "${nombre}" creado (${obligatorio ? 'obligatorio' : 'opcional'}, ${seleccionMin}-${seleccionMax}).`,
      ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  return res.status(201).json({ id });
}));

router.put('/modificadores/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const grupo = await consultarUno('SELECT id_grupo_mod FROM grupo_modificador WHERE id_grupo_mod = ?', [id]);
  if (!grupo) throw errores.noEncontrado('El grupo de modificadores');

  const fallos = validarGrupo(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }
  const { nombre, obligatorio, seleccionMin, seleccionMax } = req.body;

  await transaccion(async (cx) => {
    await cx.execute(
      `UPDATE grupo_modificador SET nombre = ?, obligatorio = ?, seleccion_min = ?, seleccion_max = ?
        WHERE id_grupo_mod = ?`,
      [String(nombre).trim(), Boolean(obligatorio), Number(seleccionMin), Number(seleccionMax), id]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'modificador.grupo_edicion', entidad: 'grupo_modificador',
      idEntidad: id, detalle: `Grupo "${nombre}" actualizado.`, ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

router.delete('/modificadores/:id', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const grupo = await consultarUno('SELECT id_grupo_mod, nombre FROM grupo_modificador WHERE id_grupo_mod = ?', [id]);
  if (!grupo) throw errores.noEncontrado('El grupo de modificadores');

  // Un modificador ya elegido en una comanda no se puede borrar:
  // orden_detalle_modificador lo referencia y perderiamos qué se pidió.
  const usados = await consultarUno(
    `SELECT COUNT(*) AS n FROM orden_detalle_modificador odm
       JOIN modificador m ON m.id_modificador = odm.id_modificador
      WHERE m.id_grupo_mod = ?`, [id]
  );
  if (usados.n > 0) {
    throw errores.conflicto(
      `Las opciones de este grupo se han usado en ${usados.n} línea(s) de comanda. ` +
      'No se puede eliminar sin perder el detalle de esas ventas; desactive las opciones en su lugar.'
    );
  }

  await transaccion(async (cx) => {
    // Las opciones y las asociaciones caen por ON DELETE CASCADE.
    await cx.execute('DELETE FROM grupo_modificador WHERE id_grupo_mod = ?', [id]);
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'modificador.grupo_eliminacion', entidad: 'grupo_modificador',
      idEntidad: id, detalle: `Grupo "${grupo.nombre}" eliminado.`, ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/** PUT /modificadores/:id/opciones  { opciones: [...] } — reemplazo en lote. */
router.put('/modificadores/:id/opciones', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const opciones = req.body?.opciones;

  if (!Array.isArray(opciones) || !opciones.length) {
    throw errores.peticionInvalida('Un grupo necesita al menos una opción.');
  }

  const grupo = await consultarUno(
    'SELECT id_grupo_mod, nombre, seleccion_max FROM grupo_modificador WHERE id_grupo_mod = ?', [id]
  );
  if (!grupo) throw errores.noEncontrado('El grupo de modificadores');

  for (const o of opciones) {
    if (!o.nombre || String(o.nombre).trim().length < 1) {
      throw errores.peticionInvalida('Todas las opciones necesitan un nombre.');
    }
    const precio = Number(o.precioExtra ?? 0);
    if (!Number.isFinite(precio) || precio < 0) {
      throw errores.peticionInvalida(`La opción "${o.nombre}" tiene un precio extra inválido.`);
    }
  }

  // Pedir más opciones de las que existen dejaría al comandero exigiendo algo
  // imposible de cumplir.
  if (grupo.seleccion_max > opciones.length) {
    throw errores.reglaDeNegocio(
      `El grupo permite elegir hasta ${grupo.seleccion_max} opciones pero solo tiene ${opciones.length}. ` +
      'Ajuste el máximo o añada más opciones.'
    );
  }

  await transaccion(async (cx) => {
    // Se conservan las opciones ya usadas en comandas: borrarlas rompería el
    // historial. Las que no vengan y no estén usadas, se eliminan.
    const [existentes] = await cx.execute(
      'SELECT id_modificador FROM modificador WHERE id_grupo_mod = ?', [id]
    );
    const idsEnviados = new Set(opciones.map((o) => Number(o.id)).filter(Boolean));

    for (const ex of existentes) {
      if (idsEnviados.has(ex.id_modificador)) continue;
      const [uso] = await cx.execute(
        'SELECT COUNT(*) AS n FROM orden_detalle_modificador WHERE id_modificador = ?',
        [ex.id_modificador]
      );
      if (uso[0].n > 0) {
        await cx.execute('UPDATE modificador SET activo = FALSE WHERE id_modificador = ?', [ex.id_modificador]);
      } else {
        await cx.execute('DELETE FROM modificador WHERE id_modificador = ?', [ex.id_modificador]);
      }
    }

    for (const o of opciones) {
      if (o.id && idsEnviados.has(Number(o.id))) {
        await cx.execute(
          'UPDATE modificador SET nombre = ?, precio_extra = ?, activo = TRUE WHERE id_modificador = ?',
          [String(o.nombre).trim(), Number(o.precioExtra ?? 0), Number(o.id)]
        );
      } else {
        await cx.execute(
          'INSERT INTO modificador (id_grupo_mod, nombre, precio_extra) VALUES (?, ?, ?)',
          [id, String(o.nombre).trim(), Number(o.precioExtra ?? 0)]
        );
      }
    }

    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'modificador.opciones', entidad: 'grupo_modificador',
      idEntidad: id,
      detalle: `Opciones del grupo "${grupo.nombre}" actualizadas: ${opciones.length} vigente(s).`,
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/** PUT /modificadores/:id/productos  { productos: [id, ...] } */
router.put('/modificadores/:id/productos', requierePermiso('catalogo.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const productos = req.body?.productos;

  if (!Array.isArray(productos)) {
    throw errores.peticionInvalida('Envíe el arreglo "productos" con los ids asociados.');
  }

  const grupo = await consultarUno('SELECT id_grupo_mod, nombre FROM grupo_modificador WHERE id_grupo_mod = ?', [id]);
  if (!grupo) throw errores.noEncontrado('El grupo de modificadores');

  const ids = [...new Set(productos.map(Number).filter(Number.isInteger))];

  await transaccion(async (cx) => {
    await cx.execute('DELETE FROM producto_grupo_modificador WHERE id_grupo_mod = ?', [id]);
    for (const idProducto of ids) {
      await cx.execute(
        'INSERT INTO producto_grupo_modificador (id_producto, id_grupo_mod) VALUES (?, ?)',
        [idProducto, id]
      );
    }
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'modificador.asociacion', entidad: 'grupo_modificador',
      idEntidad: id,
      detalle: `Grupo "${grupo.nombre}" asociado a ${ids.length} plato(s).`,
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true, productos: ids.length });
}));

/* =====================================================================
   Insumos
   ===================================================================== */

router.get('/insumos', requierePermiso('catalogo.ver', 'inventario.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT id_insumo, nombre, unidad_medida, stock_actual, stock_minimo, costo_promedio
       FROM insumo ORDER BY nombre`
  );
  return res.json({
    insumos: filas.map((i) => ({
      id: i.id_insumo,
      nombre: i.nombre,
      unidadMedida: i.unidad_medida,
      stockActual: String(i.stock_actual),
      stockMinimo: String(i.stock_minimo),
      costoPromedio: String(i.costo_promedio),
      // El FSD 5.4 permite stock negativo a proposito: se marca para conciliar,
      // no se bloquea la venta.
      bajoMinimo: Number(i.stock_actual) <= Number(i.stock_minimo),
    })),
  });
}));

/* =====================================================================
   Fichas tecnicas (recetas)
   ===================================================================== */

/**
 * GET /recetas/:idProducto
 * Devuelve la ficha con su costo teorico. El calculo es del servidor: el
 * cliente solo lo muestra.
 */
router.get('/recetas/:idProducto', requierePermiso('catalogo.ver'), asyncHandler(async (req, res) => {
  const id = Number(req.params.idProducto);

  const producto = await consultarUno(
    'SELECT id_producto, nombre, precio_base FROM producto WHERE id_producto = ?', [id]
  );
  if (!producto) throw errores.noEncontrado('El plato');

  const filas = await consultar(
    `SELECT r.id_insumo, r.cantidad, i.nombre, i.unidad_medida, i.costo_promedio
       FROM receta r JOIN insumo i ON i.id_insumo = r.id_insumo
      WHERE r.id_producto = ?
      ORDER BY i.nombre`,
    [id]
  );

  // Costo teorico = suma de cantidad x costo promedio de cada insumo.
  let costoTotal = 0;
  const lineas = filas.map((f) => {
    const costoLinea = Number(f.cantidad) * Number(f.costo_promedio);
    costoTotal += costoLinea;
    return {
      idInsumo: f.id_insumo,
      nombre: f.nombre,
      cantidad: String(f.cantidad),
      unidadMedida: f.unidad_medida,
      costoPromedio: String(f.costo_promedio),
      costoLinea: costoLinea.toFixed(2),
    };
  });

  const precio = Number(producto.precio_base);
  const porcentaje = precio > 0 ? costoTotal / precio : 0;

  return res.json({
    idProducto: id,
    producto: producto.nombre,
    precioBase: String(producto.precio_base),
    lineas,
    costoTotal: costoTotal.toFixed(2),
    porcentajeCosto: (porcentaje * 100).toFixed(1),
    // FSD 4.1 vista 6: alerta si el costo supera el 40 % del precio de venta.
    superaUmbral: porcentaje > UMBRAL_COSTO,
    umbralPorcentaje: UMBRAL_COSTO * 100,
    margen: (precio - costoTotal).toFixed(2),
  });
}));

/** PUT /recetas/:idProducto  { lineas: [{idInsumo, cantidad}] } */
router.put('/recetas/:idProducto', requierePermiso('catalogo.recetas.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.idProducto);
  const lineas = req.body?.lineas;

  if (!Array.isArray(lineas)) {
    throw errores.peticionInvalida('Envíe el arreglo "lineas" con los insumos de la ficha.');
  }

  const producto = await consultarUno('SELECT id_producto, nombre FROM producto WHERE id_producto = ?', [id]);
  if (!producto) throw errores.noEncontrado('El plato');

  const vistos = new Set();
  for (const l of lineas) {
    const idInsumo = Number(l.idInsumo);
    if (!Number.isInteger(idInsumo)) throw errores.peticionInvalida('Hay una línea sin insumo.');

    // La PK compuesta (producto, insumo) ya lo impediría, pero el mensaje de
    // la base sería incomprensible para el usuario.
    if (vistos.has(idInsumo)) {
      throw errores.conflicto('Hay un insumo repetido en la ficha. Sume las cantidades en una sola línea.');
    }
    vistos.add(idInsumo);

    const cantidad = Number(l.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw errores.peticionInvalida('Todas las cantidades deben ser mayores que cero.',
        { campos: { cantidad: 'Debe ser mayor que cero.' } });
    }
  }

  if (vistos.size) {
    const marcadores = [...vistos].map(() => '?').join(',');
    const existentes = await consultar(
      `SELECT id_insumo FROM insumo WHERE id_insumo IN (${marcadores})`, [...vistos]
    );
    if (existentes.length !== vistos.size) {
      throw errores.peticionInvalida('Uno o más insumos de la ficha no existen.');
    }
  }

  await transaccion(async (cx) => {
    await cx.execute('DELETE FROM receta WHERE id_producto = ?', [id]);
    for (const l of lineas) {
      await cx.execute(
        'INSERT INTO receta (id_producto, id_insumo, cantidad) VALUES (?, ?, ?)',
        [id, Number(l.idInsumo), Number(l.cantidad)]
      );
    }
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'receta.actualizacion', entidad: 'producto',
      idEntidad: id,
      detalle: `Ficha técnica de "${producto.nombre}" actualizada: ${lineas.length} insumo(s). ` +
               'Afecta al descuento de inventario de las próximas comandas.',
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true, lineas: lineas.length });
}));

export default router;
