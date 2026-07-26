/**
 * Casos de uso del capítulo 7 del FSD, automatizados de extremo a extremo.
 *
 *   CU-01  Tomar pedido y enviar a cocina           (Mesero)
 *   CU-02  Preparar y entregar platos (KDS)         (Cocinero)
 *   CU-03  Cobrar una mesa (pago simple o mixto)    (Cajero)
 *   CU-04  Dividir la cuenta de una mesa            (Cajero)
 *   CU-05  Cierre de turno con arqueo ciego         (Cajero)
 *
 * FSD 10.2: "E2E funcionales: los 5 casos de uso del capítulo 7 automatizados
 * sobre navegador real, incluyendo móvil emulado."
 *
 * Estas pruebas recorren el flujo completo por HTTP, con un cliente por rol y
 * sus permisos reales, verificando precondiciones, flujo principal, flujos
 * alternos y postcondiciones tal como los define el documento. Es la capa que
 * comprueba que los módulos encajan entre sí.
 *
 * (La verificación sobre navegador real —incluido el móvil emulado— se hizo de
 * forma manual y quedó registrada en TRAZABILIDAD.md; esto la complementa con
 * una red de seguridad automatizada que corre en cada cambio.)
 *
 * Requiere el servidor corriendo:  npm run test:e2e
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import 'dotenv/config';

import { asegurarZonaPruebas } from '../comun/salon.mjs';

const BASE = process.env.URL_PRUEBAS ?? 'http://localhost:3000/api/v1';
const NUMERO_MESA = 'E2E-1';

let admin;
let idMesa;
let idZona;

class Cliente {
  constructor(nombre) { this.nombre = nombre; this.cookie = null; this.csrf = null; }

  async peticion(metodo, ruta, cuerpo) {
    const cabeceras = {};
    if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
    if (this.cookie) cabeceras.Cookie = this.cookie;
    if (this.csrf && !['GET', 'HEAD'].includes(metodo)) cabeceras['X-CSRF-Token'] = this.csrf;

    const r = await fetch(BASE + ruta, {
      method: metodo, headers: cabeceras,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];

    let datos = null;
    try { datos = await r.json(); } catch { /* sin cuerpo */ }
    return { estado: r.status, datos };
  }

  get(r) { return this.peticion('GET', r); }
  post(r, c) { return this.peticion('POST', r, c ?? {}); }
  patch(r, c) { return this.peticion('PATCH', r, c ?? {}); }

  async login(credenciales) {
    const r = await this.post('/auth/login', credenciales);
    assert.equal(r.estado, 200, `${this.nombre} debe poder autenticarse`);
    this.csrf = r.datos.tokenCsrf;
    return r.datos.usuario;
  }
}

/* ---------------------------------------------------------------
   Preparación
   --------------------------------------------------------------- */

