/**
 * Pedidos a domicilio.
 *
 * LA DECISION CENTRAL DE TODO EL CANAL DIGITAL
 * Un pedido aceptado SE CONVIERTE EN UNA `orden` REAL. No hay un circuito
 * paralelo para domicilios: en cuanto Caja lo acepta, el pedido entra por el
 * mismo tuberia que una comanda de sala -- se manda a cocina con
 * `enviarACocina`, aparece en el KDS, descuenta inventario por receta y se
 * cobra en caja. Reimplementar todo eso para el domicilio habria duplicado la
 * mitad del sistema y garantizado que las dos copias divergieran.
 *
 * El puente es la zona virtual `Domicilios` (activa = FALSE) con mesas
 * D1..D30 que siembra db/05_movil.sql. `orden.id_mesa` es NOT NULL y hacerlo
 * nullable obligaba a revisar decenas de consultas con JOIN mesa; una mesa
 * virtual resuelve el problema sin tocar ninguna. En el KDS la comanda aparece
 * como "D7", que ademas se distingue de un vistazo del servicio en sala.
 *
 * POR QUE DOS TABLAS Y NO METER EL PEDIDO DIRECTO EN `orden`
 * Una orden ocupa mesa y entra en el flujo de servicio en el instante en que
 * se crea. Un pedido pendiente de aceptar todavia puede rechazarse: no debe
 * aparecer en caja, ni bloquear una posicion, ni descontar inventario, hasta
 * que una persona lo apruebe.
 *
 * MAQUINA DE ESTADOS
 *
 *   pendiente ──aceptar──> aceptado ──> en_preparacion ──> en_camino ──> entregado
 *       ├──rechazar──> rechazado
 *       └──cancelar──> cancelado    (el cliente, solo mientras este pendiente)
 */
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores } from '../middleware/errores.js';
import { aCentavos, aDecimal, impuestoDe } from './dinero.js';
import { resolverPrecio } from './precios.js';
import { cotizar } from './entregas.js';
import { enviarACocina } from './ordenes.js';
import { notificar } from './push.js';
import { estadoInicial, PAGOS_ACEPTABLES } from './pagos.js';
import { auditar } from './auditoria.js';

/** Nombre de la zona virtual que ancla las ordenes de domicilio. */
const ZONA_DOMICILIOS = 'Domicilios';

/** Avance permitido del estado. Cualquier otro salto es un error de negocio. */
const TRANSICIONES = {
  pendiente:      ['aceptado', 'rechazado', 'cancelado'],
  aceptado:       ['en_preparacion', 'cancelado'],
  en_preparacion: ['en_camino', 'cancelado'],
  en_camino:      ['entregado'],
  entregado:      [],
  rechazado:      [],
  cancelado:      [],
};

export const ESTADOS_VIVOS = ['pendiente', 'aceptado', 'en_preparacion', 'en_camino'];

/** Consecutivo legible, correlativo y sin huecos. */
async function siguienteCodigo(cx) {
  await cx.execute("UPDATE secuencia SET valor = valor + 1 WHERE nombre = 'pedido_domicilio'");
  const [[fila]] = await cx.execute("SELECT valor FROM secuencia WHERE nombre = 'pedido_domicilio'");
  return `D-${String(fila.valor).padStart(6, '0')}`;
}

/* =====================================================================
   Creacion
   ===================================================================== */

/**
 * Congela precio e impuesto de cada linea del carrito y calcula el subtotal.
 *
 * El precio se resuelve con `resolverPrecio`, LA MISMA funcion que usa el
 * comandero: si el restaurante tiene una variante de "happy hour", el cliente
 * de la app la recibe igual que quien esta sentado en la mesa. Duplicar aqui
 * la logica de precios habria significado que un dia los dos canales cobran
 * distinto por el mismo plato.
 *
 * Los importes se calculan en CENTAVOS ENTEROS (dinero.js): sumar decimales de
 * coma flotante descuadra el arqueo de caja.
 */
