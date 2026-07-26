/**
 * Inteligencia de negocio: KPIs y reportes.  RF-21, RF-22.
 *
 * FSD 5.8:
 *  - "KPIs del dashboard calculados sobre datos vivos: ventas brutas/netas del
 *     día, ticket promedio (total facturado / nº facturas), ocupación (mesas
 *     ocupadas / mesas activas), platos estrella (top por unidades), alertas de
 *     stock."
 *  - "Reportes generados 100 % en servidor con consultas agregadas
 *     parametrizadas; exportación a PDF y Excel con los mismos totales que la
 *     vista previa."
 *
 * TODO SE AGREGA EN SQL, NO EN JAVASCRIPT
 * Sumar importes fila a fila en JS reintroduciría el error de coma flotante que
 * dinero.js evita en la caja. MySQL suma DECIMAL con precisión exacta, así que
 * los SUM() salen ya correctos y aquí solo se formatean como string.
 */
import { consultar, consultarUno } from '../db.js';
import { errores } from '../middleware/errores.js';

/** Rango de un día completo en formato DATETIME. */
function rangoDia(fecha) {
  const f = fecha ?? new Date().toISOString().slice(0, 10);
  return [`${f} 00:00:00`, `${f} 23:59:59`];
}

/**
 * Valida un rango de fechas.
 * FSD 4.1 vista 10: "validación de rango de fechas (inicio <= fin, máximo 12 meses)".
 */
export function validarRango(desde, hasta) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(desde ?? '')) || !re.test(String(hasta ?? ''))) {
    throw errores.peticionInvalida('Indique las fechas en formato AAAA-MM-DD.');
  }
  if (desde > hasta) {
    throw errores.peticionInvalida('La fecha inicial no puede ser posterior a la final.');
  }
  const dias = (new Date(hasta) - new Date(desde)) / 86400000;
  if (dias > 366) {
    throw errores.peticionInvalida('El rango no puede superar los 12 meses.');
  }
  return [`${desde} 00:00:00`, `${hasta} 23:59:59`];
}

/* =====================================================================
   Dashboard (RF-21)
   ===================================================================== */

export async function kpisDelDia(fecha) {
  const [inicio, fin] = rangoDia(fecha);

  // Ventas del día. "Bruto" incluye impuestos y propina; "neto" es la base
  // gravable tras descuentos: es lo que el negocio realmente ingresa por venta.
  const ventas = await consultarUno(
    `SELECT COUNT(*) AS facturas,
            COALESCE(SUM(total), 0)                        AS bruto,
            COALESCE(SUM(subtotal - descuento), 0)         AS neto,
            COALESCE(SUM(impuestos), 0)                    AS impuestos,
            COALESCE(SUM(propina), 0)                      AS propina,
            COALESCE(SUM(descuento), 0)                    AS descuentos
       FROM factura
      WHERE estado = 'emitida' AND emitida_en BETWEEN ? AND ?`,
    [inicio, fin]
  );

  // Ticket promedio = total facturado / nº facturas (FSD 5.8).
  // La división se hace en SQL para no convertir los DECIMAL a Number.
  const ticket = ventas.facturas > 0
    ? await consultarUno(
        `SELECT COALESCE(SUM(total),0) / COUNT(*) AS ticket
           FROM factura WHERE estado='emitida' AND emitida_en BETWEEN ? AND ?`,
        [inicio, fin]
      )
    : { ticket: 0 };

  // Ocupación = mesas ocupadas / mesas activas.
  const ocupacion = await consultarUno(
    `SELECT COUNT(*) AS activas,
            SUM(estado <> 'libre') AS ocupadas
       FROM mesa WHERE activa = TRUE`
  );
  const pctOcupacion = ocupacion.activas > 0
    ? ((Number(ocupacion.ocupadas) / Number(ocupacion.activas)) * 100).toFixed(1)
    : '0.0';

  // Ventas por hora, para la gráfica de líneas.
  const porHora = await consultar(
    `SELECT HOUR(emitida_en) AS hora, COUNT(*) AS facturas, COALESCE(SUM(total),0) AS total
       FROM factura
      WHERE estado = 'emitida' AND emitida_en BETWEEN ? AND ?
      GROUP BY HOUR(emitida_en)
      ORDER BY hora`,
    [inicio, fin]
  );

  // Top 10 platos por unidades (platos estrella).
  const topPlatos = await consultar(
    `SELECT p.id_producto, p.nombre,
            SUM(od.cantidad) AS unidades,
            COALESCE(SUM(od.cantidad * od.precio_unitario), 0) AS total
       FROM orden_detalle od
       JOIN producto p ON p.id_producto = od.id_producto
       JOIN orden o    ON o.id_orden = od.id_orden
       JOIN factura f  ON f.id_orden = o.id_orden AND f.estado = 'emitida'
      WHERE f.emitida_en BETWEEN ? AND ?
        AND od.estado_preparacion <> 'anulado'
      GROUP BY p.id_producto, p.nombre
      ORDER BY unidades DESC
      LIMIT 10`,
    [inicio, fin]
  );

  // Alertas de stock crítico (RF-09).
  const stockCritico = await consultar(
    `SELECT id_insumo, nombre, unidad_medida, stock_actual, stock_minimo
       FROM insumo
      WHERE stock_actual <= stock_minimo
      ORDER BY (stock_actual - stock_minimo) ASC
      LIMIT 20`
  );

  return {
    fecha: fecha ?? new Date().toISOString().slice(0, 10),
    ventas: {
      facturas: ventas.facturas,
      bruto: String(ventas.bruto),
      neto: String(ventas.neto),
      impuestos: String(ventas.impuestos),
      propina: String(ventas.propina),
      descuentos: String(ventas.descuentos),
      ticketPromedio: Number(ticket.ticket).toFixed(2),
    },
    ocupacion: {
      activas: Number(ocupacion.activas),
      ocupadas: Number(ocupacion.ocupadas ?? 0),
      porcentaje: pctOcupacion,
    },
    porHora: porHora.map((h) => ({ hora: h.hora, facturas: h.facturas, total: String(h.total) })),
    topPlatos: topPlatos.map((p) => ({
      id: p.id_producto, nombre: p.nombre,
      unidades: Number(p.unidades), total: String(p.total),
    })),
    stockCritico: stockCritico.map((i) => ({
      id: i.id_insumo, nombre: i.nombre, unidadMedida: i.unidad_medida,
      stockActual: String(i.stock_actual), stockMinimo: String(i.stock_minimo),
      negativo: Number(i.stock_actual) < 0,
    })),
  };
}

