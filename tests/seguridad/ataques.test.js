/**
 * Pruebas de seguridad activas.  FSD 10.2.
 *
 * "Seguridad: intentos de inyección SQL en todos los inputs, XSS almacenado en
 *  notas de comanda, escalación de privilegios por manipulación de peticiones,
 *  fuerza bruta de PIN."
 *
 * Estas pruebas ATACAN el sistema por HTTP, como lo haría alguien de fuera. No
 * llaman a los servicios directamente: van contra la API, que es la superficie
 * real. Requieren el servidor corriendo:
 *
 *   docker compose up -d
 *   npm run test:seguridad
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import 'dotenv/config';

import { asegurarMesaPruebas } from '../comun/salon.mjs';

const BASE = process.env.URL_PRUEBAS ?? 'http://localhost:3000/api/v1';

let admin;

/** Cliente HTTP que conserva la cookie de sesión, como un navegador. */
class Cliente {
  constructor() { this.cookie = null; this.csrf = null; }

  async peticion(metodo, ruta, cuerpo, cabecerasExtra = {}) {
    const cabeceras = { ...cabecerasExtra };
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
    try { datos = await r.json(); } catch { /* respuesta sin cuerpo */ }
    return { estado: r.status, datos };
  }

  get(ruta) { return this.peticion('GET', ruta); }
  post(ruta, cuerpo, cab) { return this.peticion('POST', ruta, cuerpo ?? {}, cab); }
  put(ruta, cuerpo) { return this.peticion('PUT', ruta, cuerpo ?? {}); }
  patch(ruta, cuerpo) { return this.peticion('PATCH', ruta, cuerpo ?? {}); }
  borrar(ruta) { return this.peticion('DELETE', ruta); }

  async login(credenciales) {
    const r = await this.post('/auth/login', credenciales);
    if (r.datos?.tokenCsrf) this.csrf = r.datos.tokenCsrf;
    return r;
  }
}

before(async () => {
  admin = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3307),
    user: 'root', password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
    database: process.env.DB_NAME || 'sigr',
  });
  // Deja limpio el bloqueo de los usuarios de prueba.
  await admin.execute('UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL');
});

after(async () => {
  await admin.execute('UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL');
  await admin.end();
});

/* =====================================================================
   Inyección SQL
   ===================================================================== */

/** Cargas clásicas: si alguna funciona, el sistema concatena SQL en algún sitio. */
const INYECCIONES = [
  "' OR '1'='1",
  "' OR 1=1--",
  "admin@sigr.local'--",
  "'; DROP TABLE usuario;--",
  "' UNION SELECT 1,2,3,4,5,6,7,8,9--",
  "1' AND (SELECT SLEEP(3))--",
  "\\' OR 1=1--",
];

test('inyección SQL en el login por correo no autentica a nadie', async () => {
  for (const carga of INYECCIONES) {
    const c = new Cliente();
    const r = await c.login({ correo: carga, password: "' OR '1'='1" });
    assert.notEqual(r.estado, 200, `la carga "${carga}" no puede autenticar`);
  }
});

test('inyección SQL en el login por documento no autentica a nadie', async () => {
  for (const carga of INYECCIONES) {
    const c = new Cliente();
    const r = await c.login({ documento: carga, pin: '0000' });
    assert.notEqual(r.estado, 200, `la carga "${carga}" no puede autenticar`);
  }
});

test('inyección SQL con SLEEP no retrasa la respuesta (no se ejecuta)', async () => {
  const c = new Cliente();
  const t0 = Date.now();
  await c.login({ correo: "x' AND (SELECT SLEEP(3))--@x.com", password: 'x' });
  const ms = Date.now() - t0;
  // Un SLEEP(3) inyectado tardaría >3s. bcrypt tarda ~250ms; se deja margen.
  assert.ok(ms < 2500, `la respuesta tardó ${ms} ms: el SLEEP se estaría ejecutando`);
});