async function prepararLineas(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) {
    throw errores.peticionInvalida('El pedido no tiene platos.');
  }
  if (lineas.length > 50) {
    throw errores.peticionInvalida('El pedido no puede tener mas de 50 lineas.');
  }

  const preparadas = [];
  let subtotalC = 0;
  let impuestosC = 0;

  for (const linea of lineas) {
    const idProducto = Number(linea.idProducto);
    const cantidad = Number(linea.cantidad ?? 1);

    if (!Number.isInteger(idProducto)) {
      throw errores.peticionInvalida('Hay una linea con un plato invalido.');
    }
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) {
      throw errores.peticionInvalida('La cantidad de cada plato debe estar entre 1 y 99.');
    }

    const filas = await consultar(
      `SELECT p.id_producto, p.nombre, p.precio_base, p.tasa_impuesto,
              p.disponible, p.activo,
              pp.id_precio, pp.nombre AS nombre_precio, pp.precio,
              pp.hora_inicio, pp.hora_fin, pp.fecha_inicio, pp.fecha_fin, pp.dias_semana
         FROM producto p
         LEFT JOIN producto_precio pp
                ON pp.id_producto = p.id_producto AND pp.activo = TRUE
        WHERE p.id_producto = ?`,
      [idProducto]
    );
    if (!filas.length) throw errores.noEncontrado('Uno de los platos del pedido');

    const producto = filas[0];
    if (!producto.activo) {
      throw errores.reglaDeNegocio(`"${producto.nombre}" ya no esta en el menu.`);
    }
    // El cocinero pudo marcarlo agotado mientras el cliente llenaba el carrito.
    if (!producto.disponible) {
      throw errores.reglaDeNegocio(`"${producto.nombre}" esta agotado.`,
        { agotado: true, idProducto });
    }

    const variantes = filas.filter((f) => f.id_precio !== null);
    const { precio, tasaImpuesto } = resolverPrecio(producto, variantes);

    // Modificadores: se validan contra el plato y se congela su precio extra.
    const idsMod = [...new Set((linea.modificadores ?? []).map(Number).filter(Number.isInteger))];
    let modificadores = [];
    if (idsMod.length) {
      modificadores = await consultar(
        `SELECT m.id_modificador, m.nombre, m.precio_extra
           FROM modificador m
           JOIN producto_grupo_modificador pgm ON pgm.id_grupo_mod = m.id_grupo_mod
          WHERE pgm.id_producto = ? AND m.id_modificador IN (${idsMod.map(() => '?').join(',')})
            AND m.activo = TRUE`,
        [idProducto, ...idsMod]
      );
      if (modificadores.length !== idsMod.length) {
        throw errores.peticionInvalida(`Hay opciones no validas para "${producto.nombre}".`);
      }
    }

    const extrasC = modificadores.reduce((suma, m) => suma + aCentavos(m.precio_extra), 0);
    const unitarioC = aCentavos(precio) + extrasC;
    const lineaC = unitarioC * cantidad;

    subtotalC += lineaC;
    impuestosC += impuestoDe(lineaC, tasaImpuesto);

    preparadas.push({
      idProducto,
      nombre: producto.nombre,
      cantidad,
      precioUnitario: aDecimal(unitarioC),
      tasaImpuesto,
      notas: linea.notas ? String(linea.notas).slice(0, 255) : null,
      modificadores,
    });
  }

  return { lineas: preparadas, subtotalC, impuestosC };
}

/**
 * Crea un pedido a domicilio.
 *
 * El TOTAL LO CALCULA EL SERVIDOR, siempre (FSD 5.7). Lo que la app muestre en
 * el carrito es informativo: si el cliente manipulara los importes de la
 * peticion, no cambiaria nada de lo que se cobra.
 */