async function limpiarMesa() {
  const [mesas] = await admin.execute(
    'SELECT id_mesa FROM mesa WHERE id_zona = ? AND numero = ?', [idZona, NUMERO_MESA]
  );
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
      await admin.execute('DELETE FROM orden WHERE id_orden = ?', [o.id_orden]);
    }
    await admin.execute('DELETE FROM mesa WHERE id_mesa = ?', [m.id_mesa]);
  }
  // Turnos del cajero sin facturas colgando.
  const [turnos] = await admin.execute(
    `SELECT id_turno FROM turno_caja
      WHERE id_cajero = 2 AND id_turno NOT IN (SELECT DISTINCT id_turno FROM factura)`
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
  await limpiarMesa();
  const [r] = await admin.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, 'redonda', 8, 95, 95, 3, 3)`, [idZona, NUMERO_MESA]
  );
  idMesa = r.insertId;
  await admin.execute('UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL');
});

after(async () => {
  await limpiarMesa();
  await admin.end();
});

beforeEach(async () => {
  await admin.execute("UPDATE orden SET estado='cerrada' WHERE id_mesa=? AND estado IN ('abierta','enviada','precuenta')", [idMesa]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [idMesa]);
  await admin.execute("UPDATE turno_caja SET estado='cerrado', cerrado_en=NOW() WHERE id_cajero=2 AND estado='abierto'");
  await admin.execute('UPDATE producto SET disponible = TRUE WHERE id_producto IN (3, 8)');
});

/* =====================================================================
   CU-01: Tomar pedido y enviar a cocina
   ===================================================================== */

test('CU-01: el mesero toma el pedido y lo envía a cocina', async () => {
  const mesero = new Cliente('mesero');
  // Precondición: "Sesión iniciada con PIN; mesa en estado libre."
  const u = await mesero.login({ documento: 'CC1004', pin: '4444' });
  assert.equal(u.rol, 'Mesero');

  const salon = await mesero.get('/salon/zonas');
  const mesa = salon.datos.zonas.flatMap((z) => z.mesas).find((m) => m.id === idMesa);
  assert.equal(mesa.estado, 'libre', 'precondición: la mesa está libre');

  // 1-2. Toca la mesa libre y registra el nº de comensales.
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 4 });
  assert.equal(orden.estado, 201);
  const idOrden = orden.datos.idOrden;

  // 3. Selecciona platos, resuelve modificadores obligatorios y añade notas.
  const l1 = await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 2, tiempoSalida: 2,
    modificadores: [2],   // Término medio (grupo obligatorio)
    notas: 'Sin cebolla, alergia',
  });
  assert.equal(l1.estado, 201);

  // 4. Agrupa por tiempos de salida: la limonada sale primero.
  const l2 = await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 8, cantidad: 2, tiempoSalida: 1,
  });
  assert.equal(l2.estado, 201);

  // 5-6. Envía. El sistema congela precios, descuenta inventario y enruta.
  const [[carneAntes]] = await admin.execute('SELECT stock_actual FROM insumo WHERE id_insumo = 1');

  const envio = await mesero.post(`/ordenes/${idOrden}/enviar`);
  assert.equal(envio.estado, 200);
  assert.equal(envio.datos.lineasEnviadas, 2);
  assert.equal(envio.datos.aCocina, 1, 'la hamburguesa va a cocina');
  assert.equal(envio.datos.aBarra, 1, 'la limonada va a barra');

  // Postcondición: "Orden enviada; mesa ocupada; tarjetas visibles en el KDS;
  // kárdex actualizado."
  const [[o]] = await admin.execute('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.equal(o.estado, 'enviada');

  const [[m]] = await admin.execute('SELECT estado FROM mesa WHERE id_mesa = ?', [idMesa]);
  assert.equal(m.estado, 'ocupada');

  const [[carneDespues]] = await admin.execute('SELECT stock_actual FROM insumo WHERE id_insumo = 1');
  assert.equal(Number(carneAntes.stock_actual) - Number(carneDespues.stock_actual), 300,
    '2 hamburguesas = 300 g de carne descontados');

  // El precio quedó congelado.
  const [lineas] = await admin.execute(
    'SELECT precio_unitario, enviado_en FROM orden_detalle WHERE id_orden = ?', [idOrden]
  );
  assert.ok(lineas.every((l) => Number(l.precio_unitario) > 0 && l.enviado_en),
    'todas las líneas con precio congelado y marca de envío');
});

test('CU-01 flujo alterno 3a: un plato agotado durante la toma no se puede añadir', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 2 });

  // El cocinero agota el plato mientras el mesero toma el pedido.
  const cocinero = new Cliente('cocinero');
  await cocinero.login({ documento: 'CC1003', pin: '3333' });
  const agotar = await cocinero.patch('/kds/productos/3/disponibilidad', { disponible: false });
  assert.equal(agotar.estado, 200);

  // El mesero ya no puede añadirlo.
  const r = await mesero.post(`/ordenes/${orden.datos.idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  assert.equal(r.estado, 422);
  assert.match(r.datos.mensaje, /agotado/i);

  await cocinero.patch('/kds/productos/3/disponibilidad', { disponible: true });
});

/* =====================================================================
   CU-02: Preparar y entregar platos (KDS)
   ===================================================================== */