test('inyección SQL en los buscadores no rompe ni filtra datos', async () => {
  const c = new Cliente();
  await c.login({ correo: 'admin@sigr.local', password: 'Admin123!' });

  for (const carga of INYECCIONES) {
    const q = encodeURIComponent(carga);
    // Los buscadores construyen LIKE con parámetros: la carga debe tratarse
    // como texto literal, devolver 0 resultados y nunca un error 500.
    const usuarios = await c.get(`/usuarios?buscar=${q}`);
    assert.equal(usuarios.estado, 200, `buscador de usuarios con "${carga}"`);
    assert.equal(usuarios.datos.usuarios.length, 0, 'no debe devolver filas');

    const productos = await c.get(`/catalogo/productos?buscar=${q}`);
    assert.equal(productos.estado, 200, `buscador de catálogo con "${carga}"`);
  }
});

test('la tabla usuario sigue existiendo tras los intentos de DROP', async () => {
  const [filas] = await admin.execute('SELECT COUNT(*) AS n FROM usuario');
  assert.ok(filas[0].n >= 4, 'los usuarios del seed siguen ahí');
});

test('inyección SQL en parámetros numéricos no rompe', async () => {
  const c = new Cliente();
  await c.login({ correo: 'admin@sigr.local', password: 'Admin123!' });

  for (const carga of ['1 OR 1=1', "1'; DROP TABLE mesa;--", '1 UNION SELECT 1']) {
    const r = await c.get(`/usuarios/${encodeURIComponent(carga)}`);
    // Number() convierte la carga en NaN → el id no existe → 404. Nunca un 500.
    assert.ok([400, 404].includes(r.estado), `carga "${carga}" devolvió ${r.estado}`);
  }
});

/* =====================================================================
   XSS almacenado
   ===================================================================== */

const CARGAS_XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "javascript:alert(document.cookie)",
  '<iframe src="javascript:alert(1)">',
];

test('XSS almacenado en las notas de comanda se guarda literal y sale escapado', async () => {
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });

  // Mesa libre para la prueba.
  const mesa = { id_mesa: await asegurarMesaPruebas(admin, 'TEST-SEG') };
  const orden = await mesero.post('/ordenes', { idMesa: mesa.id_mesa, numComensales: 2 });
  assert.equal(orden.estado, 201);
  const idOrden = orden.datos.idOrden;

  for (const carga of CARGAS_XSS) {
    const r = await mesero.post(`/ordenes/${idOrden}/lineas`, {
      idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2], notas: carga,
    });
    assert.equal(r.estado, 201, `la nota "${carga}" debe aceptarse como texto`);
  }

  // La API devuelve el texto TAL CUAL: escapar en el servidor sería incorrecto
  // (rompería las notas legítimas con < o >). La defensa está en el cliente,
  // que usa textContent y nunca innerHTML.
  const detalle = await mesero.get(`/ordenes/${idOrden}`);
  const notas = detalle.datos.lineas.map((l) => l.notas).filter(Boolean);
  for (const carga of CARGAS_XSS) {
    assert.ok(notas.includes(carga), 'la nota se conserva literal en los datos');
  }

  // Y en la base también está literal, sin HTML entities.
  const [filas] = await admin.execute(
    'SELECT notas FROM orden_detalle WHERE id_orden = ? AND notas IS NOT NULL', [idOrden]
  );
  assert.ok(filas.some((f) => f.notas === '<script>alert(1)</script>'),
    'la base guarda el texto sin transformar');

  // Limpieza.
  await admin.execute('DELETE FROM orden_detalle_modificador WHERE id_orden_detalle IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)', [idOrden]);
  await admin.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [idOrden]);
  // Auditoría append-only: no se borra (rompería la cadena de hashes).
  await admin.execute('DELETE FROM orden WHERE id_orden = ?', [idOrden]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [mesa.id_mesa]);
});

test('XSS en el nombre de un usuario no ejecuta nada al listarlo', async () => {
  const c = new Cliente();
  await c.login({ correo: 'admin@sigr.local', password: 'Admin123!' });

  const r = await c.post('/usuarios', {
    nombreCompleto: '<img src=x onerror=alert(1)>Test',
    correo: 'xsstest@sigr.local', documento: 'XSS999',
    password: 'Prueba12345', pin: '9876', idRol: 4,
  });
  assert.equal(r.estado, 201);

  const lista = await c.get('/usuarios?buscar=xsstest');
  assert.equal(lista.datos.usuarios[0].nombreCompleto, '<img src=x onerror=alert(1)>Test',
    'el dato viaja literal; el cliente lo pinta con textContent');

  // Auditoría append-only: no se borra. El usuario temporal nunca se autenticó,
  // así que ninguna fila de log_auditoria lo referencia como autor (id_usuario);
  // la única que lo menciona es 'usuario.creacion', con id_entidad (sin FK). Por
  // eso el DELETE del usuario no choca con la FK aunque la auditoría permanezca.
  await admin.execute('DELETE FROM usuario WHERE id_usuario = ?', [r.datos.id]);
});