export async function crear(idCliente, datos) {
  const {
    lineas, direccion, referencia, lat, lng, telefonoContacto,
    metodoPago = 'contra_entrega', pagaCon, notas,
  } = datos ?? {};

  if (!direccion || String(direccion).trim().length < 5) {
    throw errores.peticionInvalida('Indique la direccion de entrega.',
      { campos: { direccion: 'Escriba la direccion completa.' } });
  }
  if (!telefonoContacto || String(telefonoContacto).trim().length < 7) {
    throw errores.peticionInvalida('Indique un telefono de contacto.',
      { campos: { telefonoContacto: 'Indique un telefono valido.' } });
  }

  // El metodo se valida contra la tabla, no contra una lista escrita aqui: el
  // administrador los activa y desactiva, y una lista en el codigo se quedaria
  // desfasada. `estadoInicial` rechaza tanto un codigo inventado como uno
  // desactivado, y decide si el pedido nace esperando comprobante o no.
  const { metodo, estadoPago } = await estadoInicial(metodoPago);

  // Un pedido sin resolver por cliente: evita que un doble toque en el boton
  // de confirmar genere dos pedidos identicos.
  const enCurso = await consultarUno(
    `SELECT codigo FROM pedido_domicilio
      WHERE id_cliente = ? AND estado = 'pendiente' LIMIT 1`,
    [idCliente]
  );
  if (enCurso) {
    throw errores.conflicto(
      `Ya tiene el pedido ${enCurso.codigo} esperando confirmacion. Espere a que lo acepten.`
    );
  }

  const { lineas: preparadas, subtotalC, impuestosC } = await prepararLineas(lineas);

  // Cobertura y coste de envio: misma funcion que usa el Admin al
  // previsualizar, asi que el precio no puede discrepar.
  const cotizacion = await cotizar({ lat: Number(lat), lng: Number(lng), subtotal: aDecimal(subtotalC) });
  if (!cotizacion.zona) {
    throw errores.reglaDeNegocio(
      'No hacemos entregas en esa direccion. Pruebe con otra ubicacion.',
      { motivo: 'fuera_de_cobertura' }
    );
  }
  if (!cotizacion.cubierto) {
    throw errores.reglaDeNegocio(
      `El pedido minimo para esa zona es de $${cotizacion.pedidoMinimo}. ` +
      `Le faltan $${cotizacion.faltaParaMinimo}.`,
      { motivo: cotizacion.motivo, faltaParaMinimo: cotizacion.faltaParaMinimo }
    );
  }

  const envioC = aCentavos(cotizacion.costoEnvio);
  const totalC = subtotalC + impuestosC + envioC;

  // El cambio se comprueba aqui y no en el movil: si el cliente dice que paga
  // con menos de lo que cuesta, el domiciliario se entera en la puerta.
  //
  // Solo tiene sentido en contra entrega: en los metodos digitales el cliente
  // transfiere el importe exacto y no hay cambio que llevar.
  let pagaConC = null;
  if (metodoPago === 'contra_entrega' && pagaCon != null && String(pagaCon) !== '') {
    pagaConC = aCentavos(pagaCon);
    if (pagaConC < totalC) {
      throw errores.peticionInvalida(
        `El pedido cuesta $${aDecimal(totalC)} y indico que paga con $${aDecimal(pagaConC)}.`,
        { campos: { pagaCon: 'Debe ser al menos el total del pedido.' } }
      );
    }
  }

  const creado = await transaccion(async (cx) => {
    const codigo = await siguienteCodigo(cx);

    const [r] = await cx.execute(
      `INSERT INTO pedido_domicilio
         (codigo, id_cliente, id_zona_entrega, direccion_entrega, referencia_entrega,
          lat, lng, telefono_contacto, subtotal, impuestos, costo_envio, total,
          metodo_pago, estado_pago, paga_con, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        codigo, idCliente, cotizacion.zona.id,
        String(direccion).trim().slice(0, 200),
        referencia ? String(referencia).trim().slice(0, 200) : null,
        Number(lat), Number(lng),
        String(telefonoContacto).trim().slice(0, 20),
        aDecimal(subtotalC), aDecimal(impuestosC), aDecimal(envioC), aDecimal(totalC),
        metodo.codigo, estadoPago, pagaConC !== null ? aDecimal(pagaConC) : null,
        notas ? String(notas).slice(0, 255) : null,
      ]
    );

    for (const linea of preparadas) {
      const [d] = await cx.execute(
        `INSERT INTO pedido_domicilio_detalle
           (id_pedido, id_producto, cantidad, precio_unitario, tasa_impuesto, notas)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.insertId, linea.idProducto, linea.cantidad, linea.precioUnitario,
         linea.tasaImpuesto, linea.notas]
      );
      for (const m of linea.modificadores) {
        await cx.execute(
          `INSERT INTO pedido_domicilio_detalle_modificador (id_detalle, id_modificador, precio_extra)
           VALUES (?, ?, ?)`,
          [d.insertId, m.id_modificador, m.precio_extra]
        );
      }
    }

    return { id: r.insertId, codigo };
  });

  return detalle(creado.id);
}

/* =====================================================================
   Consulta
   ===================================================================== */

const SQL_PEDIDO = `
  SELECT pd.id_pedido, pd.codigo, pd.id_cliente, pd.id_orden, pd.id_zona_entrega,
         pd.direccion_entrega, pd.referencia_entrega, pd.lat, pd.lng,
         pd.telefono_contacto, pd.subtotal, pd.impuestos, pd.costo_envio, pd.total,
         pd.metodo_pago, pd.estado_pago, pd.url_comprobante, pd.comprobante_en,
         pd.verificado_en, pd.motivo_pago, pd.paga_con, pd.estado, pd.notas, pd.gestionada_en,
         pd.motivo_gestion, pd.creado_en,
         c.nombre_completo AS cliente, c.documento,
         ze.nombre AS zona_entrega, ze.tiempo_estimado_min,
         m.numero AS mesa,
         u.nombre_completo AS gestionado_por,
         up.nombre_completo AS verificado_por,
         mp.nombre AS metodo_nombre, mp.requiere_comprobante
    FROM pedido_domicilio pd
    JOIN cliente c            ON c.id_cliente = pd.id_cliente
    LEFT JOIN zona_entrega ze ON ze.id_zona_entrega = pd.id_zona_entrega
    LEFT JOIN orden o         ON o.id_orden = pd.id_orden
    LEFT JOIN mesa m          ON m.id_mesa = o.id_mesa
    LEFT JOIN usuario u       ON u.id_usuario = pd.id_usuario_gestion
    LEFT JOIN metodo_pago_app mp ON mp.codigo = pd.metodo_pago
    LEFT JOIN usuario up      ON up.id_usuario = pd.id_usuario_pago
`;