test('CU-02: el cocinero prepara y entrega los platos', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 2 });
  const idOrden = orden.datos.idOrden;
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2], notas: 'ALERGIA AL GLUTEN',
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  const cocinero = new Cliente('cocinero');
  await cocinero.login({ documento: 'CC1003', pin: '3333' });

  // 1. La tarjeta llega al monitor.
  const kds = await cocinero.get('/kds/comandas?estacion=cocina');
  assert.equal(kds.estado, 200);
  const tarjeta = kds.datos.comandas.find((c) => c.idOrden === idOrden);
  assert.ok(tarjeta, 'la comanda aparece en el KDS de cocina');
  assert.ok(tarjeta.lineas[0].notas.includes('ALERGIA'), 'la nota de alergia llega al cocinero');
  assert.ok(tarjeta.segundosEspera >= 0, 'la tarjeta trae su cronómetro');

  const idLinea = tarjeta.lineas[0].id;

  // 2. Marca "Preparando".
  const preparando = await cocinero.patch(`/kds/lineas/${idLinea}/estado`);
  assert.equal(preparando.estado, 200);
  assert.equal(preparando.datos.estado, 'preparando');

  // 3. Al terminar marca "Listo".
  const listo = await cocinero.patch(`/kds/lineas/${idLinea}/estado`);
  assert.equal(listo.datos.estado, 'listo');

  // 4. El mesero sirve y marca "Servido".
  const servido = await mesero.patch(`/kds/lineas/${idLinea}/servido`);
  assert.equal(servido.datos.estado, 'servido');

  // Postcondición: "Estados y timestamps registrados para métricas de tiempos."
  const [[l]] = await admin.execute(
    'SELECT estado_preparacion, enviado_en, listo_en FROM orden_detalle WHERE id_orden_detalle = ?',
    [idLinea]
  );
  assert.equal(l.estado_preparacion, 'servido');
  assert.ok(l.enviado_en, 'timestamp de envío');
  assert.ok(l.listo_en, 'timestamp de listo: es lo que mide el tiempo de cocina');
});

test('CU-02: el flujo de estados no admite saltos ni retrocesos', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 1 });
  const linea = await mesero.post(`/ordenes/${orden.datos.idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${orden.datos.idOrden}/enviar`);

  const cocinero = new Cliente('cocinero');
  await cocinero.login({ documento: 'CC1003', pin: '3333' });
  const idLinea = linea.datos.idLinea;

  // Saltar de en_cola directo a listo: rechazado.
  const salto = await cocinero.patch(`/kds/lineas/${idLinea}/estado`, { estado: 'listo' });
  assert.equal(salto.estado, 422);
  assert.match(salto.datos.mensaje, /solo se puede pasar a "preparando"/i);

  // El camino correcto sí funciona.
  await cocinero.patch(`/kds/lineas/${idLinea}/estado`);
  await cocinero.patch(`/kds/lineas/${idLinea}/estado`);

  // Retroceder: rechazado.
  const retroceso = await cocinero.patch(`/kds/lineas/${idLinea}/estado`, { estado: 'preparando' });
  assert.equal(retroceso.estado, 422);
});

/* =====================================================================
   CU-03: Cobrar una mesa
   ===================================================================== */

test('CU-03: el cajero cobra la mesa con pago mixto', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 3 });
  const idOrden = orden.datos.idOrden;
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 2, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  // Precondición ideal: pre-cuenta solicitada.
  const precuenta = await mesero.post(`/ordenes/${idOrden}/precuenta`);
  assert.equal(precuenta.estado, 200);

  const cajero = new Cliente('cajero');
  await cajero.login({ documento: 'CC1002', pin: '2222' });

  // Precondición: turno de caja abierto.
  const turno = await cajero.post('/caja/turnos', { fondoInicial: '200000' });
  assert.equal(turno.estado, 201);

  // 1. El cajero abre la cuenta destacada.
  const cuentas = await cajero.get('/caja/cuentas');
  const destacada = cuentas.datos.cuentas.find((c) => c.idOrden === idOrden);
  assert.ok(destacada.precuenta, 'la cuenta con pre-cuenta se marca para destacarla');
  assert.equal(cuentas.datos.cuentas[0].idOrden, idOrden, 'y sube al inicio de la lista');

  const cuenta = await cajero.get(`/caja/cuentas/${idOrden}`);
  assert.equal(cuenta.datos.total, '69120.00', '2 hamburguesas + 8% de impuesto');

  // 2-4. Descuento con motivo, propina y pagos hasta saldo cero.
  const motivos = await cajero.get('/caja/motivos-descuento');
  assert.ok(motivos.datos.motivos.length > 0);

  // 5-6. Cobra con pago mixto.
  const cobro = await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    pagos: [
      { metodo: 'efectivo', monto: '40000', recibido: '50000' },
      { metodo: 'tarjeta_credito', monto: '29120', referencia: 'VISA-999' },
    ],
  });
  assert.equal(cobro.estado, 200);
  assert.equal(cobro.datos.total, '69120.00');
  assert.match(cobro.datos.consecutivo, /^FAC-\d{8}$/, 'factura con consecutivo fiscal');
  assert.equal(cobro.datos.cambio, '10000.00', 'el cambio del efectivo');

  // Postcondición: "Factura emitida; pagos registrados en el turno; mesa libre;
  // auditoría escrita."
  assert.ok(cobro.datos.mesaLiberada);
  const [[m]] = await admin.execute('SELECT estado FROM mesa WHERE id_mesa = ?', [idMesa]);
  assert.equal(m.estado, 'libre');

  const [[o]] = await admin.execute('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.equal(o.estado, 'cerrada');

  const [[aud]] = await admin.execute(
    "SELECT COUNT(*) AS n FROM log_auditoria WHERE accion='caja.cobro' AND id_entidad=?",
    [cobro.datos.idFactura]
  );
  assert.equal(aud.n, 1, 'el cobro quedó auditado');
});