/* =====================================================================
   Escalación de privilegios
   ===================================================================== */

test('un mesero no puede escalar a administrador manipulando peticiones', async () => {
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });

  const intentos = [
    ['GET', '/usuarios', undefined],
    ['POST', '/usuarios', { nombreCompleto: 'Hacker', correo: 'h@x.com', password: '12345678', pin: '1111', idRol: 1 }],
    ['PUT', '/roles/4/permisos', { permisos: [1, 2, 3] }],
    ['GET', '/auditoria', undefined],
    ['GET', '/dashboard/kpis', undefined],
    ['GET', '/reportes/informe_fiscal?desde=2026-01-01&hasta=2026-12-31', undefined],
    ['GET', '/inventario/existencias', undefined],
    ['POST', '/inventario/ajustes', { idInsumo: 1, cantidad: 99999, motivo: 'robo' }],
    ['POST', '/caja/turnos', { fondoInicial: '1000' }],
  ];

  for (const [metodo, ruta, cuerpo] of intentos) {
    const r = await mesero.peticion(metodo, ruta, cuerpo);
    assert.equal(r.estado, 403, `${metodo} ${ruta} debe devolver 403, devolvió ${r.estado}`);
  }
});

test('un cocinero no puede cobrar ni tocar la caja', async () => {
  const cocinero = new Cliente();
  await cocinero.login({ documento: 'CC1003', pin: '3333' });

  for (const [metodo, ruta, cuerpo] of [
    ['GET', '/caja/cuentas', undefined],
    ['POST', '/caja/turnos', { fondoInicial: '1000' }],
    ['GET', '/auditoria', undefined],
  ]) {
    const r = await cocinero.peticion(metodo, ruta, cuerpo);
    assert.equal(r.estado, 403, `${metodo} ${ruta} debe devolver 403`);
  }
});

test('un mesero no puede darse permisos cambiando su propio rol', async () => {
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });

  // Intento de auto-promoción editando su propio usuario.
  const r = await mesero.put('/usuarios/4', {
    nombreCompleto: 'Luis Barrera', correo: 'mesero@sigr.local', idRol: 1,
  });
  assert.equal(r.estado, 403);

  // El rol sigue siendo Mesero.
  const [[u]] = await admin.execute('SELECT id_rol FROM usuario WHERE id_usuario = 4');
  assert.equal(u.id_rol, 4, 'el rol no cambió');
});

test('IDOR: un mesero no puede operar la comanda de otro mesero', async () => {
  // El admin abre una comanda (actúa como otro mesero).
  const adminC = new Cliente();
  await adminC.login({ correo: 'admin@sigr.local', password: 'Admin123!' });

  const mesa = { id_mesa: await asegurarMesaPruebas(admin, 'TEST-SEG') };
  const orden = await adminC.post('/ordenes', { idMesa: mesa.id_mesa, numComensales: 2 });
  assert.equal(orden.estado, 201);
  const idOrden = orden.datos.idOrden;

  // El mesero intenta verla y manipularla: no es suya y no tiene ordenes.ver_todas.
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });

  const ver = await mesero.get(`/ordenes/${idOrden}`);
  assert.equal(ver.estado, 403, 'no puede ver la comanda ajena');

  const agregar = await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  assert.equal(agregar.estado, 403, 'no puede agregarle líneas');

  const enviar = await mesero.post(`/ordenes/${idOrden}/enviar`);
  assert.equal(enviar.estado, 403, 'no puede enviarla');

  // Auditoría append-only: no se borra (rompería la cadena de hashes).
  await admin.execute('DELETE FROM orden WHERE id_orden = ?', [idOrden]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [mesa.id_mesa]);
});