function comoDto(p, lineas = []) {
  return {
    id: p.id_pedido,
    codigo: p.codigo,
    idCliente: p.id_cliente,
    cliente: p.cliente,
    documento: p.documento,
    idOrden: p.id_orden,
    mesa: p.mesa,
    zonaEntrega: p.zona_entrega,
    tiempoEstimadoMin: p.tiempo_estimado_min,
    direccion: p.direccion_entrega,
    referencia: p.referencia_entrega,
    lat: Number(p.lat),
    lng: Number(p.lng),
    telefono: p.telefono_contacto,
    // Importes como string: mysql2 devuelve DECIMAL sin convertir a proposito.
    subtotal: p.subtotal,
    impuestos: p.impuestos,
    costoEnvio: p.costo_envio,
    total: p.total,
    metodoPago: p.metodo_pago,
    metodoNombre: p.metodo_nombre ?? p.metodo_pago,
    requiereComprobante: Boolean(p.requiere_comprobante),
    estadoPago: p.estado_pago,
    urlComprobante: p.url_comprobante,
    comprobanteEn: p.comprobante_en,
    verificadoEn: p.verificado_en,
    verificadoPor: p.verificado_por,
    motivoPago: p.motivo_pago,
    pagaCon: p.paga_con,
    estado: p.estado,
    notas: p.notas,
    gestionadoPor: p.gestionado_por,
    gestionadaEn: p.gestionada_en,
    motivoGestion: p.motivo_gestion,
    creadoEn: p.creado_en,
    lineas,
  };
}

/** Lineas de un pedido, con sus modificadores. */
async function lineasDe(idPedido) {
  const lineas = await consultar(
    `SELECT d.id_detalle, d.id_producto, d.cantidad, d.precio_unitario,
            d.tasa_impuesto, d.notas, p.nombre AS producto, p.url_imagen
       FROM pedido_domicilio_detalle d
       JOIN producto p ON p.id_producto = d.id_producto
      WHERE d.id_pedido = ?
      ORDER BY d.id_detalle`,
    [idPedido]
  );
  if (!lineas.length) return [];

  const mods = await consultar(
    `SELECT dm.id_detalle, dm.precio_extra, m.nombre
       FROM pedido_domicilio_detalle_modificador dm
       JOIN modificador m ON m.id_modificador = dm.id_modificador
      WHERE dm.id_detalle IN (${lineas.map(() => '?').join(',')})`,
    lineas.map((l) => l.id_detalle)
  );

  return lineas.map((l) => ({
    id: l.id_detalle,
    idProducto: l.id_producto,
    producto: l.producto,
    urlImagen: l.url_imagen,
    cantidad: l.cantidad,
    precioUnitario: l.precio_unitario,
    tasaImpuesto: l.tasa_impuesto,
    notas: l.notas,
    modificadores: mods
      .filter((m) => m.id_detalle === l.id_detalle)
      .map((m) => ({ nombre: m.nombre, precioExtra: m.precio_extra })),
  }));
}

/**
 * Lineas de VARIOS pedidos a la vez, agrupadas por id.
 *
 * Dos consultas en total (lineas + modificadores) independientemente de
 * cuantos pedidos haya: el listado de Caja se refresca con cada evento del
 * canal de tiempo real, y una consulta por pedido lo convertiria en una
 * tormenta de N+1 cada vez que entra un domicilio nuevo.
 *
 * @param {number[]} ids
 * @returns {Promise<Map<number, object[]>>}
 */
async function lineasDeVarios(ids) {
  const porPedido = new Map();
  if (!ids.length) return porPedido;

  const marcadores = ids.map(() => '?').join(',');

  const lineas = await consultar(
    `SELECT d.id_detalle, d.id_pedido, d.id_producto, d.cantidad, d.precio_unitario,
            d.tasa_impuesto, d.notas, p.nombre AS producto, p.url_imagen
       FROM pedido_domicilio_detalle d
       JOIN producto p ON p.id_producto = d.id_producto
      WHERE d.id_pedido IN (${marcadores})
      ORDER BY d.id_pedido, d.id_detalle`,
    ids
  );
  if (!lineas.length) return porPedido;

  const mods = await consultar(
    `SELECT dm.id_detalle, dm.precio_extra, m.nombre
       FROM pedido_domicilio_detalle_modificador dm
       JOIN modificador m ON m.id_modificador = dm.id_modificador
      WHERE dm.id_detalle IN (${lineas.map(() => '?').join(',')})`,
    lineas.map((l) => l.id_detalle)
  );

  for (const l of lineas) {
    if (!porPedido.has(l.id_pedido)) porPedido.set(l.id_pedido, []);
    porPedido.get(l.id_pedido).push({
      id: l.id_detalle,
      idProducto: l.id_producto,
      producto: l.producto,
      urlImagen: l.url_imagen,
      cantidad: l.cantidad,
      precioUnitario: l.precio_unitario,
      tasaImpuesto: l.tasa_impuesto,
      notas: l.notas,
      modificadores: mods
        .filter((m) => m.id_detalle === l.id_detalle)
        .map((m) => ({ nombre: m.nombre, precioExtra: m.precio_extra })),
    });
  }

  return porPedido;
}

/** Un pedido completo, o null. */
export async function detalle(idPedido) {
  const p = await consultarUno(`${SQL_PEDIDO} WHERE pd.id_pedido = ?`, [idPedido]);
  if (!p) return null;
  return comoDto(p, await lineasDe(idPedido));
}

