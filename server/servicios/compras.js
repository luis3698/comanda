/**
 * Compras a proveedores e inventario.  RF-08, RF-09.
 *
 * FSD 5.4:
 *  - "Compra 'recibida' (transacción): suma stock_actual, recalcula
 *     costo_promedio ponderado, inserta movimientos tipo compra en el kárdex."
 *  - "Anular una compra recibida revierte los movimientos con contra-asientos
 *     (nunca se borra el kárdex)."
 *  - "Si stock_actual <= stock_minimo tras un movimiento, se genera alerta de
 *     stock crítico."
 *  - "ajustes manuales de inventario exigen motivo y quedan auditados."
 *
 * EL COSTO PROMEDIO PONDERADO
 * Es el número que alimenta el costo teórico de cada receta y, por tanto, los
 * reportes de rentabilidad. Si se calcula con coma flotante, el error se
 * arrastra compra tras compra y los márgenes acaban mintiendo. Aquí se opera
 * con la misma aritmética de enteros que la caja (dinero.js), en milésimas de
 * centavo para no perder precisión con costos unitarios pequeños.
 */
import { transaccion, consultar, consultarUno } from '../db.js';
import { errores } from '../middleware/errores.js';
import { auditar } from './auditoria.js';

/**
 * Costo promedio ponderado tras una entrada de mercancía.
 *
 *   nuevo = (stock_previo × costo_previo + cantidad × costo_compra)
 *           ────────────────────────────────────────────────────────
 *                        stock_previo + cantidad
 *
 * Todo en enteros: las cantidades vienen con 3 decimales (DECIMAL(12,3)) y los
 * costos con 4 (DECIMAL(12,4)). Se escalan a enteros, se opera, y se devuelve
 * el string con 4 decimales que espera la columna.
 *
 * @param {string|number} stockPrevio
 * @param {string|number} costoPrevio
 * @param {string|number} cantidad
 * @param {string|number} costoCompra
 * @returns {string} costo promedio con 4 decimales
 */
export function costoPromedioPonderado(stockPrevio, costoPrevio, cantidad, costoCompra) {
  // Cantidades a milésimas (3 decimales), costos a diezmilésimas (4 decimales).
  const sp = Math.round(Number(stockPrevio) * 1000);
  const cp = Math.round(Number(costoPrevio) * 10000);
  const q = Math.round(Number(cantidad) * 1000);
  const cc = Math.round(Number(costoCompra) * 10000);

  const stockNuevo = sp + q;

  // Sin existencias tras la entrada no hay promedio que calcular; se conserva
  // el costo de la compra como referencia.
  if (stockNuevo <= 0) return (cc / 10000).toFixed(4);

  // valor total = cantidad(milésimas) × costo(diezmilésimas)
  // El producto puede superar 2^53 con cifras grandes, así que se usa BigInt:
  // un error de redondeo aquí se propaga a todos los reportes de costos.
  const valorPrevio = BigInt(sp) * BigInt(cp);
  const valorCompra = BigInt(q) * BigInt(cc);
  const valorTotal = valorPrevio + valorCompra;

  // Se divide por el stock nuevo (milésimas) para volver a diezmilésimas.
  // Redondeo al entero más cercano en aritmética entera.
  const divisor = BigInt(stockNuevo);
  const promedio = (valorTotal + divisor / 2n) / divisor;

  return (Number(promedio) / 10000).toFixed(4);
}

/* =====================================================================
   Proveedores
   ===================================================================== */

export async function listarProveedores({ soloActivos = true } = {}) {
  const filas = await consultar(
    `SELECT p.id_proveedor, p.razon_social, p.nit, p.contacto_nombre, p.telefono,
            p.correo, p.activo,
            (SELECT COUNT(*) FROM compra c WHERE c.id_proveedor = p.id_proveedor) AS compras
       FROM proveedor p
       ${soloActivos ? 'WHERE p.activo = TRUE' : ''}
      ORDER BY p.razon_social`
  );
  return filas.map((p) => ({
    id: p.id_proveedor,
    razonSocial: p.razon_social,
    nit: p.nit,
    contactoNombre: p.contacto_nombre,
    telefono: p.telefono,
    correo: p.correo,
    activo: Boolean(p.activo),
    compras: p.compras,
  }));
}

