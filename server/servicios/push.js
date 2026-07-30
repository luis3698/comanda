/**
 * Notificaciones al cliente: bandeja in-app + push por Firebase (FCM).
 *
 * ORDEN DE LAS OPERACIONES -- IMPORTA
 * Primero se ESCRIBE la notificacion en `notificacion_cliente`, y solo despues
 * se intenta el push. Nunca al reves. El push es el canal poco fiable: puede
 * no haber credenciales configuradas, el token puede haber caducado, el movil
 * puede tener los avisos silenciados o estar sin datos. La bandeja es la que
 * garantiza que el cliente se entera al abrir la aplicacion. Si el push falla,
 * se registra en consola y ya: NINGUN fallo de FCM debe tumbar la operacion de
 * negocio que la origino. Que una reserva se confirme no puede depender de que
 * Google responda.
 *
 * POR QUE NO SE USA `firebase-admin`
 * FCM HTTP v1 solo necesita un token OAuth2 obtenido con un JWT firmado por la
 * cuenta de servicio. Son unas 30 lineas con `node:crypto`, frente a las
 * decenas de megas de dependencias transitivas que arrastra el SDK oficial
 * para, al final, hacer un POST. Es la misma postura que el proyecto ya tomo
 * al escribir a mano las cabeceras de seguridad en vez de usar helmet
 * (ver server/index.js). El token de acceso se cachea porque dura una hora:
 * pedir uno nuevo por cada notificacion seria una llamada de red de mas.
 *
 * SIN CREDENCIALES, EL SISTEMA FUNCIONA IGUAL
 * Si faltan FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY, este modulo
 * se queda en modo bandeja: escribe la notificacion, avisa una sola vez por
 * consola y sigue. Es lo que permite desarrollar y demostrar el sistema
 * completo sin abrir una cuenta de Firebase.
 */
import crypto from 'node:crypto';
import { consultar, pool } from '../db.js';

const PROJECT_ID = process.env.FCM_PROJECT_ID || '';
const CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL || '';
// En un .env la clave va en una sola linea con \n escapados; hay que
// devolverle los saltos reales o crypto no la reconoce como PEM.
const PRIVATE_KEY = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const AMBITO = 'https://www.googleapis.com/auth/firebase.messaging';

/** ¿Hay credenciales suficientes para hablar con FCM? */
export function pushConfigurado() {
  return Boolean(PROJECT_ID && CLIENT_EMAIL && PRIVATE_KEY);
}

let avisadoSinConfigurar = false;

function avisarSinConfigurar() {
  if (avisadoSinConfigurar) return;
  avisadoSinConfigurar = true;
  console.warn(
    '[push] FCM no esta configurado (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY). ' +
    'Las notificaciones se guardan en la bandeja de la aplicacion pero no se envian al movil.'
  );
}

/* =====================================================================
   Token de acceso OAuth2
   ===================================================================== */

let tokenCache = null;
let tokenExpiraEn = 0;

const base64url = (dato) => Buffer.from(dato).toString('base64url');

/** Firma el JWT que Google canjea por un token de acceso. */
function construirJwt() {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: AMBITO,
    aud: URL_TOKEN,
    iat: ahora,
    exp: ahora + 3600,
  }));

  const material = `${cabecera}.${cuerpo}`;
  const firma = crypto.createSign('RSA-SHA256').update(material).sign(PRIVATE_KEY).toString('base64url');
  return `${material}.${firma}`;
}

/**
 * Token de acceso vigente, pidiendolo a Google si hace falta.
 * Se renueva 5 min antes de caducar para no usar uno que expire justo en
 * medio de un envio masivo.
 */
async function tokenDeAcceso() {
  if (tokenCache && Date.now() < tokenExpiraEn) return tokenCache;

  const respuesta = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: construirJwt(),
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`FCM: no se pudo obtener el token de acceso (${respuesta.status}): ${detalle}`);
  }

  const datos = await respuesta.json();
  tokenCache = datos.access_token;
  tokenExpiraEn = Date.now() + (Number(datos.expires_in || 3600) - 300) * 1000;
  return tokenCache;
}