/** Pedidos del cliente, mas recientes primero. Es el historial de la app. */
export async function listarDeCliente(idCliente, { soloActivos = false, limite = 50 } = {}) {
  const filtro = soloActivos ? `AND pd.estado IN ('${ESTADOS_VIVOS.join("','")}')` : '';
  const l = Math.min(100, Math.max(1, Number(limite) || 50));

  const filas = await consultar(
    `${SQL_PEDIDO} WHERE pd.id_cliente = ? ${filtro} ORDER BY pd.creado_en DESC LIMIT ${l}`,
    [idCliente]
  );
  // El listado no trae lineas: el historial muestra codigo, estado y total, y
  // el detalle se pide al tocar uno. Traer todo seria N+1 consultas por nada.
  return filas.map((p) => comoDto(p));
}

/** Listado para el backoffice. */
export async function listar({ estado, limite = 100 } = {}) {
  const condiciones = [];
  const params = [];

  if (estado === 'vivos') {
    condiciones.push(`pd.estado IN ('${ESTADOS_VIVOS.join("','")}')`);
  } else if (estado) {
    condiciones.push('pd.estado = ?');
    params.push(estado);
  }

  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const l = Math.min(500, Math.max(1, Number(limite) || 100));

  const filas = await consultar(
    `${SQL_PEDIDO} ${donde} ORDER BY pd.creado_en ASC LIMIT ${l}`,
    params
  );
  if (!filas.length) return [];

  // ESTE LISTADO SI TRAE LAS LINEAS, al contrario que el historial del
  // cliente. Es lo que el cajero necesita leer para decidir si acepta el
  // pedido: cuantos platos son, si hay una nota de alergia, si algo esta
  // agotado. Sin ellas tendria que abrir cada pedido para saber que contiene.
  //
  // Se piden TODAS de una vez y se agrupan en memoria, en vez de una consulta
  // por pedido: con 30 domicilios en cola serian 60 consultas por refresco, y
  // esta vista se refresca con cada evento del canal de tiempo real.
  const lineasPorPedido = await lineasDeVarios(filas.map((p) => p.id_pedido));
  return filas.map((p) => comoDto(p, lineasPorPedido.get(p.id_pedido) ?? []));
}

/** Cuantos pedidos esperan respuesta. Alimenta el globo de Caja. */
export async function contarPendientes() {
  const fila = await consultarUno(
    "SELECT COUNT(*) AS n FROM pedido_domicilio WHERE estado = 'pendiente'"
  );
  return Number(fila.n);
}

/* =====================================================================
   Aceptacion: el puente hacia la comanda
   ===================================================================== */

function exigirTransicion(actual, destino) {
  if (!TRANSICIONES[actual]?.includes(destino)) {
    throw errores.reglaDeNegocio(
      `Un pedido ${actual} no puede pasar a ${destino}.`,
      { estadoActual: actual }
    );
  }
}

/**
 * Acepta un pedido: crea la comanda y la manda a cocina.
 *
 * Se hace en DOS PASOS porque `enviarACocina` es una transaccion propia -- la
 * mas delicada del sistema, la que congela precios y descuenta inventario por
 * receta -- y reescribirla aqui para meterla en la misma transaccion habria
 * significado mantener dos copias de ese codigo.
 *
 *   Paso 1 (atomico): ocupar una mesa virtual libre, crear la orden con todas
 *           sus lineas, marcar el pedido como aceptado y enlazarlo.
 *   Paso 2: `enviarACocina(idOrden)`, que ya existe y esta probada.
 *
 * SI EL PASO 2 FALLA (por ejemplo, sin inventario para la receta) se DESHACE
 * el paso 1: se borra la orden -- todavia no tiene lineas enviadas, asi que es
 * seguro -- se libera la mesa y el pedido vuelve a 'pendiente'. El cajero ve
 * el error real y el sistema queda como estaba, sin ordenes fantasma ocupando
 * posiciones de domicilio.
 */