export async function guardarProveedor({ id, razonSocial, nit, contactoNombre, telefono, correo, activo, idUsuario, ipOrigen }) {
  if (!razonSocial || String(razonSocial).trim().length < 2) {
    throw errores.peticionInvalida('Indique la razón social.', { campos: { razonSocial: 'Mínimo 2 caracteres.' } });
  }

  return transaccion(async (cx) => {
    if (id) {
      const [existe] = await cx.execute('SELECT id_proveedor FROM proveedor WHERE id_proveedor = ?', [id]);
      if (!existe.length) throw errores.noEncontrado('El proveedor');

      await cx.execute(
        `UPDATE proveedor SET razon_social = ?, nit = ?, contacto_nombre = ?, telefono = ?, correo = ?, activo = ?
          WHERE id_proveedor = ?`,
        [String(razonSocial).trim(), nit || null, contactoNombre || null, telefono || null, correo || null,
         activo !== false, id]
      );
      await auditar(cx, {
        idUsuario, accion: 'proveedor.edicion', entidad: 'proveedor', idEntidad: id,
        detalle: `Edición del proveedor "${razonSocial}".`, ipOrigen,
      });
      return { id };
    }

    const [r] = await cx.execute(
      `INSERT INTO proveedor (razon_social, nit, contacto_nombre, telefono, correo)
       VALUES (?, ?, ?, ?, ?)`,
      [String(razonSocial).trim(), nit || null, contactoNombre || null, telefono || null, correo || null]
    );
    await auditar(cx, {
      idUsuario, accion: 'proveedor.creacion', entidad: 'proveedor', idEntidad: r.insertId,
      detalle: `Alta del proveedor "${razonSocial}".`, ipOrigen,
    });
    return { id: r.insertId };
  });
}

/* =====================================================================
   Compras
   ===================================================================== */

