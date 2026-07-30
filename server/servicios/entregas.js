/**
 * Cobertura de domicilios: que zona cubre un punto y cuanto cuesta llevarlo.
 *
 * ESTE ARCHIVO ES LA UNICA FUENTE DE VERDAD DE LA REGLA.
 * Lo llaman los dos lados:
 *   - el Administrador, al previsualizar una coordenada mientras dibuja
 *     los circulos en el mapa   (POST /configuracion/zonas-entrega/previsualizar)
 *   - el cliente, al pedir      (POST /app/domicilios/cotizar)
 *
 * Si la formula se hubiera duplicado en el navegador o en la app, un dia el
 * administrador veria un precio y el comensal otro. Al vivir en un solo sitio,
 * discrepar es imposible.
 *
 * POR QUE CIRCULOS Y NO POLIGONOS
 * Un poligono describe mejor un barrio real, pero exige un editor de vertices
 * y consultas espaciales (ST_Contains, indices SPATIAL). El circulo se dibuja
 * con dos gestos, se le explica solo al administrador ("hasta 3 km cuesta
 * $5.000") y se resuelve con Haversine sin extensiones de MySQL.
 */
import { consultar } from '../db.js';
import { aCentavos, aDecimal } from './dinero.js';
import { obtener } from './parametros.js';

/** Radio medio de la Tierra en metros (esfera WGS-84). */
const RADIO_TIERRA_M = 6_371_008.8;

const aRadianes = (grados) => (grados * Math.PI) / 180;

/**
 * Distancia sobre la superficie terrestre entre dos puntos, en metros.
 *
 * Haversine y no la distancia euclidea sobre lat/lng: un grado de longitud mide
 * ~111 km en el ecuador pero ~79 km en Bogota, asi que restar coordenadas
 * directamente daria zonas de reparto ovaladas y precios mal cobrados. Tampoco
 * hace falta Vincenty: a escala de una ciudad, el error de la aproximacion
 * esferica es de centimetros.
 */
export function distanciaMetros(lat1, lng1, lat2, lng2) {
  const dLat = aRadianes(lat2 - lat1);
  const dLng = aRadianes(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(a)));
}

/** ¿Es una coordenada geografica valida? */
export function coordenadaValida(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/** Zonas activas, ya ordenadas por la regla de desempate. */
async function zonasActivas() {
  return consultar(
    `SELECT id_zona_entrega, nombre, centro_lat, centro_lng, radio_m,
            costo_envio, pedido_minimo, tiempo_estimado_min, color, prioridad
       FROM zona_entrega
      WHERE activa = TRUE
      ORDER BY prioridad ASC, radio_m ASC`
  );
}

/** Forma con la que se devuelve una zona al cliente. */
function comoDto(z, distancia = null) {
  return {
    id: z.id_zona_entrega,
    nombre: z.nombre,
    centroLat: Number(z.centro_lat),
    centroLng: Number(z.centro_lng),
    radioM: z.radio_m,
    costoEnvio: z.costo_envio,          // string DECIMAL, sin pasar por Number
    pedidoMinimo: z.pedido_minimo,
    tiempoEstimadoMin: z.tiempo_estimado_min,
    color: z.color,
    prioridad: z.prioridad,
    ...(distancia !== null ? { distanciaM: distancia } : {}),
  };
}

/** Lista publica de zonas, para pintarlas en el mapa del Admin y de la app. */
export async function listarZonas() {
  const filas = await zonasActivas();
  return filas.map((z) => comoDto(z));
}

/**
 * Zona que cubre un punto, o null si ninguna lo alcanza.
 *
 * DESEMPATE. Un punto puede caer dentro de varios circulos a la vez -- es lo
 * normal cuando hay una zona amplia y otra pequena de precio reducido para el
 * centro. Gana la `prioridad` MENOR y, a igualdad, el `radio_m` menor: la zona
 * mas especifica. Asi el administrador consigue "todo el sur a $8.000, salvo
 * estos 800 m junto al local, que van a $3.000" dibujando el circulo pequeno
 * encima del grande, sin recortar nada.
 *
 * La consulta ya viene ordenada por ese criterio, asi que basta la primera
 * coincidencia.
 */
export async function zonaPara(lat, lng) {
  if (!coordenadaValida(lat, lng)) return null;

  for (const z of await zonasActivas()) {
    const distancia = distanciaMetros(lat, lng, Number(z.centro_lat), Number(z.centro_lng));
    if (distancia <= z.radio_m) return comoDto(z, distancia);
  }
  return null;
}

/**
 * Cotiza una entrega.
 *
 * Devuelve SIEMPRE un objeto, tambien cuando no hay cobertura: el cliente
 * necesita distinguir "no llegamos hasta ahi" de "te falta pedido minimo", y
 * cada caso se resuelve de forma distinta (mover el pin / anadir platos). Un
 * error 4xx para ambos obligaria a leer codigos de error para pintar la
 * pantalla.
 *
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lng
 * @param {string|number} [p.subtotal]  Subtotal del carrito, para el minimo.
 * @returns {Promise<{cubierto: boolean, motivo: string|null, zona: object|null,
 *                    costoEnvio: string, pedidoMinimo: string,
 *                    faltaParaMinimo: string, tiempoEstimadoMin: number|null}>}
 */
export async function cotizar({ lat, lng, subtotal = 0 }) {
  const sinCobertura = {
    cubierto: false,
    motivo: 'fuera_de_cobertura',
    zona: null,
    costoEnvio: '0.00',
    pedidoMinimo: '0.00',
    faltaParaMinimo: '0.00',
    tiempoEstimadoMin: null,
  };

  if (!coordenadaValida(lat, lng)) {
    return { ...sinCobertura, motivo: 'coordenada_invalida' };
  }

  const zona = await zonaPara(lat, lng);
  if (!zona) return sinCobertura;

  // El minimo de la zona manda; si la zona no define uno propio (0), se aplica
  // el global, que el administrador ajusta en un solo sitio.
  const minimoGlobal = await obtener('domicilios.pedido_minimo_global', 0);
  const minimoZonaCentavos = aCentavos(zona.pedidoMinimo);
  const minimoCentavos = minimoZonaCentavos > 0 ? minimoZonaCentavos : aCentavos(minimoGlobal);

  const subtotalCentavos = aCentavos(subtotal);
  const faltan = Math.max(0, minimoCentavos - subtotalCentavos);

  return {
    cubierto: faltan === 0,
    motivo: faltan > 0 ? 'pedido_minimo' : null,
    zona,
    costoEnvio: aDecimal(aCentavos(zona.costoEnvio)),
    pedidoMinimo: aDecimal(minimoCentavos),
    faltaParaMinimo: aDecimal(faltan),
    tiempoEstimadoMin: zona.tiempoEstimadoMin,
  };
}
