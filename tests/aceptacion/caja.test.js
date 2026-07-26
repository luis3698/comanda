/**
 * Criterios de aceptación de la fase 4 (Caja), contra la base real.
 *
 *   CA-05  Imposible cerrar una factura si SUM(pagos) ≠ total.
 *   CA-06  La división no permite cobrar hasta que las sub-cuentas igualen la orden.
 *   CA-07  El total esperado del arqueo solo se revela tras confirmar el conteo.
 *
 * Requiere el contenedor de MySQL en pie. Limpia lo que crea.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import 'dotenv/config';

import { asegurarZonaPruebas } from '../comun/salon.mjs';
import { pool, consultarUno } from '../../server/db.js';
import { abrirOrden, agregarLinea, enviarACocina } from '../../server/servicios/ordenes.js';
import {
  abrirTurno, cobrar, cerrarTurnoArqueo, validarDivision, calcularCuenta, turnoAbiertoDe,
  registrarMovimiento,
} from '../../server/servicios/caja.js';

const MESERO = 4;
const CAJERO = 2;
const HAMBURGUESA = 3;   // precio base 32000, IVA 8%
const NUMERO_MESA = 'TEST-CAJA';

let admin;
let idMesa;
let idZona;

async function limpiar() {
  // Facturas, pagos, turnos y órdenes de la mesa de prueba, con credencial root.
  const [mesas] = await admin.execute('SELECT id_mesa FROM mesa WHERE id_zona = ? AND numero = ?', [idZona, NUMERO_MESA]);
  for (const m of mesas) {
    const [ordenes] = await admin.execute('SELECT id_orden FROM orden WHERE id_mesa = ?', [m.id_mesa]);
    for (const o of ordenes) {
      const [facturas] = await admin.execute('SELECT id_factura FROM factura WHERE id_orden = ?', [o.id_orden]);
      for (const f of facturas) {
        await admin.execute('DELETE FROM pago WHERE id_factura = ?', [f.id_factura]);
        await admin.execute('DELETE FROM factura_detalle WHERE id_factura = ?', [f.id_factura]);
        // Auditoría append-only: no se borra (rompería la cadena de hashes).
        await admin.execute('DELETE FROM factura WHERE id_factura = ?', [f.id_factura]);
      }
      await admin.execute('DELETE FROM movimiento_inventario WHERE id_referencia IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)', [o.id_orden]);
      await admin.execute('DELETE FROM orden_detalle_modificador WHERE id_orden_detalle IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)', [o.id_orden]);
      await admin.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [o.id_orden]);
      // Auditoría append-only: no se borra (rompería la cadena de hashes).
      await admin.execute('DELETE FROM orden WHERE id_orden = ?', [o.id_orden]);
    }
    await admin.execute('DELETE FROM mesa WHERE id_mesa = ?', [m.id_mesa]);
  }
  // Turnos del cajero que ya no tienen ninguna factura colgando.
  //
  // El filtro por facturas importa: las facturas de la mesa de prueba se
  // borraron arriba, así que sus turnos quedan libres. Pero un turno con
  // facturas de OTRAS mesas (datos de una prueba manual en el navegador, o
  // datos reales) no es nuestro y no se toca: intentar borrarlo fallaría por
  // la FK de factura, y con razón.
  const [turnos] = await admin.execute(
    `SELECT id_turno FROM turno_caja
      WHERE id_cajero = ?
        AND id_turno NOT IN (SELECT DISTINCT id_turno FROM factura)`,
    [CAJERO]
  );
  for (const t of turnos) {
    await admin.execute('DELETE FROM movimiento_caja WHERE id_turno = ?', [t.id_turno]);
    // Auditoría append-only: no se borra (rompería la cadena de hashes).
    await admin.execute('DELETE FROM turno_caja WHERE id_turno = ?', [t.id_turno]);
  }
}

before(async () => {
  admin = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3307),
    user: 'root', password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
    database: process.env.DB_NAME || 'sigr',
  });
  idZona = await asegurarZonaPruebas(admin);
  await limpiar();
  const [r] = await admin.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, 'redonda', 8, 92, 92, 4, 4)`, [idZona, NUMERO_MESA]
  );
  idMesa = r.insertId;
});

after(async () => {
  await limpiar();
  await admin.end();
  await pool.end();
});

/** Deja la mesa libre y sin órdenes vivas antes de cada prueba. */
beforeEach(async () => {
  await admin.execute("UPDATE orden SET estado='cerrada' WHERE id_mesa = ? AND estado IN ('abierta','enviada','precuenta')", [idMesa]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [idMesa]);
  // Cierra cualquier turno abierto del cajero.
  await admin.execute("UPDATE turno_caja SET estado='cerrado', cerrado_en=NOW() WHERE id_cajero = ? AND estado='abierto'", [CAJERO]);
});