/* =====================================================================
   Reportes (RF-22)
   ===================================================================== */

/**
 * Catálogo de reportes disponibles (FSD 4.1 vista 10).
 * Cada uno declara sus columnas para que la vista previa y la exportación
 * usen exactamente la misma definición: si divergieran, el PDF mentiría
 * respecto a lo que el administrador vio en pantalla.
 */
export const REPORTES = {
  ventas_por_metodo: {
    titulo: 'Ventas por método de pago',
    columnas: [
      { clave: 'metodo', etiqueta: 'Método' },
      { clave: 'operaciones', etiqueta: 'Operaciones', tipo: 'entero' },
      { clave: 'total', etiqueta: 'Total', tipo: 'dinero' },
    ],
  },
  cierres_de_caja: {
    titulo: 'Cierres de caja',
    columnas: [
      { clave: 'turno', etiqueta: 'Turno' },
      { clave: 'cajero', etiqueta: 'Cajero' },
      { clave: 'abierto', etiqueta: 'Apertura' },
      { clave: 'cerrado', etiqueta: 'Cierre' },
      { clave: 'esperado', etiqueta: 'Esperado', tipo: 'dinero' },
      { clave: 'contado', etiqueta: 'Contado', tipo: 'dinero' },
      { clave: 'diferencia', etiqueta: 'Diferencia', tipo: 'dinero' },
    ],
  },
  rendimiento_personal: {
    titulo: 'Rendimiento del personal',
    columnas: [
      { clave: 'usuario', etiqueta: 'Empleado' },
      { clave: 'rol', etiqueta: 'Rol' },
      { clave: 'ordenes', etiqueta: 'Comandas', tipo: 'entero' },
      { clave: 'items', etiqueta: 'Ítems', tipo: 'entero' },
      { clave: 'total', etiqueta: 'Vendido', tipo: 'dinero' },
    ],
  },
  costos_produccion: {
    titulo: 'Costos de producción',
    columnas: [
      { clave: 'producto', etiqueta: 'Plato' },
      { clave: 'unidades', etiqueta: 'Vendidas', tipo: 'entero' },
      { clave: 'ingreso', etiqueta: 'Ingreso', tipo: 'dinero' },
      { clave: 'costo', etiqueta: 'Costo teórico', tipo: 'dinero' },
      { clave: 'margen', etiqueta: 'Margen', tipo: 'dinero' },
      { clave: 'pctCosto', etiqueta: '% costo' },
    ],
  },
  informe_fiscal: {
    titulo: 'Informe fiscal',
    columnas: [
      { clave: 'consecutivo', etiqueta: 'Factura' },
      { clave: 'fecha', etiqueta: 'Fecha' },
      { clave: 'subtotal', etiqueta: 'Base', tipo: 'dinero' },
      { clave: 'descuento', etiqueta: 'Descuento', tipo: 'dinero' },
      { clave: 'impuestos', etiqueta: 'Impuestos', tipo: 'dinero' },
      { clave: 'propina', etiqueta: 'Propina', tipo: 'dinero' },
      { clave: 'total', etiqueta: 'Total', tipo: 'dinero' },
    ],
  },
};

