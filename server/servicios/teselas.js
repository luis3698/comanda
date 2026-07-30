/**
 * Proxy y cache de teselas de mapa.
 *
 * POR QUE EXISTE ESTE ARCHIVO
 * El CSP del servidor es estricto a proposito (server/index.js): `img-src
 * 'self' data:` y `connect-src 'self'`. Un mapa que pidiera las teselas
 * directamente a tile.openstreetmap.org quedaria bloqueado por el navegador.
 *
 * Habia dos salidas: relajar el CSP para dejar entrar a un tercero, o traer
 * las teselas por aqui. Se eligio lo segundo, y el CSP no se modifico ni un
 * caracter. A cambio se consiguen tres cosas mas:
 *
 *   1. El navegador del restaurante no habla con ningun servidor externo, asi
 *      que no filtra a nadie que se este mirando las coordenadas del local.
 *   2. La cache en disco hace que dibujar la misma zona diez veces cueste una
 *      sola descarga. Sin ella se estaria martilleando un servicio publico y
 *      gratuito, que es justo lo que su politica de uso prohibe.
 *   3. La aplicacion Android usa ESTE MISMO endpoint (osmdroid apuntando
 *      aqui), asi que no hace falta clave de Google Maps ni cuenta de
 *      facturacion.
 *
 * POLITICA DE USO DE OPENSTREETMAP
 * Exige un User-Agent identificable y desaconseja el trafico masivo. Ambas
 * cosas se respetan: cabecera propia configurable y cache agresiva. Para un
 * despliegue serio, lo correcto es apuntar MAPA_TESELAS_URL a un proveedor de
 * teselas propio o de pago.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errores } from '../middleware/errores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Plantilla del proveedor. Se puede cambiar sin tocar codigo. */
const PLANTILLA = process.env.MAPA_TESELAS_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * Fuera de public/: estas imagenes NO se sirven como estaticos, se entregan
 * por el endpoint, que valida antes las coordenadas. Un directorio publico
 * escribible por una descarga remota es una superficie de ataque gratuita.
 */
export const DIR_CACHE = process.env.MAPA_CACHE_DIR ||
  path.join(__dirname, '..', '..', '.cache', 'teselas');

const USER_AGENT = process.env.MAPA_USER_AGENT || 'SIGR/0.1 (sistema de gestion de restaurantes)';

/** Cuanto puede cachear el navegador. Las teselas cambian muy despacio. */
const CACHE_NAVEGADOR_S = 60 * 60 * 24 * 7;   // 7 dias

/** Zoom aceptado. Por debajo de 1 no hay detalle; por encima de 19, OSM no sirve. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 19;

/** Tiempo maximo esperando al proveedor antes de rendirse. */
const TIEMPO_LIMITE_MS = 8000;

/**
 * Valida z/x/y.
 *
 * ESTO ES LA DEFENSA CONTRA EL PATH TRAVERSAL. Los tres valores acaban
 * formando una ruta de archivo; si no fueran enteros comprobados, un
 * `..%2f..%2fetc%2fpasswd` saldria del directorio de cache. Por eso se
 * convierten a numero, se exige que sean enteros y se acotan al rango que la
 * propia rejilla del mapa permite: en el zoom z solo existen 2^z columnas y
 * 2^z filas, asi que cualquier valor fuera de ahi es basura.
 */
export function validarCoordenadas(z, x, y) {
  const nz = Number(z);
  const nx = Number(x);
  const ny = Number(y);

  if (!Number.isInteger(nz) || nz < ZOOM_MIN || nz > ZOOM_MAX) {
    throw errores.peticionInvalida('Nivel de zoom fuera de rango.');
  }

  const maximo = 2 ** nz;
  if (!Number.isInteger(nx) || nx < 0 || nx >= maximo ||
      !Number.isInteger(ny) || ny < 0 || ny >= maximo) {
    throw errores.peticionInvalida('Coordenadas de tesela fuera de rango.');
  }

  return { z: nz, x: nx, y: ny };
}

/** Ruta en disco de una tesela ya validada. */
function rutaEnDisco(z, x, y) {
  return path.join(DIR_CACHE, String(z), String(x), `${y}.png`);
}

/** Descarga la tesela del proveedor. */
async function descargar(z, x, y) {
  const url = PLANTILLA
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);

  try {
    const respuesta = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*' },
      signal: control.signal,
    });

    if (!respuesta.ok) {
      throw errores.noEncontrado(`La tesela ${z}/${x}/${y}`);
    }

    const buffer = Buffer.from(await respuesta.arrayBuffer());

    // Se comprueba que de verdad es un PNG antes de guardarlo, con la misma
    // logica de magic bytes que servicios/imagenes.js: si el proveedor
    // devolviera una pagina de error con estado 200, no acabaria en la cache
    // haciendose pasar por una imagen.
    const esPng = buffer.length > 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    if (!esPng) throw errores.noEncontrado(`La tesela ${z}/${x}/${y}`);

    return buffer;
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Devuelve una tesela, de la cache si esta o del proveedor si no.
 *
 * Un fallo al ESCRIBIR la cache no rompe la peticion: la tesela ya se
 * descargo y el usuario debe verla igualmente. Lo unico que se pierde es el
 * ahorro de la proxima vez.
 *
 * @returns {Promise<{buffer: Buffer, deCache: boolean}>}
 */
export async function obtenerTesela(z, x, y) {
  const validas = validarCoordenadas(z, x, y);
  const ruta = rutaEnDisco(validas.z, validas.x, validas.y);

  try {
    return { buffer: await fs.readFile(ruta), deCache: true };
  } catch {
    // No estaba en cache: se pide al proveedor.
  }

  const buffer = await descargar(validas.z, validas.x, validas.y);

  try {
    await fs.mkdir(path.dirname(ruta), { recursive: true });
    await fs.writeFile(ruta, buffer);
  } catch (error) {
    console.error('[mapa] no se pudo cachear la tesela:', error.message);
  }

  return { buffer, deCache: false };
}

/** Cabeceras de respuesta de una tesela. */
export function cabecerasTesela() {
  return {
    'Content-Type': 'image/png',
    'Cache-Control': `public, max-age=${CACHE_NAVEGADOR_S}, immutable`,
  };
}

/** Tamano y numero de teselas cacheadas, para la pantalla de configuracion. */
export async function estadisticasCache() {
  let archivos = 0;
  let bytes = 0;

  async function recorrer(dir) {
    let entradas;
    try {
      entradas = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;   // la cache aun no existe
    }
    for (const entrada of entradas) {
      const completa = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        await recorrer(completa);
      } else {
        archivos++;
        bytes += (await fs.stat(completa).catch(() => ({ size: 0 }))).size;
      }
    }
  }

  await recorrer(DIR_CACHE);
  return { archivos, bytes, megas: Number((bytes / 1024 / 1024).toFixed(2)) };
}
