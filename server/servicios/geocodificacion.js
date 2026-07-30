/**
 * Geocodificacion inversa: de unas coordenadas a una direccion escrita.
 *
 * POR QUE PASA POR EL SERVIDOR Y NO LO HACE EL MOVIL
 * Es la misma decision que ya se tomo con las teselas (servicios/teselas.js), y
 * por las mismas razones:
 *
 *   1. Ninguna clave de API ni cuenta con facturacion. Android trae un
 *      `Geocoder` propio, pero se apoya en los servicios de Google Play: en un
 *      movil que no los tenga -- o en un emulador sin ellos -- devuelve una
 *      lista vacia sin explicar por que. Aqui funciona en todos.
 *   2. El movil del comensal no habla con ningun tercero. Sus coordenadas de
 *      casa no salen hacia un servicio ajeno desde su dispositivo.
 *   3. La cache es COMPARTIDA. Diez vecinos del mismo edificio preguntando por
 *      su portal son una sola consulta al proveedor, no diez.
 *
 * POLITICA DE USO DE NOMINATIM
 * Es un servicio publico y gratuito, y su politica es mas estricta que la de
 * las teselas: exige User-Agent identificable y pone un techo duro de UNA
 * peticion por segundo. Las dos cosas se cumplen abajo -- cabecera propia y
 * cola serializada con espaciado real --, ademas de la cache, que es lo que de
 * verdad mantiene el trafico bajo.
 *
 * Para un despliegue serio lo correcto es levantar un Nominatim propio o
 * contratar un proveedor, y apuntar ahi MAPA_GEOCODIFICACION_URL. El codigo no
 * cambia.
 */
import { errores } from '../middleware/errores.js';

const URL_BASE = process.env.MAPA_GEOCODIFICACION_URL ||
  'https://nominatim.openstreetmap.org/reverse';

const USER_AGENT = process.env.MAPA_USER_AGENT || 'SIGR/0.1 (sistema de gestion de restaurantes)';

/** Idioma de la respuesta. Un cliente colombiano espera leer "Calle", no "Street". */
const IDIOMA = process.env.MAPA_IDIOMA || 'es';

/** Tiempo maximo esperando al proveedor antes de rendirse. */
const TIEMPO_LIMITE_MS = 6000;

/**
 * Espaciado minimo entre llamadas salientes.
 *
 * La politica de Nominatim dice "maximo 1 por segundo". Se dejan 1100 ms de
 * margen: si se apura al milisegundo, un reloj que va un pelo adelantado
 * respecto al del servidor remoto convierte el cumplimiento en una carrera que
 * se pierde de vez en cuando, y la sancion es un bloqueo por IP.
 */
const ESPACIADO_MS = 1100;

/**
 * Cuanto vive una entrada en cache. Las direcciones cambian con las decadas,
 * pero no conviene guardarlas para siempre en memoria: 24 h cubre de sobra el
 * uso real (un cliente da de alta su direccion una vez).
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Techo de entradas. Cada una son unos pocos cientos de bytes, asi que 5000
 * direcciones son menos de 2 MB; el limite existe para que un script que
 * pregunte por coordenadas aleatorias no haga crecer la memoria sin fin.
 */
const MAX_ENTRADAS = 5000;

/** clave -> { valor, expiraEn } */
const cache = new Map();

/**
 * Precision de la clave de cache: 4 decimales, unos 11 metros.
 *
 * Es el punto justo. Con mas decimales, mover el pin dos metros ya cuenta como
 * otra pregunta y la cache no sirve de nada. Con menos, dos portales distintos
 * de la misma calle comparten respuesta y el cliente ve la direccion del
 * vecino.
 */
const DECIMALES_CLAVE = 4;

function clave(lat, lng) {
  return `${lat.toFixed(DECIMALES_CLAVE)},${lng.toFixed(DECIMALES_CLAVE)}`;
}

/** Valida el par de coordenadas. */
export function validarPunto(lat, lng) {
  const nlat = Number(lat);
  const nlng = Number(lng);

  if (!Number.isFinite(nlat) || nlat < -90 || nlat > 90) {
    throw errores.peticionInvalida('Latitud fuera de rango.');
  }
  if (!Number.isFinite(nlng) || nlng < -180 || nlng > 180) {
    throw errores.peticionInvalida('Longitud fuera de rango.');
  }
  return { lat: nlat, lng: nlng };
}

/**
 * Arma una direccion legible a partir del desglose que devuelve el proveedor.
 *
 * NO se usa `display_name` tal cual: viene con pais, codigo postal y a veces
 * hasta el nombre de la region, algo como "Carrera 13 #45-67, Chapinero,
 * Bogota, Distrito Capital, 110231, Colombia". Eso no es lo que nadie escribe
 * en la casilla "direccion completa" de un domicilio, y ademas no cabe.
 *
 * Se compone lo que un repartidor necesita para llegar: la via con su numero,
 * el barrio y la ciudad. Si el proveedor no da suficiente desglose se cae a
 * `display_name` recortado, que es peor pero mejor que nada.
 */
