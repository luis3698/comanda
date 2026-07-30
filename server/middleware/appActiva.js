/**
 * Interruptores de la aplicacion movil.
 *
 * El modulo Administrador puede apagar la aplicacion entera, o solo las
 * reservas, o solo los domicilios. Estos middleware son el lado servidor de
 * esos interruptores: la app puede pintar lo que quiera, pero si el parametro
 * esta en falso la API no acepta la operacion.
 *
 * DOBLE CAPA, IGUAL QUE CON LOS PERMISOS (FSD 6.1)
 * La app oculta las secciones desactivadas al arrancar, leyendo GET
 * /app/estado. Eso es comodidad, no control: una version antigua de la app, o
 * alguien lanzando peticiones a mano, se saltaria la comprobacion del cliente.
 * La que cuenta es esta.
 *
 * POR QUE 503 Y NO 403
 * No es que al cliente le falte permiso -- es que el servicio esta apagado a
 * proposito y volvera. El 503 lo dice con precision, permite acompanarlo del
 * mensaje que escribio el administrador, y evita que un monitor lo registre
 * como un fallo permanente de autorizacion.
 */
import { obtener } from '../servicios/parametros.js';
import { errores } from './errores.js';

/** Mensaje configurable que ve el cliente cuando algo esta apagado. */
async function mensajeInactiva() {
  return obtener(
    'app.movil.mensaje_inactiva',
    'El servicio no esta disponible en este momento. Intentelo mas tarde.'
  );
}

/**
 * Interruptor general. Se monta sobre TODO /api/v1/app excepto GET /estado.
 *
 * La excepcion es deliberada: si /estado tambien respondiera 503, la app solo
 * podria ensenar un error generico de red. Dejandolo abierto, la app lee el
 * motivo y pinta la pantalla de mantenimiento con el texto real del
 * administrador -- y sabe cuando volver a intentarlo.
 */
export async function requiereAppActiva(_req, _res, next) {
  try {
    // Por defecto TRUE: si todavia no se aplico db/05_movil.sql, la API
    // funciona en vez de responder 503 sin explicacion.
    const activa = await obtener('app.movil.activa', true);
    if (!activa) return next(errores.appDesactivada(await mensajeInactiva()));
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Fabrica un interruptor fino sobre un parametro concreto. */
function interruptor(clave, mensajePorDefecto) {
  return async (_req, _res, next) => {
    try {
      const activo = await obtener(clave, true);
      if (!activo) {
        // El mensaje general del administrador tiene prioridad si lo cambio;
        // si sigue siendo el de fabrica, se usa el especifico, que explica
        // mejor que es lo que esta cerrado.
        return next(errores.appDesactivada(mensajePorDefecto));
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const requiereReservasActivas = interruptor(
  'app.movil.reservas_activas',
  'Las reservas por la aplicacion estan cerradas en este momento. Llame al restaurante para reservar.'
);

export const requiereDomiciliosActivos = interruptor(
  'app.movil.domicilios_activos',
  'Los pedidos a domicilio estan cerrados en este momento. Vuelva a intentarlo mas tarde.'
);