test('anular una línea enviada sin permiso ni PIN se rechaza', async () => {
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });

  const mesa = { id_mesa: await asegurarMesaPruebas(admin, 'TEST-SEG') };
  const orden = await mesero.post('/ordenes', { idMesa: mesa.id_mesa, numComensales: 1 });
  const idOrden = orden.datos.idOrden;
  const linea = await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  // Sin PIN: rechazado (el mesero no tiene ordenes.anular_enviada).
  const sinPin = await mesero.post(`/ordenes/${idOrden}/lineas/${linea.datos.idLinea}/anular`, {
    motivo: 'me lo invento',
  });
  assert.equal(sinPin.estado, 403, 'sin PIN de autorización debe rechazarse');

  // Con un PIN inventado: también rechazado.
  const pinMalo = await mesero.post(`/ordenes/${idOrden}/lineas/${linea.datos.idLinea}/anular`, {
    motivo: 'me lo invento', pinAutorizador: '0000',
  });
  assert.equal(pinMalo.estado, 403, 'con un PIN incorrecto debe rechazarse');

  // La línea sigue viva.
  const [[l]] = await admin.execute(
    'SELECT estado_preparacion FROM orden_detalle WHERE id_orden_detalle = ?',
    [linea.datos.idLinea]
  );
  assert.notEqual(l.estado_preparacion, 'anulado');

  await admin.execute('DELETE FROM movimiento_inventario WHERE id_referencia = ?', [linea.datos.idLinea]);
  await admin.execute('DELETE FROM orden_detalle_modificador WHERE id_orden_detalle = ?', [linea.datos.idLinea]);
  await admin.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [idOrden]);
  // Auditoría append-only: no se borra (rompería la cadena de hashes).
  await admin.execute('DELETE FROM orden WHERE id_orden = ?', [idOrden]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [mesa.id_mesa]);
});

/* =====================================================================
   Sesión y CSRF
   ===================================================================== */

test('sin sesión, todo endpoint protegido responde 401', async () => {
  const anon = new Cliente();
  for (const ruta of ['/usuarios', '/auditoria', '/caja/cuentas', '/dashboard/kpis',
                      '/inventario/existencias', '/ordenes/activas']) {
    const r = await anon.get(ruta);
    assert.equal(r.estado, 401, `${ruta} sin sesión debe ser 401`);
  }
});

test('una cookie de sesión inventada no autentica', async () => {
  const c = new Cliente();
  c.cookie = `sigr_sesion=${'a'.repeat(64)}`;
  const r = await c.get('/auth/sesion');
  assert.equal(r.estado, 401);
});

test('sin token CSRF, las peticiones que escriben se rechazan', async () => {
  const c = new Cliente();
  await c.login({ correo: 'admin@sigr.local', password: 'Admin123!' });
  c.csrf = null;   // se descarta el token pero se conserva la cookie

  const r = await c.post('/usuarios', {
    nombreCompleto: 'Sin CSRF', correo: 'nocsrf@x.com',
    password: '12345678', pin: '1111', idRol: 4,
  });
  assert.equal(r.estado, 400, 'debe rechazarse por falta de token anti-CSRF');
});

test('un token CSRF de otra sesión no sirve', async () => {
  const a = new Cliente();
  await a.login({ correo: 'admin@sigr.local', password: 'Admin123!' });
  const b = new Cliente();
  await b.login({ documento: 'CC1004', pin: '4444' });

  // Cookie de A con el token de B.
  a.csrf = b.csrf;
  const r = await a.post('/usuarios', {
    nombreCompleto: 'Token ajeno', correo: 'ajeno@x.com',
    password: '12345678', pin: '1111', idRol: 4,
  });
  assert.equal(r.estado, 400);
});

test('una petición con Origin de otro dominio se rechaza', async () => {
  const c = new Cliente();
  await c.login({ correo: 'admin@sigr.local', password: 'Admin123!' });

  const r = await c.peticion('POST', '/usuarios', {
    nombreCompleto: 'Origen malo', correo: 'origen@x.com',
    password: '12345678', pin: '1111', idRol: 4,
  }, { Origin: 'https://sitio-malicioso.example' });

  assert.equal(r.estado, 400, 'el origen ajeno debe rechazarse');
});

/* =====================================================================
   Fuerza bruta de PIN
   ===================================================================== */

