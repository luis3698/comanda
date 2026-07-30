/**
 * Cache de la matriz rol -> permisos.
 *
 * POR QUE EXISTE
 * `cargarSesion` relee los permisos en CADA peticion (FSD 5.1: "cambios de rol
 * o permisos surten efecto en la siguiente peticion"). Eso es correcto y no se
 * negocia, pero se estaba pagando con un JOIN contra rol_permiso por peticion
 * -- incluidas las de un KDS que refresca cada pocos segundos y las de un salon
 * con veinte comanderos abiertos. La matriz de permisos, en cambio, cambia
 * cuando el administrador la edita: dos o tres veces en la vida del sistema.
 *
 * SE SIGUE CUMPLIENDO LA REGLA DEL FSD
 * La invalidacion es explicita: `invalidar()` se llama desde el unico sitio que
 * escribe rol_permiso (PUT /roles/:id/permisos) y desde el borrado de roles.
 * En el proceso que atiende esa escritura el efecto es inmediato -- la
 * siguiente peticion ya lee la matriz nueva -- que es literalmente lo que pide
 * el FSD 5.1.
 *
 * El TTL es la red de seguridad para el dia en que haya varias instancias
 * detras de un balanceador: la que no atendio la escritura se enteraria como
 * mucho 30 s despues. Es el mismo compromiso, y por las mismas razones, que ya
 * se documenta en servicios/parametros.js.
 *
 * LO QUE NO SE CACHEA, A PROPOSITO
 * El rol del usuario, si sigue activo y si su sesion vive. Eso se lee siempre
 * de la base: dar de baja a alguien o cambiarle el rol tiene que cortar en
 * seco, y son justo los datos que un atacante querria que quedaran cacheados.
 * Aqui solo vive el mapa rol -> codigos, que no depende del usuario.
 */
import { consultar } from '../db.js';

/** Milisegundos que se considera fresca una entrada. */
const TTL_MS = 30_000;

/** idRol -> { permisos: Set<string>, expiraEn: number } */
const cache = new Map();

/**
 * Permisos de un rol, como Set de codigos.
 *
 * Devuelve SIEMPRE el mismo Set mientras la entrada siga fresca, asi que quien
 * lo reciba no debe modificarlo. Nadie lo hace: `req.usuario.permisos` solo se
 * consulta con .has() desde middleware/permisos.js y desde realtime.js.
 *
 * @param {number} idRol
 * @returns {Promise<Set<string>>}
 */
export async function permisosDeRol(idRol) {
  const ahora = Date.now();
  const entrada = cache.get(idRol);
  if (entrada && entrada.expiraEn > ahora) return entrada.permisos;

  const filas = await consultar(
    `SELECT p.codigo
       FROM rol_permiso rp
       JOIN permiso p ON p.id_permiso = rp.id_permiso
      WHERE rp.id_rol = ?`,
    [idRol]
  );

  const permisos = new Set(filas.map((f) => f.codigo));
  cache.set(idRol, { permisos, expiraEn: ahora + TTL_MS });
  return permisos;
}

/**
 * Suscriptores a la invalidacion.
 *
 * Lo usa el canal de tiempo real. Un WebSocket resuelve los permisos UNA vez,
 * en el handshake, y se queda con ellos mientras el socket viva -- que en un
 * KDS son las doce horas del turno. Quitarle a un rol el permiso de ver la
 * cocina cortaba su acceso por HTTP en la peticion siguiente, pero su pantalla
 * seguia recibiendo comandas en vivo hasta que alguien recargara.
 *
 * En vez de releer la matriz en cada difusion -- publicar() es sincrono y se
 * llama en el camino critico de CA-01 --, se avisa a quien tenga clientes
 * conectados justo cuando la matriz cambia, que son dos o tres veces en la vida
 * del sistema.
 *
 * @type {Array<() => void>}
 */
const suscriptores = [];

/**
 * Registra una funcion que se ejecuta cada vez que la matriz cambia.
 * @param {() => void} fn
 */
export function alInvalidar(fn) {
  suscriptores.push(fn);
}

/**
 * Fuerza la relectura. Sin argumento vacia la cache entera.
 *
 * Se llama desde las rutas que tocan la matriz. Vaciar de mas nunca hace dano
 * -- como mucho cuesta un SELECT --, mientras que olvidar una invalidacion deja
 * permisos viejos vivos hasta 30 s; ante la duda, se invalida todo.
 *
 * @param {number} [idRol]
 */
export function invalidar(idRol) {
  if (idRol === undefined) cache.clear();
  else cache.delete(idRol);

  for (const fn of suscriptores) {
    // Un suscriptor que reviente no puede tumbar la peticion que estaba
    // guardando los permisos: el guardado ya se hizo y fue correcto.
    try {
      fn(idRol);
    } catch (e) {
      console.error('[permisos] fallo al notificar la invalidacion:', e.message);
    }
  }
}

/** Solo para las pruebas: estado interno de la cache. */
export function estadoCache() {
  return { roles: cache.size };
}
