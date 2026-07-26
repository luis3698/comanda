/**
 * Criterios de aceptacion de la fase 3, contra la base de datos real.
 *
 *   CA-03  El stock baja exactamente receta.cantidad x cantidad vendida.
 *   CA-04  El precio cobrado es el vigente al enviar y no cambia si el
 *          catalogo se edita despues.
 *   CA-09  Dos meseros no pueden abrir simultaneamente la misma mesa.
 *
 * Estas pruebas NO usan mocks: la concurrencia y las transacciones solo se
 * pueden verificar contra un MySQL de verdad. Requieren el contenedor en pie:
 *
 *   docker compose up -d db
 *   npm test
 *
 * Cada prueba limpia lo que crea, para poder ejecutarse una y otra vez.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import 'dotenv/config';

import { asegurarZonaPruebas } from '../comun/salon.mjs';
import { pool, consultarUno, consultar } from '../../server/db.js';
import { abrirOrden, agregarLinea, enviarACocina, anularLinea } from '../../server/servicios/ordenes.js';

/**
 * Conexion administrativa SOLO para limpiar entre pruebas.
 *
 * Hace falta porque el usuario de la aplicacion no tiene DELETE sobre
 * `movimiento_inventario` ni sobre `log_auditoria` (db/04_privilegios.sql):
 * son tablas de solo insercion y el motor lo impone, tambien contra este
 * archivo. Eso es exactamente lo que se quiere en produccion, asi que en vez
 * de aflojar los privilegios, las pruebas usan una credencial aparte para
 * dejar la base como estaba.
 *
 * Ningun codigo de `server/` usa esta conexion.
 */
let admin;

/** Datos del seed que usan las pruebas. */
const MESERO = 4;                    // Luis Barrera
const HAMBURGUESA = 3;               // Hamburguesa Clasica, precio base 32000
const CARNE = 1;                     // Carne de res: 150 g por hamburguesa
const PAN = 3;                       // Pan brioche: 1 unidad por hamburguesa

const NUMERO_MESA_PRUEBA = 'TEST-CA';
let idMesaPrueba;
let idZona;

/**
 * Borra todo rastro de la mesa de pruebas.
 * El orden importa: las FK impiden borrar la mesa antes que sus ordenes, y el
 * kardex antes que las lineas que lo referencian.
 */
async function limpiarMesaPrueba() {
  const [previas] = await admin.execute(
    'SELECT id_mesa FROM mesa WHERE id_zona = ? AND numero = ?', [idZona, NUMERO_MESA_PRUEBA]
  );
  for (const m of previas) {
    const [ordenes] = await admin.execute('SELECT id_orden FROM orden WHERE id_mesa = ?', [m.id_mesa]);
    for (const o of ordenes) {
      // El kárdex y la auditoría solo se pueden tocar con la credencial admin.
      await admin.execute(
        `DELETE FROM movimiento_inventario
          WHERE id_referencia IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)`,
        [o.id_orden]
      );
      // La auditoría es de solo inserción (append-only): NO se borra aquí.
      // Borrar filas de log_auditoria rompe la cadena de hashes de todos los
      // registros siguientes y hace que la vista 9 reporte "cadena rota" con un
      // registro que en realidad nunca fue manipulado en producción. Las filas
      // quedan como historial; su id_entidad no tiene FK, así que apuntar a una
      // orden ya borrada es válido.
      await admin.execute(
        `DELETE FROM orden_detalle_modificador
          WHERE id_orden_detalle IN (SELECT id_orden_detalle FROM orden_detalle WHERE id_orden = ?)`,
        [o.id_orden]
      );
      await admin.execute('DELETE FROM orden_detalle WHERE id_orden = ?', [o.id_orden]);
    }
    await admin.execute('DELETE FROM orden WHERE id_mesa = ?', [m.id_mesa]);
    await admin.execute('DELETE FROM mesa WHERE id_mesa = ?', [m.id_mesa]);
  }
}

