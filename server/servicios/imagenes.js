/**
 * Subida de imagenes de producto.
 *
 * FSD 6.1 (Subida de archivos):
 *  "Solo imagenes JPG/PNG/WebP <= 2 MB, validacion de tipo real (magic bytes),
 *   renombrado aleatorio, almacenamiento fuera de rutas ejecutables."
 *
 * POR QUE MAGIC BYTES Y NO LA EXTENSION
 * La extension y el Content-Type los pone el cliente: renombrar `payload.html`
 * a `foto.jpg` y declararlo `image/jpeg` es trivial. Lo unico que no se puede
 * falsificar sin dejar de ser una imagen valida son los primeros bytes del
 * archivo. Por eso se guarda en memoria, se inspecciona la cabecera real, y
 * solo entonces se escribe a disco: un archivo que no supere la comprobacion
 * nunca llega al sistema de ficheros.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { errores } from '../middleware/errores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Las imagenes se sirven como estaticos, nunca se interpretan como codigo. */
export const DIR_SUBIDAS = path.join(__dirname, '..', '..', 'public', 'uploads');
export const RUTA_PUBLICA = '/uploads';

const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB (FSD 6.1)

/**
 * Firmas reales de los tres formatos permitidos.
 * La extension de salida la decide esta tabla, no el nombre que envio el
 * cliente: asi es imposible acabar con un .html o un .js en el directorio.
 */
const FIRMAS = [
  {
    tipo: 'image/jpeg',
    extension: '.jpg',
    coincide: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    tipo: 'image/png',
    extension: '.png',
    coincide: (b) => b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    tipo: 'image/webp',
    extension: '.webp',
    // RIFF....WEBP: el contenedor RIFF en 0..3 y el marcador WEBP en 8..11.
    coincide: (b) => b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/**
 * Identifica el formato real de un buffer.
 * @returns {{tipo: string, extension: string}|null}
 */
export function detectarFormato(buffer) {
  return FIRMAS.find((f) => f.coincide(buffer)) ?? null;
}

/**
 * Middleware de multer. Guarda en memoria, no en disco: hasta que los magic
 * bytes no se validan, el archivo no toca el sistema de ficheros.
 */
export const recibirImagen = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, archivo, cb) => {
    // Filtro barato por Content-Type declarado. NO es la validacion buena
    // (el cliente lo controla), solo evita procesar lo obviamente ajeno.
    if (!archivo.mimetype?.startsWith('image/')) {
      return cb(errores.peticionInvalida('El archivo debe ser una imagen JPG, PNG o WebP.'));
    }
    cb(null, true);
  },
}).single('imagen');

/**
 * Valida y persiste una imagen.
 *
 * @param {Buffer} buffer  Contenido recibido.
 * @returns {Promise<string>} Ruta publica de la imagen guardada.
 */
export async function guardarImagen(buffer) {
  if (!buffer?.length) {
    throw errores.peticionInvalida('No se recibió ninguna imagen.');
  }
  if (buffer.length > MAX_BYTES) {
    throw errores.peticionInvalida('La imagen supera el máximo de 2 MB.');
  }

  // La comprobacion que de verdad cuenta.
  const formato = detectarFormato(buffer);
  if (!formato) {
    throw errores.peticionInvalida(
      'El archivo no es una imagen JPG, PNG o WebP válida. Puede que la extensión no coincida con su contenido real.'
    );
  }

  await fs.mkdir(DIR_SUBIDAS, { recursive: true });

  // Nombre aleatorio (FSD 6.1): evita colisiones, evita que se adivine la ruta
  // de una imagen ajena, y descarta cualquier nombre malicioso del cliente
  // (por ejemplo con "../" para escapar del directorio).
  const nombre = `${crypto.randomBytes(16).toString('hex')}${formato.extension}`;
  await fs.writeFile(path.join(DIR_SUBIDAS, nombre), buffer);

  return `${RUTA_PUBLICA}/${nombre}`;
}

/**
 * Borra una imagen anterior al reemplazarla.
 * Nunca lanza: que no se pueda borrar un archivo viejo no debe tumbar la
 * edicion de un plato. Como mucho queda un huerfano en disco.
 */
export async function borrarImagen(rutaPublica) {
  if (!rutaPublica?.startsWith(`${RUTA_PUBLICA}/`)) return;

  const nombre = path.basename(rutaPublica);
  // Defensa contra path traversal: solo se acepta el patron que genera
  // guardarImagen(), nada de subrutas ni nombres arbitrarios.
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(nombre)) return;

  try {
    await fs.unlink(path.join(DIR_SUBIDAS, nombre));
  } catch { /* ya no estaba: no hay nada que hacer */ }
}
