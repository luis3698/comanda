/**
 * Configuracion del salon: zonas y mesas.  RF-04  ·  Vista 2.
 *
 * FSD 5.2:
 *  - "mesa.numero unico dentro de su zona (UNIQUE compuesto id_zona + numero)."
 *  - "capacidad CHECK entre 1 y 30; formas restringidas por ENUM."
 *  - "Una mesa con orden abierta no puede eliminarse ni desactivarse
 *     (validacion de servidor)."
 *  - "Los cambios de distribucion se publican por WebSocket."
 *
 * El lienzo del disenador guarda en LOTE (FSD 4.1 vista 2): mover diez mesas y
 * pulsar "Guardar distribucion" es una sola transaccion, no diez peticiones.
 * Si una falla, no queda medio plano guardado.
 */
import { Router } from 'express';
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';
import { publicar, EVENTOS } from '../realtime.js';

const router = Router();
router.use(requiereAutenticacion);

const FORMAS = ['redonda', 'cuadrada', 'rectangular', 'barra'];
const ESTADOS_MESA = ['libre', 'ocupada', 'precuenta', 'bloqueada'];

/**
 * Zona virtual que ancla las comandas de domicilio (ver el README).
 *
 * POR QUE HAY QUE PROTEGERLA DEL DISENADOR
 * Se sembro con activa = FALSE dando por hecho que eso la mantendria fuera del
 * plano, porque `listarSalon` filtra las zonas inactivas. Pero el disenador pide
 * `/salon/zonas?todas=1` -- necesita ver las zonas inactivas para poder
 * gestionarlas-- y con ese flag SI aparece, con sus 30 mesas D1..D30 dentro.
 *
 * Paso de verdad: se seleccionaron esas mesas y se quitaron de una vez. Las que
 * no tenian historial se borraron y la que si lo tenia quedo de baja logica, de
 * modo que la capacidad de domicilios se quedo en cero. El siguiente pedido que
 * intento aceptar Caja fallo con "No hay posiciones de domicilio configuradas".
 *
 * No son mesas de sala: no se dibujan en ningun sitio, no se sientan clientes en
 * ellas y borrarlas no libera nada. Lo unico que hacen es permitir que un
 * domicilio aceptado se convierta en una `orden` real. Por eso el servidor las
 * rechaza en bloque en lugar de confiar en que la interfaz las oculte: la UI
 * oculta, la API revalida.
 */
const ZONA_DOMICILIOS = 'Domicilios';

/** Corta cualquier intento de editar la zona de domicilios desde el salon. */
function exigirZonaEditable(zona) {
  if (zona?.nombre !== ZONA_DOMICILIOS) return;

  throw errores.reglaDeNegocio(
    'La zona "Domicilios" no se edita desde el diseñador de salón. No es una zona ' +
    'real: son las plazas que permiten que un pedido a domicilio aceptado llegue a ' +
    'cocina y a caja. Si la cambia, Caja dejará de poder aceptar domicilios.',
    { motivo: 'zona_domicilios_protegida' }
  );
}

/**
 * Corta cualquier intento de tocar mesas concretas de la zona de domicilios.
 *
 * @param {object} cx     Conexion o null para usar el pool.
 * @param {number[]} ids  Ids de mesa implicadas.
 * @param {string} accion Verbo para el mensaje: 'eliminar', 'modificar'...
 */
async function exigirQueNoSeanDomicilio(cx, ids, accion = 'modificar') {
  if (!ids.length) return;

  const marcas = ids.map(() => '?').join(',');
  const sql =
    `SELECT m.numero FROM mesa m
       JOIN zona z ON z.id_zona = m.id_zona
      WHERE z.nombre = ? AND m.id_mesa IN (${marcas})
      ORDER BY m.id_mesa`;
  const params = [ZONA_DOMICILIOS, ...ids];

  const filas = cx
    ? (await cx.execute(sql, params))[0]
    : await consultar(sql, params);

  if (!filas.length) return;

  throw errores.reglaDeNegocio(
    `No se pueden ${accion} las posiciones de domicilio ` +
    `(${filas.map((f) => f.numero).join(', ')}). No son mesas de la sala: son las ` +
    'plazas que permiten que un pedido a domicilio aceptado llegue a cocina y a ' +
    'caja. Si las quita, Caja no podra aceptar ningun domicilio.',
    { motivo: 'zona_domicilios_protegida' }
  );
}

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/**
 * Avisa a todo el que dibuja el plano de que acaba de cambiar.
 *
 * Va a quien tenga `salon.ver`, que es justo quien lo pinta: el mapa de mesas
 * del mesero, el panel de cuentas del cajero, el tablero del administrador y el
 * propio disenador si hay dos administradores trabajando a la vez.
 *
 * El evento NO lleva el plano nuevo, solo el motivo del cambio: quien lo recibe
 * vuelve a pedirlo por HTTP. Asi cada vista recibe exactamente los campos que
 * su permiso le consiente, en lugar de repartir el plano entero por el socket.
 *
 * @param {object} req
 * @param {string} motivo  Que cambio: 'zona.creada', 'mesa.eliminada'...
 * @param {object} [datos] Ids afectados, para que el cliente afine si quiere.
 */