export async function aceptar(idPedido, { idUsuario, ipOrigen } = {}) {
  const preparado = await transaccion(async (cx) => {
    const [pedidos] = await cx.execute(
      `SELECT id_pedido, codigo, id_cliente, estado, estado_pago, metodo_pago
         FROM pedido_domicilio WHERE id_pedido = ? FOR UPDATE`,
      [idPedido]
    );
    if (!pedidos.length) throw errores.noEncontrado('El pedido');
    const pedido = pedidos[0];

    exigirTransicion(pedido.estado, 'aceptado');

    // ---- LA PUERTA DEL PAGO ----
    //
    // Este es el UNICO sitio por el que un pedido entra en cocina, asi que es
    // aqui donde se comprueba. Un pedido pagado por adelantado cuyo
    // comprobante no se ha verificado no puede empezar a cocinarse: si el pago
    // resulta falso, el restaurante ya habria gastado el producto.
    //
    // Contra entrega queda exento: no hay pago por adelantado que mirar, se
    // cobra en la puerta.
    if (!PAGOS_ACEPTABLES.includes(pedido.estado_pago)) {
      const mensajes = {
        pendiente: 'El cliente todavia no ha subido el comprobante de pago. ' +
                   'Espere a que lo envie, o llamele.',
        por_verificar: 'Hay un comprobante de pago sin revisar. ' +
                       'Verifiquelo antes de aceptar el pedido.',
        rechazado: 'El comprobante de pago fue rechazado. ' +
                   'El cliente tiene que subir otro.',
      };
      throw errores.reglaDeNegocio(
        mensajes[pedido.estado_pago] ?? 'El pago de este pedido no esta confirmado.',
        { motivo: 'pago_no_verificado', estadoPago: pedido.estado_pago }
      );
    }

    // Primera mesa virtual sin comanda viva. FOR UPDATE serializa a dos
    // cajeros aceptando pedidos a la vez: sin el, ambos elegirian la misma.
    const [libres] = await cx.execute(
      `SELECT m.id_mesa, m.numero
         FROM mesa m
         JOIN zona z ON z.id_zona = m.id_zona
        WHERE z.nombre = ? AND m.activa = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM orden o
             WHERE o.id_mesa = m.id_mesa
               AND o.estado IN ('abierta','enviada','precuenta')
          )
        ORDER BY m.id_mesa ASC
        LIMIT 1
        FOR UPDATE`,
      [ZONA_DOMICILIOS]
    );

    if (!libres.length) {
      // No basta con decir "estan todas ocupadas": hay DOS motivos distintos
      // para no encontrar posicion, y llevan a sitios opuestos.
      //
      // Se descubrio en pruebas reales: `npm run bd:vaciar` trunca `zona` y
      // `mesa`, y se lleva por delante la zona virtual que siembra
      // db/05_movil.sql. El cajero veia "hay 30 pedidos sin cerrar" cuando en
      // realidad no existia ni una sola posicion, y se ponia a buscar cuentas
      // abiertas que no estaban. Un error que apunta al sitio equivocado cuesta
      // mas tiempo que no dar ninguno.
      const [[capacidad]] = await cx.execute(
        `SELECT COUNT(*) AS n FROM mesa m
           JOIN zona z ON z.id_zona = m.id_zona
          WHERE z.nombre = ? AND m.activa = TRUE`,
        [ZONA_DOMICILIOS]
      );

      if (Number(capacidad.n) === 0) {
        throw errores.reglaDeNegocio(
          'No hay posiciones de domicilio configuradas en el sistema, asi que no se ' +
          'puede abrir la comanda. Suele pasar despues de vaciar la base de datos: ' +
          'vuelva a aplicar db/05_movil.sql para recrearlas.',
          { motivo: 'sin_posiciones' }
        );
      }

      throw errores.reglaDeNegocio(
        `Capacidad de domicilios al limite: las ${capacidad.n} posiciones tienen una ` +
        'comanda sin cerrar. Cobre o cierre alguna en caja antes de aceptar otro pedido.',
        { motivo: 'capacidad_llena', posiciones: Number(capacidad.n) }
      );
    }
    const mesa = libres[0];

    const [lineas] = await cx.execute(
      `SELECT d.id_detalle, d.id_producto, d.cantidad, d.notas,
              d.precio_unitario, d.tasa_impuesto
         FROM pedido_domicilio_detalle d WHERE d.id_pedido = ? ORDER BY d.id_detalle`,
      [idPedido]
    );
    if (!lineas.length) throw errores.reglaDeNegocio('El pedido no tiene lineas.');

    /**
     * Precios que el cliente ACEPTO en la aplicacion, por linea de comanda.
     * Se aplican despues de enviar a cocina; ver la explicacion en el paso 3.
     */
    const preciosDelCliente = [];

    // La orden se abre a nombre del usuario que acepta: es quien responde por
    // ella en el arqueo, igual que el mesero responde de su mesa.
    const [orden] = await cx.execute(
      `INSERT INTO orden (id_mesa, id_mesero, num_comensales, estado, abierta_en)
       VALUES (?, ?, 1, 'abierta', NOW())`,
      [mesa.id_mesa, idUsuario]
    );
    const idOrden = orden.insertId;

    await cx.execute("UPDATE mesa SET estado = 'ocupada' WHERE id_mesa = ?", [mesa.id_mesa]);

    for (const linea of lineas) {
      // Se insertan ya con el precio que acepto el cliente. `enviarACocina` lo
      // va a sobrescribir en el paso 2 -- hace bien, es su trabajo para una
      // comanda de sala -- y el paso 3 lo devuelve a este valor.
      const [od] = await cx.execute(
        `INSERT INTO orden_detalle
           (id_orden, id_producto, cantidad, precio_unitario, tasa_impuesto,
            tiempo_salida, notas, estado_preparacion)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'en_cola')`,
        [idOrden, linea.id_producto, linea.cantidad,
         linea.precio_unitario, linea.tasa_impuesto, linea.notas]
      );

      preciosDelCliente.push({
        idOrdenDetalle: od.insertId,
        precio: linea.precio_unitario,
        tasa: linea.tasa_impuesto,
      });

      await cx.execute(
        `INSERT INTO orden_detalle_modificador (id_orden_detalle, id_modificador, precio_extra)
         SELECT ?, dm.id_modificador, dm.precio_extra
           FROM pedido_domicilio_detalle_modificador dm
          WHERE dm.id_detalle = ?`,
        [od.insertId, linea.id_detalle]
      );
    }

    await cx.execute(
      `UPDATE pedido_domicilio
          SET estado = 'aceptado', id_orden = ?, id_usuario_gestion = ?, gestionada_en = NOW()
        WHERE id_pedido = ?`,
      [idOrden, idUsuario, idPedido]
    );

    await auditar(cx, {
      idUsuario,
      accion: 'domicilio.aceptado',
      entidad: 'pedido_domicilio',
      idEntidad: idPedido,
      detalle: `Pedido ${pedido.codigo} aceptado. Comanda ${idOrden} en la posicion ${mesa.numero}.`,
      ipOrigen,
    });

    return {
      pedido, idOrden, idMesa: mesa.id_mesa, numeroMesa: mesa.numero,
      preciosDelCliente,
    };
  });

  // Paso 2: a cocina, con la transaccion ya probada del servicio de ordenes.
  try {
    await enviarACocina({ idOrden: preparado.idOrden, idUsuario, ipOrigen });
  } catch (error) {
    await revertirAceptacion(preparado, idPedido);
    throw error;
  }

  // ---------------------------------------------------------------------
  // Paso 3: DEVOLVER EL PRECIO QUE ACEPTO EL CLIENTE.
  //
  // `enviarACocina` recongela el precio con el vigente en ESE instante. Para
  // una comanda de sala es exactamente lo correcto (CA-04): la venta se hace
  // real cuando el pedido entra en cocina.
  //
  // Para un domicilio no. El cliente vio un total en la aplicacion, lo acepto
  // y espera pagar eso. Entre que pide y que Caja acepta pueden pasar minutos,
  // y en esos minutos puede empezar o acabar un "happy hour", o el
  // administrador puede tocar un precio. Quien pide a las 17:59 con descuento
  // no debe perderlo porque el cajero acepte a las 18:01.
  //
  // Se descubrio comparando un pedido real con su comanda: la app habia
  // congelado 35.000 y la comanda decia 32.000, asi que caja habria cobrado un
  // importe distinto del aceptado.
  //
  // Va DESPUES de enviar y no antes porque enviarACocina sobrescribe sin
  // preguntar. Es seguro: el descuento de inventario depende de la cantidad,
  // no del precio, y la factura se calcula despues sumando estas lineas.
  // ---------------------------------------------------------------------
  await transaccion(async (cx) => {
    for (const linea of preparado.preciosDelCliente) {
      await cx.execute(
        'UPDATE orden_detalle SET precio_unitario = ?, tasa_impuesto = ? WHERE id_orden_detalle = ?',
        [linea.precio, linea.tasa, linea.idOrdenDetalle]
      );
    }
  }).catch((e) => {
    // Si esto falla, la comanda queda con el precio del catalogo y no con el
    // aceptado. No se revierte el pedido -- la comida ya esta en cocina -- pero
    // tiene que quedar rastro para poder ajustarlo a mano en caja.
    console.error(
      `[domicilios] ATENCION: no se pudieron restaurar los precios aceptados por el ` +
      `cliente en la comanda ${preparado.idOrden}: ${e.message}. ` +
      `Revise el importe antes de cobrar.`
    );
  });

  await notificar(preparado.pedido.id_cliente, {
    tipo: 'pedido',
    referencia: preparado.pedido.codigo,
    titulo: 'Pedido confirmado',
    cuerpo: `Su pedido ${preparado.pedido.codigo} fue aceptado y ya esta en preparacion.`,
  }).catch((e) => console.error('[domicilios] no se pudo notificar:', e.message));

  return { ...(await detalle(idPedido)), numeroMesa: preparado.numeroMesa };
}