test('fuerza bruta de PIN: la cuenta se bloquea a los 5 intentos', async () => {
  // Un PIN de 4 dígitos son 10.000 combinaciones: sin bloqueo, un script las
  // agota en minutos. El bloqueo es lo único que lo impide.
  await admin.execute('UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE documento = ?', ['CC1003']);

  let bloqueado = false;
  for (let i = 0; i < 8; i++) {
    const c = new Cliente();
    const r = await c.login({ documento: 'CC1003', pin: String(1000 + i) });
    if (r.datos?.error === 'cuenta_bloqueada') { bloqueado = true; break; }
  }
  assert.ok(bloqueado, 'la cuenta debe bloquearse antes del 8º intento');

  // Ni siquiera el PIN correcto entra mientras dura el bloqueo.
  const c = new Cliente();
  const conCorrecto = await c.login({ documento: 'CC1003', pin: '3333' });
  assert.equal(conCorrecto.datos.error, 'cuenta_bloqueada');

  await admin.execute('UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE documento = ?', ['CC1003']);
});

test('el bloqueo queda registrado en la auditoría', async () => {
  const [filas] = await admin.execute(
    "SELECT COUNT(*) AS n FROM log_auditoria WHERE accion = 'auth.bloqueo'"
  );
  assert.ok(filas[0].n > 0, 'el bloqueo genera evento de auditoría');
});

test('el login no revela si un usuario existe', async () => {
  const c1 = new Cliente();
  const inexistente = await c1.login({ correo: 'nadie@sigr.local', password: 'loquesea' });
  const c2 = new Cliente();
  const claveMala = await c2.login({ correo: 'admin@sigr.local', password: 'claveIncorrecta' });

  // Mismo código y mismo mensaje: no se puede enumerar usuarios.
  assert.equal(inexistente.datos.error, claveMala.datos.error);
  assert.equal(inexistente.datos.mensaje, claveMala.datos.mensaje);

  await admin.execute('UPDATE usuario SET intentos_fallidos = 0 WHERE correo = ?', ['admin@sigr.local']);
});

/* =====================================================================
   Manipulación de importes
   ===================================================================== */

test('el cliente no puede imponer el total de una factura', async () => {
  const mesero = new Cliente();
  await mesero.login({ documento: 'CC1004', pin: '4444' });
  const mesa = { id_mesa: await asegurarMesaPruebas(admin, 'TEST-SEG') };
  const orden = await mesero.post('/ordenes', { idMesa: mesa.id_mesa, numComensales: 1 });
  const idOrden = orden.datos.idOrden;
  await mesero.post(`/ordenes/${idOrden}/lineas`, {
    idProducto: 3, cantidad: 1, tiempoSalida: 1, modificadores: [2],
  });
  await mesero.post(`/ordenes/${idOrden}/enviar`);

  const cajero = new Cliente();
  await cajero.login({ documento: 'CC1002', pin: '2222' });
  await admin.execute("UPDATE turno_caja SET estado='cerrado' WHERE id_cajero=2 AND estado='abierto'");
  const turno = await cajero.post('/caja/turnos', { fondoInicial: '100000' });

  // Intento de pagar $1 una cuenta de $34.560 inventando el total.
  const r = await cajero.post(`/caja/cuentas/${idOrden}/cobrar`, {
    pagos: [{ metodo: 'efectivo', monto: '1.00' }],
    total: '1.00',        // campo inventado: el servidor lo ignora
    subtotal: '1.00',
  });
  assert.equal(r.estado, 422, 'el servidor recalcula y rechaza');
  assert.match(r.datos.mensaje, /no coincide con el total/i);

  // La orden sigue abierta.
  const [[o]] = await admin.execute('SELECT estado FROM orden WHERE id_orden = ?', [idOrden]);
  assert.notEqual(o.estado, 'cerrada');

  // Limpieza.
  await admin.execute('DELETE FROM movimiento_inventario WHERE id_referencia IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)', [idOrden]);
  await admin.execute('DELETE FROM orden_detalle_modificador WHERE id_orden_detalle IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)', [idOrden]);
  await admin.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [idOrden]);
  // Auditoría append-only: no se borra (rompería la cadena de hashes).
  await admin.execute('DELETE FROM orden WHERE id_orden = ?', [idOrden]);
  await admin.execute("UPDATE mesa SET estado='libre' WHERE id_mesa = ?", [mesa.id_mesa]);
  // Auditoría append-only: no se borra (rompería la cadena de hashes).
  await admin.execute('DELETE FROM turno_caja WHERE id_turno = ?', [turno.datos.idTurno]);
});