/** Crea una orden con N hamburguesas enviadas y devuelve su id. */
async function ordenConHamburguesas(n) {
  const { idOrden } = await abrirOrden({ idMesa, idMesero: MESERO, numComensales: 4 });
  await agregarLinea({ idOrden, idProducto: HAMBURGUESA, cantidad: n, tiempoSalida: 1, modificadores: [2], idUsuario: MESERO });
  await enviarACocina({ idOrden, idUsuario: MESERO });
  return idOrden;
}

/* =====================================================================
   Turno
   ===================================================================== */

test('no se puede cobrar sin un turno abierto', async () => {
  const idOrden = await ordenConHamburguesas(1);
  await assert.rejects(
    () => cobrar({ idOrden, idTurno: 999999, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO }),
    /no encontrado|turno/i
  );
});

/* =====================================================================
   CA-05 — la suma de pagos debe igualar el total
   ===================================================================== */

test('CA-05: no se cierra la factura si los pagos no cuadran', async () => {
  const idOrden = await ordenConHamburguesas(1);
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });

  // 1 hamburguesa: 32000 + 8% IVA = 34560.
  const cuenta = await calcularCuenta(idOrden);
  assert.equal(cuenta.total, '34560.00');

  // Pago de menos: debe rechazarse.
  await assert.rejects(
    () => cobrar({ idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '30000' }], idCajero: CAJERO }),
    /no coincide con el total/i
  );
  // Pago de más: también.
  await assert.rejects(
    () => cobrar({ idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '40000' }], idCajero: CAJERO }),
    /no coincide con el total/i
  );

  // La orden sigue abierta: no se cobró nada.
  const orden = await consultarUno('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.notEqual(orden.estado, 'cerrada');
});

test('CA-05: pago exacto cierra la factura y libera la mesa', async () => {
  const idOrden = await ordenConHamburguesas(1);
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });

  const r = await cobrar({
    idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560', recibido: '50000' }], idCajero: CAJERO,
  });

  assert.equal(r.total, '34560.00');
  assert.equal(r.cambio, '15440.00', 'el cambio se calcula sobre lo recibido');
  assert.ok(r.mesaLiberada, 'la mesa queda libre');
  assert.match(r.consecutivo, /^FAC-\d{8}$/, 'la factura lleva consecutivo fiscal');

  const orden = await consultarUno('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.equal(orden.estado, 'cerrada');
  const mesa = await consultarUno('SELECT estado FROM mesa WHERE id_mesa = ?', [idMesa]);
  assert.equal(mesa.estado, 'libre');
});

test('CA-05: pago mixto que suma el total exacto se acepta', async () => {
  const idOrden = await ordenConHamburguesas(2);   // 2 x 34560 = 69120
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });

  const cuenta = await calcularCuenta(idOrden);
  assert.equal(cuenta.total, '69120.00');

  const r = await cobrar({
    idOrden, idTurno,
    pagos: [
      { metodo: 'efectivo', monto: '40000', recibido: '40000' },
      { metodo: 'tarjeta_credito', monto: '29120', referencia: 'VISA-1234' },
    ],
    idCajero: CAJERO,
  });
  assert.equal(r.total, '69120.00');

  // Se guardaron los dos pagos.
  const pagos = await consultarUno('SELECT COUNT(*) AS n FROM pago WHERE id_factura = ?', [r.idFactura]);
  assert.equal(pagos.n, 2);
});

test('el consecutivo fiscal es correlativo y sin huecos', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });

  const o1 = await ordenConHamburguesas(1);
  const r1 = await cobrar({ idOrden: o1, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO });
  const o2 = await ordenConHamburguesas(1);
  const r2 = await cobrar({ idOrden: o2, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO });

  const n1 = Number(r1.consecutivo.slice(4));
  const n2 = Number(r2.consecutivo.slice(4));
  assert.equal(n2, n1 + 1, 'los consecutivos son correlativos');
});

/* =====================================================================
   CA-06 — la división debe igualar la orden original
   ===================================================================== */

test('CA-06: la división no valida si las sub-cuentas no cubren toda la orden', async () => {
  const idOrden = await ordenConHamburguesas(4);
  const cuenta = await calcularCuenta(idOrden);
  const idLinea = cuenta.lineas[0].id;   // una línea con cantidad 4

  // Asignar solo 3 de las 4 unidades: inválido.
  const parcial = await validarDivision(idOrden, [
    { lineas: [{ id: idLinea, cantidad: 2 }] },
    { lineas: [{ id: idLinea, cantidad: 1 }] },
  ]);
  assert.equal(parcial.valida, false);
  assert.ok(parcial.problemas.length > 0);

  // Asignar las 4 completas (2+2): válido.
  const completa = await validarDivision(idOrden, [
    { lineas: [{ id: idLinea, cantidad: 2 }] },
    { lineas: [{ id: idLinea, cantidad: 2 }] },
  ]);
  assert.equal(completa.valida, true);
  assert.equal(completa.problemas.length, 0);
});