/**
 * Mesa exclusiva de las pruebas: no se tocan las del seed.
 * Se limpia ANTES de crearla, no solo despues: si una ejecucion anterior murio
 * a mitad, la mesa quedaria viva y el UNIQUE(id_zona, numero) haria fallar
 * todas las pruebas con un error que no tiene nada que ver con lo que prueban.
 */
before(async () => {
  admin = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3307),
    user: 'root',
    password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
    database: process.env.DB_NAME || 'sigr',
  });

  idZona = await asegurarZonaPruebas(admin);
  await limpiarMesaPrueba();
  const [r] = await admin.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, 'redonda', 8, 90, 90, 5, 5)`,
    [idZona, NUMERO_MESA_PRUEBA]
  );
  idMesaPrueba = r.insertId;
});

after(async () => {
  await limpiarMesaPrueba();
  await admin.end();
  await pool.end();
});

/** Libera la mesa entre pruebas. */
async function liberarMesa() {
  await pool.execute("UPDATE orden SET estado = 'cerrada' WHERE id_mesa = ? AND estado IN ('abierta','enviada','precuenta')", [idMesaPrueba]);
  await pool.execute("UPDATE mesa SET estado = 'libre' WHERE id_mesa = ?", [idMesaPrueba]);
}

async function stockDe(idInsumo) {
  const f = await consultarUno('SELECT stock_actual FROM insumo WHERE id_insumo = ?', [idInsumo]);
  return Number(f.stock_actual);
}

/* =====================================================================
   CA-09 — Concurrencia en la apertura de mesa
   ===================================================================== */

test('CA-09: dos meseros no pueden abrir la misma mesa a la vez', async () => {
  await liberarMesa();

  // Las dos peticiones salen a la vez, como dos meseros tocando la mesa en el
  // mismo instante. Sin SELECT ... FOR UPDATE ambas leerian "libre" y ambas
  // insertarian su orden.
  const resultados = await Promise.allSettled([
    abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 2 }),
    abrirOrden({ idMesa: idMesaPrueba, idMesero: 1, numComensales: 4 }),
  ]);

  const exitosas = resultados.filter((r) => r.status === 'fulfilled');
  const fallidas = resultados.filter((r) => r.status === 'rejected');

  assert.equal(exitosas.length, 1, 'exactamente una apertura debe tener éxito');
  assert.equal(fallidas.length, 1, 'la otra debe fallar');
  assert.match(fallidas[0].reason.message, /no está libre/i);

  // La comprobacion que de verdad importa: una sola orden viva en la mesa.
  const vivas = await consultarUno(
    `SELECT COUNT(*) AS n FROM orden
      WHERE id_mesa = ? AND estado IN ('abierta','enviada','precuenta')`,
    [idMesaPrueba]
  );
  assert.equal(vivas.n, 1, 'la mesa no puede quedar con dos comandas abiertas');

  await liberarMesa();
});

test('CA-09: la mesa pasa a ocupada al abrir la comanda', async () => {
  await liberarMesa();
  await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 2 });

  const mesa = await consultarUno('SELECT estado FROM mesa WHERE id_mesa = ?', [idMesaPrueba]);
  assert.equal(mesa.estado, 'ocupada');

  await liberarMesa();
});

test('no se puede abrir una comanda con más comensales que la capacidad', async () => {
  await liberarMesa();
  await assert.rejects(
    () => abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 99 }),
    /capacidad para 8 personas/i
  );
  await liberarMesa();
});

/* =====================================================================
   CA-03 — Descuento exacto de inventario
   ===================================================================== */

test('CA-03: el stock baja exactamente receta.cantidad x cantidad vendida', async () => {
  await liberarMesa();

  const carneAntes = await stockDe(CARNE);
  const panAntes = await stockDe(PAN);

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 2 });
  // 3 hamburguesas: 3 x 150 g de carne = 450 g; 3 x 1 pan = 3 unidades.
  await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 3, tiempoSalida: 1,
    modificadores: [2],   // "Termino medio": el grupo es obligatorio
    idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const carneDespues = await stockDe(CARNE);
  const panDespues = await stockDe(PAN);

  assert.equal(carneAntes - carneDespues, 450, 'la carne debe bajar exactamente 450 g');
  assert.equal(panAntes - panDespues, 3, 'el pan debe bajar exactamente 3 unidades');

  await liberarMesa();
});

test('CA-03: el kárdex registra el movimiento en negativo y con su referencia', async () => {
  await liberarMesa();

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });
  const { idLinea } = await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 2, tiempoSalida: 1,
    modificadores: [2], idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const mov = await consultarUno(
    `SELECT tipo, cantidad, id_referencia FROM movimiento_inventario
      WHERE id_referencia = ? AND id_insumo = ?`,
    [idLinea, CARNE]
  );

  assert.ok(mov, 'debe existir el movimiento de kárdex');
  assert.equal(mov.tipo, 'venta');
  assert.equal(Number(mov.cantidad), -300, '2 hamburguesas = -300 g de carne');
  assert.equal(mov.id_referencia, idLinea, 'el movimiento apunta a la línea que lo causó');

  await liberarMesa();
});

test('CA-03: reenviar una comanda no vuelve a descontar las líneas ya enviadas', async () => {
  await liberarMesa();

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 2 });
  await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1,
    modificadores: [2], idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const carneTrasPrimerEnvio = await stockDe(CARNE);

  // Sin lineas nuevas, el envio debe rechazarse en vez de descontar otra vez.
  await assert.rejects(
    () => enviarACocina({ idOrden, idUsuario: MESERO }),
    /no hay líneas nuevas/i
  );
  assert.equal(await stockDe(CARNE), carneTrasPrimerEnvio, 'el stock no puede moverse');

  // Con una linea nueva, solo se descuenta esa.
  await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 2,
    modificadores: [2], idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  assert.equal(
    carneTrasPrimerEnvio - await stockDe(CARNE), 150,
    'solo debe descontarse la línea nueva'
  );

  await liberarMesa();
});

test('el stock puede quedar negativo: la venta nunca se detiene (FSD 5.4)', async () => {
  await liberarMesa();

  // Se deja un insumo casi agotado a proposito.
  const original = await stockDe(CARNE);
  await pool.execute('UPDATE insumo SET stock_actual = 100 WHERE id_insumo = ?', [CARNE]);

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });
  await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 2, tiempoSalida: 1,
    modificadores: [2], idUsuario: MESERO,
  });

  // 2 hamburguesas necesitan 300 g y solo hay 100: la venta DEBE completarse.
  const r = await enviarACocina({ idOrden, idUsuario: MESERO });
  assert.equal(r.lineas.length, 1, 'la comanda se envía igual');

  const stock = await stockDe(CARNE);
  assert.equal(stock, -200, 'el stock queda negativo, no bloqueado');
  assert.ok(
    r.criticos.some((c) => c.idInsumo === CARNE && c.negativo),
    'el insumo debe marcarse como crítico y negativo para conciliar'
  );

  await pool.execute('UPDATE insumo SET stock_actual = ? WHERE id_insumo = ?', [original, CARNE]);
  await liberarMesa();
});

/* =====================================================================
   CA-04 — Precio congelado
   ===================================================================== */

test('CA-04: el precio se congela al enviar y no cambia si el catálogo se edita después', async () => {
  await liberarMesa();

  const original = await consultarUno('SELECT precio_base FROM producto WHERE id_producto = ?', [HAMBURGUESA]);

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });
  const { idLinea } = await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1,
    modificadores: [2], idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const congelado = await consultarUno(
    'SELECT precio_unitario, tasa_impuesto FROM orden_detalle WHERE id_orden_detalle = ?', [idLinea]
  );
  assert.equal(Number(congelado.precio_unitario), 32000, 'se congela el precio vigente al enviar');

  // El administrador sube el precio DESPUES de enviar la comanda.
  await pool.execute('UPDATE producto SET precio_base = 99000 WHERE id_producto = ?', [HAMBURGUESA]);

  const trasCambio = await consultarUno(
    'SELECT precio_unitario FROM orden_detalle WHERE id_orden_detalle = ?', [idLinea]
  );
  assert.equal(
    Number(trasCambio.precio_unitario), 32000,
    'la línea ya enviada conserva su precio: el cliente paga lo que se le ofreció'
  );

  await pool.execute('UPDATE producto SET precio_base = ? WHERE id_producto = ?', [original.precio_base, HAMBURGUESA]);
  await liberarMesa();
});

/* =====================================================================
   Reglas de modificadores y de estado
   ===================================================================== */

test('un grupo obligatorio impide agregar el plato sin elegir opción', async () => {
  await liberarMesa();
  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });

  // La hamburguesa exige "Termino de coccion" (obligatorio, 1-1).
  await assert.rejects(
    () => agregarLinea({
      idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1,
      modificadores: [], idUsuario: MESERO,
    }),
    /obligatorio/i
  );

  await liberarMesa();
});

test('no se puede elegir más opciones de las que permite el grupo', async () => {
  await liberarMesa();
  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });

  // "Termino de coccion" permite exactamente una: se mandan dos.
  await assert.rejects(
    () => agregarLinea({
      idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1,
      modificadores: [1, 2], idUsuario: MESERO,
    }),
    /como máximo 1/i
  );

  await liberarMesa();
});

test('un plato agotado no se puede agregar a la comanda', async () => {
  await liberarMesa();
  await pool.execute('UPDATE producto SET disponible = FALSE WHERE id_producto = ?', [HAMBURGUESA]);

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });
  await assert.rejects(
    () => agregarLinea({
      idOrden, idProducto: HAMBURGUESA, cantidad: 1, tiempoSalida: 1,
      modificadores: [2], idUsuario: MESERO,
    }),
    /agotado/i
  );

  await pool.execute('UPDATE producto SET disponible = TRUE WHERE id_producto = ?', [HAMBURGUESA]);
  await liberarMesa();
});

/* =====================================================================
   CA-08 — Anulacion y reverso de inventario
   ===================================================================== */

test('CA-08: anular una línea enviada devuelve el inventario con contra-asiento', async () => {
  await liberarMesa();

  const { idOrden } = await abrirOrden({ idMesa: idMesaPrueba, idMesero: MESERO, numComensales: 1 });
  const { idLinea } = await agregarLinea({
    idOrden, idProducto: HAMBURGUESA, cantidad: 2, tiempoSalida: 1,
    modificadores: [2], idUsuario: MESERO,
  });
  await enviarACocina({ idOrden, idUsuario: MESERO });

  const trasEnvio = await stockDe(CARNE);

  await anularLinea({
    idLinea, idUsuario: MESERO, idAutorizador: 1,
    motivo: 'Prueba automatizada de anulación',
  });

  assert.equal(await stockDe(CARNE), trasEnvio + 300, 'debe devolverse lo consumido');

  // El kardex conserva AMBOS movimientos: nunca se borra (FSD 5.4).
  const movimientos = await consultar(
    'SELECT tipo, cantidad FROM movimiento_inventario WHERE id_referencia = ? AND id_insumo = ? ORDER BY id_movimiento',
    [idLinea, CARNE]
  );
  assert.equal(movimientos.length, 2, 'la venta y su reverso, ambos en el kárdex');
  assert.equal(Number(movimientos[0].cantidad), -300, 'la salida original');
  assert.equal(Number(movimientos[1].cantidad), 300, 'el contra-asiento');

  // La auditoría guarda autor Y autorizador (CA-08).
  const log = await consultarUno(
    `SELECT id_usuario, id_autorizador, detalle FROM log_auditoria
      WHERE accion = 'orden.anulacion' AND id_entidad = ?`,
    [idLinea]
  );
  assert.ok(log, 'la anulación debe quedar auditada');
  assert.equal(log.id_usuario, MESERO, 'queda registrado quién anuló');
  assert.equal(log.id_autorizador, 1, 'y quién lo autorizó');

  await liberarMesa();
});
