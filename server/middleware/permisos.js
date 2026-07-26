/**
 * Autorizacion por permiso granular.
 *
 * FSD 6.1: "Doble capa: la UI oculta lo no permitido (JS) y la API revalida el
 * permiso exacto en cada endpoint contra rol_permiso."
 * CA-10: "Un usuario sin permiso recibe HTTP 403 aunque manipule el cliente JS."
 *
 * Que la UI esconda un boton no es seguridad: cualquiera puede abrir la
 * consola y lanzar la peticion a mano. La comprobacion que cuenta es esta.
 */
import { errores } from './errores.js';

/**
 * Exige al menos uno de los permisos indicados.
 *
 * @param {...string} codigos  Codigos de permiso; basta con tener uno.
 * @example  router.post('/ordenes', requierePermiso('ordenes.abrir'), handler)
 */
export function requierePermiso(...codigos) {
  return (req, _res, next) => {
    if (!req.usuario) return next(errores.noAutenticado());

    const autorizado = codigos.some((codigo) => req.usuario.permisos.has(codigo));
    if (!autorizado) return next(errores.sinPermiso(codigos.join(' o ')));

    return next();
  };
}

/**
 * Exige todos los permisos indicados.
 */
export function requiereTodosLosPermisos(...codigos) {
  return (req, _res, next) => {
    if (!req.usuario) return next(errores.noAutenticado());

    const faltante = codigos.find((codigo) => !req.usuario.permisos.has(codigo));
    if (faltante) return next(errores.sinPermiso(faltante));

    return next();
  };
}

/**
 * Consulta puntual dentro de un handler, para ramas que dependen del permiso
 * sin bloquear toda la ruta. Ejemplo: la vista 11 muestra las mesas de otros
 * meseros solo si se tiene 'ordenes.ver_todas'.
 */
export function tienePermiso(req, codigo) {
  return Boolean(req.usuario?.permisos.has(codigo));
}