test('CA-06: cobrar una sub-cuenta deja la orden abierta hasta cobrar el resto', async () => {
  // Orden con dos líneas separadas: una hamburguesa en el 1er tiempo y otra
  // en el 2º. Se cobra cada una por separado (división por líneas).
  const { idOrden } = await abrirOrden({ idMesa, idMesero: MESERO, numComensales: 2 });
  await agregarLinea({ idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1, modificadores: [2], idUsuario: MESERO });
  await agregarLinea({ idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 2, modificadores: [2], idUsuario: MESERO });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  const cuenta = await calcularCuenta(idOrden);
  assert.equal(cuenta.lineas.length, 2);

  // La sub-cuenta de la primera línea vale lo que diga el servidor: se calcula
  // solo esa línea para saber el monto exacto que hay que pagar.
  const sub1 = await calcularCuenta(idOrden, [cuenta.lineas[0].id]);

  const r1 = await cobrar({
    idOrden, idTurno, idsDetalle: [cuenta.lineas[0].id],
    pagos: [{ metodo: 'efectivo', monto: sub1.total }], idCajero: CAJERO,
  });
  assert.equal(r1.mesaLiberada, false, 'aún queda una línea por cobrar');

  const ordenMedio = await consultarUno('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.notEqual(ordenMedio.estado, 'cerrada', 'la orden sigue abierta');

  // Cobrar la segunda línea: ahora sí se cierra y libera la mesa.
  const sub2 = await calcularCuenta(idOrden, [cuenta.lineas[1].id]);
  const r2 = await cobrar({
    idOrden, idTurno, idsDetalle: [cuenta.lineas[1].id],
    pagos: [{ metodo: 'tarjeta_debito', monto: sub2.total }], idCajero: CAJERO,
  });
  assert.equal(r2.mesaLiberada, true, 'cobrada la última línea, se libera la mesa');

  const ordenFinal = await consultarUno('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.equal(ordenFinal.estado, 'cerrada');

  // Dos facturas independientes vinculadas a la misma orden (FSD 5.7).
  const facturas = await consultarUno('SELECT COUNT(*) AS n FROM factura WHERE id_orden = ?', [idOrden]);
  assert.equal(facturas.n, 2);
});

/* =====================================================================
   CA-07 — arqueo ciego
   ===================================================================== */

test('CA-07: el resumen del turno NO expone el total esperado antes del cierre', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  const idOrden = await ordenConHamburguesas(1);
  await cobrar({ idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO });

  // El turno abierto en la base no tiene total_sistema calculado todavía.
  const turno = await consultarUno('SELECT total_sistema, total_contado, diferencia FROM turno_caja WHERE id_turno = ?', [idTurno]);
  assert.equal(turno.total_sistema, null, 'el esperado no existe hasta el cierre');
  assert.equal(turno.total_contado, null);
  assert.equal(turno.diferencia, null);
});

test('CA-07: el esperado se revela solo al cerrar con el conteo', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  const idOrden = await ordenConHamburguesas(1);
  await cobrar({ idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO });

  // Esperado = fondo 100000 + venta efectivo 34560 = 134560.
  // El cajero cuenta exactamente eso: cuadra.
  const r = await cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '134560' });

  assert.equal(r.esperado, '134560.00', 'el esperado se calcula al cerrar');
  assert.equal(r.contado, '134560.00');
  assert.equal(r.diferencia, '0.00');
  assert.equal(r.tipo, 'cuadrado');
});

test('CA-07: un faltante exige comentario justificativo', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  const idOrden = await ordenConHamburguesas(1);
  await cobrar({ idOrden, idTurno, pagos: [{ metodo: 'efectivo', monto: '34560' }], idCajero: CAJERO });

  // Cuenta menos de lo esperado (faltante) sin comentario: rechazado.
  await assert.rejects(
    () => cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '130000' }),
    /comentario justificativo/i
  );

  // Con comentario, se cierra y marca el faltante.
  const r = await cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '130000', comentario: 'Faltante por vuelto mal dado' });
  assert.equal(r.tipo, 'faltante');
  assert.equal(r.diferencia, '-4560.00');
});

test('CA-07: un turno cerrado es inmutable', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  await cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '100000' });

  // Intentar cerrarlo otra vez: rechazado.
  await assert.rejects(
    () => cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '100000' }),
    /ya está cerrado|inmutable/i
  );
  // Intentar registrar un movimiento en él: rechazado.
  await assert.rejects(
    () => registrarMovimiento({ idTurno, tipo: 'salida', monto: '1000', motivo: 'prueba', idUsuario: CAJERO }),
    /cerrado/i
  );
});

test('las salidas de efectivo restan del esperado del arqueo', async () => {
  const { idTurno } = await abrirTurno({ idCajero: CAJERO, fondoInicial: '100000' });
  await registrarMovimiento({ idTurno, tipo: 'salida', monto: '20000', motivo: 'Compra de emergencia', idUsuario: CAJERO });

  // Esperado = 100000 − 20000 = 80000, sin ventas.
  const r = await cerrarTurnoArqueo({ idTurno, idCajero: CAJERO, totalContado: '80000' });
  assert.equal(r.esperado, '80000.00');
  assert.equal(r.tipo, 'cuadrado');
});
