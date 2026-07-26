/**
 * Rutas de autenticacion.  RF-01.
 *
 * FSD 5.1 (reglas implementadas aqui):
 *  - Contrasenas y PIN se almacenan solo como hash; la comparacion es en servidor.
 *  - 5 intentos fallidos consecutivos bloquean la cuenta 15 minutos y generan
 *    evento de auditoria.
 *  - JS del cliente valida formato solo como UX; la API revalida todo.
 *
 * COMO SE IDENTIFICA AL USUARIO EN LOS DISPOSITIVOS OPERATIVOS
 * El FSD dice "PIN de 4 digitos o lectura RFID", pero un PIN de 4 digitos no
 * identifica a nadie: con una decena de empleados las colisiones son casi
 * seguras, y probar el PIN contra todos los usuarios seria a la vez inseguro
 * y lento. Por eso el acceso operativo exige documento + PIN: el documento
 * identifica, el PIN autentica. El RFID si identifica por si solo (uid unico).
 * Decision registrada en TRAZABILIDAD.md.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { consultarUno, pool } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import {
  crearSesion, destruirSesion, opcionesCookie, COOKIE_SESION,
  requiereAutenticacion,
} from '../middleware/auth.js';
import { auditar } from '../servicios/auditoria.js';

const router = Router();

const MAX_INTENTOS = 5;         // FSD 5.1 y 6.1
const BLOQUEO_MINUTOS = 15;     // FSD 5.1

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_PIN = /^\d{4}$/;       // FSD 5.1: ^\d{4}$

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/**
 * Registra un intento fallido y bloquea la cuenta al llegar al tope.
 * Devuelve el error que debe enviarse al cliente.
 */
async function registrarFallo(usuario, req) {
  const intentos = usuario.intentos_fallidos + 1;

  if (intentos >= MAX_INTENTOS) {
    await pool.execute(
      `UPDATE usuario
          SET intentos_fallidos = ?, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE id_usuario = ?`,
      [intentos, BLOQUEO_MINUTOS, usuario.id_usuario]
    );
    await auditar(null, {
      idUsuario: usuario.id_usuario,
      accion: 'auth.bloqueo',
      entidad: 'usuario',
      idEntidad: usuario.id_usuario,
      detalle: `Cuenta bloqueada ${BLOQUEO_MINUTOS} min tras ${intentos} intentos fallidos consecutivos.`,
      ipOrigen: ipDe(req),
    });
    return errores.cuentaBloqueada(BLOQUEO_MINUTOS);
  }

  await pool.execute(
    'UPDATE usuario SET intentos_fallidos = ? WHERE id_usuario = ?',
    [intentos, usuario.id_usuario]
  );
  await auditar(null, {
    idUsuario: usuario.id_usuario,
    accion: 'auth.fallo',
    entidad: 'usuario',
    idEntidad: usuario.id_usuario,
    detalle: `Intento de acceso fallido (${intentos}/${MAX_INTENTOS}).`,
    ipOrigen: ipDe(req),
  });
  return errores.credencialesInvalidas();
}

/** Comprobaciones comunes de estado de la cuenta. Devuelve un error o null. */
function revisarEstadoCuenta(usuario) {
  if (!usuario.activo) return errores.cuentaInactiva();
  if (usuario.minutos_bloqueo !== null && Number(usuario.minutos_bloqueo) > 0) {
    return errores.cuentaBloqueada(Math.max(1, Number(usuario.minutos_bloqueo)));
  }
  return null;
}

const SQL_USUARIO = `
  SELECT u.id_usuario, u.nombre_completo, u.correo, u.hash_password, u.hash_pin,
         u.activo, u.intentos_fallidos,
         CASE WHEN u.bloqueado_hasta IS NULL OR u.bloqueado_hasta <= NOW() THEN NULL
              ELSE TIMESTAMPDIFF(MINUTE, NOW(), u.bloqueado_hasta) + 1 END AS minutos_bloqueo,
         r.id_rol, r.nombre AS rol
    FROM usuario u
    JOIN rol r ON r.id_rol = u.id_rol
`;

/** Deja la cuenta limpia tras un acceso correcto y abre la sesion. */
async function completarLogin(req, res, usuario, tipoAcceso) {
  await pool.execute(
    'UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = NOW() WHERE id_usuario = ?',
    [usuario.id_usuario]
  );

  const { idSesion, tokenCsrf } = await crearSesion(usuario.id_usuario, tipoAcceso, {
    ip: ipDe(req),
    userAgent: req.get('user-agent'),
  });

  await auditar(null, {
    idUsuario: usuario.id_usuario,
    accion: 'auth.login',
    entidad: 'usuario',
    idEntidad: usuario.id_usuario,
    detalle: `Inicio de sesion (${tipoAcceso}).`,
    ipOrigen: ipDe(req),
  });

  res.cookie(COOKIE_SESION, idSesion, opcionesCookie());
  return res.json({
    usuario: {
      id: usuario.id_usuario,
      nombre: usuario.nombre_completo,
      correo: usuario.correo,
      rol: usuario.rol,
      idRol: usuario.id_rol,
    },
    tokenCsrf,
  });
}