/**
 * Genera un reporte. Devuelve filas + totales, ya calculados en SQL.
 * La vista previa y la exportación consumen ESTA misma función: es la única
 * forma de garantizar que el archivo y la pantalla coincidan (FSD 5.8).
 */
export async function generarReporte(tipo, { desde, hasta, idCajero, idZona, idCategoria } = {}) {
  const def = REPORTES[tipo];
  if (!def) throw errores.noEncontrado('El reporte solicitado');

  const [inicio, fin] = validarRango(desde, hasta);

  let filas = [];
  let totales = {};

  switch (tipo) {
    case 'ventas_por_metodo': {
      const cond = ['f.estado = \'emitida\'', 'f.emitida_en BETWEEN ? AND ?'];
      const params = [inicio, fin];
      if (idCajero) { cond.push('t.id_cajero = ?'); params.push(Number(idCajero)); }

      const r = await consultar(
        `SELECT pg.metodo, COUNT(*) AS operaciones, SUM(pg.monto) AS total
           FROM pago pg
           JOIN factura f    ON f.id_factura = pg.id_factura
           JOIN turno_caja t ON t.id_turno = f.id_turno
          WHERE ${cond.join(' AND ')}
          GROUP BY pg.metodo
          ORDER BY total DESC`,
        params
      );
      const ETIQUETA = {
        efectivo: 'Efectivo', tarjeta_credito: 'Tarjeta de crédito',
        tarjeta_debito: 'Tarjeta de débito', transferencia: 'Transferencia', otro: 'Otro',
      };
      filas = r.map((x) => ({
        metodo: ETIQUETA[x.metodo] ?? x.metodo,
        operaciones: Number(x.operaciones),
        total: String(x.total),
      }));

      const t = await consultarUno(
        `SELECT COUNT(*) AS operaciones, COALESCE(SUM(pg.monto),0) AS total
           FROM pago pg JOIN factura f ON f.id_factura = pg.id_factura
           JOIN turno_caja t ON t.id_turno = f.id_turno
          WHERE ${cond.join(' AND ')}`,
        params
      );
      totales = { operaciones: Number(t.operaciones), total: String(t.total) };
      break;
    }

    case 'cierres_de_caja': {
      const cond = ['t.estado = \'cerrado\'', 't.cerrado_en BETWEEN ? AND ?'];
      const params = [inicio, fin];
      if (idCajero) { cond.push('t.id_cajero = ?'); params.push(Number(idCajero)); }

      const r = await consultar(
        `SELECT t.id_turno, u.nombre_completo AS cajero, t.abierto_en, t.cerrado_en,
                t.total_sistema, t.total_contado, t.diferencia, t.comentario_cierre
           FROM turno_caja t JOIN usuario u ON u.id_usuario = t.id_cajero
          WHERE ${cond.join(' AND ')}
          ORDER BY t.cerrado_en DESC`,
        params
      );
      filas = r.map((x) => ({
        turno: `#${x.id_turno}`,
        cajero: x.cajero,
        abierto: x.abierto_en,
        cerrado: x.cerrado_en,
        esperado: String(x.total_sistema ?? '0.00'),
        contado: String(x.total_contado ?? '0.00'),
        diferencia: String(x.diferencia ?? '0.00'),
        comentario: x.comentario_cierre,
      }));

      const t = await consultarUno(
        `SELECT COUNT(*) AS turnos, COALESCE(SUM(t.diferencia),0) AS diferencia
           FROM turno_caja t WHERE ${cond.join(' AND ')}`,
        params
      );
      totales = { turnos: Number(t.turnos), diferencia: String(t.diferencia) };
      break;
    }

    case 'rendimiento_personal': {
      const r = await consultar(
        `SELECT u.nombre_completo AS usuario, rl.nombre AS rol,
                COUNT(DISTINCT o.id_orden) AS ordenes,
                COALESCE(SUM(od.cantidad), 0) AS items,
                COALESCE(SUM(od.cantidad * od.precio_unitario), 0) AS total
           FROM orden o
           JOIN usuario u  ON u.id_usuario = o.id_mesero
           JOIN rol rl     ON rl.id_rol = u.id_rol
           JOIN orden_detalle od ON od.id_orden = o.id_orden AND od.estado_preparacion <> 'anulado'
           JOIN factura f  ON f.id_orden = o.id_orden AND f.estado = 'emitida'
          WHERE f.emitida_en BETWEEN ? AND ?
          GROUP BY u.id_usuario, u.nombre_completo, rl.nombre
          ORDER BY total DESC`,
        [inicio, fin]
      );
      filas = r.map((x) => ({
        usuario: x.usuario, rol: x.rol,
        ordenes: Number(x.ordenes), items: Number(x.items), total: String(x.total),
      }));
      totales = {
        ordenes: filas.reduce((s, f) => s + f.ordenes, 0),
        items: filas.reduce((s, f) => s + f.items, 0),
      };
      break;
    }

    case 'costos_produccion': {
      // El costo teórico sale de la receta × costo promedio de cada insumo.
      // La agregación es de SQL: sumar esto en JS perdería precisión.
      const cond = ['f.emitida_en BETWEEN ? AND ?', 'f.estado = \'emitida\'', 'od.estado_preparacion <> \'anulado\''];
      const params = [inicio, fin];
      if (idCategoria) { cond.push('p.id_categoria = ?'); params.push(Number(idCategoria)); }

      const r = await consultar(
        `SELECT p.id_producto, p.nombre AS producto,
                SUM(od.cantidad) AS unidades,
                COALESCE(SUM(od.cantidad * od.precio_unitario), 0) AS ingreso,
                COALESCE(SUM(od.cantidad * (
                  SELECT COALESCE(SUM(rc.cantidad * i.costo_promedio), 0)
                    FROM receta rc JOIN insumo i ON i.id_insumo = rc.id_insumo
                   WHERE rc.id_producto = p.id_producto
                )), 0) AS costo
           FROM orden_detalle od
           JOIN producto p ON p.id_producto = od.id_producto
           JOIN orden o    ON o.id_orden = od.id_orden
           JOIN factura f  ON f.id_orden = o.id_orden
          WHERE ${cond.join(' AND ')}
          GROUP BY p.id_producto, p.nombre
          ORDER BY ingreso DESC`,
        params
      );

      filas = r.map((x) => {
        const ingreso = Number(x.ingreso);
        const costo = Number(x.costo);
        return {
          producto: x.producto,
          unidades: Number(x.unidades),
          ingreso: ingreso.toFixed(2),
          costo: costo.toFixed(2),
          margen: (ingreso - costo).toFixed(2),
          pctCosto: ingreso > 0 ? `${((costo / ingreso) * 100).toFixed(1)} %` : '—',
        };
      });

      const sumaIngreso = filas.reduce((s, f) => s + Number(f.ingreso), 0);
      const sumaCosto = filas.reduce((s, f) => s + Number(f.costo), 0);
      totales = {
        ingreso: sumaIngreso.toFixed(2),
        costo: sumaCosto.toFixed(2),
        margen: (sumaIngreso - sumaCosto).toFixed(2),
      };
      break;
    }

    case 'informe_fiscal': {
      const r = await consultar(
        `SELECT f.consecutivo_fiscal, f.emitida_en, f.subtotal, f.descuento,
                f.impuestos, f.propina, f.total, f.estado
           FROM factura f
          WHERE f.emitida_en BETWEEN ? AND ?
          ORDER BY f.consecutivo_fiscal`,
        [inicio, fin]
      );
      filas = r.map((x) => ({
        consecutivo: x.consecutivo_fiscal,
        fecha: x.emitida_en,
        subtotal: String(x.subtotal),
        descuento: String(x.descuento),
        impuestos: String(x.impuestos),
        propina: String(x.propina),
        total: String(x.total),
        estado: x.estado,
      }));

      const t = await consultarUno(
        `SELECT COUNT(*) AS facturas,
                COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(descuento),0) AS descuento,
                COALESCE(SUM(impuestos),0) AS impuestos, COALESCE(SUM(propina),0) AS propina,
                COALESCE(SUM(total),0) AS total
           FROM factura
          WHERE emitida_en BETWEEN ? AND ? AND estado = 'emitida'`,
        [inicio, fin]
      );
      totales = {
        facturas: Number(t.facturas),
        subtotal: String(t.subtotal), descuento: String(t.descuento),
        impuestos: String(t.impuestos), propina: String(t.propina), total: String(t.total),
      };
      break;
    }
  }

  return {
    tipo,
    titulo: def.titulo,
    columnas: def.columnas,
    filas,
    totales,
    rango: { desde, hasta },
    generadoEn: new Date().toISOString(),
  };
}