/* =====================================================================
   Envio
   ===================================================================== */

/** Desactiva un token que FCM ya no reconoce. */
async function desactivarToken(token) {
  await pool
    .execute('UPDATE dispositivo_cliente SET activo = FALSE WHERE token_fcm = ?', [token])
    .catch(() => {});
}

/**
 * Envia a un token concreto.
 * @returns {Promise<boolean>} si FCM lo acepto.
 */
async function enviarAToken(accessToken, token, { titulo, cuerpo, datos }) {
  const respuesta = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: titulo, body: cuerpo },
          // FCM exige que todos los valores de `data` sean cadenas.
          data: Object.fromEntries(
            Object.entries(datos ?? {}).map(([k, v]) => [k, String(v)])
          ),
          android: {
            priority: 'high',
            notification: {
              // Mismo verde del sistema (--c-primario de public/css/base.css).
              color: '#0f766e',
              // Agrupa por tipo en la bandeja de Android en vez de apilar
              // veinte notificaciones sueltas.
              tag: String(datos?.tipo ?? 'sigr'),
            },
          },
        },
      }),
    }
  );

  if (respuesta.ok) return true;

  const detalle = await respuesta.text();

  // 404 UNREGISTERED o 400 INVALID_ARGUMENT: el token murio (la app se
  // desinstalo, o los datos se borraron). Se desactiva para no reintentar
  // contra el en cada envio futuro.
  if (respuesta.status === 404 || respuesta.status === 400) {
    await desactivarToken(token);
    return false;
  }

  console.error(`[push] fallo al enviar (${respuesta.status}): ${detalle}`);
  return false;
}

/**
 * Envia una notificacion a todos los dispositivos activos de un cliente.
 * Devuelve cuantos envios acepto FCM. No lanza nunca: un fallo de push no debe
 * propagarse a la operacion de negocio.
 */
async function enviarACliente(idCliente, contenido) {
  if (!pushConfigurado()) {
    avisarSinConfigurar();
    return 0;
  }

  const dispositivos = await consultar(
    'SELECT token_fcm FROM dispositivo_cliente WHERE id_cliente = ? AND activo = TRUE',
    [idCliente]
  );
  if (!dispositivos.length) return 0;

  try {
    const accessToken = await tokenDeAcceso();
    const resultados = await Promise.all(
      dispositivos.map((d) => enviarAToken(accessToken, d.token_fcm, contenido).catch(() => false))
    );
    return resultados.filter(Boolean).length;
  } catch (error) {
    console.error('[push] no se pudo enviar:', error.message);
    return 0;
  }
}

/* =====================================================================
   API del modulo
   ===================================================================== */

/**
 * Notifica a un cliente: guarda en la bandeja y, si se puede, envia el push.
 *
 * @param {number} idCliente
 * @param {object} aviso
 * @param {'reserva'|'pedido'|'promocion'|'sistema'} aviso.tipo
 * @param {string} aviso.titulo
 * @param {string} aviso.cuerpo
 * @param {string} [aviso.referencia]  Codigo de la reserva o del pedido.
 * @returns {Promise<{idNotificacion: number, enviados: number}>}
 */
export async function notificar(idCliente, { tipo = 'sistema', titulo, cuerpo, referencia = null }) {
  // 1. La bandeja primero: es lo que no puede fallar.
  const [r] = await pool.execute(
    `INSERT INTO notificacion_cliente (id_cliente, tipo, titulo, cuerpo, referencia)
     VALUES (?, ?, ?, ?, ?)`,
    [idCliente, tipo, String(titulo).slice(0, 120), String(cuerpo).slice(0, 255), referencia]
  );

  // 2. El push despues, sin bloquear ni propagar errores.
  const enviados = await enviarACliente(idCliente, {
    titulo,
    cuerpo,
    datos: { tipo, referencia: referencia ?? '', idNotificacion: r.insertId },
  });

  return { idNotificacion: r.insertId, enviados };
}

/**
 * Difunde una promocion a todos los clientes que las aceptan.
 *
 * Se recorre cliente a cliente en vez de usar un `topic` de FCM porque cada
 * uno necesita su fila en la bandeja: sin ella, quien tuviera el movil apagado
 * no se enteraria nunca de la promocion.
 *
 * @returns {Promise<{clientes: number, enviados: number}>}
 */
