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
app.use('/api/v1', rutasReportes);   // /dashboard/kpis, /reportes, /auditoria

app.get('/api/v1/salud', async (_req, res) => {
  try {
    await verificarConexion();
    return res.json({ estado: 'ok', bd: 'conectada' });
  } catch {
    return res.status(503).json({ estado: 'degradado', bd: 'sin conexion' });
  }
});

// --- Cliente estatico ---
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

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
  tareaLimpieza = setInterval(() => {
    limpiarSesionesVencidas()
      .then((n) => { if (n > 0) console.log(`[sigr] ${n} sesion(es) vencida(s) purgada(s)`); })
      .catch((e) => console.error('[sigr] fallo al purgar sesiones:', e.message));
  }, 60 * 60 * 1000);
  tareaLimpieza.unref();
}

async function apagar(senal) {
  console.log(`[sigr] ${senal} recibido, cerrando...`);
  clearInterval(tareaLimpieza);
  realtime?.cerrar();
  servidor?.close();
  await cerrarPool().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

arrancar();

export { app };