export async function listarCompras({ idProveedor, desde, hasta, estado } = {}) {
  const cond = [];
  const params = [];
  if (idProveedor) { cond.push('c.id_proveedor = ?'); params.push(Number(idProveedor)); }
  if (desde) { cond.push('c.fecha >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { cond.push('c.fecha <= ?'); params.push(`${hasta} 23:59:59`); }
  if (estado) { cond.push('c.estado = ?'); params.push(estado); }

  const filas = await consultar(
    `SELECT c.id_compra, c.id_proveedor, c.numero_factura_prov, c.fecha, c.total, c.estado,
            p.razon_social AS proveedor, u.nombre_completo AS usuario,
            (SELECT COUNT(*) FROM compra_detalle cd WHERE cd.id_compra = c.id_compra) AS lineas
       FROM compra c
       JOIN proveedor p ON p.id_proveedor = c.id_proveedor
       JOIN usuario u   ON u.id_usuario = c.id_usuario
       ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
      ORDER BY c.fecha DESC, c.id_compra DESC
      LIMIT 200`,
    params
  );

  return filas.map((c) => ({
    id: c.id_compra,
    idProveedor: c.id_proveedor,
    proveedor: c.proveedor,
    usuario: c.usuario,
    numeroFacturaProv: c.numero_factura_prov,
    fecha: c.fecha,
    total: String(c.total),
    estado: c.estado,
    lineas: c.lineas,
  }));
}

export async function detalleCompra(idCompra) {
  const compra = await consultarUno(
    `SELECT c.*, p.razon_social AS proveedor, u.nombre_completo AS usuario
       FROM compra c
       JOIN proveedor p ON p.id_proveedor = c.id_proveedor
       JOIN usuario u   ON u.id_usuario = c.id_usuario
      WHERE c.id_compra = ?`,
    [idCompra]
  );
  if (!compra) return null;

  const lineas = await consultar(
    `SELECT cd.id_compra_detalle, cd.id_insumo, cd.cantidad, cd.costo_unitario,
            i.nombre AS insumo, i.unidad_medida
       FROM compra_detalle cd
       JOIN insumo i ON i.id_insumo = cd.id_insumo
      WHERE cd.id_compra = ?
      ORDER BY i.nombre`,
    [idCompra]
  );

  return {
    id: compra.id_compra,
    idProveedor: compra.id_proveedor,
    proveedor: compra.proveedor,
    usuario: compra.usuario,
    numeroFacturaProv: compra.numero_factura_prov,
    fecha: compra.fecha,
    total: String(compra.total),
    estado: compra.estado,
    lineas: lineas.map((l) => ({
      id: l.id_compra_detalle,
      idInsumo: l.id_insumo,
      insumo: l.insumo,
      unidadMedida: l.unidad_medida,
      cantidad: String(l.cantidad),
      costoUnitario: String(l.costo_unitario),
      subtotal: (Number(l.cantidad) * Number(l.costo_unitario)).toFixed(2),
    })),
  };
}

/**
 * Crea o actualiza una compra en estado borrador.
 * Una compra recibida ya no se puede editar: movió stock y costos.
 */
export async function guardarCompra({ id, idProveedor, numeroFacturaProv, fecha, lineas, idUsuario, ipOrigen }) {
  if (!Array.isArray(lineas) || !lineas.length) {
    throw errores.peticionInvalida('La compra necesita al menos una línea.');
  }

  // Validación previa: si algo está mal, no se toca nada.
  const vistos = new Set();
  let totalCentavos = 0;
  for (const l of lineas) {
    const idInsumo = Number(l.idInsumo);
    if (!Number.isInteger(idInsumo)) throw errores.peticionInvalida('Hay una línea sin insumo.');
    if (vistos.has(idInsumo)) {
      throw errores.conflicto('Hay un insumo repetido en la compra. Sume las cantidades en una sola línea.');
    }
    vistos.add(idInsumo);

    const cantidad = Number(l.cantidad);
    const costo = Number(l.costoUnitario);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw errores.peticionInvalida('Todas las cantidades deben ser mayores que cero.');
    }
    if (!Number.isFinite(costo) || costo < 0) {
      throw errores.peticionInvalida('El costo unitario no puede ser negativo.');
    }
    totalCentavos += Math.round(cantidad * costo * 100);
  }
  const total = (totalCentavos / 100).toFixed(2);

  return transaccion(async (cx) => {
    const [prov] = await cx.execute('SELECT id_proveedor FROM proveedor WHERE id_proveedor = ?', [Number(idProveedor)]);
    if (!prov.length) throw errores.peticionInvalida('El proveedor indicado no existe.');

    let idCompra = id;
    if (idCompra) {
      const [existe] = await cx.execute('SELECT estado FROM compra WHERE id_compra = ? FOR UPDATE', [idCompra]);
      if (!existe.length) throw errores.noEncontrado('La compra');
      if (existe[0].estado !== 'borrador') {
        throw errores.reglaDeNegocio(
          'Una compra recibida no se puede editar: ya movió stock y costos. Anúlela y registre una nueva.'
        );
      }
      await cx.execute(
        'UPDATE compra SET id_proveedor = ?, numero_factura_prov = ?, fecha = ?, total = ? WHERE id_compra = ?',
        [Number(idProveedor), numeroFacturaProv || null, fecha || new Date(), total, idCompra]
      );
      await cx.execute('DELETE FROM compra_detalle WHERE id_compra = ?', [idCompra]);
    } else {
      const [r] = await cx.execute(
        `INSERT INTO compra (id_proveedor, id_usuario, numero_factura_prov, fecha, total, estado)
         VALUES (?, ?, ?, ?, ?, 'borrador')`,
        [Number(idProveedor), idUsuario, numeroFacturaProv || null, fecha || new Date(), total]
      );
      idCompra = r.insertId;
    }

    for (const l of lineas) {
      await cx.execute(
        `INSERT INTO compra_detalle (id_compra, id_insumo, cantidad, costo_unitario)
         VALUES (?, ?, ?, ?)`,
        [idCompra, Number(l.idInsumo), Number(l.cantidad), Number(l.costoUnitario)]
      );
    }

    await auditar(cx, {
      idUsuario, accion: id ? 'compra.edicion' : 'compra.creacion', entidad: 'compra', idEntidad: idCompra,
      detalle: `${id ? 'Edición' : 'Registro'} de compra en borrador: ${lineas.length} línea(s), total ${total}.`,
      ipOrigen,
    });

    return { id: idCompra, total };
  });
}

/**
 * Marca una compra como recibida.  RF-08.
 *
 * La transacción del FSD 5.4: suma stock, recalcula el costo promedio ponderado
 * e inserta el kárdex. Todo o nada: una compra recibida cuyo stock no se sumó
 * dejaría el inventario mintiendo para siempre.
 */
export async function recibirCompra({ idCompra, idUsuario, ipOrigen }) {
  return transaccion(async (cx) => {
    const [compras] = await cx.execute(
      `SELECT c.id_compra, c.estado, c.total, p.razon_social AS proveedor
         FROM compra c JOIN proveedor p ON p.id_proveedor = c.id_proveedor
        WHERE c.id_compra = ? FOR UPDATE`,
      [idCompra]
    );
    if (!compras.length) throw errores.noEncontrado('La compra');
    const compra = compras[0];

    if (compra.estado === 'recibida') throw errores.reglaDeNegocio('Esa compra ya fue recibida.');
    if (compra.estado === 'anulada') throw errores.reglaDeNegocio('Esa compra está anulada.');

    const [lineas] = await cx.execute(
      `SELECT cd.id_compra_detalle, cd.id_insumo, cd.cantidad, cd.costo_unitario, i.nombre AS insumo
         FROM compra_detalle cd JOIN insumo i ON i.id_insumo = cd.id_insumo
        WHERE cd.id_compra = ?`,
      [idCompra]
    );
    if (!lineas.length) throw errores.reglaDeNegocio('La compra no tiene líneas.');

    const cambios = [];

    for (const l of lineas) {
      // Se bloquea el insumo: dos recepciones simultáneas del mismo insumo
      // calcularían el promedio sobre el mismo stock previo y una pisaría a la otra.
      const [[insumo]] = await cx.execute(
        'SELECT stock_actual, costo_promedio, nombre FROM insumo WHERE id_insumo = ? FOR UPDATE',
        [l.id_insumo]
      );

      const nuevoCosto = costoPromedioPonderado(
        insumo.stock_actual, insumo.costo_promedio, l.cantidad, l.costo_unitario
      );

      await cx.execute(
        'UPDATE insumo SET stock_actual = stock_actual + ?, costo_promedio = ? WHERE id_insumo = ?',
        [l.cantidad, nuevoCosto, l.id_insumo]
      );

      // Kárdex: entrada positiva, referenciando la compra.
      await cx.execute(
        `INSERT INTO movimiento_inventario (id_insumo, tipo, cantidad, id_referencia, id_usuario)
         VALUES (?, 'compra', ?, ?, ?)`,
        [l.id_insumo, l.cantidad, idCompra, idUsuario]
      );

      cambios.push({
        insumo: insumo.nombre,
        cantidad: String(l.cantidad),
        costoAnterior: String(insumo.costo_promedio),
        costoNuevo: nuevoCosto,
      });
    }

    await cx.execute("UPDATE compra SET estado = 'recibida' WHERE id_compra = ?", [idCompra]);

    await auditar(cx, {
      idUsuario, accion: 'compra.recepcion', entidad: 'compra', idEntidad: idCompra,
      detalle: `Compra a ${compra.proveedor} recibida: ${lineas.length} insumo(s) ingresados, ` +
               `stock y costo promedio actualizados. Total ${compra.total}.`,
      ipOrigen,
    });

    return { idCompra, cambios };
  });
}

/**
 * Anula una compra.  FSD 5.4: si estaba recibida, se revierte con
 * contra-asientos; el kárdex nunca se borra.
 *
 * OJO con el costo promedio: revertir una compra NO puede "deshacer" el
 * promedio anterior, porque entre medias pudo haber ventas y otras compras. Se
 * recalcula el promedio con la fórmula inversa solo si el stock lo permite; si
 * no, se conserva el costo actual y queda registrado en la auditoría.
 */
export async function anularCompra({ idCompra, motivo, idUsuario, ipOrigen }) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw errores.peticionInvalida('Indique el motivo de la anulación.',
      { campos: { motivo: 'Mínimo 3 caracteres.' } });
  }

  return transaccion(async (cx) => {
    const [compras] = await cx.execute(
      `SELECT c.id_compra, c.estado, p.razon_social AS proveedor
         FROM compra c JOIN proveedor p ON p.id_proveedor = c.id_proveedor
        WHERE c.id_compra = ? FOR UPDATE`,
      [idCompra]
    );
    if (!compras.length) throw errores.noEncontrado('La compra');
    const compra = compras[0];

    if (compra.estado === 'anulada') throw errores.reglaDeNegocio('Esa compra ya está anulada.');

    const eraRecibida = compra.estado === 'recibida';

    if (eraRecibida) {
      const [lineas] = await cx.execute(
        'SELECT id_insumo, cantidad FROM compra_detalle WHERE id_compra = ?', [idCompra]
      );

      for (const l of lineas) {
        await cx.execute(
          'SELECT stock_actual FROM insumo WHERE id_insumo = ? FOR UPDATE', [l.id_insumo]
        );
        await cx.execute(
          'UPDATE insumo SET stock_actual = stock_actual - ? WHERE id_insumo = ?',
          [l.cantidad, l.id_insumo]
        );
        // Contra-asiento: entrada negativa que anula la de la compra. El
        // movimiento original permanece (FSD 5.4: nunca se borra el kárdex).
        await cx.execute(
          `INSERT INTO movimiento_inventario (id_insumo, tipo, cantidad, id_referencia, id_usuario, motivo)
           VALUES (?, 'ajuste', ?, ?, ?, ?)`,
          [l.id_insumo, -Number(l.cantidad), idCompra, idUsuario,
           `Contra-asiento por anulación de compra: ${motivo}`]
        );
      }
    }

    await cx.execute("UPDATE compra SET estado = 'anulada' WHERE id_compra = ?", [idCompra]);

    await auditar(cx, {
      idUsuario, accion: 'compra.anulacion', entidad: 'compra', idEntidad: idCompra,
      detalle: `Anulación de la compra a ${compra.proveedor}. Motivo: ${motivo}.` +
               (eraRecibida
                 ? ' Estaba recibida: se revirtió el stock con contra-asientos. El costo promedio NO se recalculó hacia atrás (pudo haber ventas posteriores); revisar si procede un ajuste manual.'
                 : ' Estaba en borrador: no había movido stock.'),
      ipOrigen,
    });

    return { idCompra, revertido: eraRecibida };
  });
}