/**
 * Deshace el paso 1 cuando el envio a cocina falla.
 *
 * Es seguro borrar la orden: sus lineas siguen en 'en_cola' sin enviar, no se
 * descontó inventario y no existe factura. `orden_detalle` cae por CASCADE.
 */
async function revertirAceptacion({ idOrden, idMesa }, idPedido) {
  await transaccion(async (cx) => {
    await cx.execute(
      `UPDATE pedido_domicilio
          SET estado = 'pendiente', id_orden = NULL, id_usuario_gestion = NULL, gestionada_en = NULL
        WHERE id_pedido = ?`,
      [idPedido]
    );
    await cx.execute('DELETE FROM orden WHERE id_orden = ?', [idOrden]);
    await cx.execute("UPDATE mesa SET estado = 'libre' WHERE id_mesa = ?", [idMesa]);
  }).catch((e) => {
    // Si hasta la reversion falla, hay que dejar rastro: queda una orden
    // huerfana que alguien tendra que cerrar a mano desde caja.
    console.error(
      `[domicilios] no se pudo revertir la aceptacion del pedido ${idPedido} ` +
      `(orden ${idOrden}, mesa ${idMesa}): ${e.message}`
    );
  });
}

/* =====================================================================
   Resto de transiciones
   ===================================================================== */