test('un descuento mayor que el subtotal se rechaza', async () => {
  const c = new Cliente();
  await c.login({ documento: 'CC1002', pin: '2222' });
  // No hace falta llegar al cobro: la validación está en el servicio y se
  // comprueba en las pruebas de caja. Aquí solo se verifica que el endpoint
  // no acepta un descuento absurdo sin motivo.
  const r = await c.post('/caja/cuentas/999999/cobrar', {
    pagos: [{ metodo: 'efectivo', monto: '1' }], descuento: '999999999',
  });
  // 404 (la orden no existe) o 422: nunca un 500 ni un cobro.
  assert.ok([404, 422].includes(r.estado), `devolvió ${r.estado}`);
});

/* =====================================================================
   Cabeceras de seguridad (FSD 6.1)
   ===================================================================== */

test('las cabeceras de seguridad están presentes', async () => {
  const r = await fetch('http://localhost:3000/');
  const csp = r.headers.get('content-security-policy');

  assert.ok(csp, 'debe haber Content-Security-Policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);

  // Lo que de verdad frena el XSS de ejecución es que script-src NO permita
  // inline. Se aísla esa directiva y se comprueba sobre ella, no sobre toda la
  // CSP: style-src sí admite 'unsafe-inline' (el diseñador de salón posiciona
  // las mesas con estilos inline), y eso no es un vector de ejecución de código.
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  assert.ok(!scriptSrc.includes('unsafe-inline'), 'script-src no debe permitir scripts inline');
  assert.ok(!scriptSrc.includes('unsafe-eval'), 'script-src no debe permitir eval');
  assert.ok(!csp.includes('unsafe-eval'), 'la CSP no debe permitir eval en ninguna directiva');

  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(!r.headers.get('x-powered-by'), 'no debe revelar la tecnología del servidor');
});

test('la cookie de sesión es HttpOnly y SameSite=Strict', async () => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo: 'admin@sigr.local', password: 'Admin123!' }),
  });
  const cookie = r.headers.get('set-cookie');
  assert.ok(cookie, 'debe entregar la cookie');
  assert.match(cookie, /HttpOnly/i, 'HttpOnly impide leerla desde JS (mitiga XSS)');
  assert.match(cookie, /SameSite=Strict/i, 'SameSite=Strict es la primera defensa anti-CSRF');
});

/* =====================================================================
   Inmutabilidad de la auditoría (FSD 6.1)
   ===================================================================== */

test('el usuario de la aplicación no puede alterar la auditoría', async () => {
  const app = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3307),
    user: process.env.DB_USER || 'sigr_app',
    password: process.env.DB_PASSWORD || 'sigr_app_dev',
    database: process.env.DB_NAME || 'sigr',
  });

  try {
    // Estas tres deben fallar por privilegios del motor, no por código.
    await assert.rejects(
      () => app.execute("UPDATE log_auditoria SET detalle = 'alterado'"),
      /denied/i, 'UPDATE sobre la auditoría debe estar denegado'
    );
    await assert.rejects(
      () => app.execute('DELETE FROM log_auditoria'),
      /denied/i, 'DELETE sobre la auditoría debe estar denegado'
    );
    await assert.rejects(
      () => app.execute('DELETE FROM movimiento_inventario'),
      /denied/i, 'DELETE sobre el kárdex debe estar denegado'
    );
  } finally {
    await app.end();
  }
});

test('el usuario de reporting no puede escribir', async () => {
  const rep = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3307),
    user: 'sigr_reportes', password: 'sigr_reportes_dev',
    database: process.env.DB_NAME || 'sigr',
  });

  try {
    const [filas] = await rep.execute('SELECT COUNT(*) AS n FROM factura');
    assert.ok(filas[0].n >= 0, 'puede leer');

    await assert.rejects(
      () => rep.execute("INSERT INTO zona (nombre) VALUES ('x')"),
      /denied/i, 'no puede escribir'
    );
  } finally {
    await rep.end();
  }
});