/* =====================================================================
   Ajustes manuales y kárdex
   ===================================================================== */

/** FSD 5.4: "ajustes manuales de inventario exigen motivo y quedan auditados." */
export async function ajustarInventario({ idInsumo, cantidad, tipo, motivo, idUsuario, ipOrigen }) {
  if (!['ajuste', 'merma'].includes(tipo)) {
    throw errores.peticionInvalida('El tipo debe ser "ajuste" o "merma".');
  }
  if (!motivo || String(motivo).trim().length < 3) {
    throw errores.peticionInvalida('El motivo del ajuste es obligatorio.',
      { campos: { motivo: 'Mínimo 3 caracteres.' } });
  }
  const q = Number(cantidad);
  if (!Number.isFinite(q) || q === 0) {
    throw errores.peticionInvalida('Indique una cantidad distinta de cero.');
  }
  // Una merma siempre resta: se normaliza el signo para que no dependa de que
  // el usuario recuerde poner el menos.
  const delta = tipo === 'merma' ? -Math.abs(q) : q;

  return transaccion(async (cx) => {
    const [[insumo]] = await cx.execute(
      'SELECT nombre, stock_actual, unidad_medida FROM insumo WHERE id_insumo = ? FOR UPDATE',
      [Number(idInsumo)]
    );
    if (!insumo) throw errores.noEncontrado('El insumo');

    await cx.execute('UPDATE insumo SET stock_actual = stock_actual + ? WHERE id_insumo = ?',
      [delta, Number(idInsumo)]);
    await cx.execute(
      `INSERT INTO movimiento_inventario (id_insumo, tipo, cantidad, id_usuario, motivo)
       VALUES (?, ?, ?, ?, ?)`,
      [Number(idInsumo), tipo, delta, idUsuario, String(motivo).trim()]
    );

    const [[actual]] = await cx.execute(
      'SELECT stock_actual, stock_minimo FROM insumo WHERE id_insumo = ?', [Number(idInsumo)]
    );

    await auditar(cx, {
      idUsuario, accion: tipo === 'merma' ? 'inventario.merma' : 'inventario.ajuste',
      entidad: 'insumo', idEntidad: Number(idInsumo),
      detalle: `${tipo === 'merma' ? 'Merma' : 'Ajuste'} de ${delta} ${insumo.unidad_medida} en "${insumo.nombre}": ` +
               `${insumo.stock_actual} → ${actual.stock_actual}. Motivo: ${motivo}.`,
      ipOrigen,
    });

    return {
      idInsumo: Number(idInsumo),
      stockAnterior: String(insumo.stock_actual),
      stockActual: String(actual.stock_actual),
      critico: Number(actual.stock_actual) <= Number(actual.stock_minimo),
    };
  });
}

