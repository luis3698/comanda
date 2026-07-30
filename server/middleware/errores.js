/**
 * Errores de la API y su manejador central.
 *
 * FSD 6.3: los errores se comunican "en lenguaje claro en espanol".
 * Los mensajes de este modulo se muestran al usuario final, asi que describen
 * que paso y que hacer, no el detalle tecnico interno.
 */

export class ErrorAPI extends Error {
  /**
   * @param {number} estado  Codigo HTTP.
   * @param {string} codigo  Identificador estable para el cliente JS.
   * @param {string} mensaje Texto en espanol para el usuario.
   * @param {object} [datos] Informacion adicional (campos invalidos, etc).
   */
  constructor(estado, codigo, mensaje, datos = undefined) {
    super(mensaje);
    this.name = 'ErrorAPI';
    this.estado = estado;
    this.codigo = codigo;
    this.datos = datos;
  }
}

export const errores = {
  peticionInvalida: (mensaje = 'Los datos enviados no son validos.', datos) =>
    new ErrorAPI(400, 'peticion_invalida', mensaje, datos),

  credencialesInvalidas: () =>
    new ErrorAPI(401, 'credenciales_invalidas', 'Correo, contrasena o PIN incorrectos.'),

  noAutenticado: () =>
    new ErrorAPI(401, 'no_autenticado', 'Debe iniciar sesion para continuar.'),

  sesionExpirada: () =>
    new ErrorAPI(401, 'sesion_expirada', 'Su sesion expiro. Vuelva a iniciar sesion.'),

  requierePin: () =>
    new ErrorAPI(401, 'requiere_pin', 'Por inactividad, confirme su PIN para continuar.'),

  // CA-10: "Un usuario sin permiso recibe HTTP 403 aunque manipule el cliente JS."
  sinPermiso: (permiso) =>
    new ErrorAPI(403, 'sin_permiso', 'No tiene permiso para realizar esta accion.',
      permiso ? { permiso_requerido: permiso } : undefined),

  cuentaBloqueada: (minutos) =>
    new ErrorAPI(423, 'cuenta_bloqueada',
      `Cuenta bloqueada por intentos fallidos. Intente de nuevo en ${minutos} minuto(s).`),

  cuentaInactiva: () =>
    new ErrorAPI(403, 'cuenta_inactiva', 'Su cuenta esta dada de baja. Contacte al administrador.'),

  noEncontrado: (que = 'El recurso solicitado') =>
    new ErrorAPI(404, 'no_encontrado', `${que} no existe.`),

  conflicto: (mensaje, datos) =>
    new ErrorAPI(409, 'conflicto', mensaje, datos),

  reglaDeNegocio: (mensaje, datos) =>
    new ErrorAPI(422, 'regla_negocio', mensaje, datos),

  // --- Canal digital (aplicacion movil de clientes) ---

  // El cliente de la app no tiene sesion, no tiene una sesion caducada: son
  // dos pantallas distintas ("inicie sesion" frente a "su sesion expiro"), y
  // el codigo es lo que las separa.
  clienteNoAutenticado: () =>
    new ErrorAPI(401, 'cliente_no_autenticado', 'Inicie sesion para continuar.'),

  // 503 y no 403: no es que al cliente le falte permiso, es que el servicio
  // esta apagado por decision del administrador. El 503 tambien evita que un
  // buscador o un monitor lo interprete como un fallo permanente.
  appDesactivada: (mensaje) =>
    new ErrorAPI(503, 'app_desactivada',
      mensaje || 'El servicio no esta disponible en este momento.'),
};

/** Ruta no encontrada. Se monta despues de todas las rutas. */
export function rutaNoEncontrada(req, res, next) {
  next(new ErrorAPI(404, 'ruta_no_encontrada', `La ruta ${req.method} ${req.path} no existe.`));
}

/**
 * Manejador central de errores. Debe montarse el ultimo.
 *
 * Nunca filtra el detalle interno de un error inesperado al cliente: un stack
 * trace o un mensaje de MySQL revela estructura de la base y ayuda a un
 * atacante. Al log si va completo.
 */
export function manejadorErrores(error, req, res, _next) {
  if (error instanceof ErrorAPI) {
    const cuerpo = { error: error.codigo, mensaje: error.message };
    if (error.datos) cuerpo.datos = error.datos;
    return res.status(error.estado).json(cuerpo);
  }

  // Errores de MySQL que corresponden a una causa de negocio identificable.
  if (error?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: 'duplicado',
      mensaje: 'Ya existe un registro con ese valor unico.',
    });
  }
  if (error?.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return res.status(422).json({
      error: 'regla_negocio',
      mensaje: 'Los datos violan una restriccion de validacion.',
    });
  }
  if (error?.code === 'ER_NO_REFERENCED_ROW_2' || error?.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({
      error: 'integridad_referencial',
      mensaje: 'La operacion afecta a registros relacionados y no puede completarse.',
    });
  }

  console.error(`[error] ${req.method} ${req.path}`, error);
  return res.status(500).json({
    error: 'error_interno',
    mensaje: 'Ocurrio un error inesperado. Intente de nuevo.',
  });
}

/**
 * Envuelve un handler async para que sus rechazos lleguen al manejador de
 * errores. Sin esto, una promesa rechazada en Express 4 queda colgada y la
 * peticion nunca responde.
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