function componerDireccion(datos) {
  const a = datos?.address ?? {};

  const via = a.road || a.pedestrian || a.footway || a.residential || a.neighbourhood;
  const numero = a.house_number;
  const barrio = a.suburb || a.neighbourhood || a.city_district || a.borough;
  const ciudad = a.city || a.town || a.village || a.municipality || a.county;

  const partes = [];
  if (via) partes.push(numero ? `${via} #${numero}` : via);
  // El barrio se omite si repite lo que ya dice la via: en muchos barrios el
  // nombre de la calle ES el del barrio, y sale "Chapinero, Chapinero".
  if (barrio && barrio !== via) partes.push(barrio);
  if (ciudad && ciudad !== barrio) partes.push(ciudad);

  if (partes.length) return partes.join(', ');

  // Sin desglose util: se recorta display_name a lo que quepa en el campo.
  const crudo = String(datos?.display_name ?? '').trim();
  return crudo ? crudo.split(',').slice(0, 3).join(',').trim() : null;
}

/**
 * Cola de salida.
 *
 * Todas las llamadas al proveedor se encadenan sobre esta promesa, de modo que
 * nunca hay dos en vuelo y entre una y la siguiente pasan ESPACIADO_MS. Sin
 * esto, cinco clientes moviendo el pin a la vez lanzarian cinco peticiones
 * simultaneas y Nominatim bloquearia la IP del restaurante -- dejando el mapa
 * sin direcciones para todos, no solo para ellos.
 */
let cola = Promise.resolve();
let ultimaLlamada = 0;

function enCola(fn) {
  const resultado = cola.then(async () => {
    const espera = ESPACIADO_MS - (Date.now() - ultimaLlamada);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaLlamada = Date.now();
    return fn();
  });

  // La cola no debe romperse si una llamada falla: se encadena una version que
  // absorbe el error, mientras que el error real si llega a quien lo pidio.
  cola = resultado.catch(() => {});
  return resultado;
}

/** Guarda en cache respetando el techo de entradas. */
function guardar(k, valor) {
  if (cache.size >= MAX_ENTRADAS) {
    // Se tira la mas antigua. Map conserva el orden de insercion, asi que la
    // primera clave es la que lleva mas tiempo dentro.
    const primera = cache.keys().next().value;
    if (primera !== undefined) cache.delete(primera);
  }
  cache.set(k, { valor, expiraEn: Date.now() + TTL_MS });
}

/**
 * Direccion escrita de un punto.
 *
 * NUNCA LANZA por un fallo del proveedor. Que Nominatim no responda no puede
 * impedir dar de alta una direccion: el cliente siempre puede escribirla a
 * mano, que es como se hacia antes de que esto existiera. Por eso el fallo se
 * devuelve como `{ direccion: null, disponible: false }` y no como un error
 * HTTP -- la app deja el campo en paz y el usuario sigue.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{direccion: string|null, disponible: boolean, cacheada: boolean}>}
 */
export async function direccionDe(lat, lng) {
  const punto = validarPunto(lat, lng);
  const k = clave(punto.lat, punto.lng);

  const guardada = cache.get(k);
  if (guardada && guardada.expiraEn > Date.now()) {
    return { direccion: guardada.valor, disponible: true, cacheada: true };
  }

  try {
    const datos = await enCola(async () => {
      const url = new URL(URL_BASE);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(punto.lat));
      url.searchParams.set('lon', String(punto.lng));
      // zoom 18 es "numero de portal". Por debajo devuelve la calle entera o el
      // barrio, que no sirve para entregar un pedido.
      url.searchParams.set('zoom', '18');
      url.searchParams.set('addressdetails', '1');

      const respuesta = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': IDIOMA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });

      if (!respuesta.ok) throw new Error(`el proveedor respondio ${respuesta.status}`);
      return respuesta.json();
    });

    const direccion = componerDireccion(datos);
    // Tambien se cachea el "no hay nada aqui" (mitad del mar, un descampado):
    // sin eso, tocar repetidamente una zona sin datos machaca al proveedor
    // preguntando algo cuya respuesta ya se sabe.
    guardar(k, direccion);

    return { direccion, disponible: true, cacheada: false };
  } catch (error) {
    console.error('[geo] no se pudo resolver la direccion:', error.message);
    return { direccion: null, disponible: false, cacheada: false };
  }
}

/** Estado de la cache, para la pantalla de administracion y las pruebas. */
export function estadoCache() {
  return { entradas: cache.size };
}

/** Solo para las pruebas. */
export function vaciarCache() {
  cache.clear();
}
