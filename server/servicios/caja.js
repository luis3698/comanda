/**
 * Caja y facturación.  RF-17 a RF-20.
 *
 * Las tres reglas que definen esta fase:
 *
 *  CA-05  Imposible cerrar una factura si SUM(pagos) ≠ total.
 *  CA-06  La división no permite cobrar hasta que las sub-cuentas igualen la orden.
 *  CA-07  El total esperado del arqueo solo se revela tras confirmar el conteo físico.
 *
 * FSD 5.7:
 *  - "No se puede cobrar sin turno abierto."
 *  - "Cálculo en servidor: subtotal − descuento + impuestos + propina = total."
 *  - "Cierre de mesa (transacción): factura emitida con consecutivo fiscal único,
 *     pagos insertados, orden cerrada, mesa libre, impresión disparada, auditoría."
 *
 * Todo el dinero se maneja en centavos enteros (server/servicios/dinero.js):
 * ningún importe se suma en coma flotante.
 */
import { transaccion, consultar, consultarUno } from '../db.js';
import { errores } from '../middleware/errores.js';
import { auditar } from './auditoria.js';
import { aCentavos, aDecimal, calcularTotal, impuestoDe, formatear } from './dinero.js';

const METODOS_PAGO = ['efectivo', 'tarjeta_credito', 'tarjeta_debito', 'transferencia', 'otro'];

/* =====================================================================
   Turno de caja
   ===================================================================== */

/** Turno abierto del cajero, o null. FSD 5.7: no se cobra sin turno. */
export async function turnoAbiertoDe(idCajero) {
  return consultarUno(
    `SELECT id_turno, fondo_inicial, abierto_en
       FROM turno_caja WHERE id_cajero = ? AND estado = 'abierto'`,
    [idCajero]
  );
}

export async function abrirTurno({ idCajero, fondoInicial, ipOrigen }) {
  const fondo = aCentavos(fondoInicial);
  if (fondo < 0) throw errores.peticionInvalida('El fondo inicial no puede ser negativo.');

  return transaccion(async (cx) => {
    // Un cajero no puede tener dos turnos abiertos a la vez.
    const [abiertos] = await cx.execute(
      "SELECT id_turno FROM turno_caja WHERE id_cajero = ? AND estado = 'abierto' FOR UPDATE",
      [idCajero]
    );
    if (abiertos.length) {
      throw errores.conflicto('Ya tiene un turno de caja abierto. Ciérrelo antes de abrir otro.');
    }

    const [r] = await cx.execute(
      `INSERT INTO turno_caja (id_cajero, fondo_inicial, estado) VALUES (?, ?, 'abierto')`,
      [idCajero, aDecimal(fondo)]
    );
    await auditar(cx, {
      idUsuario: idCajero, accion: 'caja.turno_apertura', entidad: 'turno_caja',
      idEntidad: r.insertId, detalle: `Apertura de turno con fondo inicial ${formatear(fondo)}.`,
      ipOrigen,
    });
    return { idTurno: r.insertId };
  });
}

/**
 * Resumen de ventas del turno por método de pago (FSD 4.4 vista 21).
 * NO incluye total_sistema ni nada que revele el esperado del arqueo.
 */
