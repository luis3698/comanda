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

export default router;
