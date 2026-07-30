/**
 * Arranque del servidor SIGR.
 *
 * Arquitectura (FSD 2.2): cliente-servidor de tres capas. Este proceso es la
 * capa de aplicacion: expone la API REST /api/v1, valida toda entrada, aplica
 * autorizacion por permiso y habla con MySQL con consultas parametrizadas.
 * El navegador nunca toca la base de datos.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import 'dotenv/config';

import { verificarConexion, cerrarPool } from './db.js';
import { rutaNoEncontrada, manejadorErrores } from './middleware/errores.js';
import { comprimir } from './middleware/compresion.js';
import { cargarSesion, protegerCsrf, limpiarSesionesVencidas } from './middleware/auth.js';
import rutasAuth from './rutas/auth.js';
import rutasUsuarios from './rutas/usuarios.js';
import rutasRoles from './rutas/roles.js';
import rutasSalon from './rutas/salon.js';
import rutasCatalogo from './rutas/catalogo.js';
import rutasRecetas from './rutas/recetas.js';
import rutasOrdenes from './rutas/ordenes.js';
import rutasKds from './rutas/kds.js';
import rutasCaja from './rutas/caja.js';
import rutasInventario from './rutas/inventario.js';
import rutasReportes from './rutas/reportes.js';
// Canal digital: aplicacion movil de clientes (ver el README).
import rutasApp from './rutas/app.js';
import rutasReservas from './rutas/reservas.js';
import rutasDomicilios from './rutas/domicilios.js';
import rutasConfiguracion from './rutas/configuracion.js';
import rutasMapa from './rutas/mapa.js';
import { limpiarSesionesClienteVencidas } from './middleware/authCliente.js';
import { montarRealtime } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const app = express();

// Detras de un proxy inverso (VPS, Railway, Render) para que req.ip sea la IP
// real del cliente y no la del proxy: la auditoria registra ip_origen.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * Cabeceras de seguridad (FSD 6.1).
 * Se escriben a mano en lugar de usar helmet: son pocas, quedan a la vista y
 * evitan una dependencia mas que auditar.
 */
