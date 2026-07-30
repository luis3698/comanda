/**
 * Sesiones y autenticacion.
 *
 * FSD 5.1:
 *  - "La sesion se gestiona con token de expiracion corta en dispositivos
 *     compartidos (comandero, KDS, POS: 12 h con re-autenticacion por PIN
 *     tras 10 min de inactividad)."
 *  - "Cambios de rol o permisos surten efecto en la siguiente peticion
 *     (revalidacion por request, no por sesion)."
 *
 * Esa segunda regla es la razon de que la sesion viva en la base y no en un
 * JWT ni en memoria: los permisos se releen en CADA peticion. Si el
 * administrador revoca un permiso, la siguiente accion del usuario ya lo
 * refleja. Con un token autocontenido habria que esperar a que expirara.
 */
import crypto from 'node:crypto';
import { consultarUno, pool } from '../db.js';
import { permisosDeRol } from '../servicios/permisosRol.js';
import { errores } from './errores.js';

export const COOKIE_SESION = 'sigr_sesion';

const SESION_HORAS = Number(process.env.SESION_HORAS || 12);
const INACTIVIDAD_MIN = Number(process.env.SESION_INACTIVIDAD_MIN || 10);
const COOKIE_SEGURA = String(process.env.COOKIE_SEGURA || 'false') === 'true';

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Crea una sesion y devuelve sus tokens.
 * @param {number} idUsuario
 * @param {'backoffice'|'operativo'} tipoAcceso
 */