/** Textos que ve el cliente en cada cambio de estado. */
const AVISOS = {
  en_preparacion: { titulo: 'Pedido en preparacion', cuerpo: (c) => `Estamos preparando su pedido ${c}.` },
  en_camino:      { titulo: 'Pedido en camino',      cuerpo: (c) => `Su pedido ${c} salio hacia su direccion.` },
  entregado:      { titulo: 'Pedido entregado',      cuerpo: (c) => `Su pedido ${c} fue entregado. ¡Buen provecho!` },
  rechazado:      { titulo: 'Pedido rechazado',      cuerpo: (c) => `No pudimos atender su pedido ${c}.` },
  cancelado:      { titulo: 'Pedido cancelado',      cuerpo: (c) => `Su pedido ${c} fue cancelado.` },
};

/**
 * Avanza el estado de un pedido desde el backoffice.
 * `aceptar` no pasa por aqui: tiene su propia funcion porque crea la comanda.
 */
export async function cambiarEstado(idPedido, destino, { idUsuario, motivo, ipOrigen } = {}) {
  if (destino === 'aceptado') {
    throw errores.peticionInvalida('Para aceptar un pedido use la accion de aceptar.');
  }

  const pedido = await transaccion(async (cx) => {
    const [filas] = await cx.execute(
      'SELECT id_pedido, codigo, id_cliente, id_orden, estado FROM pedido_domicilio WHERE id_pedido = ? FOR UPDATE',
      [idPedido]
    );
    if (!filas.length) throw errores.noEncontrado('El pedido');
    const p = filas[0];

    exigirTransicion(p.estado, destino);

    if (destino === 'rechazado' && !String(motivo ?? '').trim()) {
      throw errores.peticionInvalida('Explique por que se rechaza el pedido.',
        { campos: { motivo: 'Indique el motivo.' } });
    }

    await cx.execute(
      `UPDATE pedido_domicilio
          SET estado = ?, id_usuario_gestion = ?, gestionada_en = NOW(),
              motivo_gestion = COALESCE(?, motivo_gestion)
        WHERE id_pedido = ?`,
      [destino, idUsuario, motivo ? String(motivo).slice(0, 255) : null, idPedido]
    );

    await auditar(cx, {
      idUsuario,
      accion: `domicilio.${destino}`,
      entidad: 'pedido_domicilio',
      idEntidad: idPedido,
      detalle: `Pedido ${p.codigo} -> ${destino}${motivo ? `. Motivo: ${motivo}` : '.'}`,
      ipOrigen,
    });

    return p;
  });

  const aviso = AVISOS[destino];
  if (aviso) {
    await notificar(pedido.id_cliente, {
      tipo: 'pedido',
      referencia: pedido.codigo,
      titulo: aviso.titulo,
      cuerpo: `${aviso.cuerpo(pedido.codigo)}${motivo ? ` ${motivo}` : ''}`.trim(),
    }).catch((e) => console.error('[domicilios] no se pudo notificar:', e.message));
  }

  return detalle(idPedido);
}

/**
 * Cancelacion pedida por el propio cliente.
 *
 * Solo mientras el pedido sigue 'pendiente'. Una vez aceptado, la cocina ya
 * empezo y el inventario ya se descontó: cancelarlo desde el movil dejaria
 * comida hecha sin cobrar. A partir de ahi hay que llamar al restaurante, y es
 * el cajero quien decide.
 */
export async function cancelarPorCliente(idCliente, idPedido) {
  const pedido = await transaccion(async (cx) => {
    const [filas] = await cx.execute(
      'SELECT id_pedido, codigo, estado FROM pedido_domicilio WHERE id_pedido = ? AND id_cliente = ? FOR UPDATE',
      [idPedido, idCliente]
    );
    if (!filas.length) throw errores.noEncontrado('El pedido');

    if (filas[0].estado !== 'pendiente') {
      throw errores.reglaDeNegocio(
        'El pedido ya fue aceptado y esta en preparacion. Llame al restaurante para cancelarlo.',
        { estadoActual: filas[0].estado }
      );
    }

    await cx.execute(
      `UPDATE pedido_domicilio
          SET estado = 'cancelado', gestionada_en = NOW(),
              motivo_gestion = 'Cancelado por el cliente desde la aplicacion.'
        WHERE id_pedido = ?`,
      [idPedido]
    );
    return filas[0];
  });

  return { cancelado: true, codigo: pedido.codigo, idPedido };
}