function publicarSalon(req, motivo, datos = {}) {
  return publicar(EVENTOS.SALON_ACTUALIZADO,
    { motivo, ...datos, porUsuario: req.usuario.id },
    { permiso: 'salon.ver' });
}

/** ¿La mesa tiene una comanda en curso? (FSD 5.2) */
async function tieneOrdenAbierta(idMesa, cx = null) {
  const sql = `SELECT COUNT(*) AS n FROM orden
                WHERE id_mesa = ? AND estado IN ('abierta','enviada','precuenta')`;
  if (cx) {
    const [filas] = await cx.execute(sql, [idMesa]);
    return filas[0].n > 0;
  }
  const f = await consultarUno(sql, [idMesa]);
  return f.n > 0;
}

/**
 * Reservas que apuntan a una mesa: cuantas siguen vivas y cuantas hay en total.
 *
 * POR QUE ESTO EXISTE
 * `reserva.id_mesa` es una clave foranea a `mesa` (db/05_movil.sql), asi que
 * una mesa reservada alguna vez NO SE PUEDE BORRAR: MySQL lo rechaza y el
 * usuario recibia un "La operacion afecta a registros relacionados" que no
 * decia ni que mesa era ni por que.
 *
 * Se distinguen los dos casos porque llevan a decisiones opuestas:
 *   vivas > 0     -> hay clientes esperando esa mesa: no se puede quitar.
 *   total > 0     -> solo historial: baja logica, igual que con las comandas.
 */
async function reservasDeMesa(idMesa, cx = null) {
  const sql = `SELECT COUNT(*) AS total,
                      SUM(estado IN ('pendiente','confirmada')) AS vivas
                 FROM reserva WHERE id_mesa = ?`;
  const fila = cx
    ? (await cx.execute(sql, [idMesa]))[0][0]
    : await consultarUno(sql, [idMesa]);
  return { total: Number(fila.total), vivas: Number(fila.vivas ?? 0) };
}

/**
 * La fila que ya ocupa ese numero dentro de la zona, este activa o retirada.
 *
 * El UNIQUE (id_zona, numero) del esquema no distingue entre unas y otras: una
 * mesa dada de baja logica sigue reservando su numero aunque no se dibuje en el
 * plano. Cualquier alta tiene que mirar aqui antes de insertar.
 */
async function mesaConNumero(cx, idZona, numero, excluir = 0) {
  const [filas] = await cx.execute(
    `SELECT id_mesa, numero, activa FROM mesa
      WHERE id_zona = ? AND numero = ? AND id_mesa <> ?`,
    [idZona, numero, excluir]
  );
  return filas.length ? filas[0] : null;
}

/**
 * Alta de una mesa dentro de una zona.
 *
 * Si el numero lo conserva una mesa RETIRADA, no estamos ante un conflicto sino
 * ante la misma mesa fisica volviendo al salon: se reactiva su fila en vez de
 * insertar otra. Insertar era imposible (choca con el UNIQUE y el usuario recibia
 * un "Ya existe un registro con ese valor unico" incomprensible, porque la mesa
 * culpable no aparece en el plano), y renumerarla a la fuerza habria dejado dos
 * historiales distintos para el mismo numero de mesa.
 *
 * @returns {Promise<{ id: number, reactivada: boolean }>}
 */