export async function difundirPromocion({ titulo, cuerpo, referencia = null }) {
  const clientes = await consultar(
    'SELECT id_cliente FROM cliente WHERE activo = TRUE AND acepta_promociones = TRUE'
  );

  let enviados = 0;
  for (const c of clientes) {
    const r = await notificar(c.id_cliente, { tipo: 'promocion', titulo, cuerpo, referencia })
      .catch((e) => {
        console.error('[push] fallo al notificar la promocion:', e.message);
        return { enviados: 0 };
      });
    enviados += r.enviados;
  }

  return { clientes: clientes.length, enviados };
}

/* =====================================================================
   Bandeja y dispositivos
   ===================================================================== */

/** Notificaciones del cliente, mas recientes primero. */
export async function listarNotificaciones(idCliente, { limite = 50 } = {}) {
  const l = Math.min(100, Math.max(1, Number(limite) || 50));
  const filas = await consultar(
    `SELECT id_notificacion, tipo, titulo, cuerpo, referencia, leida, creado_en
       FROM notificacion_cliente
      WHERE id_cliente = ?
      ORDER BY creado_en DESC
      LIMIT ${l}`,
    [idCliente]
  );
  return filas.map((n) => ({
    id: n.id_notificacion,
    tipo: n.tipo,
    titulo: n.titulo,
    cuerpo: n.cuerpo,
    referencia: n.referencia,
    leida: Boolean(n.leida),
    creadoEn: n.creado_en,
  }));
}

/** Cuantas quedan sin leer. Alimenta el globo del icono en la app. */
export async function contarNoLeidas(idCliente) {
  const filas = await consultar(
    'SELECT COUNT(*) AS n FROM notificacion_cliente WHERE id_cliente = ? AND leida = FALSE',
    [idCliente]
  );
  return Number(filas[0].n);
}

/** Marca una notificacion como leida. El filtro por cliente es la autorizacion. */
export async function marcarLeida(idCliente, idNotificacion) {
  const [r] = await pool.execute(
    'UPDATE notificacion_cliente SET leida = TRUE WHERE id_notificacion = ? AND id_cliente = ?',
    [idNotificacion, idCliente]
  );
  return { actualizada: r.affectedRows > 0 };
}

/** Marca todas como leidas. */
export async function marcarTodasLeidas(idCliente) {
  const [r] = await pool.execute(
    'UPDATE notificacion_cliente SET leida = TRUE WHERE id_cliente = ? AND leida = FALSE',
    [idCliente]
  );
  return { actualizadas: r.affectedRows };
}

/**
 * Registra (o reasigna) un token de dispositivo.
 *
 * FCM reutiliza tokens entre instalaciones: el mismo valor puede reaparecer
 * asociado a otra cuenta si dos personas usan el mismo movil. Por eso el
 * UPSERT reasigna el id_cliente en vez de fallar por clave duplicada -- de lo
 * contrario, el segundo usuario recibiria las notificaciones del primero.
 */
export async function registrarDispositivo(idCliente, { token, plataforma = 'android', modelo = null }) {
  if (!token || String(token).length < 10) return { registrado: false };

  await pool.execute(
    `INSERT INTO dispositivo_cliente (id_cliente, token_fcm, plataforma, modelo)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id_cliente = VALUES(id_cliente),
       plataforma = VALUES(plataforma),
       modelo     = VALUES(modelo),
       activo     = TRUE,
       ultimo_uso = NOW()`,
    [idCliente, String(token).slice(0, 255), plataforma, modelo ? String(modelo).slice(0, 80) : null]
  );

  return { registrado: true };
}

/** Da de baja un token. Se llama al cerrar sesion en el movil. */
export async function borrarDispositivo(idCliente, token) {
  const [r] = await pool.execute(
    'DELETE FROM dispositivo_cliente WHERE token_fcm = ? AND id_cliente = ?',
    [String(token), idCliente]
  );
  return { borrado: r.affectedRows > 0 };
}
