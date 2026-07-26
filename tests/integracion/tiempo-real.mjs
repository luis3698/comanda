/**
 * CA-01 y CA-02 — verificación de tiempo real cronometrada.
 *
 *   CA-01: una comanda enviada aparece en el KDS en < 1 s.
 *   CA-02: un plato agotado desaparece de los comanderos en < 1 s.
 *
 * No es un test unitario: necesita el servidor HTTP+WS en pie, así que se
 * ejecuta aparte de `npm test`, con el servidor corriendo:
 *
 *   npm start &            (o node server/index.js)
 *   node tests/integracion/tiempo-real.mjs
 *
 * Abre WebSockets reales como cocinero y como mesero, dispara la acción por
 * HTTP y mide el tiempo hasta que el evento llega al socket. Limpia lo que crea.
 */
import WebSocket from 'ws';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const BASE = 'http://localhost:3000/api/v1';
let fallos = 0;

async function login(cuerpo) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`login falló (${r.status}). ¿El servidor está en pie y la base con el seed?`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: (await r.json()).tokenCsrf };
}

async function req(metodo, ruta, cred, cuerpo) {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', cookie: cred.cookie, 'X-CSRF-Token': cred.csrf },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${metodo} ${ruta}: ${r.status} ${JSON.stringify(datos)}`);
  return datos;
}

function abrirWS(cookie, estacion) {
  const url = estacion
    ? `ws://localhost:3000/realtime?estacion=${estacion}`
    : 'ws://localhost:3000/realtime';
  const ws = new WebSocket(url, { headers: { cookie } });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function esperarEvento(ws, tipo, desde) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout (5 s) esperando "${tipo}"`)), 5000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.tipo === tipo) { clearTimeout(t); resolve({ ms: Date.now() - desde, datos: msg.datos }); }
    });
  });
}

function comprobar(nombre, ms) {
  const ok = ms < 1000;
  if (!ok) fallos++;
  console.log(`  ${ok ? '✓' : '✗ FALLA'}  ${nombre}: ${ms} ms  (límite < 1000 ms)`);
}

const admin = await login({ correo: 'admin@sigr.local', password: 'Admin123!' });
const mesero = await login({ documento: 'CC1004', pin: '4444' });
const cocinero = await login({ documento: 'CC1003', pin: '3333' });

// Zona donde colgar la mesa de prueba. El seed ya no siembra ninguna, así que
// se reutiliza la primera que haya o se crea una.
const plano = await req('GET', '/salon/zonas?todas=1', admin);
const idZona = plano.zonas[0]?.id
  ?? (await req('POST', '/salon/zonas', admin, { nombre: 'Zona de pruebas', ordenVisual: 0 })).id;

// Mesa y comanda de prueba con un plato de cocina.
const mesa = await req('POST', '/salon/mesas', admin, {
  idZona, numero: 'CA-RT', forma: 'redonda', capacidad: 4, posX: 85, posY: 85, ancho: 5, alto: 5,
});
const orden = await req('POST', '/ordenes', mesero, { idMesa: mesa.id, numComensales: 2 });
await req('POST', `/ordenes/${orden.idOrden}/lineas`, mesero, {
  idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
});

console.log('CA-01 — comanda enviada llega al KDS:');
const wsCocina = await abrirWS(cocinero.cookie, 'cocina');
await new Promise((r) => setTimeout(r, 200));
{
  const t0 = Date.now();
  const p = esperarEvento(wsCocina, 'orden.enviada', t0);
  await req('POST', `/ordenes/${orden.idOrden}/enviar`, mesero, {});
  const { ms, datos } = await p;
  comprobar('la comanda llega a cocina', ms);
  console.log(`      recibido: ${datos.lineas[0].cantidad}× ${datos.lineas[0].producto}, mesa ${datos.mesa}`);
}

console.log('CA-02 — plato agotado desaparece del comandero:');
const wsMesero = await abrirWS(mesero.cookie);
await new Promise((r) => setTimeout(r, 200));
{
  const t0 = Date.now();
  const p = esperarEvento(wsMesero, 'producto.agotado', t0);
  await req('PATCH', '/kds/productos/4/disponibilidad', cocinero, { disponible: false });
  const { ms, datos } = await p;
  comprobar('el "agotado" llega al mesero', ms);
  console.log(`      recibido: ${datos.nombre}, disponible=${datos.disponible}`);
  await req('PATCH', '/kds/productos/4/disponibilidad', cocinero, { disponible: true });
}

wsCocina.close();
wsMesero.close();

// Limpieza con credencial root: la app no puede borrar kárdex ni auditoría.
const admincx = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3307),
  user: 'root', password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
  database: process.env.DB_NAME || 'sigr',
});
const [dets] = await admincx.execute('SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?', [orden.idOrden]);
for (const d of dets) {
  await admincx.execute('DELETE FROM movimiento_inventario WHERE id_referencia = ?', [d.id_orden_detalle]);
  await admincx.execute('DELETE FROM orden_detalle_modificador WHERE id_orden_detalle = ?', [d.id_orden_detalle]);
}
await admincx.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [orden.idOrden]);
// Auditoría append-only: no se borra (rompería la cadena de hashes).
await admincx.execute('DELETE FROM orden WHERE id_orden = ?', [orden.idOrden]);
await admincx.execute('DELETE FROM mesa WHERE id_mesa = ?', [mesa.id]);
await admincx.end();

console.log(`\n${fallos === 0 ? '✓ CA-01 y CA-02 cumplidos' : `✗ ${fallos} criterio(s) fuera de límite`}`);
process.exit(fallos === 0 ? 0 : 1);