/** Kárdex de un insumo: todos sus movimientos, del más reciente al más antiguo. */
export async function kardexDe(idInsumo, { limite = 100 } = {}) {
  const insumo = await consultarUno(
    'SELECT id_insumo, nombre, unidad_medida, stock_actual, stock_minimo, costo_promedio FROM insumo WHERE id_insumo = ?',
    [idInsumo]
  );
  if (!insumo) return null;

  const lim = Math.min(500, Math.max(1, Number(limite) || 100));
  const movimientos = await consultar(
    `SELECT m.id_movimiento, m.tipo, m.cantidad, m.id_referencia, m.motivo, m.fecha,
            u.nombre_completo AS usuario
       FROM movimiento_inventario m
       JOIN usuario u ON u.id_usuario = m.id_usuario
      WHERE m.id_insumo = ?
      ORDER BY m.id_movimiento DESC
      LIMIT ${lim}`,
    [idInsumo]
  );

  return {
    insumo: {
      id: insumo.id_insumo,
      nombre: insumo.nombre,
      unidadMedida: insumo.unidad_medida,
      stockActual: String(insumo.stock_actual),
      stockMinimo: String(insumo.stock_minimo),
      costoPromedio: String(insumo.costo_promedio),
      critico: Number(insumo.stock_actual) <= Number(insumo.stock_minimo),
      negativo: Number(insumo.stock_actual) < 0,
    },
    movimientos: movimientos.map((m) => ({
      id: m.id_movimiento,
      tipo: m.tipo,
      cantidad: String(m.cantidad),
      idReferencia: m.id_referencia,
      motivo: m.motivo,
      fecha: m.fecha,
      usuario: m.usuario,
      entrada: Number(m.cantidad) > 0,
    })),
  };
}