/**
 * POST /api/v1/auth/login
 * Acepta tres formas:
 *   { correo, password }   -> backoffice
 *   { documento, pin }     -> dispositivo operativo
 *   { uidRfid }            -> dispositivo operativo con tarjeta
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { correo, password, documento, pin, uidRfid } = req.body ?? {};

  // ---- Acceso por RFID ----
  if (uidRfid) {
    const usuario = await consultarUno(`${SQL_USUARIO} WHERE u.uid_rfid = ?`, [String(uidRfid)]);
    // Mismo mensaje que unas credenciales erroneas: no revelamos si la tarjeta
    // esta registrada o no.
    if (!usuario) throw errores.credencialesInvalidas();
    const problema = revisarEstadoCuenta(usuario);
    if (problema) throw problema;
    return completarLogin(req, res, usuario, 'operativo');
  }

  // ---- Acceso operativo por documento + PIN ----
  if (documento || pin) {
    if (!documento || !pin) {
      throw errores.peticionInvalida('Indique su documento y su PIN.');
    }
    if (!RE_PIN.test(String(pin))) {
      throw errores.peticionInvalida('El PIN debe tener exactamente 4 digitos.');
    }
    const usuario = await consultarUno(`${SQL_USUARIO} WHERE u.documento = ?`, [String(documento)]);
    if (!usuario) throw errores.credencialesInvalidas();

    const problema = revisarEstadoCuenta(usuario);
    if (problema) throw problema;

    const correcto = await bcrypt.compare(String(pin), usuario.hash_pin);
    if (!correcto) throw await registrarFallo(usuario, req);

    return completarLogin(req, res, usuario, 'operativo');
  }

  // ---- Acceso de backoffice por correo + contrasena ----
  if (!correo || !password) {
    throw errores.peticionInvalida('Indique su correo y su contrasena.');
  }
  if (!RE_CORREO.test(String(correo))) {
    throw errores.peticionInvalida('El correo no tiene un formato valido.');
  }

  const usuario = await consultarUno(`${SQL_USUARIO} WHERE u.correo = ?`, [String(correo)]);
  if (!usuario) throw errores.credencialesInvalidas();

  const problema = revisarEstadoCuenta(usuario);
  if (problema) throw problema;

  const correcto = await bcrypt.compare(String(password), usuario.hash_password);
  if (!correcto) throw await registrarFallo(usuario, req);

  return completarLogin(req, res, usuario, 'backoffice');
}));

/**
 * POST /api/v1/auth/reautenticar
 * Confirma el PIN tras 10 min de inactividad en un dispositivo compartido
 * (FSD 5.1). No abre una sesion nueva: refresca la actual.
 */
router.post('/reautenticar', requiereAutenticacion, asyncHandler(async (req, res) => {
  const { pin } = req.body ?? {};
  if (!RE_PIN.test(String(pin ?? ''))) {
    throw errores.peticionInvalida('El PIN debe tener exactamente 4 digitos.');
  }

  const usuario = await consultarUno(`${SQL_USUARIO} WHERE u.id_usuario = ?`, [req.usuario.id]);
  if (!usuario) throw errores.noAutenticado();

  const problema = revisarEstadoCuenta(usuario);
  if (problema) throw problema;

  const correcto = await bcrypt.compare(String(pin), usuario.hash_pin);
  if (!correcto) throw await registrarFallo(usuario, req);

  await pool.execute(
    'UPDATE sesion SET ultima_actividad = NOW() WHERE id_sesion = ?',
    [req.usuario.sesion.id]
  );
  await pool.execute(
    'UPDATE usuario SET intentos_fallidos = 0 WHERE id_usuario = ?',
    [usuario.id_usuario]
  );

  return res.json({ ok: true });
}));

/** POST /api/v1/auth/logout */
router.post('/logout', asyncHandler(async (req, res) => {
  const idSesion = req.cookies?.[COOKIE_SESION];
  if (idSesion) {
    if (req.usuario) {
      await auditar(null, {
        idUsuario: req.usuario.id,
        accion: 'auth.logout',
        entidad: 'usuario',
        idEntidad: req.usuario.id,
        detalle: 'Cierre de sesion.',
        ipOrigen: ipDe(req),
      });
    }
    await destruirSesion(idSesion);
  }
  res.clearCookie(COOKIE_SESION, { path: '/' });
  return res.json({ ok: true });
}));

/**
 * GET /api/v1/auth/sesion
 * Estado de la sesion actual. El cliente lo usa al arrancar para saber si
 * sigue autenticado, recuperar el token CSRF y construir el menu segun sus
 * permisos (FSD 5.1: "sesion iniciada con menu filtrado por permisos").
 */
router.get('/sesion', requiereAutenticacion, asyncHandler(async (req, res) => {
  return res.json({
    usuario: {
      id: req.usuario.id,
      nombre: req.usuario.nombre,
      correo: req.usuario.correo,
      rol: req.usuario.rol,
      idRol: req.usuario.idRol,
    },
    permisos: [...req.usuario.permisos],
    tokenCsrf: req.usuario.sesion.tokenCsrf,
    tipoAcceso: req.usuario.sesion.tipoAcceso,
    minutosInactivo: req.usuario.sesion.minutosInactivo,
  });
}));

export default router;