/* =====================================================================
   CU-04: Dividir la cuenta
   ===================================================================== */

test('CU-04: el cajero divide la cuenta en dos facturas independientes', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 2 });
  const idOrden = orden.datos.idOrden;

  // Precondición: "Orden con dos o más líneas de consumo."
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 8, cantidad: 1, tiempoSalida: 1,
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  const cajero = new Cliente('cajero');
  await cajero.login({ documento: 'CC1002', pin: '2222' });
  await cajero.post('/caja/turnos', { fondoInicial: '200000' });

  const cuenta = await cajero.get(`/caja/cuentas/${idOrden}`);
  const [linea1, linea2] = cuenta.datos.lineas;

  // 4. El sistema valida que la suma iguale la cuenta original.
  const parcial = await cajero.post(`/caja/cuentas/${idOrden}/validar-division`, {
    subcuentas: [{ lineas: [{ id: linea1.id, cantidad: linea1.cantidad }] }],
  });
  assert.equal(parcial.datos.valida, false, 'falta asignar la segunda línea');

  const completa = await cajero.post(`/caja/cuentas/${idOrden}/validar-division`, {
    subcuentas: [
      { lineas: [{ id: linea1.id, cantidad: linea1.cantidad }] },
      { lineas: [{ id: linea2.id, cantidad: linea2.cantidad }] },
    ],
  });
  assert.equal(completa.datos.valida, true, 'con todo asignado, la división es válida');

  // 5. Cobra cada sub-cuenta con su propio método de pago.
  const sub1 = await cajero.get(`/caja/cuentas/${idOrden}?lineas=${linea1.id}`);
  const cobro1 = await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    idsDetalle: [linea1.id],
    pagos: [{ metodo: 'efectivo', monto: sub1.datos.total }],
  });
  assert.equal(cobro1.estado, 200);
  assert.equal(cobro1.datos.mesaLiberada, false, 'aún queda la otra sub-cuenta');

  const sub2 = await cajero.get(`/caja/cuentas/${idOrden}?lineas=${linea2.id}`);
  const cobro2 = await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    idsDetalle: [linea2.id],
    pagos: [{ metodo: 'tarjeta_debito', monto: sub2.datos.total }],
  });
  assert.equal(cobro2.estado, 200);
  assert.equal(cobro2.datos.mesaLiberada, true, 'cobrada la última, se libera la mesa');

  // Postcondición: "N facturas independientes vinculadas a la misma orden."
  const [facturas] = await admin.execute(
    'SELECT consecutivo_fiscal, total FROM factura WHERE id_orden = ? ORDER BY id_factura', [idOrden]
  );
  assert.equal(facturas.length, 2, 'dos facturas independientes');
  assert.notEqual(facturas[0].consecutivo_fiscal, facturas[1].consecutivo_fiscal,
    'cada una con su consecutivo fiscal');
});

/* =====================================================================
   CU-05: Cierre de turno con arqueo ciego
   ===================================================================== */

