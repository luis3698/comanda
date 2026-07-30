/**
 * Compresion de respuestas.  gzip / deflate / brotli
 *
 * POR QUE A MANO Y NO CON EL PAQUETE `compression`
 * Por la misma razon por la que las cabeceras de seguridad de index.js no usan
 * helmet: es poco codigo, queda a la vista y es una dependencia menos que
 * auditar. Lo que hace falta aqui son ochenta lineas de node:zlib.
 *
 * QUE GANA
 * El plano del salon, la carta y la cola del KDS son JSON con mucha estructura
 * repetida: comprimen entre un 75 % y un 85 %. Leaflet, que se sirve
 * vendorizado desde public/vendor/, son 150 KB que bajan a unos 45 KB. En la
 * red wifi de un restaurante, con quince tabletas colgando del mismo punto de
 * acceso, eso es la diferencia entre un plano que aparece y uno que tarda.
 *
 * COMO DECIDE, SIN LLENAR LA MEMORIA
 * No acumula la respuesta para medirla. Decide en el momento de la primera
 * escritura, mirando las cabeceras que ya estan puestas:
 *
 *  - Si hay Content-Length y es pequeño, no comprime. Comprimir 200 bytes los
 *    deja en 190 y gasta CPU: no compensa. Como express fija Content-Length en
 *    res.json() y express.static lo fija con el tamaño del archivo, este caso
 *    cubre practicamente todas las respuestas del sistema.
 *  - Si NO hay Content-Length, la respuesta va en streaming (una factura en PDF
 *    o un reporte en Excel) y se decide solo por el tipo.
 *
 * LO QUE NUNCA COMPRIME
 * Lo que ya viene comprimido: imagenes de los platos, teselas del mapa (PNG),
 * PDF y XLSX -- un .xlsx es un zip por dentro. Volver a comprimirlos gasta CPU
 * para dejarlo todo igual o un poco mas grande.
 */
import zlib from 'node:zlib';

/** Por debajo de esto no compensa comprimir. */
const UMBRAL_BYTES = 1024;

/**
 * Tipos que SI comprimen. Se comprueba con startsWith contra el Content-Type,
 * asi que "application/json; charset=utf-8" entra por "application/json".
 */
const COMPRIMIBLES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/manifest+json',
  'image/svg+xml',
  'application/xml',
  'application/x-ndjson',
];

/**
 * Elige la codificacion mirando el Accept-Encoding del cliente.
 *
 * Brotli primero, y luego gzip para quien no lo anuncie. Lo entiende cualquier
 * navegador desde 2017, muy por debajo de lo que ya exige el resto del sistema.
 */
function negociar(cabecera) {
  const aceptado = String(cabecera ?? '').toLowerCase();
  if (aceptado.includes('br')) return 'br';
  if (aceptado.includes('gzip')) return 'gzip';
  if (aceptado.includes('deflate')) return 'deflate';
  return null;
}

/**
 * Calidad de brotli: 5.
 *
 * NO es un numero elegido a ojo. Medido sobre los dos contenidos que de verdad
 * viajan por aqui -- leaflet.js, que es lo mas grande que se sirve, y una cola
 * del KDS de 60 comandas, que es lo mas frecuente:
 *
 *                    leaflet.js (147 KB)      JSON del KDS (51 KB)
 *   gzip -6            42 715 B   3,65 ms       1 517 B   0,21 ms
 *   brotli q4          43 940 B   2,86 ms       1 054 B   0,22 ms
 *   brotli q5          41 056 B   4,12 ms       1 012 B   0,78 ms
 *   brotli q6          40 563 B   5,16 ms       1 012 B   1,39 ms
 *   brotli q7          40 248 B   9,81 ms       1 002 B   2,74 ms
 *
 * La q4 sale PEOR que gzip sobre JavaScript, asi que no sirve. De la q6 en
 * adelante se paga mas tiempo del que se ahorra en bytes. La q5 es la primera
 * que gana a gzip en los dos casos, y su coste sobre el JSON -- 0,78 ms -- no
 * se nota dentro del segundo que concede CA-01 para que la comanda llegue al
 * KDS.
 *
 * La q11 por defecto de brotli esta pensada para comprimir un archivo UNA vez
 * al publicarlo, no para responder en caliente.
 */
const CALIDAD_BROTLI = 5;

/**
 * @param {string} codificacion
 * @param {number|null} tamano  Bytes del cuerpo, si se conocen. Brotli
 *   aprovecha el dato para dimensionar su ventana en vez de suponerla.
 */
function crearCompresor(codificacion, tamano) {
  if (codificacion === 'br') {
    const params = {
      [zlib.constants.BROTLI_PARAM_QUALITY]: CALIDAD_BROTLI,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    };
    if (tamano) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = tamano;
    return zlib.createBrotliCompress({ params });
  }
  if (codificacion === 'deflate') return zlib.createDeflate({ level: 6 });
  return zlib.createGzip({ level: 6 });
}

