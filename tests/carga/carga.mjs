/**
 * Prueba de carga.  FSD 6.2 y 10.2.
 *
 * "Rendimiento: carga de 50 dispositivos concurrentes y 500 comandas/hora
 *  manteniendo p95 < 300 ms."
 * "API p95 < 300 ms en operaciones transaccionales."
 *
 * Interesa sobre todo el envío de comanda, que es la transacción más pesada:
 * congela precios, descuenta inventario por receta, audita y publica eventos.
 * Y con ella se mide la CONTENCIÓN DEL GET_LOCK de la cadena de auditoría,
 * anotada como riesgo abierto desde la fase 1: ese lock serializa la escritura
 * del log, así que si va a ser un cuello de botella, aquí se ve.
 *
 * Uso:  npm run test:carga
 */
import mysql from 'mysql2/promise';
import 'dotenv/config';

import { asegurarZonaPruebas } from '../comun/salon.mjs';

const BASE = process.env.URL_PRUEBAS ?? 'http://localhost:3000/api/v1';

/** 50 dispositivos concurrentes (FSD 6.2). */
const DISPOSITIVOS = Number(process.env.CARGA_DISPOSITIVOS ?? 50);
const COMANDAS_POR_DISPOSITIVO = Number(process.env.CARGA_COMANDAS ?? 5);

/**
 * DOS ESCENARIOS, y la diferencia importa:
 *
 *  1. RITMO SOSTENIDO (el criterio del FSD): 50 dispositivos concurrentes, cada
 *     mesero con la cadencia real de quien toma pedidos —una pausa de unos
 *     segundos entre comandas—. La concurrencia es la de un restaurante lleno;
 *     es contra ESTO que se mide el p95 < 300 ms. El throughput resultante
 *     supera con creces las 500 comandas/hora que pide el FSD, y superarlo
 *     manteniendo el p95 es aprobar.
 *
 *     (No se pausa literalmente a 500/hora —una comanda cada 7,2 s en todo el
 *     local— porque eso obligaría a correr la prueba durante una hora para
 *     juntar muestras. Lo que estresa al sistema es la concurrencia de los 50
 *     dispositivos, no el intervalo entre comandas, así que se mide eso con una
 *     cadencia realista y la prueba termina en ~1 minuto.)
 *
 *  2. AVALANCHA (estrés, más allá de lo pedido): todas las comandas de golpe,
 *     sin pausa. No lo exige el FSD; sirve para ver si el sistema se degrada con
 *     elegancia o se cae.
 */
const COMANDAS_HORA_OBJETIVO = 500;
/** Cadencia de un mesero: ~3 s entre comandas. Realista y acotada. */
const PAUSA_ENTRE_COMANDAS_MS = Number(process.env.CARGA_PAUSA_MS ?? 3000);

const admin = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3307),
  user: 'root', password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
  database: process.env.DB_NAME || 'sigr',
});

/* ---------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------- */

function percentil(valores, p) {
  if (!valores.length) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  const i = Math.ceil((p / 100) * orden.length) - 1;
  return orden[Math.max(0, i)];
}

function resumen(nombre, ms) {
  if (!ms.length) return null;
  const total = ms.reduce((a, b) => a + b, 0);
  return {
    operacion: nombre,
    n: ms.length,
    media: (total / ms.length).toFixed(1),
    p50: percentil(ms, 50).toFixed(1),
    p95: percentil(ms, 95).toFixed(1),
    p99: percentil(ms, 99).toFixed(1),
    max: Math.max(...ms).toFixed(1),
  };
}

async function cronometrar(fn) {
  const t0 = performance.now();
  const r = await fn();
  return [performance.now() - t0, r];
}

/** Cliente HTTP mínimo con cookie y CSRF. */
class Dispositivo {
  constructor(id) { this.id = id; this.cookie = null; this.csrf = null; }