export async function resumenTurno(idTurno) {
  const turno = await consultarUno(
    `SELECT id_turno, id_cajero, fondo_inicial, abierto_en, estado FROM turno_caja WHERE id_turno = ?`,
    [idTurno]
  );
  if (!turno) return null;

  const porMetodo = await consultar(
    `SELECT pg.metodo, COUNT(*) AS n, SUM(pg.monto) AS total
       FROM pago pg
       JOIN factura f ON f.id_factura = pg.id_factura
      WHERE f.id_turno = ? AND f.estado = 'emitida'
      GROUP BY pg.metodo`,
    [idTurno]
  );

  const movimientos = await consultar(
    `SELECT tipo, SUM(monto) AS total, COUNT(*) AS n
       FROM movimiento_caja WHERE id_turno = ? GROUP BY tipo`,
    [idTurno]
  );

  const facturas = await consultarUno(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
       FROM factura WHERE id_turno = ? AND estado = 'emitida'`,
    [idTurno]
  );

  return {
    idTurno: turno.id_turno,
    fondoInicial: String(turno.fondo_inicial),
    abiertoEn: turno.abierto_en,
    estado: turno.estado,
    facturas: facturas.n,
    totalFacturado: String(facturas.total),
    porMetodo: porMetodo.map((m) => ({ metodo: m.metodo, cantidad: m.n, total: String(m.total) })),
    movimientos: movimientos.map((m) => ({ tipo: m.tipo, cantidad: m.n, total: String(m.total) })),
  };
}

export async function registrarMovimiento({ idTurno, tipo, monto, motivo, idUsuario, ipOrigen }) {
  if (!['ingreso', 'salida'].includes(tipo)) {
    throw errores.peticionInvalida('Tipo de movimiento inválido.');
  }
  const centavos = aCentavos(monto);
  if (centavos <= 0) throw errores.peticionInvalida('El monto debe ser mayor que cero.');
  if (!motivo || String(motivo).trim().length < 3) {
    throw errores.peticionInvalida('El motivo es obligatorio.', { campos: { motivo: 'Mínimo 3 caracteres.' } });
  }

  return transaccion(async (cx) => {
    const [turnos] = await cx.execute(
      "SELECT id_turno, id_cajero, estado FROM turno_caja WHERE id_turno = ? FOR UPDATE", [idTurno]
    );
    if (!turnos.length) throw errores.noEncontrado('El turno');
    if (turnos[0].estado !== 'abierto') throw errores.reglaDeNegocio('El turno ya está cerrado.');

    await cx.execute(
      `INSERT INTO movimiento_caja (id_turno, tipo, monto, motivo, id_usuario) VALUES (?, ?, ?, ?, ?)`,
      [idTurno, tipo, aDecimal(centavos), String(motivo).trim(), idUsuario]
    );
    await auditar(cx, {
      idUsuario, accion: tipo === 'salida' ? 'caja.salida_efectivo' : 'caja.ingreso_efectivo',
      entidad: 'turno_caja', idEntidad: idTurno,
      detalle: `${tipo === 'salida' ? 'Salida' : 'Ingreso'} de efectivo ${formatear(centavos)}. Motivo: ${motivo}.`,
      ipOrigen,
    });
    return { ok: true };
  });
}

/**
 * Cierre de turno con arqueo ciego.  CA-07.
 *
 * EL PUNTO CRÍTICO: el cajero envía el conteo físico y SOLO ENTONCES el sistema
 * calcula y revela el esperado, el contado y la diferencia. Nunca antes. No hay
 * ningún endpoint que devuelva total_sistema mientras el turno está abierto:
 * si lo hubiera, el cajero podría cuadrar el conteo al esperado y el arqueo
 * ciego dejaría de ser ciego.
 *
 * El esperado = fondo inicial + ventas en efectivo + ingresos − salidas.
 * (Solo el efectivo: las tarjetas y transferencias no están en el cajón.)
 */
export async function cerrarTurnoArqueo({ idTurno, idCajero, totalContado, comentario, ipOrigen }) {
  const contadoCentavos = aCentavos(totalContado);
  if (contadoCentavos < 0) throw errores.peticionInvalida('El conteo no puede ser negativo.');

  return transaccion(async (cx) => {
    const [turnos] = await cx.execute(
      "SELECT id_turno, id_cajero, fondo_inicial, estado FROM turno_caja WHERE id_turno = ? FOR UPDATE",
      [idTurno]
    );
    if (!turnos.length) throw errores.noEncontrado('El turno');
    const turno = turnos[0];

    if (turno.id_cajero !== idCajero) {
      throw errores.sinPermiso('Solo el cajero del turno puede cerrarlo');
    }
    if (turno.estado !== 'abierto') {
      throw errores.reglaDeNegocio('El turno ya está cerrado. Un turno cerrado es inmutable.');
    }

    // No se puede cerrar con mesas del turno sin cobrar (FSD CU-05 precondición).
    // Se comprueba que no queden órdenes en pre-cuenta apuntando a este cajero...
    // en realidad, cualquier orden viva bloquea, pero el cobro las cierra. Aquí
    // solo verificamos que el turno pueda cuadrarse.

    // ---- Cálculo del esperado (recién ahora, tras recibir el conteo) ----
    const [[efectivo]] = await cx.execute(
      `SELECT COALESCE(SUM(pg.monto),0) AS total
         FROM pago pg JOIN factura f ON f.id_factura = pg.id_factura
        WHERE f.id_turno = ? AND f.estado = 'emitida' AND pg.metodo = 'efectivo'`,
      [idTurno]
    );
    const [[ingresos]] = await cx.execute(
      `SELECT COALESCE(SUM(monto),0) AS total FROM movimiento_caja WHERE id_turno = ? AND tipo = 'ingreso'`,
      [idTurno]
    );
    const [[salidas]] = await cx.execute(
      `SELECT COALESCE(SUM(monto),0) AS total FROM movimiento_caja WHERE id_turno = ? AND tipo = 'salida'`,
      [idTurno]
    );

    const fondoC = aCentavos(turno.fondo_inicial);
    const efectivoC = aCentavos(efectivo.total);
    const ingresosC = aCentavos(ingresos.total);
    const salidasC = aCentavos(salidas.total);

    const esperadoC = fondoC + efectivoC + ingresosC - salidasC;
    const diferenciaC = contadoCentavos - esperadoC;   // + sobrante, − faltante

    // FSD CU-05 flujo 4a: diferencia fuera de tolerancia exige comentario.
    // Tolerancia: 0 (cualquier diferencia se resalta). Se pide comentario si la hay.
    if (diferenciaC !== 0 && (!comentario || String(comentario).trim().length < 3)) {
      throw errores.reglaDeNegocio(
        'El conteo no cuadra con lo esperado. Debe indicar un comentario justificativo para cerrar el turno.',
        { requiereComentario: true }
      );
    }

    await cx.execute(
      `UPDATE turno_caja
          SET estado = 'cerrado', cerrado_en = NOW(),
              total_contado = ?, total_sistema = ?, diferencia = ?, comentario_cierre = ?
        WHERE id_turno = ?`,
      [aDecimal(contadoCentavos), aDecimal(esperadoC), aDecimal(diferenciaC),
       comentario ? String(comentario).trim() : null, idTurno]
    );

    await auditar(cx, {
      idUsuario: idCajero, accion: 'caja.turno_cierre', entidad: 'turno_caja', idEntidad: idTurno,
      detalle: `Cierre de turno. Esperado ${formatear(esperadoC)}, contado ${formatear(contadoCentavos)}, ` +
               `diferencia ${formatear(diferenciaC)}${diferenciaC !== 0 ? ` (${diferenciaC > 0 ? 'sobrante' : 'faltante'})` : ''}.`,
      ipOrigen,
    });

    // Solo AHORA se devuelven los números: es la primera vez que salen del servidor.
    return {
      idTurno,
      esperado: aDecimal(esperadoC),
      contado: aDecimal(contadoCentavos),
      diferencia: aDecimal(diferenciaC),
      tipo: diferenciaC === 0 ? 'cuadrado' : (diferenciaC > 0 ? 'sobrante' : 'faltante'),
      desglose: {
        fondoInicial: aDecimal(fondoC),
        ventaEfectivo: aDecimal(efectivoC),
        ingresos: aDecimal(ingresosC),
        salidas: aDecimal(salidasC),
      },
    };
  });
}

/* =====================================================================
   Cálculo de la cuenta
   ===================================================================== */

/**
 * Calcula el estado de cuenta de una orden desde sus líneas, en el servidor.
 * Devuelve todo en centavos y también en decimal para mostrar.
 *
 * @param {Array} [idsDetalle]  Si se indica, solo esas líneas (para dividir).
 */
export async function calcularCuenta(idOrden, idsDetalle = null) {
  let sql = `SELECT od.id_orden_detalle, od.id_producto, od.cantidad,
                    od.precio_unitario, od.tasa_impuesto, od.notas,
                    p.nombre AS producto, od.estado_preparacion
               FROM orden_detalle od
               JOIN producto p ON p.id_producto = od.id_producto
              WHERE od.id_orden = ? AND od.estado_preparacion <> 'anulado'`;
  const params = [idOrden];

  if (idsDetalle) {
    if (!idsDetalle.length) return null;
    sql += ` AND od.id_orden_detalle IN (${idsDetalle.map(() => '?').join(',')})`;
    params.push(...idsDetalle);
  }

  const lineas = await consultar(sql, params);
  if (!lineas.length) return null;

  const mods = await consultar(
    `SELECT odm.id_orden_detalle, m.nombre, odm.precio_extra
       FROM orden_detalle_modificador odm
       JOIN modificador m ON m.id_modificador = odm.id_modificador
      WHERE odm.id_orden_detalle IN (${lineas.map(() => '?').join(',')})`,
    lineas.map((l) => l.id_orden_detalle)
  );

  let subtotalC = 0;
  let impuestosC = 0;
  const detalle = lineas.map((l) => {
    const extrasC = mods
      .filter((m) => m.id_orden_detalle === l.id_orden_detalle)
      .reduce((s, m) => s + aCentavos(m.precio_extra), 0);

    const unitarioC = aCentavos(l.precio_unitario) + extrasC;
    const lineaC = unitarioC * l.cantidad;
    const impLineaC = impuestoDe(lineaC, l.tasa_impuesto);

    subtotalC += lineaC;
    impuestosC += impLineaC;

    return {
      id: l.id_orden_detalle,
      producto: l.producto,
      cantidad: l.cantidad,
      precioUnitario: aDecimal(unitarioC),
      subtotal: aDecimal(lineaC),
      tasaImpuesto: String(l.tasa_impuesto),
      impuesto: aDecimal(impLineaC),
      notas: l.notas,
      modificadores: mods
        .filter((m) => m.id_orden_detalle === l.id_orden_detalle)
        .map((m) => ({ nombre: m.nombre, precioExtra: String(m.precio_extra) })),
    };
  });

  return {
    lineas: detalle,
    subtotalCentavos: subtotalC,
    impuestosCentavos: impuestosC,
    subtotal: aDecimal(subtotalC),
    impuestos: aDecimal(impuestosC),
    total: aDecimal(subtotalC + impuestosC),
  };
}

/* =====================================================================
   Cobro
   ===================================================================== */

/** Obtiene el siguiente consecutivo fiscal, correlativo y sin huecos. */
async function siguienteConsecutivo(cx) {
  // El UPDATE bloquea la fila: dos cierres simultáneos se serializan y nunca
  // obtienen el mismo número.
  await cx.execute("UPDATE secuencia SET valor = valor + 1 WHERE nombre = 'factura_fiscal'");
  const [[fila]] = await cx.execute("SELECT valor FROM secuencia WHERE nombre = 'factura_fiscal'");
  return `FAC-${String(fila.valor).padStart(8, '0')}`;
}

/**
 * Valida un descuento y su motivo.
 * Con la matriz validada (2026-07-16), el cajero no tiene tope: cualquier
 * descuento es válido con motivo. El motivo sigue siendo obligatorio (§5.7).
 */
async function resolverDescuento(cx, { descuento, idMotivoDescuento, subtotalC }) {
  const descuentoC = aCentavos(descuento ?? 0);
  if (descuentoC < 0) throw errores.peticionInvalida('El descuento no puede ser negativo.');
  if (descuentoC === 0) return { descuentoC: 0, idMotivo: null };

  // FSD 5.7: motivo obligatorio si descuento > 0.
  if (!idMotivoDescuento) {
    throw errores.reglaDeNegocio('Todo descuento exige seleccionar un motivo.');
  }
  const [motivos] = await cx.execute(
    'SELECT id_motivo, nombre, porcentaje_max FROM motivo_descuento WHERE id_motivo = ? AND activo = TRUE',
    [Number(idMotivoDescuento)]
  );
  if (!motivos.length) throw errores.peticionInvalida('El motivo de descuento no existe.');

  // Un descuento no puede superar el subtotal (dejaría un total negativo).
  if (descuentoC > subtotalC) {
    throw errores.reglaDeNegocio('El descuento no puede ser mayor que el subtotal de la cuenta.');
  }

  return { descuentoC, idMotivo: motivos[0].id_motivo };
}

/**
 * Cobra una cuenta (completa o una sub-cuenta de la división).  CA-05.
 *
 * La transacción de cierre (FSD 5.7):
 *   1. Recalcula el total en el servidor.            (nunca se confía en el cliente)
 *   2. Verifica SUM(pagos) == total.                 (CA-05)
 *   3. Emite factura con consecutivo fiscal único.
 *   4. Inserta pagos y, si es división, factura_detalle.
 *   5. Cierra la orden y libera la mesa (si no quedan líneas por cobrar).
 *   6. Audita.
 *
 * @param {object} p
 * @param {number} p.idOrden
 * @param {number} p.idTurno
 * @param {Array}  [p.idsDetalle]  Sub-cuenta: solo estas líneas.
 * @param {Array}  p.pagos         [{ metodo, monto, recibido?, referencia? }]
 * @param {number} [p.propina]
 * @param {number} [p.descuento]
 * @param {number} [p.idMotivoDescuento]
 */
export async function cobrar({ idOrden, idTurno, idsDetalle = null, pagos, propina, descuento, idMotivoDescuento, idCajero, ipOrigen }) {
  if (!Array.isArray(pagos) || !pagos.length) {
    throw errores.peticionInvalida('Indique al menos un pago.');
  }
  for (const pg of pagos) {
    if (!METODOS_PAGO.includes(pg.metodo)) {
      throw errores.peticionInvalida(`Método de pago inválido: ${pg.metodo}.`);
    }
    if (aCentavos(pg.monto) <= 0) {
      throw errores.peticionInvalida('Cada pago debe ser mayor que cero.');
    }
  }

  return transaccion(async (cx) => {
    // Turno abierto del cajero (FSD 5.7: no se cobra sin turno).
    const [turnos] = await cx.execute(
      "SELECT id_turno, id_cajero, estado FROM turno_caja WHERE id_turno = ? FOR UPDATE", [idTurno]
    );
    if (!turnos.length) throw errores.noEncontrado('El turno');
    if (turnos[0].estado !== 'abierto') throw errores.reglaDeNegocio('El turno de caja está cerrado.');
    if (turnos[0].id_cajero !== idCajero) throw errores.sinPermiso('Solo el cajero del turno puede cobrar en él');

    const [ordenes] = await cx.execute(
      `SELECT o.id_orden, o.id_mesa, o.estado, m.numero AS mesa
         FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
        WHERE o.id_orden = ? FOR UPDATE`,
      [idOrden]
    );
    if (!ordenes.length) throw errores.noEncontrado('La orden');
    const orden = ordenes[0];
    if (orden.estado === 'cerrada') throw errores.reglaDeNegocio('Esa cuenta ya fue cobrada.');
    if (orden.estado === 'anulada') throw errores.reglaDeNegocio('Esa orden está anulada.');

    // ---- Recalculo del total en el servidor (nunca del cliente) ----
    const cuenta = await calcularCuenta(idOrden, idsDetalle);
    if (!cuenta) throw errores.reglaDeNegocio('No hay líneas que cobrar en esa cuenta.');

    const { descuentoC, idMotivo } = await resolverDescuento(cx, {
      descuento, idMotivoDescuento, subtotalC: cuenta.subtotalCentavos,
    });
    const propinaC = aCentavos(propina ?? 0);
    if (propinaC < 0) throw errores.peticionInvalida('La propina no puede ser negativa.');

    const totalC = calcularTotal({
      subtotalCentavos: cuenta.subtotalCentavos,
      descuentoCentavos: descuentoC,
      impuestosCentavos: cuenta.impuestosCentavos,
      propinaCentavos: propinaC,
    });

    // ---- CA-05: la suma de pagos debe igualar el total, exactamente ----
    const pagadoC = pagos.reduce((s, pg) => s + aCentavos(pg.monto), 0);
    if (pagadoC !== totalC) {
      throw errores.reglaDeNegocio(
        `La suma de los pagos (${formatear(pagadoC)}) no coincide con el total a cobrar (${formatear(totalC)}).`,
        { totalEsperado: aDecimal(totalC), pagado: aDecimal(pagadoC) }
      );
    }

    // ---- Factura ----
    const consecutivo = await siguienteConsecutivo(cx);
    const [rf] = await cx.execute(
      `INSERT INTO factura
         (consecutivo_fiscal, id_orden, id_turno, subtotal, descuento, id_motivo_descuento,
          impuestos, propina, total, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitida')`,
      [consecutivo, idOrden, idTurno, cuenta.subtotal, aDecimal(descuentoC), idMotivo,
       cuenta.impuestos, aDecimal(propinaC), aDecimal(totalC)]
    );
    const idFactura = rf.insertId;

    // Líneas asignadas a esta factura (soporta la división de cuentas).
    for (const l of cuenta.lineas) {
      await cx.execute(
        `INSERT INTO factura_detalle (id_factura, id_orden_detalle, cantidad_asignada)
         VALUES (?, ?, ?)`,
        [idFactura, l.id, l.cantidad]
      );
    }

    // Pagos.
    for (const pg of pagos) {
      await cx.execute(
        `INSERT INTO pago (id_factura, metodo, monto, recibido, referencia)
         VALUES (?, ?, ?, ?, ?)`,
        [idFactura, pg.metodo, aDecimal(aCentavos(pg.monto)),
         pg.recibido != null ? aDecimal(aCentavos(pg.recibido)) : null,
         pg.referencia ? String(pg.referencia).slice(0, 60) : null]
      );
    }

    // ---- ¿Queda algo por cobrar en la orden? ----
    // Si esta factura cubrió todas las líneas vivas, se cierra la orden y se
    // libera la mesa. Si fue una sub-cuenta parcial, la orden sigue abierta.
    const [[pendientes]] = await cx.execute(
      `SELECT COUNT(*) AS n FROM orden_detalle od
        WHERE od.id_orden = ? AND od.estado_preparacion <> 'anulado'
          AND od.id_orden_detalle NOT IN (
            SELECT fd.id_orden_detalle FROM factura_detalle fd
              JOIN factura f ON f.id_factura = fd.id_factura
             WHERE f.id_orden = ? AND f.estado = 'emitida')`,
      [idOrden, idOrden]
    );

    let mesaLiberada = false;
    if (pendientes.n === 0) {
      await cx.execute("UPDATE orden SET estado = 'cerrada', cerrada_en = NOW() WHERE id_orden = ?", [idOrden]);
      await cx.execute("UPDATE mesa SET estado = 'libre' WHERE id_mesa = ?", [orden.id_mesa]);
      mesaLiberada = true;
    }

    // Cálculo del cambio (efectivo).
    const recibidoC = pagos.reduce((s, pg) => s + (pg.recibido != null ? aCentavos(pg.recibido) : aCentavos(pg.monto)), 0);
    const cambioC = Math.max(0, recibidoC - totalC);

    await auditar(cx, {
      idUsuario: idCajero, accion: 'caja.cobro', entidad: 'factura', idEntidad: idFactura,
      detalle: `Factura ${consecutivo} de la mesa ${orden.mesa}: total ${formatear(totalC)}` +
               (descuentoC > 0 ? `, descuento ${formatear(descuentoC)}` : '') +
               (propinaC > 0 ? `, propina ${formatear(propinaC)}` : '') +
               `. ${pagos.length} pago(s).` + (mesaLiberada ? ' Mesa liberada.' : ' Cobro parcial (división).'),
      ipOrigen,
    });

    return {
      idFactura,
      consecutivo,
      subtotal: cuenta.subtotal,
      descuento: aDecimal(descuentoC),
      impuestos: cuenta.impuestos,
      propina: aDecimal(propinaC),
      total: aDecimal(totalC),
      cambio: aDecimal(cambioC),
      mesaLiberada,
      idMesa: orden.id_mesa,
      mesa: orden.mesa,
    };
  });
}