app.use((_req, res, next) => {
  // CSP restrictiva. El FSD 2.1 impone JS vanilla sin frameworks ni CDN, asi
  // que todo se sirve desde el propio origen.
  //
  // script-src 'self' SIN unsafe-inline: es la restriccion que de verdad frena
  // el XSS, porque impide ejecutar codigo inyectado. Se mantiene estricta.
  //
  // style-src SI permite 'unsafe-inline'. El diseñador de salon (vista 2)
  // posiciona cada mesa con un style inline (left/top en %) que se calcula al
  // arrastrarla; sin esto la CSP bloquea el atributo style y todas las mesas se
  // apilan en la esquina 0,0. Permitir estilos inline NO es un vector de
  // ejecucion de codigo: el XSS peligroso (inyectar <script> o manejadores)
  // sigue bloqueado por script-src. Es la postura CSP estandar y segura.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",   // WebSocket de tiempo real (2.2)
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Compresion. Va lo primero para envolver TODO lo que se responda: JSON de la
// API, HTML, JavaScript y la copia vendorizada de Leaflet. Ver el detalle de
// que se comprime y que no en middleware/compresion.js.
app.use(comprimir());

// Limite de cuerpo: una comanda o un formulario son pequenos. Un limite bajo
// evita que una peticion enorme agote la memoria del proceso.
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Toda peticion pasa por aqui: si trae cookie valida, deja req.usuario con sus
// permisos releidos de la base (FSD 5.1).
app.use(cargarSesion);
app.use(protegerCsrf);

// --- API ---
app.use('/api/v1/auth', rutasAuth);
app.use('/api/v1/usuarios', rutasUsuarios);
app.use('/api/v1/roles', rutasRoles);
app.use('/api/v1/salon', rutasSalon);
app.use('/api/v1/catalogo', rutasCatalogo);
app.use('/api/v1/catalogo', rutasRecetas);
app.use('/api/v1/ordenes', rutasOrdenes);
app.use('/api/v1/kds', rutasKds);
app.use('/api/v1/caja', rutasCaja);
app.use('/api/v1/inventario', rutasInventario);

// --- Canal digital ---
// OJO AL ORDEN: estas rutas van ANTES que rutasReportes. Ese router se monta
// en /api/v1 a secas y empieza con requiereAutenticacion, asi que TODA
// peticion a /api/v1/* que llegue despues pasa por su guardia y muere con un
// 401 antes de alcanzar su router. /app tiene su propia autenticacion (token
// Bearer, no cookie) y varios endpoints publicos a proposito, de modo que
// montarlo detras lo dejaba inservible.
//
// /app es la unica superficie pensada para internet abierto: token Bearer en
// vez de cookie, ningun requierePermiso y limite por IP. Las otras tres son
// backoffice normal, con permisos del modulo canal_digital.
app.use('/api/v1/app', rutasApp);
app.use('/api/v1/reservas', rutasReservas);
app.use('/api/v1/domicilios', rutasDomicilios);
app.use('/api/v1/configuracion', rutasConfiguracion);
// Proxy de teselas del mapa. Sin sesion: son imagenes publicas de
// OpenStreetMap, y exigirla romperia el mapa de la app antes del login.
app.use('/api/v1/mapa', rutasMapa);

// Sonda de salud. Va ANTES de rutasReportes por la misma razon que el canal
// digital: ese router se monta en /api/v1 a secas y arranca con
// requiereAutenticacion, asi que estaba devolviendo 401 y dejando la sonda
// inservible -- justo para quien la usa, que es Docker o un monitor externo,
// sin sesion ninguna. No expone nada: solo dice si la base responde.
app.get('/api/v1/salud', async (_req, res) => {
  try {
    await verificarConexion();
    return res.json({ estado: 'ok', bd: 'conectada' });
  } catch {
    return res.status(503).json({ estado: 'degradado', bd: 'sin conexion' });
  }
});

app.use('/api/v1', rutasReportes);   // /dashboard/kpis, /reportes, /auditoria

// --- Cliente estatico ---
//
// Politica de cache en dos velocidades. Antes no habia ninguna: cada carga de
// pantalla se traia los 150 KB de Leaflet y las fotos de la carta enteras, una
// y otra vez, sobre el wifi compartido del restaurante.
//
// ETAG SIEMPRE, PORQUE NO HAY PASO DE COMPILACION
// public/ se sirve tal cual (FSD 2.1), asi que un archivo cambia SIN cambiar de
// nombre: no hay hash en la URL donde apoyarse. Cachear el HTML o el JS "por
// tiempo" dejaria a un mesero con una version vieja del comandero y sin forma
// de saberlo. Por eso lo normal aqui es no-cache: el navegador pregunta
// siempre, pero si nada cambio el servidor responde 304 sin cuerpo, que es
// donde esta el ahorro real.
//
// Las dos excepciones son archivos que NUNCA cambian bajo la misma URL:
//   · /vendor/  -- Leaflet, una version fija que solo se mueve al actualizarla
//                  a mano, y entonces cambia de contenido y de carpeta.
//   · /uploads/ -- las fotos de los platos llevan nombre aleatorio de 32 hex
//                  (servicios/imagenes.js) y jamas se sobrescriben: cambiar la
//                  foto de un plato escribe un archivo nuevo y borra el viejo.
// Con immutable el navegador ni siquiera revalida.
const ANIO_S = 365 * 24 * 60 * 60;

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, ruta) => {
    const relativa = path.relative(PUBLIC_DIR, ruta).split(path.sep).join('/');
    if (relativa.startsWith('vendor/') || relativa.startsWith('uploads/')) {
      res.setHeader('Cache-Control', `public, max-age=${ANIO_S}, immutable`);
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use(rutaNoEncontrada);
app.use(manejadorErrores);

// ---------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------
let servidor;
let tareaLimpieza;
let realtime;

async function arrancar() {
  // Falla rapido y con un mensaje claro si la base no responde, en vez de
  // aceptar peticiones que reventarian una por una.
  try {
    await verificarConexion();
    console.log('[sigr] conexion con MySQL verificada');
  } catch (error) {
    console.error('[sigr] no se pudo conectar a MySQL:', error.message);
    console.error('[sigr] revise las variables DB_HOST/DB_PORT/DB_USER/DB_PASSWORD del archivo .env');
    process.exit(1);
  }

  servidor = app.listen(PORT, () => {
    console.log(`[sigr] servidor escuchando en http://localhost:${PORT}`);
  });

  // El WebSocket comparte el puerto HTTP: detras de un proxy inverso solo hay
  // que reenviar una ruta, no abrir un segundo puerto (FSD 2.2).
  realtime = montarRealtime(servidor);
  console.log('[sigr] canal de tiempo real activo en ws://localhost:' + PORT + '/realtime');

  // Las sesiones vencidas se acumularian indefinidamente: se purgan cada hora.
  // Las del personal y las de los clientes de la app viven en tablas distintas
  // (ver el README), asi que hay que barrer las dos.
  tareaLimpieza = setInterval(() => {
    limpiarSesionesVencidas()
      .then((n) => { if (n > 0) console.log(`[sigr] ${n} sesion(es) vencida(s) purgada(s)`); })
      .catch((e) => console.error('[sigr] fallo al purgar sesiones:', e.message));
    limpiarSesionesClienteVencidas()
      .then((n) => { if (n > 0) console.log(`[sigr] ${n} sesion(es) de cliente purgada(s)`); })
      .catch((e) => console.error('[sigr] fallo al purgar sesiones de cliente:', e.message));
  }, 60 * 60 * 1000);
  tareaLimpieza.unref();
}

/**
 * Margen para que terminen las peticiones que ya estaban en curso.
 *
 * Docker manda SIGTERM y espera 10 s antes del SIGKILL, asi que el limite se
 * pone por debajo: si algo se atasca, se sale por decision propia y con un
 * aviso en el log, en vez de que lo mate el runtime sin dejar rastro.
 */
const MARGEN_APAGADO_MS = 8000;

let apagando = false;

async function apagar(senal) {
  // Docker reenvia SIGTERM, y un Ctrl+C impaciente manda varios SIGINT. Sin
  // esta guarda, la segunda señal entra a cerrar el pool que la primera ya
  // estaba cerrando.
  if (apagando) return;
  apagando = true;

  console.log(`[sigr] ${senal} recibido, cerrando...`);
  clearInterval(tareaLimpieza);
  realtime?.cerrar();

  // server.close() deja de aceptar conexiones nuevas y espera a que las
  // abiertas terminen. Antes no se esperaba: el process.exit() de la linea
  // siguiente cortaba en seco, y una peticion a mitad -- un cobro, el cierre de
  // un turno -- moria sin respuesta aunque su transaccion ya hubiera confirmado.
  // El cajero veia un error de red sobre una operacion que SI se hizo.
  await new Promise((resolver) => {
    if (!servidor) return resolver();

    const limite = setTimeout(() => {
      console.warn(`[sigr] quedaban peticiones tras ${MARGEN_APAGADO_MS} ms: se cierra igualmente`);
      resolver();
    }, MARGEN_APAGADO_MS);
    limite.unref();

    servidor.close(() => {
      clearTimeout(limite);
      resolver();
    });
  });

  await cerrarPool().catch(() => {});
  console.log('[sigr] cerrado limpiamente');
  process.exit(0);
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

arrancar();

export { app };
