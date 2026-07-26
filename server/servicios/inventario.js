/**
 * Movimientos de inventario (kardex).
 *
 * FSD 5.4:
 *  - "Descuento automatico: al enviarse una comanda, por cada linea se insertan
 *     movimientos tipo venta restando receta.cantidad x orden_detalle.cantidad
 *     de cada insumo, EN LA MISMA TRANSACCION de la comanda."
 *  - "Si stock_actual <= stock_minimo tras un movimiento, se genera alerta de
 *     stock critico en el dashboard."
 *  - "El stock puede quedar negativo (la operacion no se bloquea en servicio)
 *     pero se marca en rojo para conciliacion: la venta nunca debe detenerse
 *     por un dato de inventario desactualizado."
 *  - "Anular una compra recibida revierte los movimientos con contra-asientos
 *     (nunca se borra el kardex)."
 *
 * CA-03: "Al enviar una comanda, el stock de cada insumo disminuye exactamente
 * receta.cantidad x cantidad vendida."
 *
 * TODAS las funciones reciben `cx` (conexion de una transaccion en curso) y no
 * el pool: el descuento de inventario tiene que poder deshacerse junto con la
 * comanda si algo falla despues. Un kardex que registra consumo de una comanda
 * que no llego a existir descuadra el inventario para siempre.
 */

/**
 * Descuenta los insumos de una linea de comanda segun su ficha tecnica.
 *
 * @param {object} cx              Conexion de la transaccion.
 * @param {object} linea
 * @param {number} linea.idOrdenDetalle
 * @param {number} linea.idProducto
 * @param {number} linea.cantidad   Unidades vendidas.
 * @param {number} linea.idUsuario
 * @returns {Promise<Array>} insumos que quedaron en o por debajo del minimo.
 */
export async function descontarPorReceta(cx, { idOrdenDetalle, idProducto, cantidad, idUsuario }) {
  const [receta] = await cx.execute(
    `SELECT r.id_insumo, r.cantidad, i.nombre, i.stock_minimo
       FROM receta r JOIN insumo i ON i.id_insumo = r.id_insumo
      WHERE r.id_producto = ?`,
    [idProducto]
  );

  // Un plato sin ficha tecnica no descuenta nada. No es un error: puede ser
  // una bebida embotellada que se controla por unidades, o un plato aun sin
  // receta cargada. La venta no se detiene por eso (5.4).
  if (!receta.length) return [];

  const criticos = [];

  for (const insumo of receta) {
    // La cantidad total consumida es lo que verifica CA-03.
    // Se calcula en SQL, con DECIMAL, y no en JavaScript: multiplicar
    // 150.000 x 2 en coma flotante puede dar 300.00000000000006 y eso
    // acabaria corrompiendo el stock poco a poco, venta tras venta.
    await cx.execute(
      `UPDATE insumo
          SET stock_actual = stock_actual - (? * ?)
        WHERE id_insumo = ?`,
      [insumo.cantidad, cantidad, insumo.id_insumo]
    );

    // El kardex guarda el movimiento en negativo (salida).
    await cx.execute(
      `INSERT INTO movimiento_inventario
         (id_insumo, tipo, cantidad, id_referencia, id_usuario)
       VALUES (?, 'venta', -(? * ?), ?, ?)`,
      [insumo.id_insumo, insumo.cantidad, cantidad, idOrdenDetalle, idUsuario]
    );

    // Se relee el stock ya actualizado para decidir la alerta.
    const [[actual]] = await cx.execute(
      'SELECT stock_actual, stock_minimo, nombre FROM insumo WHERE id_insumo = ?',
      [insumo.id_insumo]
    );

    if (Number(actual.stock_actual) <= Number(actual.stock_minimo)) {
      criticos.push({
        idInsumo: insumo.id_insumo,
        nombre: actual.nombre,
        stockActual: String(actual.stock_actual),
        stockMinimo: String(actual.stock_minimo),
        // El stock negativo NO bloquea la venta (5.4), solo se marca para
        // conciliar: significa que el conteo fisico y el sistema divergieron.
        negativo: Number(actual.stock_actual) < 0,
      });
    }
  }

  return criticos;
}

/**
 * Devuelve al inventario lo consumido por una linea anulada.
 *
 * Contra-asiento, nunca un DELETE: el kardex es de solo insercion (5.4 y los
 * privilegios de db/04_privilegios.sql lo imponen en el motor). El rastro de
 * que se consumio y se devolvio es justo lo que permite auditar una anulacion.
 */
export async function revertirPorReceta(cx, { idOrdenDetalle, idProducto, cantidad, idUsuario, motivo }) {
  const [receta] = await cx.execute(
    'SELECT id_insumo, cantidad FROM receta WHERE id_producto = ?',
    [idProducto]
  );
  if (!receta.length) return;

  for (const insumo of receta) {
    await cx.execute(
      'UPDATE insumo SET stock_actual = stock_actual + (? * ?) WHERE id_insumo = ?',
      [insumo.cantidad, cantidad, insumo.id_insumo]
    );
    await cx.execute(
      `INSERT INTO movimiento_inventario
         (id_insumo, tipo, cantidad, id_referencia, id_usuario, motivo)
       VALUES (?, 'ajuste', (? * ?), ?, ?, ?)`,
      [insumo.id_insumo, insumo.cantidad, cantidad, idOrdenDetalle, idUsuario,
       motivo ?? 'Reverso por anulación de línea de comanda']
    );
  }
}

/**
 * Insumos en o por debajo de su minimo. Alimenta la alerta del dashboard
 * (RF-09) y el semaforo del kardex.
 */
export async function insumosCriticos(cx) {
  const [filas] = await cx.execute(
    `SELECT id_insumo, nombre, unidad_medida, stock_actual, stock_minimo
       FROM insumo
      WHERE stock_actual <= stock_minimo
      ORDER BY (stock_actual - stock_minimo) ASC`
  );
  return filas.map((f) => ({
    idInsumo: f.id_insumo,
    nombre: f.nombre,
    unidadMedida: f.unidad_medida,
    stockActual: String(f.stock_actual),
    stockMinimo: String(f.stock_minimo),
    negativo: Number(f.stock_actual) < 0,
  }));
}