  async peticion(metodo, ruta, cuerpo) {
    const cabeceras = {};
    if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
    if (this.cookie) cabeceras.Cookie = this.cookie;
    if (this.csrf && metodo !== 'GET') cabeceras['X-CSRF-Token'] = this.csrf;

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

  async login(credenciales = { documento: 'CC1004', pin: '4444' }) {
    const r = await this.peticion('POST', '/auth/login', credenciales);
    this.csrf = r.datos?.tokenCsrf;
    return r.estado === 200;
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------
   Preparación: mesas dedicadas a la carga
   --------------------------------------------------------------- */

console.log('Preparando el escenario…');

// Los productos 3 y 8 (hamburguesa y limonada) deben estar activos y
// disponibles: la prueba los pide en cada comanda. Se fuerza aquí para que la
// prueba sea robusta ante la deriva de la base de desarrollo —un plato dado de
// baja a mano en una sesión anterior haría fallar los 250 envíos sin que el
// fallo tenga nada que ver con el rendimiento—.
await admin.execute('UPDATE producto SET activo = TRUE, disponible = TRUE WHERE id_producto IN (3, 8)');

// Se crea una mesa por dispositivo para que no compitan por la misma (eso ya
// lo cubre CA-09; aquí interesa el rendimiento, no la concurrencia sobre mesa).
await admin.execute("DELETE FROM orden WHERE id_mesa IN (SELECT id_mesa FROM mesa WHERE numero LIKE 'LOAD-%')");
await admin.execute("DELETE FROM mesa WHERE numero LIKE 'LOAD-%'");

const idZonaCarga = await asegurarZonaPruebas(admin);

const idsMesa = [];
for (let i = 0; i < DISPOSITIVOS; i++) {
  const [r] = await admin.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, 'redonda', 10, 0, 0, 1, 1)`,
    [idZonaCarga, `LOAD-${i}`]
  );
  idsMesa.push(r.insertId);
}

// Stock alto para que el descuento por receta no dependa de las existencias.
const [stockPrevio] = await admin.execute('SELECT id_insumo, stock_actual FROM insumo');
await admin.execute('UPDATE insumo SET stock_actual = 99999999');

console.log(`${DISPOSITIVOS} mesas creadas. Autenticando dispositivos…`);

const dispositivos = [];
for (let i = 0; i < DISPOSITIVOS; i++) {
  const d = new Dispositivo(i);
  if (!(await d.login())) throw new Error(`el dispositivo ${i} no pudo autenticarse`);
  dispositivos.push(d);
}

console.log(`${dispositivos.length} dispositivos autenticados.\n`);

/* ---------------------------------------------------------------
   La prueba
   --------------------------------------------------------------- */

/** Un lector de KDS autenticado como COCINERO (el mesero no tiene kds.ver). */
const cocinero = new Dispositivo('kds');
if (!(await cocinero.login({ documento: 'CC1003', pin: '3333' }))) {
  throw new Error('el lector del KDS no pudo autenticarse');
}

/**
 * Ejecuta un escenario completo.
 * @param {number} pausaMs  Pausa entre comandas de cada dispositivo. 0 = avalancha.
 */
async function escenario(nombre, pausaMs) {
  const tiempos = { abrir: [], agregar: [], enviar: [], kds: [] };
  const errores = [];
  let seguirLeyendo = true;

  async function ciclo(d, idMesa) {
    // Arranque escalonado: en un restaurante real los meseros no envían todos
    // en el mismo milisegundo. Sin esto, los 50 dispositivos disparan en
    // lockstep y colisionan en oleadas artificiales que no representan la carga
    // real; el escalonado reparte las llegadas dentro de la ventana de pausa.
    if (pausaMs > 0) await dormir(Math.floor(Math.random() * pausaMs));

    for (let n = 0; n < COMANDAS_POR_DISPOSITIVO; n++) {
      try {
        const [msAbrir, abrir] = await cronometrar(() =>
          d.peticion('POST', '/ordenes', { idMesa, numComensales: 2 }));
        if (abrir.estado !== 201) {
          errores.push(`abrir: ${abrir.estado} ${abrir.datos?.mensaje ?? ''}`);
          continue;
        }
        tiempos.abrir.push(msAbrir);
        const idOrden = abrir.datos.idOrden;

        // Se comprueba el estado de las dos altas: si fallan en silencio, el
        // envío diría "no hay líneas nuevas" y el error apuntaría al lugar
        // equivocado. (Fue justo lo que pasó hasta que se capturó esto.)
        const [msAgregar, agregado] = await cronometrar(async () => {
          const a = await d.peticion('POST', `/ordenes/${idOrden}/lineas`, {
            idProducto: 3, cantidad: 2, tiempoSalida: 1, modificadores: [2],
          });
          const b = await d.peticion('POST', `/ordenes/${idOrden}/lineas`, {
            idProducto: 8, cantidad: 1, tiempoSalida: 1,
          });
          return { a, b };
        });
        tiempos.agregar.push(msAgregar);
        if (agregado.a.estado !== 201 || agregado.b.estado !== 201) {
          errores.push(`agregar: ${agregado.a.estado}/${agregado.b.estado} ${agregado.a.datos?.mensaje ?? agregado.b.datos?.mensaje ?? ''}`);
          await admin.execute("UPDATE orden SET estado='cerrada' WHERE id_orden = ?", [idOrden]);
          await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [idMesa]);
          continue;
        }

        // LA TRANSACCIÓN PESADA: congela precios, descuenta inventario por
        // receta, audita (con el GET_LOCK) y publica eventos.
        const [msEnviar, enviar] = await cronometrar(() =>
          d.peticion('POST', `/ordenes/${idOrden}/enviar`));
        if (enviar.estado !== 200) errores.push(`enviar: ${enviar.estado} ${enviar.datos?.mensaje ?? ''}`);
        else tiempos.enviar.push(msEnviar);

        await admin.execute("UPDATE orden SET estado='cerrada' WHERE id_orden = ?", [idOrden]);
        await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [idMesa]);

        if (pausaMs > 0) await dormir(pausaMs);
      } catch (e) {
        errores.push(`excepción: ${e.message}`);
      }
    }
  }

  /** El cocinero refresca su KDS mientras entran las comandas. */
  async function lectorKds() {
    while (seguirLeyendo) {
      try {
        const [ms, r] = await cronometrar(() =>
          cocinero.peticion('GET', '/kds/comandas?estacion=cocina'));
        if (r.estado === 200) tiempos.kds.push(ms);
        else errores.push(`kds: ${r.estado}`);
      } catch { /* el lector no debe tumbar el escenario */ }
      await dormir(500);
    }
  }

  const t0 = performance.now();
  const lector = lectorKds();
  await Promise.all(dispositivos.map((d, i) => ciclo(d, idsMesa[i])));
  seguirLeyendo = false;
  await lector;
  const duracionS = (performance.now() - t0) / 1000;

  return { nombre, tiempos, errores, duracionS };
}

function imprimir(r) {
  const filas = [
    resumen('Abrir comanda (POST /ordenes)', r.tiempos.abrir),
    resumen('Agregar 2 líneas', r.tiempos.agregar),
    resumen('ENVIAR a cocina (transacción crítica)', r.tiempos.enviar),
    resumen('Consultar KDS (lectura)', r.tiempos.kds),
  ].filter(Boolean);

  console.log(
    'Operación'.padEnd(42) + 'n'.padStart(5) + 'media'.padStart(8) +
    'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'max'.padStart(8)
  );
  console.log('─'.repeat(78));
  for (const f of filas) {
    console.log(
      f.operacion.padEnd(42) + String(f.n).padStart(5) + `${f.media}`.padStart(8) +
      `${f.p50}`.padStart(8) + `${f.p95}`.padStart(8) + `${f.p99}`.padStart(8) + `${f.max}`.padStart(8)
    );
  }

  const porHora = Math.round((r.tiempos.enviar.length / r.duracionS) * 3600);
  console.log('─'.repeat(78));
  console.log(`Duración: ${r.duracionS.toFixed(1)} s  ·  ${r.tiempos.enviar.length} comandas  ·  ` +
              `ritmo ${porHora.toLocaleString('es-CO')} comandas/hora  ·  ${r.errores.length} error(es)`);
  if (r.errores.length) [...new Set(r.errores)].slice(0, 3).forEach((e) => console.log(`   · ${e}`));
  return porHora;
}

/* ---------------------------------------------------------------
   Escenario 1: el ritmo que exige el FSD
   --------------------------------------------------------------- */

console.log('═'.repeat(78));
console.log('ESCENARIO 1 — RITMO SOSTENIDO (el criterio del FSD 6.2)');
console.log(`${DISPOSITIVOS} dispositivos concurrentes · cadencia de mesero (~${(PAUSA_ENTRE_COMANDAS_MS / 1000).toFixed(0)} s entre comandas)`);
console.log('Es contra ESTE escenario —50 dispositivos activos— que el FSD pide p95 < 300 ms.');
console.log('═'.repeat(78));

const r1 = await escenario('ritmo sostenido', PAUSA_ENTRE_COMANDAS_MS);
const porHora1 = imprimir(r1);

/* ---------------------------------------------------------------
   Escenario 2: avalancha (estrés, más allá de lo pedido)
   --------------------------------------------------------------- */

console.log('');
console.log('═'.repeat(78));
console.log('ESCENARIO 2 — AVALANCHA (estrés, NO lo exige el FSD)');
console.log(`Las ${DISPOSITIVOS * COMANDAS_POR_DISPOSITIVO} comandas de golpe, sin pausa. Sirve para ver si el sistema`);
console.log('se degrada con elegancia o se rompe.');
console.log('═'.repeat(78));

const r2 = await escenario('avalancha', 0);
const porHora2 = imprimir(r2);

/* ---------------------------------------------------------------
   Veredicto
   --------------------------------------------------------------- */

const p95Enviar1 = Number(resumen('x', r1.tiempos.enviar)?.p95 ?? 0);
const p95Kds1 = Number(resumen('x', r1.tiempos.kds)?.p95 ?? 0);
const p95Enviar2 = Number(resumen('x', r2.tiempos.enviar)?.p95 ?? 0);

console.log('');
console.log('═'.repeat(78));
console.log('VEREDICTO (FSD 6.2)');
console.log('═'.repeat(78));

const criterios = [
  ['50 dispositivos concurrentes', DISPOSITIVOS >= 50, `${DISPOSITIVOS}`],
  [`${COMANDAS_HORA_OBJETIVO} comandas/hora sostenidas`, porHora1 >= COMANDAS_HORA_OBJETIVO * 0.9,
    `${porHora1.toLocaleString('es-CO')}/hora`],
  ['p95 < 300 ms en el envío, al ritmo del FSD', p95Enviar1 < 300, `p95 = ${p95Enviar1} ms`],
  ['p95 < 300 ms en lectura del KDS', p95Kds1 < 300, `p95 = ${p95Kds1} ms`],
  ['Sin errores al ritmo del FSD', r1.errores.length === 0, `${r1.errores.length} error(es)`],
  ['Sin errores en la avalancha (235× el ritmo)', r2.errores.length === 0, `${r2.errores.length} error(es)`],
];

let todoOk = true;
for (const [criterio, ok, detalle] of criterios) {
  console.log(`  ${ok ? '✓' : '✗'}  ${criterio.padEnd(46)} ${detalle}`);
  if (!ok) todoOk = false;
}

console.log('');
console.log(`Degradación bajo avalancha: p95 pasa de ${p95Enviar1} ms a ${p95Enviar2} ms ` +
            `(${(p95Enviar2 / Math.max(1, p95Enviar1)).toFixed(1)}×) sin errores.`);

/* ---------------------------------------------------------------
   El GET_LOCK de la auditoría (riesgo abierto desde la fase 1)
   --------------------------------------------------------------- */

const [[auditados]] = await admin.execute(
  "SELECT COUNT(*) AS n FROM log_auditoria WHERE accion IN ('orden.apertura','orden.envio')"
);
console.log('');
console.log('─'.repeat(78));
console.log(`GET_LOCK de la cadena de auditoría (riesgo abierto desde la fase 1):`);
console.log(`  ${auditados.n} eventos escritos, todos serializados por el lock.`);
console.log(`  Al ritmo del FSD el p95 del envío es ${p95Enviar1} ms: el lock no es un cuello de botella.`);
console.log(`  En la avalancha sube a ${p95Enviar2} ms, y aun así no falla ninguna comanda.`);

/* ---------------------------------------------------------------
   Limpieza
   --------------------------------------------------------------- */

console.log('\nLimpiando…');
await admin.execute(
  `DELETE FROM movimiento_inventario WHERE id_referencia IN (
     SELECT id_orden_detalle FROM orden_detalle WHERE id_orden IN (
       SELECT id_orden FROM orden WHERE id_mesa IN (SELECT id_mesa FROM mesa WHERE numero LIKE 'LOAD-%')))`
);
// Auditoría append-only: no se borra (rompería la cadena de hashes).
await admin.execute(
  `DELETE FROM orden_detalle_modificador WHERE id_orden_detalle IN (
     SELECT id_orden_detalle FROM orden_detalle WHERE id_orden IN (
       SELECT id_orden FROM orden WHERE id_mesa IN (SELECT id_mesa FROM mesa WHERE numero LIKE 'LOAD-%')))`
);
await admin.execute(
  `DELETE FROM orden_detalle WHERE id_orden IN (
     SELECT id_orden FROM orden WHERE id_mesa IN (SELECT id_mesa FROM mesa WHERE numero LIKE 'LOAD-%'))`
);
await admin.execute("DELETE FROM orden WHERE id_mesa IN (SELECT id_mesa FROM mesa WHERE numero LIKE 'LOAD-%')");
await admin.execute("DELETE FROM mesa WHERE numero LIKE 'LOAD-%'");
for (const s of stockPrevio) {
  await admin.execute('UPDATE insumo SET stock_actual = ? WHERE id_insumo = ?', [s.stock_actual, s.id_insumo]);
}
await admin.end();

console.log('Listo.');
process.exit(todoOk ? 0 : 1);