export async function crearSesion(idUsuario, tipoAcceso, { ip, userAgent } = {}) {
  const idSesion = generarToken();
  const tokenCsrf = generarToken();

  await pool.execute(
    `INSERT INTO sesion (id_sesion, id_usuario, tipo_acceso, token_csrf, ip_origen, user_agent, expira_en)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [idSesion, idUsuario, tipoAcceso, tokenCsrf, ip ?? null, (userAgent ?? '').slice(0, 255), SESION_HORAS]
  );

  return { idSesion, tokenCsrf };
}

export async function destruirSesion(idSesion) {
  await pool.execute('DELETE FROM sesion WHERE id_sesion = ?', [idSesion]);
}

export async function destruirSesionesDeUsuario(idUsuario) {
  await pool.execute('DELETE FROM sesion WHERE id_usuario = ?', [idUsuario]);
}

/** Borra sesiones vencidas. Se invoca periodicamente desde index.js. */
export async function limpiarSesionesVencidas() {
  const [r] = await pool.execute('DELETE FROM sesion WHERE expira_en < NOW()');
  return r.affectedRows;
}

export function opcionesCookie() {
  return {
    httpOnly: true,                       // 6.1: inaccesible desde JS -> mitiga XSS
    secure: COOKIE_SEGURA,                // 6.1: solo por HTTPS en produccion
    sameSite: 'strict',                   // 6.1: primera defensa anti-CSRF
    maxAge: SESION_HORAS * 60 * 60 * 1000,
    path: '/',
  };
}

/**
 * Cada cuantos minutos se reescribe `ultima_actividad`.
 *
 * Antes se escribia en CADA peticion. Con el KDS y varios comanderos abiertos
 * eso es un UPDATE por peticion sobre la misma fila, y todos escriben
 * practicamente el mismo valor. El dato solo se usa para la regla de los 10
 * minutos de inactividad del FSD 5.1, asi que una resolucion de un minuto lo
 * respeta de sobra: peor caso, la sesion parece un minuto mas inactiva de lo
 * que esta, muy lejos del umbral.
 */
const REFRESCO_ACTIVIDAD_MIN = 1;

/**
 * Rutas que se saltan la carga de sesion.
 *
 * `cargarSesion` estaba montado sobre TODA peticion, incluidas las de
 * public/: cada hoja de estilos, cada modulo JS y cada icono pagaba dos SELECT
 * y un UPDATE. Cargar una pantalla del backoffice son mas de veinte archivos,
 * asi que abrirla costaba unas sesenta operaciones de base de datos ANTES de
 * pedir el primer dato de verdad.
 *
 * Ningun estatico consulta req.usuario -- express.static sirve el archivo tal
 * cual y la autorizacion vive en la API --, asi que saltarselo no cambia nada
 * de lo que se ve. Lo unico que se sirve desde disco y podria ser sensible son
 * las imagenes de los platos, que ya son publicas por diseño (la carta de la
 * app las muestra sin sesion).
 */
function necesitaSesion(req) {
  return req.path.startsWith('/api/');
}

/**
 * Carga la sesion si la cookie es valida. NO rechaza si no hay sesion: eso lo
 * decide requiereAutenticacion. Asi las rutas publicas (login) pueden convivir
 * con las protegidas.
 *
 * Deja en req.usuario: { id, nombre, correo, idRol, rol, permisos:Set, sesion }
 */
export async function cargarSesion(req, _res, next) {
  try {
    if (!necesitaSesion(req)) return next();

    const idSesion = req.cookies?.[COOKIE_SESION];
    if (!idSesion) return next();

    const fila = await consultarUno(
      `SELECT s.id_sesion, s.tipo_acceso, s.token_csrf, s.expira_en,
              s.ultima_actividad,
              TIMESTAMPDIFF(MINUTE, s.ultima_actividad, NOW()) AS minutos_inactivo,
              s.expira_en < NOW() AS vencida,
              u.id_usuario, u.nombre_completo, u.correo, u.activo,
              r.id_rol, r.nombre AS rol
         FROM sesion s
         JOIN usuario u ON u.id_usuario = s.id_usuario
         JOIN rol r     ON r.id_rol = u.id_rol
        WHERE s.id_sesion = ?`,
      [idSesion]
    );

    if (!fila) return next();

    if (Number(fila.vencida) === 1) {
      await destruirSesion(idSesion);
      return next(errores.sesionExpirada());
    }

    // Baja logica del usuario en mitad de su sesion: se corta el acceso.
    if (!fila.activo) {
      await destruirSesion(idSesion);
      return next(errores.cuentaInactiva());
    }

    // Permisos releidos en cada peticion (5.1): un cambio en la matriz surte
    // efecto de inmediato, sin esperar a que la sesion expire. La lectura pasa
    // por servicios/permisosRol.js, que la resuelve en memoria y se invalida
    // cuando alguien edita la matriz: la garantia del FSD se mantiene y se
    // ahorra un JOIN por peticion. Lo que SI se relee siempre de la base es el
    // rol del usuario y si sigue activo, arriba.
    const permisos = await permisosDeRol(fila.id_rol);

    req.usuario = {
      id: fila.id_usuario,
      nombre: fila.nombre_completo,
      correo: fila.correo,
      idRol: fila.id_rol,
      rol: fila.rol,
      permisos,
      sesion: {
        id: fila.id_sesion,
        tipoAcceso: fila.tipo_acceso,
        tokenCsrf: fila.token_csrf,
        minutosInactivo: Number(fila.minutos_inactivo),
      },
    };

    // Refresco de actividad. Sin await bloqueante del flujo para no sumar
    // latencia a cada peticion; un fallo aqui no debe tumbar la request. Y solo
    // si de verdad hay algo que actualizar: ver REFRESCO_ACTIVIDAD_MIN.
    if (Number(fila.minutos_inactivo) >= REFRESCO_ACTIVIDAD_MIN) {
      pool
        .execute('UPDATE sesion SET ultima_actividad = NOW() WHERE id_sesion = ?', [idSesion])
        .catch((e) => console.error('[auth] no se pudo refrescar la actividad de la sesion:', e.message));
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

/** Exige sesion iniciada. */
export function requiereAutenticacion(req, _res, next) {
  if (!req.usuario) return next(errores.noAutenticado());
  return next();
}

/**
 * Exige PIN de nuevo tras 10 min de inactividad en dispositivos compartidos.
 * FSD 5.1. El backoffice queda excluido: alli la sesion es personal y la
 * regla de inactividad no aplica.
 *
 * Se monta solo en las rutas operativas sensibles; devuelve 401 requiere_pin
 * para que el cliente muestre el teclado numerico sin perder el contexto.
 */
export function requiereFrescura(req, _res, next) {
  if (!req.usuario) return next(errores.noAutenticado());
  const { tipoAcceso, minutosInactivo } = req.usuario.sesion;
  if (tipoAcceso === 'operativo' && minutosInactivo >= INACTIVIDAD_MIN) {
    return next(errores.requierePin());
  }
  return next();
}

/**
 * Proteccion CSRF (FSD 6.1: "Token anti-CSRF en formularios y verificacion de
 * origen en la API"). Dos comprobaciones sobre los metodos que modifican
 * estado; las lecturas quedan exentas.
 */
export function protegerCsrf(req, _res, next) {
  const metodosSeguros = ['GET', 'HEAD', 'OPTIONS'];
  if (metodosSeguros.includes(req.method)) return next();
  if (!req.usuario) return next();  // sin sesion no hay nada que falsificar

  // 1. Verificacion de origen.
  const origen = req.get('origin');
  if (origen) {
    const esperado = `${req.protocol}://${req.get('host')}`;
    if (origen !== esperado) {
      return next(errores.peticionInvalida('Origen de la peticion no permitido.'));
    }
  }

  // 2. Token de sesion reenviado por cabecera. Se compara en tiempo constante
  // para no filtrar informacion por diferencias de tiempo de respuesta.
  const enviado = req.get('x-csrf-token') || '';
  const esperado = req.usuario.sesion.tokenCsrf;
  const a = Buffer.from(enviado);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(errores.peticionInvalida('Token de seguridad invalido o ausente.'));
  }

  return next();
}