/** Decide si esta respuesta concreta merece comprimirse. */
function vale(res) {
  // Ya viene codificada (otro middleware, o un archivo pre-comprimido).
  if (res.getHeader('Content-Encoding')) return false;

  // 204 y 304 no llevan cuerpo.
  if (res.statusCode === 204 || res.statusCode === 304) return false;

  // El estandar dice que no-transform prohibe a los intermediarios tocar el
  // cuerpo. Se respeta.
  if (String(res.getHeader('Cache-Control') ?? '').includes('no-transform')) return false;

  const tipo = String(res.getHeader('Content-Type') ?? '').toLowerCase();
  if (!tipo) return false;
  if (!COMPRIMIBLES.some((c) => tipo.startsWith(c))) return false;

  const largo = res.getHeader('Content-Length');
  // Sin Content-Length la respuesta va en streaming: no se puede medir, y por
  // el tipo ya se sabe que es texto.
  if (largo === undefined) return true;
  return Number(largo) >= UMBRAL_BYTES;
}

/**
 * Middleware de compresion. Se monta antes que las rutas y los estaticos.
 */
export function comprimir() {
  return (req, res, next) => {
    // Vary siempre, se comprima o no: sin esto una cache intermedia podria
    // servirle la version comprimida a un cliente que no la admite.
    res.setHeader('Vary', 'Accept-Encoding');

    const codificacion = negociar(req.headers['accept-encoding']);
    // HEAD no lleva cuerpo que comprimir.
    if (!codificacion || req.method === 'HEAD') return next();

    const escribirOriginal = res.write.bind(res);
    const terminarOriginal = res.end.bind(res);

    let compresor = null;
    let decidido = false;

    /** Se resuelve una sola vez, en la primera escritura. */
    function decidir() {
      if (decidido) return;
      decidido = true;
      if (!vale(res)) return;

      // Se lee antes de quitarlo: es el tamaño real del cuerpo sin comprimir,
      // justo lo que brotli quiere saber de antemano.
      const tamano = Number(res.getHeader('Content-Length')) || null;

      // El cuerpo cambia de tamaño: el Content-Length de antes ya no describe
      // lo que va a viajar. Dejarlo puesto corta la respuesta a medias.
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', codificacion);

      compresor = crearCompresor(codificacion, tamano);
      compresor.on('data', (trozo) => escribirOriginal(trozo));
      compresor.on('end', () => terminarOriginal());

      // CONTRAPRESION: sin esta linea, los archivos grandes se quedan a medias.
      //
      // express.static sirve con stream.pipe(res). pipe respeta la
      // contrapresion asi: si res.write() devuelve false, pausa el origen y
      // espera a que RES emita 'drain'. Pero aqui res.write ya no escribe en
      // res, sino en el compresor, y quien se llena -- y quien luego se vacia --
      // es el compresor. El 'drain' se emitia donde nadie escuchaba: pipe se
      // quedaba esperando para siempre un evento que no iba a llegar.
      //
      // El sintoma era exactamente ese: leaflet.js (147 KB) entregaba los diez
      // bytes de la cabecera gzip y la peticion no terminaba nunca. Los JSON de
      // la API no lo notaban porque caben de sobra en el buffer del compresor y
      // nunca llegan a devolver false.
      compresor.on('drain', () => res.emit('drain'));
      compresor.on('error', (e) => {
        // A estas alturas ya se anuncio Content-Encoding y puede haber salido
        // parte del cuerpo: no hay forma honesta de recuperarse, asi que se
        // corta la conexion en vez de entregar algo que el navegador no podra
        // descomprimir.
        console.error('[compresion] fallo al comprimir:', e.message);
        res.destroy();
      });
    }

    res.write = function write(trozo, codificacionTexto, callback) {
      decidir();
      if (!compresor) return escribirOriginal(trozo, codificacionTexto, callback);
      return compresor.write(trozo, codificacionTexto, callback);
    };

    res.end = function end(trozo, codificacionTexto, callback) {
      // res.end() admite (cb), (datos, cb) y (datos, codificacion, cb).
      if (typeof trozo === 'function') { callback = trozo; trozo = undefined; }
      else if (typeof codificacionTexto === 'function') { callback = codificacionTexto; codificacionTexto = undefined; }

      decidir();
      if (!compresor) return terminarOriginal(trozo, codificacionTexto, callback);

      // terminarOriginal la llama el evento 'end' del compresor, cuando ya ha
      // salido el ultimo byte comprimido.
      if (callback) res.once('finish', callback);
      compresor.end(trozo, codificacionTexto);
      return res;
    };

    return next();
  };
}