test('CU-05: el cajero cierra el turno con arqueo ciego', async () => {
  const mesero = new Cliente('mesero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 2 });
  const idOrden = orden.datos.idOrden;
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  const cajero = new Cliente('cajero');
  await cajero.login({ documento: 'CC1002', pin: '2222' });

  const turno = await cajero.post('/caja/turnos', { fondoInicial: '100000' });
  const idTurno = turno.datos.idTurno;

  // Precondición: "todas las mesas del turno cobradas".
  const cuenta = await cajero.get(`/caja/cuentas/${idOrden}`);
  await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    pagos: [{ metodo: 'efectivo', monto: cuenta.datos.total }],
  });

  await cajero.post(`/caja/turnos/${idTurno}/movimientos`, {
    tipo: 'salida', monto: '10000', motivo: 'Compra de emergencia',
  });

  // 2. Cuenta el efectivo SIN ver el esperado.
  //    El resumen del turno no lo revela por ningún lado.
  const resumen = await cajero.get('/caja/turno-activo');
  const json = JSON.stringify(resumen.datos);
  assert.ok(!json.includes('total_sistema') && !json.includes('esperado'),
    'el turno abierto no expone el esperado del arqueo');

  // Esperado real = 100000 + 34560 (venta) − 10000 (salida) = 124560.
  // El cajero no lo sabe: cuenta 124000 y le faltan 560.
  const sinComentario = await cajero.post(`/caja/turnos/${idTurno}/cierre`, {
    totalContado: '124000',
  });
  // Flujo alterno 4a: "Diferencia fuera de tolerancia: el cierre exige
  // comentario justificativo".
  assert.equal(sinComentario.estado, 422);
  assert.match(sinComentario.datos.mensaje, /comentario justificativo/i);

  // 3-4. Confirma el conteo con comentario y el sistema revela el arqueo.
  const cierre = await cajero.post(`/caja/turnos/${idTurno}/cierre`, {
    totalContado: '124000',
    comentario: 'Faltante de 560, revisar vueltos de la tarde',
  });
  assert.equal(cierre.estado, 200);
  assert.equal(cierre.datos.esperado, '124560.00', 'el esperado se revela recién ahora');
  assert.equal(cierre.datos.contado, '124000.00');
  assert.equal(cierre.datos.diferencia, '-560.00');
  assert.equal(cierre.datos.tipo, 'faltante');

  // El desglose explica de dónde sale el esperado.
  assert.equal(cierre.datos.desglose.fondoInicial, '100000.00');
  assert.equal(cierre.datos.desglose.ventaEfectivo, '34560.00');
  assert.equal(cierre.datos.desglose.salidas, '10000.00');

  // Postcondición: "Turno cerrado e inmutable."
  const reintento = await cajero.post(`/caja/turnos/${idTurno}/cierre`, { totalContado: '124560' });
  assert.equal(reintento.estado, 422, 'un turno cerrado no se puede volver a cerrar');

  const [[t]] = await admin.execute(
    'SELECT estado, total_sistema, diferencia FROM turno_caja WHERE id_turno = ?', [idTurno]
  );
  assert.equal(t.estado, 'cerrado');
  assert.equal(Number(t.total_sistema), 124560);
  assert.equal(Number(t.diferencia), -560);
});

/* =====================================================================
   El ciclo completo, de principio a fin
   ===================================================================== */

test('el ciclo completo: mesa libre → comanda → cocina → cobro → mesa libre', async () => {
  const mesero = new Cliente('mesero');
  const cocinero = new Cliente('cocinero');
  const cajero = new Cliente('cajero');
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  await cocinero.login({ documento: 'CC1003', pin: '3333' });
  await cajero.login({ documento: 'CC1002', pin: '2222' });

  const [[carne0]] = await admin.execute('SELECT stock_actual FROM insumo WHERE id_insumo = 1');

  // Mesa libre → comanda
  const orden = await mesero.post('/ordenes', { idMesa, numComensales: 2 });
  const idOrden = orden.datos.idOrden;
  const linea = await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  // Cocina: preparar → listo → servido
  await cocinero.patch(`/kds/lineas/${linea.datos.idLinea}/estado`);
  await cocinero.patch(`/kds/lineas/${linea.datos.idLinea}/estado`);
  await mesero.patch(`/kds/lineas/${linea.datos.idLinea}/servido`);

  // Pre-cuenta → cobro
  await mesero.post(`/ordenes/${idOrden}/precuenta`);
  await cajero.post('/caja/turnos', { fondoInicial: '100000' });
  const cuenta = await cajero.get(`/caja/cuentas/${idOrden}`);
  const cobro = await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    pagos: [{ metodo: 'efectivo', monto: cuenta.datos.total }],
  });

  // Todo cuadra al final.
  assert.ok(cobro.datos.mesaLiberada, 'la mesa vuelve a estar libre');

  const [[carne1]] = await admin.execute('SELECT stock_actual FROM insumo WHERE id_insumo = 1');
  assert.equal(Number(carne0.stock_actual) - Number(carne1.stock_actual), 150,
    'el inventario refleja exactamente lo vendido');

  const [[f]] = await admin.execute(
    'SELECT total FROM factura WHERE id_orden = ?', [idOrden]
  );
  const [[p]] = await admin.execute(
    'SELECT SUM(monto) AS pagado FROM pago WHERE id_factura IN (SELECT id_factura FROM factura WHERE id_orden = ?)',
    [idOrden]
  );
  assert.equal(Number(f.total), Number(p.pagado), 'lo facturado y lo pagado coinciden');
});
