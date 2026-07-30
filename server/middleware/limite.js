/**
 * Limitacion de frecuencia por IP.
 *
 * POR QUE APARECE AHORA Y NO ANTES
 * Hasta el canal digital, toda la API estaba detras de un login de personal en
 * una red controlada: el bloqueo por intentos fallidos de la propia cuenta
 * (FSD 5.1) bastaba. La API del cliente es distinta: /app/registro y
 * /app/auth/login dan a internet y NO exigen sesion previa. Sin un limite por
 * IP, un script puede crear cuentas en bucle o probar contrasenas contra
 * cuentas distintas -- el bloqueo por cuenta no lo frena, porque cada intento
 * ataca a otro usuario.
 *
 * EN MEMORIA Y NO EN REDIS
 * El proyecto corre como un proceso unico (docker-compose levanta una API).
 * Un contador en memoria no anade dependencias, no tiene que fallar con
 * gracia si el almacen externo se cae, y protege exactamente de lo que hay que
 * proteger. Si algun dia se escala a varias instancias, el limite pasa a ser
 * por instancia: sigue funcionando, solo que el techo real se multiplica por
 * el numero de replicas. Entonces -- y solo entonces -- tendria sentido un
 * almacen compartido.
 */
import { ErrorAPI } from './errores.js';

/** IP -> { marcas: number[] }. Se poda sola en cada consulta. */
const registros = new Map();

/**
 * Cada cuanto se barre el mapa entero buscando IPs sin actividad. Sin esto, la
 * memoria crece con cada IP que aparece una vez y no vuelve.
 */
const BARRIDO_MS = 10 * 60 * 1000;

let ultimoBarrido = Date.now();

function barrer(ahora, ventanaMs) {
  for (const [ip, registro] of registros) {
    if (registro.marcas.every((m) => ahora - m > ventanaMs)) registros.delete(ip);
  }
  ultimoBarrido = ahora;
}

/**
 * Crea un middleware de limite.
 *
 * Ventana deslizante y no cubo por minuto: con ventanas fijas, un atacante
 * lanza el maximo al final de un minuto y otro tanto al empezar el siguiente,
 * colando el doble del limite en dos segundos.
 *
 * @param {object} opciones
 * @param {number} opciones.maximo    Peticiones permitidas dentro de la ventana.
 * @param {number} opciones.ventanaMs Duracion de la ventana.
 * @param {string} [opciones.mensaje] Texto para el usuario.
 */
export function limitar({ maximo, ventanaMs, mensaje }) {
  const texto = mensaje ?? 'Demasiados intentos. Espere un momento antes de volver a probar.';

  return (req, res, next) => {
    const ahora = Date.now();
    // req.ip es la IP real del cliente porque index.js activa 'trust proxy'.
    const ip = req.ip ?? 'desconocida';

    if (ahora - ultimoBarrido > BARRIDO_MS) barrer(ahora, ventanaMs);

    const registro = registros.get(ip) ?? { marcas: [] };
    // Se descartan las marcas que ya salieron de la ventana.
    registro.marcas = registro.marcas.filter((m) => ahora - m < ventanaMs);

    if (registro.marcas.length >= maximo) {
      const masAntigua = registro.marcas[0];
      const esperaS = Math.max(1, Math.ceil((ventanaMs - (ahora - masAntigua)) / 1000));
      // Retry-After es la cabecera estandar: un cliente bien hecho la respeta
      // en vez de reintentar a ciegas.
      res.setHeader('Retry-After', String(esperaS));
      registros.set(ip, registro);
      return next(new ErrorAPI(429, 'demasiadas_peticiones', texto, { esperaSegundos: esperaS }));
    }

    registro.marcas.push(ahora);
    registros.set(ip, registro);
    return next();
  };
}

/**
 * Limite estricto para autenticacion y registro.
 * 10 intentos cada 15 min por IP: suficiente para alguien que se equivoca de
 * contrasena varias veces, inservible para un ataque por diccionario.
 */
export const limiteAutenticacion = limitar({
  maximo: 10,
  ventanaMs: 15 * 60 * 1000,
  mensaje: 'Demasiados intentos desde esta conexion. Espere unos minutos antes de volver a probar.',
});

/**
 * Limite amplio para el resto de la API del cliente. No pretende frenar un
 * ataque, sino evitar que una app con un bucle mal escrito tumbe el servidor.
 */
export const limiteApiCliente = limitar({
  maximo: 300,
  ventanaMs: 60 * 1000,
  mensaje: 'Esta enviando peticiones demasiado rapido. Intente de nuevo en un momento.',
});

/** Solo para las pruebas: deja el contador a cero. */
export function reiniciarLimites() {
  registros.clear();
}