async function crearOReactivarMesa(cx, idZona, m) {
  const numero = String(m.numero).trim();
  const valores = [m.forma, Number(m.capacidad),
                   Number(m.posX), Number(m.posY), Number(m.ancho), Number(m.alto)];

  const existente = await mesaConNumero(cx, idZona, numero);

  if (existente && existente.activa) {
    throw errores.conflicto(`Ya hay una mesa con el número "${numero}" en esta zona.`);
  }

  if (existente) {
    // Vuelve al plano con la forma, capacidad y posicion que acaba de dibujar el
    // usuario, pero conservando su id y por tanto su historial de comandas.
    // El estado se reinicia: una mesa retirada no puede volver bloqueada.
    await cx.execute(
      `UPDATE mesa SET activa = TRUE, estado = 'libre',
              forma = ?, capacidad = ?, pos_x = ?, pos_y = ?, ancho = ?, alto = ?
        WHERE id_mesa = ?`,
      [...valores, existente.id_mesa]
    );
    return { id: existente.id_mesa, reactivada: true };
  }

  const [r] = await cx.execute(
    `INSERT INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [idZona, numero, ...valores]
  );
  return { id: r.insertId, reactivada: false };
}

/* =====================================================================
   Lectura del plano
   ===================================================================== */

/**
 * GET /api/v1/salon/zonas
 * Plano completo con sus mesas. Lo consumen el disenador (vista 2), el
 * comandero (vista 11) y el POS (vista 18), por eso basta con salon.ver.
 */
router.get('/zonas', requierePermiso('salon.ver'), asyncHandler(async (req, res) => {
  // El disenador necesita ver tambien las ZONAS dadas de baja para poder
  // reactivarlas; las vistas operativas solo quieren las activas.
  //
  // Las MESAS son otra cosa: una mesa de baja logica (activa = FALSE) esta
  // retirada del plano y conserva su historial solo para trazabilidad; no debe
  // reaparecer en el lienzo del disenador ni en el mapa del mesero. Antes se
  // colaban con ?todas=1 y una mesa "eliminada" volvia a dibujarse al recargar.
  // Por eso las mesas se filtran SIEMPRE a las activas, independientemente de
  // ?todas: ese flag solo gobierna la visibilidad de las zonas.
  const soloActivas = req.query.todas !== '1';

  // La zona de domicilios NUNCA sale por aqui, ni con ?todas=1.
  //
  // Se sembro con activa = FALSE creyendo que eso bastaba, y basta para las
  // vistas operativas -- pero el disenador pide ?todas=1 y ahi aparecia, con sus
  // 30 mesas D1..D30. Desde el plano parecen 30 mesas fantasma sin sitio ni
  // sentido, y lo natural es quitarlas; hacerlo deja a Caja sin poder aceptar un
  // solo domicilio. Ya ocurrio dos veces.
  //
  // Esconderla aqui, en el servidor, la retira de golpe del disenador, del
  // comandero y del mapa del mesero. Las rutas de escritura la rechazan ademas
  // por su cuenta (exigirZonaEditable): la UI oculta, la API revalida.
  const filtros = [];
  if (soloActivas) filtros.push('activa = TRUE');
  filtros.push('nombre <> ?');

  const zonas = await consultar(
    `SELECT id_zona, nombre, orden_visual, activa
       FROM zona WHERE ${filtros.join(' AND ')}
      ORDER BY orden_visual, nombre`,
    [ZONA_DOMICILIOS]
  );

  const mesas = await consultar(
    `SELECT m.id_mesa, m.id_zona, m.numero, m.forma, m.capacidad,
            m.pos_x, m.pos_y, m.ancho, m.alto, m.estado, m.activa,
            EXISTS(SELECT 1 FROM orden o
                    WHERE o.id_mesa = m.id_mesa
                      AND o.estado IN ('abierta','enviada','precuenta')) AS ocupada_ahora
       FROM mesa m
      ORDER BY m.numero`
  );

  return res.json({
    zonas: zonas.map((z) => ({
      id: z.id_zona,
      nombre: z.nombre,
      ordenVisual: z.orden_visual,
      activa: Boolean(z.activa),
      mesas: mesas
        // Siempre solo mesas activas: las de baja logica no vuelven al plano.
        .filter((m) => m.id_zona === z.id_zona && m.activa)
        .map((m) => ({
          id: m.id_mesa,
          idZona: m.id_zona,
          numero: m.numero,
          forma: m.forma,
          capacidad: m.capacidad,
          // Los DECIMAL llegan como string; aqui son coordenadas de dibujo,
          // no dinero, asi que convertirlas a Number es seguro.
          posX: Number(m.pos_x),
          posY: Number(m.pos_y),
          ancho: Number(m.ancho),
          alto: Number(m.alto),
          estado: m.estado,
          activa: Boolean(m.activa),
          conOrdenAbierta: Boolean(Number(m.ocupada_ahora)),
        })),
    })),
  });
}));

/**
 * GET /api/v1/salon/mesas/disponibilidad?numero=X&idZona=Y&excluir=Z
 * Unicidad del numero dentro de la zona, en vivo (FSD 4.1 vista 2:
 * "validacion de unicidad en tiempo real contra la API").
 *
 * Una mesa RETIRADA no bloquea el numero: al guardar se reactiva esa misma fila
 * (ver crearOReactivarMesa). Se avisa con `reactivara` para que el disenador lo
 * anuncie en vez de marcarlo como error, que era lo que hacia antes senalando
 * una mesa que el usuario no puede ver en el plano.
 */
router.get('/mesas/disponibilidad', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const { numero, idZona, excluir } = req.query;
  if (!numero || !idZona) throw errores.peticionInvalida('Indique numero y zona.');

  const f = await consultarUno(
    'SELECT id_mesa, activa FROM mesa WHERE id_zona = ? AND numero = ? AND id_mesa <> ?',
    [Number(idZona), String(numero).trim(), Number(excluir) || 0]
  );

  const ocupadoPorActiva = Boolean(f && f.activa);
  return res.json({
    disponible: !ocupadoPorActiva,
    reactivara: Boolean(f) && !ocupadoPorActiva,
  });
}));

/* =====================================================================
   Zonas
   ===================================================================== */

router.post('/zonas', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const { nombre, ordenVisual } = req.body ?? {};
  if (!nombre || String(nombre).trim().length < 2) {
    throw errores.peticionInvalida('El nombre de la zona debe tener al menos 2 caracteres.',
      { campos: { nombre: 'Mínimo 2 caracteres.' } });
  }

  const id = await transaccion(async (cx) => {
    const [r] = await cx.execute(
      'INSERT INTO zona (nombre, orden_visual) VALUES (?, ?)',
      [String(nombre).trim(), Number(ordenVisual) || 0]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'zona.creacion', entidad: 'zona',
      idEntidad: r.insertId, detalle: `Creación de la zona "${nombre}".`, ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  publicarSalon(req, 'zona.creada', { idZona: id, nombre: String(nombre).trim() });
  return res.status(201).json({ id });
}));

router.put('/zonas/:id', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, ordenVisual, activa } = req.body ?? {};

  const zona = await consultarUno('SELECT id_zona, nombre FROM zona WHERE id_zona = ?', [id]);
  if (!zona) throw errores.noEncontrado('La zona');

  // Renombrarla la rompería igual que borrarla: la zona se localiza POR NOMBRE
  // desde el servicio de domicilios, no por id.
  exigirZonaEditable(zona);

  if (!nombre || String(nombre).trim().length < 2) {
    throw errores.peticionInvalida('El nombre de la zona debe tener al menos 2 caracteres.',
      { campos: { nombre: 'Mínimo 2 caracteres.' } });
  }

  // Desactivar una zona esconde sus mesas del comandero: si alguna esta
  // atendiendo gente, seria hacer desaparecer una comanda viva de la pantalla.
  if (activa === false) {
    const ocupadas = await consultarUno(
      `SELECT COUNT(*) AS n FROM mesa m
        WHERE m.id_zona = ? AND EXISTS(
          SELECT 1 FROM orden o WHERE o.id_mesa = m.id_mesa
                                  AND o.estado IN ('abierta','enviada','precuenta'))`,
      [id]
    );
    if (ocupadas.n > 0) {
      throw errores.reglaDeNegocio(
        `La zona tiene ${ocupadas.n} mesa(s) con comanda abierta. Ciérrelas antes de desactivarla.`
      );
    }
  }

  await transaccion(async (cx) => {
    await cx.execute(
      'UPDATE zona SET nombre = ?, orden_visual = ?, activa = ? WHERE id_zona = ?',
      [String(nombre).trim(), Number(ordenVisual) || 0, activa !== false, id]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'zona.edicion', entidad: 'zona',
      idEntidad: id, detalle: `Edición de la zona "${nombre}".`, ipOrigen: ipDe(req),
    });
  });

  publicarSalon(req, 'zona.editada', { idZona: id, nombre: String(nombre).trim() });
  return res.json({ ok: true });
}));

/**
 * DELETE /api/v1/salon/zonas/:id
 *
 * La zona se elimina cuando en ella no queda nada PENDIENTE:
 *
 *   - mesas en el plano (las activas: son las que el usuario ve y usa),
 *   - comandas abiertas, enviadas o en precuenta,
 *   - facturas con saldo por cobrar.
 *
 * Lo que NO bloquea es el historial cerrado sin facturar. Antes si lo hacia, y
 * de la peor manera: contaba tambien las mesas retiradas del plano, asi que una
 * zona que en pantalla estaba vacia respondia "La zona tiene 3 mesa(s)"
 * senalando mesas que el usuario no podia ver por ningun lado. Ese historial se
 * va con la zona (mesa.id_zona es NOT NULL: una mesa retirada no sobrevive a su
 * zona, ni una comanda a su mesa), pero nunca a espaldas del usuario: se exige
 * `confirmarHistorial=1` y la respuesta previa dice cuanto se perderia.
 *
 * LA FACTURA ES EL LIMITE DURO
 * Una venta ya facturada no se puede borrar, y no es una decision de esta ruta:
 * el usuario de BD de la aplicacion carece de DELETE sobre `factura` a proposito
 * (db/04_privilegios.sql, FSD 6.5: "las facturas emitidas son inmutables y solo
 * se corrigen con documentos de anulacion auditados"). Es el motor quien lo
 * impone, de modo que ni una inyeccion SQL podria borrar ventas. Por eso, si la
 * zona conserva facturas, el borrado fisico es imposible y lo unico que queda es
 * la baja logica -- que se hace solo si el usuario la pide con `bajaLogica=1`,
 * en vez de disfrazarla de "eliminado" y dejarle la pestaña ahi sin explicacion.
 */
router.delete('/zonas/:id', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const zona = await consultarUno('SELECT id_zona, nombre FROM zona WHERE id_zona = ?', [id]);
  if (!zona) throw errores.noEncontrado('La zona');
  exigirZonaEditable(zona);

  const activas = await consultarUno(
    'SELECT COUNT(*) AS n FROM mesa WHERE id_zona = ? AND activa = TRUE', [id]
  );
  if (activas.n > 0) {
    throw errores.conflicto(
      `La zona tiene ${activas.n} mesa(s). Elimínelas o muévalas antes de borrar la zona.`
    );
  }

  const abiertas = await consultarUno(
    `SELECT COUNT(*) AS n FROM orden o
       JOIN mesa m ON m.id_mesa = o.id_mesa
      WHERE m.id_zona = ? AND o.estado IN ('abierta','enviada','precuenta')`,
    [id]
  );
  if (abiertas.n > 0) {
    throw errores.reglaDeNegocio(
      `La zona tiene ${abiertas.n} comanda(s) sin cerrar. Ciérrelas antes de borrarla.`
    );
  }

  const historial = await consultarUno(
    `SELECT (SELECT COUNT(*) FROM mesa WHERE id_zona = ?) AS mesas,
            (SELECT COUNT(*) FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
              WHERE m.id_zona = ?) AS ordenes,
            (SELECT COUNT(*) FROM factura f
               JOIN orden o ON o.id_orden = f.id_orden
               JOIN mesa m  ON m.id_mesa  = o.id_mesa
              WHERE m.id_zona = ?) AS facturas,
            (SELECT COUNT(*) FROM factura f
               JOIN orden o ON o.id_orden = f.id_orden
               JOIN mesa m  ON m.id_mesa  = o.id_mesa
              WHERE m.id_zona = ? AND f.estado = 'emitida'
                AND f.total > (SELECT COALESCE(SUM(pg.monto), 0) FROM pago pg
                                WHERE pg.id_factura = f.id_factura)) AS porCobrar`,
    [id, id, id, id]
  );

  if (historial.porCobrar > 0) {
    throw errores.reglaDeNegocio(
      `La zona tiene ${historial.porCobrar} factura(s) pendiente(s) de pago. Cóbrelas antes de borrarla.`
    );
  }

  // Con facturas de por medio el borrado fisico esta descartado: el motor no se
  // lo permite a la aplicacion. Se ofrece la baja logica, pero solo si se pide.
  if (historial.facturas > 0) {
    if (req.query.bajaLogica !== '1') {
      throw errores.conflicto(
        `La zona conserva ${historial.facturas} factura(s) de venta y no se puede eliminar: una ` +
        'factura emitida es inmutable y no se borra nunca. Puede darla de baja para retirarla del ' +
        'servicio conservando su historial.',
        { requiereBajaLogica: true, ...historial }
      );
    }

    await transaccion(async (cx) => {
      await cx.execute('UPDATE zona SET activa = FALSE WHERE id_zona = ?', [id]);
      await auditar(cx, {
        idUsuario: req.usuario.id, accion: 'zona.baja', entidad: 'zona', idEntidad: id,
        detalle: `Baja lógica de la zona "${zona.nombre}" (conserva ${historial.mesas} mesa(s) ` +
                 `retirada(s) y ${historial.facturas} factura(s) de venta).`,
        ipOrigen: ipDe(req),
      });
    });

    publicarSalon(req, 'zona.baja', { idZona: id, nombre: zona.nombre });
    return res.json({ ok: true, bajaLogica: true, ...historial });
  }

  // Sin facturas: solo comandas cerradas o anuladas. Se pueden borrar, pero se
  // avisa primero de cuanto se lleva por delante.
  if (historial.ordenes > 0 && req.query.confirmarHistorial !== '1') {
    throw errores.conflicto(
      `La zona conserva ${historial.mesas} mesa(s) retirada(s) con ${historial.ordenes} comanda(s) ` +
      'cerradas sin facturar. Si la borra, ese historial se pierde.',
      { requiereConfirmacion: true, ...historial }
    );
  }

  await transaccion(async (cx) => {
    // Borrar la orden arrastra en cascada sus lineas y los modificadores de
    // estas; borrar la mesa exige que antes no quede ninguna orden apuntandola.
    await cx.execute(
      `DELETE o FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
        WHERE m.id_zona = ?`, [id]
    );
    // Y lo mismo con las reservas: `reserva.id_mesa` tambien es clave foranea.
    // No se borra la reserva -- eso perderia el historico del cliente y ademas
    // rompe su vista en la aplicacion -- solo se desliga de la mesa, que es lo
    // que impide el DELETE. La reserva conserva su codigo, su fecha y su
    // estado; unicamente deja de decir en que mesa fue.
    await cx.execute(
      `UPDATE reserva r JOIN mesa m ON m.id_mesa = r.id_mesa
          SET r.id_mesa = NULL
        WHERE m.id_zona = ?`, [id]
    );
    // El kardex (movimiento_inventario) no se toca: FSD 5.4, "nunca se borra".
    // Su id_referencia es polimorfico y sin FK, asi que no impide nada, y el
    // consumo de insumos que ya ocurrio sigue siendo cierto aunque la comanda
    // que lo origino desaparezca.
    await cx.execute('DELETE FROM mesa WHERE id_zona = ?', [id]);
    await cx.execute('DELETE FROM zona WHERE id_zona = ?', [id]);

    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'zona.eliminacion',
      entidad: 'zona',
      idEntidad: id,
      detalle: historial.ordenes > 0
        ? `Eliminación de la zona "${zona.nombre}" junto con ${historial.mesas} mesa(s) retirada(s) ` +
          `y ${historial.ordenes} comanda(s) sin facturar de su historial.`
        : `Eliminación de la zona "${zona.nombre}".`,
      ipOrigen: ipDe(req),
    });
  });

  publicarSalon(req, 'zona.eliminada', { idZona: id, nombre: zona.nombre });
  return res.json({ ok: true, bajaLogica: false, ...historial });
}));

/* =====================================================================
   Mesas
   ===================================================================== */

/** Validacion de una mesa. Refleja los CHECK del esquema (defensa en profundidad). */
function validarMesa({ numero, forma, capacidad, posX, posY, ancho, alto }) {
  const fallos = {};

  if (!numero || !String(numero).trim()) fallos.numero = 'Indique el número de la mesa.';
  else if (String(numero).trim().length > 10) fallos.numero = 'Máximo 10 caracteres.';

  if (!FORMAS.includes(forma)) fallos.forma = `Forma inválida. Opciones: ${FORMAS.join(', ')}.`;

  const cap = Number(capacidad);
  if (!Number.isInteger(cap) || cap < 1 || cap > 30) {
    fallos.capacidad = 'La capacidad debe ser un número entero entre 1 y 30.';
  }

  for (const [clave, valor] of Object.entries({ posX, posY, ancho, alto })) {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      fallos[clave] = 'Debe ser un porcentaje del lienzo entre 0 y 100.';
    }
  }

  return fallos;
}

router.post('/mesas', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const { idZona, numero, capacidad } = req.body ?? {};

  const fallos = validarMesa(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const zona = await consultarUno(
    'SELECT id_zona, nombre FROM zona WHERE id_zona = ?', [Number(idZona)]
  );
  if (!zona) throw errores.peticionInvalida('La zona indicada no existe.');
  exigirZonaEditable(zona);

  const alta = await transaccion(async (cx) => {
    const r = await crearOReactivarMesa(cx, Number(idZona), req.body);
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: r.reactivada ? 'mesa.reactivacion' : 'mesa.creacion',
      entidad: 'mesa',
      idEntidad: r.id,
      detalle: r.reactivada
        ? `Reactivación de la mesa ${numero} (capacidad ${capacidad}) en la zona ${idZona}; conserva su historial.`
        : `Creación de la mesa ${numero} (capacidad ${capacidad}) en la zona ${idZona}.`,
      ipOrigen: ipDe(req),
    });
    return r;
  });

  publicarSalon(req, alta.reactivada ? 'mesa.reactivada' : 'mesa.creada',
    { idZona: Number(idZona), idMesa: alta.id, numero: String(numero).trim() });
  return res.status(201).json({ id: alta.id, reactivada: alta.reactivada });
}));

router.put('/mesas/:id', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const mesa = await consultarUno('SELECT id_mesa, numero FROM mesa WHERE id_mesa = ?', [id]);
  if (!mesa) throw errores.noEncontrado('La mesa');
  await exigirQueNoSeanDomicilio(null, [id], 'modificar');

  const fallos = validarMesa(req.body ?? {});
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const { idZona, numero, forma, capacidad, posX, posY, ancho, alto } = req.body;

  await transaccion(async (cx) => {
    // Aqui no se reactiva nada: si el numero destino lo conserva una mesa
    // retirada, fusionar las dos filas mezclaria dos historiales de venta
    // distintos y no habria vuelta atras. Se rechaza con un motivo entendible en
    // vez de dejar que salte el UNIQUE con su mensaje generico.
    const choque = await mesaConNumero(cx, Number(idZona), String(numero).trim(), id);
    if (choque) {
      throw errores.conflicto(choque.activa
        ? `Ya hay una mesa con el número "${String(numero).trim()}" en esa zona.`
        : `El número "${String(numero).trim()}" lo conserva una mesa retirada con historial de ventas. Use otro número.`);
    }

    await cx.execute(
      `UPDATE mesa SET id_zona = ?, numero = ?, forma = ?, capacidad = ?,
              pos_x = ?, pos_y = ?, ancho = ?, alto = ?
        WHERE id_mesa = ?`,
      [Number(idZona), String(numero).trim(), forma, Number(capacidad),
       Number(posX), Number(posY), Number(ancho), Number(alto), id]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'mesa.edicion', entidad: 'mesa',
      idEntidad: id, detalle: `Edición de la mesa ${numero}.`, ipOrigen: ipDe(req),
    });
  });

  publicarSalon(req, 'mesa.editada',
    { idZona: Number(idZona), idMesa: id, numero: String(numero).trim() });
  return res.json({ ok: true });
}));

/**
 * PUT /api/v1/salon/zonas/:id/mesas
 * Guardado en lote de la distribucion (FSD 4.1 vista 2, y la ruta es la que
 * nombra el catalogo de API del FSD 8).
 *
 * Recibe la lista completa de mesas de la zona. Las que no vengan y no tengan
 * historial se eliminan; las que tengan historial pasan a baja logica.
 */
router.put('/zonas/:id/mesas', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const idZona = Number(req.params.id);
  const mesas = req.body?.mesas;

  if (!Array.isArray(mesas)) {
    throw errores.peticionInvalida('Envíe el arreglo "mesas" con la distribución de la zona.');
  }

  const zona = await consultarUno('SELECT id_zona, nombre FROM zona WHERE id_zona = ?', [idZona]);
  if (!zona) throw errores.noEncontrado('La zona');

  // El guardado en lote retira TODA mesa que no venga en el arreglo, asi que
  // sobre esta zona seria la forma mas rapida de quedarse sin domicilios: basta
  // con guardar una vez con el lienzo vacio.
  exigirZonaEditable(zona);

  // Validacion completa ANTES de tocar nada: si la mesa 7 es invalida, no se
  // guardan las seis primeras y luego se falla.
  const numerosVistos = new Set();
  for (const [i, m] of mesas.entries()) {
    const fallos = validarMesa(m);
    if (Object.keys(fallos).length) {
      throw errores.peticionInvalida(
        `La mesa en la posición ${i + 1} tiene datos inválidos.`,
        { indice: i, campos: fallos }
      );
    }
    const num = String(m.numero).trim();
    if (numerosVistos.has(num)) {
      throw errores.conflicto(`El número de mesa "${num}" está repetido dentro de la zona.`);
    }
    numerosVistos.add(num);
  }

  const resultado = await transaccion(async (cx) => {
    const [existentes] = await cx.execute(
      'SELECT id_mesa, numero FROM mesa WHERE id_zona = ? AND activa = TRUE', [idZona]
    );
    const idsEnviados = new Set(mesas.map((m) => Number(m.id)).filter(Boolean));

    let creadas = 0, actualizadas = 0, eliminadas = 0, desactivadas = 0, reactivadas = 0;

    // PRIMERO las mesas que desaparecieron del lienzo, y solo despues las altas
    // y las ediciones. El orden importa: el UNIQUE (id_zona, numero) no libera
    // un numero hasta que su fila se borra, asi que retirar la mesa "5" y crear
    // otra "5" en el mismo guardado chocaba a mitad del lote si las altas iban
    // antes. Todo ocurre en una transaccion, asi que si algo falla despues no
    // queda ninguna mesa retirada de mas.
    for (const ex of existentes) {
      if (idsEnviados.has(ex.id_mesa)) continue;

      if (await tieneOrdenAbierta(ex.id_mesa, cx)) {
        throw errores.reglaDeNegocio(
          `La mesa ${ex.numero} tiene una comanda abierta y no se puede quitar del plano.`
        );
      }

      // Una reserva viva es un compromiso con un cliente: quitar esa mesa del
      // plano dejaria a alguien con una reserva a una mesa que ya no existe.
      const reservas = await reservasDeMesa(ex.id_mesa, cx);
      if (reservas.vivas > 0) {
        throw errores.reglaDeNegocio(
          `La mesa ${ex.numero} tiene ${reservas.vivas} reserva(s) sin resolver y no se puede ` +
          'quitar del plano. Atiendalas o cancelelas desde Caja, o asigne esas reservas a otra mesa.',
          { idMesa: ex.id_mesa, reservasVivas: reservas.vivas }
        );
      }

      // FSD 4.1 vista 2: una mesa con historial solo se da de baja logica.
      // Borrarla rompería la trazabilidad de sus facturas -- y, desde el canal
      // digital, tambien la de sus reservas: `reserva.id_mesa` es una clave
      // foranea, asi que el DELETE fallaria con un error de integridad que no
      // explica nada al usuario.
      const [hist] = await cx.execute(
        'SELECT COUNT(*) AS n FROM orden WHERE id_mesa = ?', [ex.id_mesa]
      );
      if (hist[0].n > 0 || reservas.total > 0) {
        await cx.execute('UPDATE mesa SET activa = FALSE WHERE id_mesa = ?', [ex.id_mesa]);
        desactivadas++;
      } else {
        await cx.execute('DELETE FROM mesa WHERE id_mesa = ?', [ex.id_mesa]);
        eliminadas++;
      }
    }

    for (const m of mesas) {
      if (m.id) {
        const numero = String(m.numero).trim();

        // Renumerar una mesa hacia un numero que conserva otra (activa o
        // retirada) tambien reventaba contra el UNIQUE con el error generico.
        const choque = await mesaConNumero(cx, idZona, numero, Number(m.id));
        if (choque) {
          throw errores.conflicto(choque.activa
            ? `Ya hay una mesa con el número "${numero}" en esta zona.`
            : `El número "${numero}" lo conserva una mesa retirada con historial de ventas. Use otro número.`);
        }

        const [r] = await cx.execute(
          `UPDATE mesa SET numero = ?, forma = ?, capacidad = ?,
                  pos_x = ?, pos_y = ?, ancho = ?, alto = ?
            WHERE id_mesa = ? AND id_zona = ? AND activa = TRUE`,
          [numero, m.forma, Number(m.capacidad),
           Number(m.posX), Number(m.posY), Number(m.ancho), Number(m.alto),
           Number(m.id), idZona]
        );
        // affectedRows a 0 significa que ese id no es una mesa activa de esta
        // zona: antes se contaba como actualizada y el cambio se perdia en
        // silencio, dejando al usuario creyendo que habia guardado.
        if (r.affectedRows === 0) {
          throw errores.peticionInvalida(
            `La mesa ${numero} ya no pertenece a esta zona. Recargue el plano e inténtelo de nuevo.`
          );
        }
        actualizadas++;
      } else {
        const alta = await crearOReactivarMesa(cx, idZona, m);
        if (alta.reactivada) reactivadas++; else creadas++;
      }
    }

    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'salon.distribucion',
      entidad: 'zona',
      idEntidad: idZona,
      detalle: `Distribución de "${zona.nombre}" guardada: ${creadas} creada(s), ` +
               `${reactivadas} reactivada(s) con su historial, ` +
               `${actualizadas} actualizada(s), ${eliminadas} eliminada(s), ` +
               `${desactivadas} dada(s) de baja por tener historial.`,
      ipOrigen: ipDe(req),
    });

    return { creadas, actualizadas, eliminadas, desactivadas, reactivadas };
  });

  // FSD 5.2: "los cambios de distribucion se publican por WebSocket". Es el
  // caso que mas lo necesita: el administrador reordena el salon entero de una
  // vez, y los meseros que estan mirando el mapa tienen que verlo al momento,
  // no la proxima vez que recarguen.
  publicarSalon(req, 'distribucion.guardada', { idZona, ...resultado });

  return res.json({ ok: true, ...resultado });
}));

router.delete('/mesas/:id', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const mesa = await consultarUno('SELECT id_mesa, numero FROM mesa WHERE id_mesa = ?', [id]);
  if (!mesa) throw errores.noEncontrado('La mesa');
  await exigirQueNoSeanDomicilio(null, [id], 'eliminar');

  if (await tieneOrdenAbierta(id)) {
    throw errores.reglaDeNegocio(
      `La mesa ${mesa.numero} tiene una comanda abierta. Ciérrela antes de eliminarla.`
    );
  }

  const reservas = await reservasDeMesa(id);
  if (reservas.vivas > 0) {
    throw errores.reglaDeNegocio(
      `La mesa ${mesa.numero} tiene ${reservas.vivas} reserva(s) sin resolver. ` +
      'Atiéndalas o cancélelas desde Caja antes de eliminarla.',
      { reservasVivas: reservas.vivas }
    );
  }

  const resultado = await transaccion(async (cx) => {
    const [hist] = await cx.execute('SELECT COUNT(*) AS n FROM orden WHERE id_mesa = ?', [id]);
    // El historial de reservas cuenta igual que el de comandas: `reserva.id_mesa`
    // es clave foránea, así que borrar la mesa fallaría con un error de
    // integridad, y además esa reserva dice a qué mesa se sentó el cliente.
    const conHistorial = hist[0].n > 0 || reservas.total > 0;

    if (conHistorial) {
      await cx.execute('UPDATE mesa SET activa = FALSE WHERE id_mesa = ?', [id]);
    } else {
      await cx.execute('DELETE FROM mesa WHERE id_mesa = ?', [id]);
    }

    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: conHistorial ? 'mesa.baja' : 'mesa.eliminacion',
      entidad: 'mesa',
      idEntidad: id,
      detalle: conHistorial
        ? `Baja lógica de la mesa ${mesa.numero} (conserva ${hist[0].n} orden(es) de historial).`
        : `Eliminación de la mesa ${mesa.numero} (sin historial).`,
      ipOrigen: ipDe(req),
    });

    return { bajaLogica: conHistorial, ordenesHistoricas: hist[0].n };
  });

  publicarSalon(req, 'mesa.eliminada', { idMesa: id, numero: mesa.numero });
  return res.json({ ok: true, ...resultado });
}));

/**
 * PATCH /api/v1/salon/mesas/:id/estado
 * Bloquear o liberar una mesa manualmente (estado 'bloqueada' del FSD 2.4.2).
 */
router.patch('/mesas/:id/estado', requierePermiso('salon.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body ?? {};

  if (!ESTADOS_MESA.includes(estado)) {
    throw errores.peticionInvalida(`Estado inválido. Opciones: ${ESTADOS_MESA.join(', ')}.`);
  }

  const mesa = await consultarUno('SELECT id_mesa, numero, estado FROM mesa WHERE id_mesa = ?', [id]);
  if (!mesa) throw errores.noEncontrado('La mesa');

  // El estado 'ocupada' lo gobierna el ciclo de vida de la orden (fase 3), no
  // una edicion manual: forzarlo desde aqui descuadraria mesa y comanda.
  if (estado === 'ocupada' || mesa.estado === 'ocupada') {
    throw errores.reglaDeNegocio(
      'El estado "ocupada" lo gestiona la apertura y el cierre de comandas, no se cambia a mano.'
    );
  }

  await transaccion(async (cx) => {
    await cx.execute('UPDATE mesa SET estado = ? WHERE id_mesa = ?', [estado, id]);
    await auditar(cx, {
      idUsuario: req.usuario.id, accion: 'mesa.estado', entidad: 'mesa', idEntidad: id,
      detalle: `Mesa ${mesa.numero}: estado ${mesa.estado} → ${estado}.`,
      ipOrigen: ipDe(req),
    });
  });

  // Dos eventos porque son dos cosas distintas: mesa.estado repinta esa mesa
  // concreta (lo que ya escuchan el mapa del mesero y el POS), y el de salon
  // cubre a quien solo mira el plano en bloque.
  publicar(EVENTOS.MESA_ESTADO, { idMesa: id, estado, mesa: mesa.numero },
    { permiso: 'salon.ver' });
  publicarSalon(req, 'mesa.estado', { idMesa: id, numero: mesa.numero, estado });

  return res.json({ ok: true });
}));

export default router;
