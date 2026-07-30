/**
 * Conecta el servidor con Firebase Cloud Messaging.
 *
 * POR QUE ESTO EXISTE
 * Las tres variables de FCM salen de un JSON que descarga la consola de
 * Firebase, y copiarlas a mano falla casi siempre por el mismo sitio: la clave
 * privada tiene saltos de línea reales y en un `.env` deben ir escapados como
 * `\n`, en una sola línea y entre comillas. Un salto perdido y la firma RS256
 * no valida, con un error de Google que no menciona el formato para nada.
 *
 * Este guion lee el JSON, escribe las tres variables bien formadas y comprueba
 * contra Google que funcionan. La clave privada nunca se imprime.
 *
 * Uso:
 *   node scripts/firebase.js "C:/ruta/al/serviceAccount.json"   conectar
 *   node scripts/firebase.js --probar                           solo comprobar
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUTA_ENV = path.join(RAIZ, '.env');

const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const AMBITO = 'https://www.googleapis.com/auth/firebase.messaging';

const c = process.stdout.isTTY
  ? { rojo: '\x1b[31m', verde: '\x1b[32m', ambar: '\x1b[33m', gris: '\x1b[90m', fuerte: '\x1b[1m', fin: '\x1b[0m' }
  : { rojo: '', verde: '', ambar: '', gris: '', fuerte: '', fin: '' };

const bien = (t) => console.log(`  ${c.verde}✓${c.fin} ${t}`);
const nota = (t) => console.log(`  ${c.gris}${t}${c.fin}`);

/**
 * Aborta con un mensaje y sus pistas.
 *
 * LANZA en lugar de llamar a process.exit(). En Windows, matar el proceso con
 * el socket de `fetch` todavía en el pool hace que Node imprima
 * «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)» DESPUÉS del mensaje,
 * lo que parece un fallo del guion cuando no lo es. Dejando que el bucle de
 * eventos se vacíe solo, la salida queda limpia.
 */
class Aborta extends Error {
  constructor(titulo, pistas) { super(titulo); this.pistas = pistas; }
}

function morir(titulo, ...pistas) {
  throw new Aborta(titulo, pistas);
}

/* =====================================================================
   Comprobar contra Google
   ===================================================================== */

const base64url = (d) => Buffer.from(d).toString('base64url');

/**
 * Pide un token de acceso a Google con las credenciales dadas.
 *
 * Es la misma operación que hace `servicios/push.js` en cada envío, así que si
 * esto pasa, el push funciona. Se comprueba ANTES de dar nada por bueno: una
 * credencial mal copiada que solo falla al enviar la primera promoción es un
 * fallo que se descubre en el peor momento.
 */
async function probarCredenciales({ clientEmail, privateKey }) {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = base64url(JSON.stringify({
    iss: clientEmail, scope: AMBITO, aud: URL_TOKEN, iat: ahora, exp: ahora + 3600,
  }));

  let jwt;
  try {
    const material = `${cabecera}.${cuerpo}`;
    const firma = crypto.createSign('RSA-SHA256').update(material).sign(privateKey).toString('base64url');
    jwt = `${material}.${firma}`;
  } catch (e) {
    return { ok: false, motivo: `la clave privada no es válida (${e.message})` };
  }

  const r = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  // El cuerpo se consume SIEMPRE, incluso cuando no interesa: dejarlo sin leer
  // mantiene viva la conexión del pool y, al salir con process.exit, Node
  // imprime una aserción de libuv («UV_HANDLE_CLOSING») justo después del
  // mensaje de éxito, como si algo hubiera fallado.
  const cuerpoTexto = await r.text();

  if (!r.ok) return { ok: false, motivo: `Google respondió ${r.status}: ${cuerpoTexto.slice(0, 200)}` };
  return { ok: true };
}

/* =====================================================================
   Escribir el .env
   ===================================================================== */

/**
 * Sustituye una variable en el texto del .env, o la añade si no estaba.
 * Se conserva todo lo demás intacto, comentarios incluidos: el .env del usuario
 * es suyo y este guion solo viene a tocar tres líneas.
 */
function fijarVariable(texto, clave, valor) {
  const linea = `${clave}=${valor}`;
  const patron = new RegExp(`^${clave}=.*$`, 'm');
  return patron.test(texto) ? texto.replace(patron, linea) : `${texto.replace(/\s*$/, '')}\n${linea}\n`;
}

/* =====================================================================
   Principal
   ===================================================================== */

function mostrarAyuda() {
  console.log(`
${c.fuerte}Conectar las notificaciones push${c.fin}

  1. Consola de Firebase → Configuración del proyecto → Cuentas de servicio
  2. «Generar nueva clave privada» → descarga un .json
  3. Ejecute:

       node scripts/firebase.js "C:/Users/usted/Downloads/xxx.json"

  Para comprobar unas credenciales ya puestas:

       node scripts/firebase.js --probar
`);
}

/* --- Modo comprobación ------------------------------------------------ */

