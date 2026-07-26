/**
 * Cliente HTTP de la API.
 *
 * FSD 2.1: modulos ES + Fetch API para consumir servicios REST/JSON.
 * FSD 6.1: token anti-CSRF en las peticiones que modifican estado.
 *
 * Toda la aplicacion pasa por aqui: centraliza el token CSRF, el manejo de
 * sesion expirada y el formato de los errores, para que ninguna vista tenga
 * que repetirlo.
 */

const BASE = '/api/v1';

/** Token CSRF de la sesion actual. Lo entrega el login o GET /auth/sesion. */
let tokenCsrf = null;

export function fijarTokenCsrf(token) {
  tokenCsrf = token;
}

export function obtenerTokenCsrf() {
  return tokenCsrf;
}

/**
 * Error de la API con la forma que devuelve el servidor.
 * Permite a las vistas distinguir por `codigo` sin analizar el texto.
 */
export class ErrorPeticion extends Error {
  constructor(estado, codigo, mensaje, datos) {
    super(mensaje);
    this.name = 'ErrorPeticion';
    this.estado = estado;
    this.codigo = codigo;
    this.datos = datos;
  }
  /** Errores de validacion por campo, para pintarlos junto a cada input. */
  get campos() {
    return this.datos?.campos ?? null;
  }
}

/** Se dispara cuando la sesion deja de ser valida. */
const AL_PERDER_SESION = [];
export function alPerderSesion(fn) {
  AL_PERDER_SESION.push(fn);
}

async function peticion(metodo, ruta, cuerpo, opciones = {}) {
  const cabeceras = { Accept: 'application/json' };
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
  if (tokenCsrf && !['GET', 'HEAD'].includes(metodo)) {
    cabeceras['X-CSRF-Token'] = tokenCsrf;
  }

  let respuesta;
  try {
    respuesta = await fetch(BASE + ruta, {
      method: metodo,
      headers: cabeceras,
      // La cookie de sesion es HttpOnly: se envia sola, JS no la ve.
      credentials: 'same-origin',
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: opciones.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Fallo de red: el servidor no respondio.
    throw new ErrorPeticion(0, 'sin_conexion',
      'No hay conexion con el servidor. Revise su red e intente de nuevo.');
  }

  if (respuesta.status === 204) return null;

  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }

  if (!respuesta.ok) {
    const error = new ErrorPeticion(
      respuesta.status,
      datos?.error ?? 'error_desconocido',
      datos?.mensaje ?? `Error ${respuesta.status}.`,
      datos?.datos
    );
    // La sesion murio: se avisa una sola vez desde aqui en lugar de obligar a
    // cada vista a comprobarlo.
    if (['no_autenticado', 'sesion_expirada', 'cuenta_inactiva'].includes(error.codigo)) {
      AL_PERDER_SESION.forEach((fn) => fn(error));
    }
    throw error;
  }

  return datos;
}

export const api = {
  get:    (ruta, opciones)         => peticion('GET', ruta, undefined, opciones),
  post:   (ruta, cuerpo, opciones) => peticion('POST', ruta, cuerpo ?? {}, opciones),
  put:    (ruta, cuerpo, opciones) => peticion('PUT', ruta, cuerpo ?? {}, opciones),
  patch:  (ruta, cuerpo, opciones) => peticion('PATCH', ruta, cuerpo ?? {}, opciones),
  borrar: (ruta, opciones)         => peticion('DELETE', ruta, undefined, opciones),
};

/**
 * Recupera la sesion actual y fija el token CSRF.
 * @returns la sesion, o null si no hay ninguna activa.
 */
export async function cargarSesionActual() {
  try {
    const sesion = await api.get('/auth/sesion');
    fijarTokenCsrf(sesion.tokenCsrf);
    return sesion;
  } catch (e) {
    if (e.estado === 401 || e.estado === 403) return null;
    throw e;
  }
}
