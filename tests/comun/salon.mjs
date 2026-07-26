/**
 * Zona de pruebas compartida.
 *
 * El seed ya no siembra zonas ni mesas: el plano de cada restaurante se dibuja
 * desde cero en el disenador (vista 2). Las pruebas necesitan una zona donde
 * colgar sus mesas, asi que se la crean ellas.
 *
 * Es idempotente y devuelve siempre la misma zona: varias suites pueden correr
 * una detras de otra sin pisarse. Ninguna la borra al terminar, porque borrarla
 * arrastraria las mesas y comandas de la suite siguiente.
 *
 * No se fuerza el id 1: se busca por nombre y se crea si no esta. Asi funciona
 * igual sobre una base recien creada que sobre una donde ya se dibujo un salon.
 */

const NOMBRE = 'Zona de pruebas';

/**
 * Garantiza que existe la zona de pruebas y devuelve su id.
 * @param {import('mysql2/promise').Connection} bd conexion con privilegios de escritura
 * @returns {Promise<number>}
 */
export async function asegurarZonaPruebas(bd) {
  const [existente] = await bd.execute('SELECT id_zona FROM zona WHERE nombre = ?', [NOMBRE]);
  if (existente.length) {
    await bd.execute('UPDATE zona SET activa = TRUE WHERE id_zona = ?', [existente[0].id_zona]);
    return existente[0].id_zona;
  }

  const [r] = await bd.execute(
    'INSERT INTO zona (nombre, orden_visual, activa) VALUES (?, 0, TRUE)', [NOMBRE]
  );
  return r.insertId;
}

/**
 * Garantiza una mesa libre en la zona de pruebas y devuelve su id.
 *
 * La usan las pruebas que solo necesitan "una mesa cualquiera donde abrir una
 * comanda". Antes cogian la primera libre del seed; ahora que el salon arranca
 * en blanco, se la crean. Se deja siempre en 'libre': una prueba anterior pudo
 * dejarla ocupada al morir a mitad, y eso haria fallar a la siguiente por un
 * motivo que no tiene nada que ver con lo que prueba.
 *
 * @param {import('mysql2/promise').Connection} bd
 * @param {string} numero identificador de la mesa, unico dentro de la zona
 * @returns {Promise<number>}
 */
export async function asegurarMesaPruebas(bd, numero = 'TEST-1') {
  const idZona = await asegurarZonaPruebas(bd);

  const [existente] = await bd.execute(
    'SELECT id_mesa FROM mesa WHERE id_zona = ? AND numero = ?', [idZona, numero]
  );
  if (existente.length) {
    await bd.execute(
      "UPDATE mesa SET activa = TRUE, estado = 'libre' WHERE id_mesa = ?", [existente[0].id_mesa]
    );
    return existente[0].id_mesa;
  }

  const [r] = await bd.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, 'redonda', 8, 90, 90, 5, 5)`,
    [idZona, numero]
  );
  return r.insertId;
}