async function comprobar() {
  const { config } = await import('dotenv');
  config({ path: RUTA_ENV });

  const projectId = process.env.FCM_PROJECT_ID || '';
  const clientEmail = process.env.FCM_CLIENT_EMAIL || '';
  const privateKey = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  console.log(`\n${c.fuerte}Comprobando las credenciales del .env${c.fin}\n`);

  if (!projectId || !clientEmail || !privateKey) {
    morir('Faltan variables en el .env.',
      `FCM_PROJECT_ID   ${projectId ? '✓' : '✗ vacía'}`,
      `FCM_CLIENT_EMAIL ${clientEmail ? '✓' : '✗ vacía'}`,
      `FCM_PRIVATE_KEY  ${privateKey ? '✓' : '✗ vacía'}`,
      '',
      'Ejecute: node scripts/firebase.js "ruta/al/serviceAccount.json"');
  }

  bien(`proyecto ${projectId}`);
  bien(`cuenta   ${clientEmail}`);

  const r = await probarCredenciales({ clientEmail, privateKey });
  if (!r.ok) {
    morir('Google rechazó las credenciales.', r.motivo, '',
      'Lo más común es que la clave privada perdiera sus saltos al copiarla.',
      'Vuelva a ejecutar el guion con el .json y lo hará él.');
  }

  console.log(`\n${c.verde}${c.fuerte}Las notificaciones push están conectadas.${c.fin}\n`);
}

/* --- Modo conexión ---------------------------------------------------- */

async function conectar(argumento) {
const rutaJson = path.resolve(argumento);

if (!existsSync(rutaJson)) {
  morir(`No encuentro el archivo:\n  ${rutaJson}`,
    'Ponga la ruta entre comillas si tiene espacios.');
}

let cuenta;
try {
  cuenta = JSON.parse(await readFile(rutaJson, 'utf8'));
} catch (e) {
  morir('Ese archivo no es un JSON válido.', e.message);
}

console.log(`\n${c.fuerte}Conectando Firebase${c.fin}\n`);

// El error clásico: descargar el google-services.json (que es del cliente
// Android) creyendo que sirve para el servidor. Se distingue y se dice.
if (cuenta.project_info || cuenta.client) {
  morir('Ese es el google-services.json, que es de la app Android.',
    'El servidor necesita OTRO archivo, el de la cuenta de servicio:',
    '',
    '  Consola de Firebase → Configuración del proyecto',
    '  → pestaña «Cuentas de servicio» → «Generar nueva clave privada»',
    '',
    'El bueno empieza por  { "type": "service_account", ...');
}

if (cuenta.type !== 'service_account') {
  morir('Este JSON no es de una cuenta de servicio.',
    `Su campo "type" dice: ${cuenta.type ?? '(no tiene)'}`,
    'Debería decir "service_account".');
}

for (const campo of ['project_id', 'client_email', 'private_key']) {
  if (!cuenta[campo]) morir(`Al JSON le falta el campo "${campo}".`);
}

bien(`proyecto ${cuenta.project_id}`);
bien(`cuenta   ${cuenta.client_email}`);
nota(`clave privada leída (${cuenta.private_key.length} caracteres, no se muestra)`);

console.log('\nComprobando contra Google…');
const prueba = await probarCredenciales({
  clientEmail: cuenta.client_email,
  privateKey: cuenta.private_key,
});

if (!prueba.ok) {
  morir('Google rechazó estas credenciales. No se ha tocado el .env.', prueba.motivo, '',
    'Si la clave se revocó desde la consola, genere otra.');
}
bien('Google las acepta');

if (!existsSync(RUTA_ENV)) {
  morir('No hay .env en la raíz del proyecto.', 'Créelo primero:  cp .env.example .env');
}

let env = await readFile(RUTA_ENV, 'utf8');
env = fijarVariable(env, 'FCM_PROJECT_ID', cuenta.project_id);
env = fijarVariable(env, 'FCM_CLIENT_EMAIL', cuenta.client_email);
// Los saltos van escapados y todo entre comillas: es lo que `push.js` deshace
// con .replace(/\\n/g, '\n') al arrancar.
env = fijarVariable(env, 'FCM_PRIVATE_KEY', `"${cuenta.private_key.replace(/\n/g, '\\n')}"`);
await writeFile(RUTA_ENV, env, 'utf8');

bien('.env actualizado');

console.log(`
${c.verde}${c.fuerte}Listo. Las notificaciones push están conectadas.${c.fin}

  Reinicie el servidor para que las lea:

    ${c.fuerte}docker compose up -d --build api${c.fin}

  ${c.ambar}Guarde ese .json fuera del repositorio y no lo comparta:${c.fin}
  ${c.ambar}contiene una clave privada que permite enviar en su nombre.${c.fin}
`);
}

/* =====================================================================
   Despachador
   ===================================================================== */

const argumento = process.argv[2];

try {
  if (!argumento || argumento === '--ayuda' || argumento === '-h') {
    mostrarAyuda();
  } else if (argumento === '--probar') {
    await comprobar();
  } else {
    await conectar(argumento);
  }
} catch (e) {
  if (e instanceof Aborta) {
    console.error(`\n${c.rojo}${c.fuerte}✗ ${e.message}${c.fin}`);
    for (const p of e.pistas) console.error(`  ${p}`);
    console.error('');
  } else {
    console.error(`\n${c.rojo}${c.fuerte}✗ Error inesperado${c.fin}\n  ${e.message}\n`);
  }
  // `exitCode` y no `exit()`: así el proceso termina cuando el bucle de eventos
  // se vacía, sin la aserción de libuv que Node imprime al matarlo con el
  // socket de `fetch` todavía abierto.
  process.exitCode = 1;
}