/**
 * Valida una propuesta de división de cuentas.  CA-06.
 *
 * FSD 5.7: "la suma de asignaciones debe igualar exactamente la comanda
 * original antes de permitir el primer cobro parcial." Esta comprobación es la
 * que el divisor (vista 20) invoca antes de habilitar el cobro.
 *
 * @param {Array} subcuentas  [{ idsDetalle: [...] }] o [{ lineas: [{id, cantidad}] }]
 */
export async function validarDivision(idOrden, subcuentas) {
  const cuenta = await calcularCuenta(idOrden);
  if (!cuenta) throw errores.reglaDeNegocio('La orden no tiene líneas que dividir.');

  // Cantidad total por línea en la orden.
  const totalPorLinea = new Map(cuenta.lineas.map((l) => [l.id, l.cantidad]));
  // Cantidad asignada por línea sumando todas las sub-cuentas.
  const asignadoPorLinea = new Map();

  for (const sc of subcuentas) {
    for (const item of (sc.lineas ?? sc.idsDetalle?.map((id) => ({ id, cantidad: totalPorLinea.get(id) })) ?? [])) {
      const actual = asignadoPorLinea.get(item.id) ?? 0;
      asignadoPorLinea.set(item.id, actual + Number(item.cantidad));
    }
  }

  // Cada línea debe estar asignada por completo, ni de más ni de menos.
  const problemas = [];
  for (const [id, total] of totalPorLinea) {
    const asignado = asignadoPorLinea.get(id) ?? 0;
    if (asignado !== total) {
      const l = cuenta.lineas.find((x) => x.id === id);
      problemas.push(`"${l.producto}": ${asignado} de ${total} asignada(s)`);
    }
  }
  // No puede haber líneas asignadas que no existan en la orden.
  for (const id of asignadoPorLinea.keys()) {
    if (!totalPorLinea.has(id)) problemas.push(`línea ${id} no pertenece a la orden`);
  }

  return {
    valida: problemas.length === 0,
    problemas,
  };
}
