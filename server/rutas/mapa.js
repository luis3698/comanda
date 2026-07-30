/**
 * Teselas de mapa.   /api/v1/mapa
 *
 * Existe para que el mapa del modulo Administrador y el de la aplicacion
 * Android carguen sin relajar el CSP ni contratar una clave de Google Maps.
 * El porque completo esta en servicios/teselas.js.
 *
 * NO EXIGE SESION, A PROPOSITO
 * Son imagenes publicas de OpenStreetMap, las mismas que sirve cualquier mapa
 * de internet: no revelan ni un dato del restaurante. Pedir sesion aqui
 * romperia el mapa de la aplicacion antes del login -- justo cuando el cliente
 * quiere ver si le llega el domicilio a su barrio -- y obligaria a osmdroid a
 * gestionar tokens para bajar imagenes.
 *
 * Lo que si esta protegido es el gasto: z/x/y se validan contra la rejilla
 * real del mapa (lo que ademas cierra el path traversal, porque esos valores
 * acaban formando una ruta de archivo) y todo se cachea en disco.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/errores.js';
import { obtenerTesela, cabecerasTesela } from '../servicios/teselas.js';
import { direccionDe } from '../servicios/geocodificacion.js';
import { limitar } from '../middleware/limite.js';

const router = Router();

/**
 * GET /api/v1/mapa/teselas/:z/:x/:y.png
 *
 * El `.png` final se recorta del parametro. Va en la URL porque Leaflet y
 * osmdroid construyen las suyas con esa forma, y porque asi la respuesta se
 * comporta como una imagen normal en la cache del navegador.
 */
router.get('/teselas/:z/:x/:y.png', asyncHandler(async (req, res) => {
  const { z, x } = req.params;
  const y = String(req.params.y).replace(/\.png$/i, '');

  const { buffer } = await obtenerTesela(z, x, y);

  res.set(cabecerasTesela());
  return res.send(buffer);
}));

/** Variante sin extension, por si algun cliente construye asi la URL. */
router.get('/teselas/:z/:x/:y', asyncHandler(async (req, res) => {
  const { z, x, y } = req.params;
  const { buffer } = await obtenerTesela(z, x, y);

  res.set(cabecerasTesela());
  return res.send(buffer);
}));

/**
 * Limite propio para la geocodificacion, mas estrecho que el del resto.
 *
 * Las teselas se cachean en disco y una vez descargadas no cuestan nada, pero
 * cada direccion NO cacheada es una llamada a un servicio publico que solo
 * admite una por segundo en total. 30 por minuto y por IP da de sobra para
 * alguien moviendo el pin -- la app ademas espera a que suelte antes de
 * preguntar -- y evita que un cliente en bucle agote la cuota de todos.
 */
const limiteGeo = limitar({
  maximo: 30,
  ventanaMs: 60 * 1000,
  mensaje: 'Demasiadas consultas de direccion seguidas. Espere unos segundos.',
});

/**
 * GET /api/v1/mapa/direccion?lat=..&lng=..
 *
 * Geocodificacion inversa: devuelve la direccion escrita del punto. La usa la
 * aplicacion movil para rellenar sola la casilla "Direccion completa" cuando el
 * cliente situa el pin.
 *
 * SIN SESION, igual que las teselas y por el mismo motivo: la pantalla que la
 * necesita convive con el mapa, y exigir sesion obligaria a osmdroid y al
 * dialogo de direcciones a gestionar el token para algo que no revela ni un
 * dato del restaurante. Lo que si tiene es limite por IP, arriba.
 *
 * RESPONDE 200 AUNQUE EL PROVEEDOR FALLE, con `disponible: false`. Que el
 * servicio de mapas este caido no puede impedir dar de alta una direccion: el
 * cliente la escribe a mano, como se hacia antes. Un 5xx aqui obligaria a la
 * app a distinguir "no se pudo" de "esto esta roto" para acabar haciendo lo
 * mismo en los dos casos.
 */
router.get('/direccion', limiteGeo, asyncHandler(async (req, res) => {
  const r = await direccionDe(req.query.lat, req.query.lng);

  // Sin cache de navegador: la respuesta ya se cachea en el servidor, que es
  // donde sirve para todos, y aqui solo escondería un cambio de direccion.
  res.set('Cache-Control', 'no-store');
  return res.json(r);
}));

export default router;
