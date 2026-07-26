/**
 * Ciclo de vida de la comanda.  RF-10 a RF-13.
 *
 * Aqui viven las tres reglas que, mal hechas, rompen el sistema entero:
 *
 *  CA-09  Dos meseros no pueden abrir la misma mesa a la vez.
 *  CA-04  El precio se congela al enviar y no cambia si el catalogo se edita.
 *  CA-03  El stock baja exactamente receta.cantidad x cantidad vendida.
 *
 * FSD 5.5: "Envio a cocina (transaccion unica): inserta/actualiza
 * orden_detalle con precio e impuesto congelados, estado en_cola,
 * enviado_en = NOW(); descuenta inventario (5.4.2); enruta cada linea al KDS
 * segun categoria.destino_preparacion; publica eventos WebSocket."
 */
import { transaccion, consultar, consultarUno } from '../db.js';
import { errores } from '../middleware/errores.js';
import { auditar } from './auditoria.js';
import { resolverPrecio } from './precios.js';
import { descontarPorReceta, revertirPorReceta } from './inventario.js';

/** Estados en los que una orden sigue viva sobre la mesa. */
export const ESTADOS_VIVOS = ['abierta', 'enviada', 'precuenta'];

/**
 * Flujo de estados del KDS (FSD 5.6): "en_cola -> preparando -> listo ->
 * servido (sin retrocesos salvo autorizacion del Administrador)".
 */
export const SIGUIENTE_ESTADO = {
  en_cola: 'preparando',
  preparando: 'listo',
  listo: 'servido',
};

/**
 * Abre una comanda en una mesa.  CA-09.
 *
 * EL BLOQUEO ES LO IMPORTANTE
 * Sin `FOR UPDATE`, dos meseros que tocan la misma mesa a la vez leen ambos
 * "libre", ambos insertan su orden, y la mesa acaba con dos comandas abiertas:
 * el cliente recibe comida de dos pedidos y la cuenta sale mal. El bloqueo
 * hace que la segunda transaccion espere a que la primera termine, y entonces
 * ya lee "ocupada" y falla limpiamente.
 *
 * El FSD 5.5 habla de "bloqueo optimista", pero un optimista aqui obligaria a
 * reintentar en el cliente ante un choque; el pesimista resuelve el caso en el
 * servidor y el mesero ve un error claro en vez de un reintento silencioso.
 */
export async function abrirOrden({ idMesa, idMesero, numComensales, ipOrigen }) {
  return transaccion(async (cx) => {
    // FOR UPDATE bloquea la fila hasta el commit.
    const [mesas] = await cx.execute(
      `SELECT id_mesa, numero, estado, capacidad, activa
         FROM mesa WHERE id_mesa = ? FOR UPDATE`,
      [idMesa]
    );
    if (!mesas.length) throw errores.noEncontrado('La mesa');

    const mesa = mesas[0];
    if (!mesa.activa) throw errores.reglaDeNegocio('Esa mesa está dada de baja.');

    if (mesa.estado !== 'libre') {
      // Se informa de quien la tiene: es lo que el mesero necesita saber.
      const [abiertas] = await cx.execute(
        `SELECT o.id_orden, u.nombre_completo AS mesero
           FROM orden o JOIN usuario u ON u.id_usuario = o.id_mesero
          WHERE o.id_mesa = ? AND o.estado IN ('abierta','enviada','precuenta')
          LIMIT 1`,
        [idMesa]
      );
      const quien = abiertas.length ? ` La atiende ${abiertas[0].mesero}.` : '';
      throw errores.conflicto(`La mesa ${mesa.numero} ya no está libre.${quien}`);
    }

    // FSD 5.5: "Comensales entre 1 y mesa.capacidad".
    const comensales = Number(numComensales);
    if (!Number.isInteger(comensales) || comensales < 1) {
      throw errores.peticionInvalida('Indique cuántas personas se sientan en la mesa.');
    }
    if (comensales > mesa.capacidad) {
      throw errores.reglaDeNegocio(
        `La mesa ${mesa.numero} tiene capacidad para ${mesa.capacidad} personas y se indicaron ${comensales}.`,
        { capacidad: mesa.capacidad }
      );
    }

    const [r] = await cx.execute(
      `INSERT INTO orden (id_mesa, id_mesero, num_comensales, estado, abierta_en)
       VALUES (?, ?, ?, 'abierta', NOW())`,
      [idMesa, idMesero, comensales]
    );

    await cx.execute("UPDATE mesa SET estado = 'ocupada' WHERE id_mesa = ?", [idMesa]);

    await auditar(cx, {
      idUsuario: idMesero,
      accion: 'orden.apertura',
      entidad: 'orden',
      idEntidad: r.insertId,
      detalle: `Comanda abierta en la mesa ${mesa.numero} para ${comensales} comensal(es).`,
      ipOrigen,
    });

    return { idOrden: r.insertId, numeroMesa: mesa.numero, idMesa };
  });
}

/** Detalle completo de una comanda. */
export async function detalleOrden(idOrden) {
  const orden = await consultarUno(
    `SELECT o.id_orden, o.id_mesa, o.id_mesero, o.num_comensales, o.estado,
            o.abierta_en, o.cerrada_en, m.numero AS mesa, z.nombre AS zona,
            u.nombre_completo AS mesero
       FROM orden o
       JOIN mesa m   ON m.id_mesa = o.id_mesa
       JOIN zona z   ON z.id_zona = m.id_zona
       JOIN usuario u ON u.id_usuario = o.id_mesero
      WHERE o.id_orden = ?`,
    [idOrden]
  );
  if (!orden) return null;

  const lineas = await consultar(
    `SELECT od.id_orden_detalle, od.id_producto, od.cantidad, od.precio_unitario,
            od.tasa_impuesto, od.tiempo_salida, od.notas, od.estado_preparacion,
            od.enviado_en, od.listo_en,
            p.nombre AS producto, c.destino_preparacion
       FROM orden_detalle od
       JOIN producto p  ON p.id_producto = od.id_producto
       JOIN categoria c ON c.id_categoria = p.id_categoria
      WHERE od.id_orden = ?
      ORDER BY od.tiempo_salida, od.id_orden_detalle`,
    [idOrden]
  );

  const modificadores = lineas.length
    ? await consultar(
        `SELECT odm.id_orden_detalle, odm.precio_extra, m.nombre
           FROM orden_detalle_modificador odm
           JOIN modificador m ON m.id_modificador = odm.id_modificador
          WHERE odm.id_orden_detalle IN (${lineas.map(() => '?').join(',')})`,
        lineas.map((l) => l.id_orden_detalle)
      )
    : [];

  return {
    id: orden.id_orden,
    idMesa: orden.id_mesa,
    mesa: orden.mesa,
    zona: orden.zona,
    idMesero: orden.id_mesero,
    mesero: orden.mesero,
    numComensales: orden.num_comensales,
    estado: orden.estado,
    abiertaEn: orden.abierta_en,
    cerradaEn: orden.cerrada_en,
    lineas: lineas.map((l) => ({
      id: l.id_orden_detalle,
      idProducto: l.id_producto,
      producto: l.producto,
      cantidad: l.cantidad,
      // Importes como string: no se hace aritmetica con ellos en JS.
      precioUnitario: String(l.precio_unitario),
      tasaImpuesto: String(l.tasa_impuesto),
      tiempoSalida: l.tiempo_salida,
      notas: l.notas,
      estadoPreparacion: l.estado_preparacion,
      destino: l.destino_preparacion,
      enviadoEn: l.enviado_en,
      listoEn: l.listo_en,
      // Una linea ya enviada es inmutable para el mesero (FSD 5.5).
      enviada: Boolean(l.enviado_en),
      modificadores: modificadores
        .filter((m) => m.id_orden_detalle === l.id_orden_detalle)
        .map((m) => ({ nombre: m.nombre, precioExtra: String(m.precio_extra) })),
    })),
  };
}

/**
 * Valida los modificadores elegidos contra las reglas del grupo.
 * FSD 5.3: "Grupos obligatorios: el comandero no permite agregar el plato sin
 * cumplir seleccion_min." El comandero ya lo impide, pero eso es UX: la
 * comprobacion que cuenta es esta.
 */
async function validarModificadores(cx, idProducto, idsModificadores) {
  const [grupos] = await cx.execute(
    `SELECT g.id_grupo_mod, g.nombre, g.obligatorio, g.seleccion_min, g.seleccion_max
       FROM producto_grupo_modificador pgm
       JOIN grupo_modificador g ON g.id_grupo_mod = pgm.id_grupo_mod
      WHERE pgm.id_producto = ?`,
    [idProducto]
  );
  if (!grupos.length) {
    if (idsModificadores.length) {
      throw errores.peticionInvalida('Ese plato no admite modificadores.');
    }
    return [];
  }

  const elegidos = idsModificadores.length
    ? await (async () => {
        const [filas] = await cx.execute(
          `SELECT id_modificador, id_grupo_mod, nombre, precio_extra, activo
             FROM modificador
            WHERE id_modificador IN (${idsModificadores.map(() => '?').join(',')})`,
          idsModificadores
        );
        return filas;
      })()
    : [];

  if (elegidos.length !== idsModificadores.length) {
    throw errores.peticionInvalida('Uno o más modificadores no existen.');
  }
  const inactivo = elegidos.find((m) => !m.activo);
  if (inactivo) {
    throw errores.reglaDeNegocio(`La opción "${inactivo.nombre}" ya no está disponible.`);
  }

  const idsGrupos = new Set(grupos.map((g) => g.id_grupo_mod));
  const ajeno = elegidos.find((m) => !idsGrupos.has(m.id_grupo_mod));
  if (ajeno) {
    throw errores.peticionInvalida(`La opción "${ajeno.nombre}" no corresponde a ese plato.`);
  }

  for (const g of grupos) {
    const enGrupo = elegidos.filter((m) => m.id_grupo_mod === g.id_grupo_mod);

    if (g.obligatorio && enGrupo.length < g.seleccion_min) {
      throw errores.reglaDeNegocio(
        `"${g.nombre}" es obligatorio: elija al menos ${g.seleccion_min} opción(es).`,
        { idGrupo: g.id_grupo_mod }
      );
    }
    if (enGrupo.length > g.seleccion_max) {
      throw errores.reglaDeNegocio(
        `En "${g.nombre}" puede elegir como máximo ${g.seleccion_max} opción(es).`,
        { idGrupo: g.id_grupo_mod }
      );
    }
  }

  return elegidos;
}

/**
 * Agrega una linea a una comanda abierta (todavia sin enviar).
 * El precio NO se congela aqui: se congela al enviar (CA-04), que es el
 * momento en que la venta se hace real.
 */
export async function agregarLinea({ idOrden, idProducto, cantidad, notas, tiempoSalida, modificadores = [], idUsuario }) {
  return transaccion(async (cx) => {
    const [ordenes] = await cx.execute(
      'SELECT id_orden, id_mesero, estado FROM orden WHERE id_orden = ? FOR UPDATE',
      [idOrden]
    );
    if (!ordenes.length) throw errores.noEncontrado('La comanda');
    if (['cerrada', 'anulada'].includes(ordenes[0].estado)) {
      throw errores.reglaDeNegocio('Esa comanda ya está cerrada.');
    }

    const [productos] = await cx.execute(
      `SELECT p.id_producto, p.nombre, p.disponible, p.activo
         FROM producto p WHERE p.id_producto = ?`,
      [idProducto]
    );
    if (!productos.length) throw errores.noEncontrado('El plato');
    const producto = productos[0];

    if (!producto.activo) throw errores.reglaDeNegocio('Ese plato ya no está en el menú.');
    // El cocinero pudo marcarlo agotado mientras el mesero tomaba el pedido
    // (CU-01, flujo alterno 3a).
    if (!producto.disponible) {
      throw errores.reglaDeNegocio(`"${producto.nombre}" está agotado.`, { agotado: true });
    }

    const unidades = Number(cantidad);
    if (!Number.isInteger(unidades) || unidades < 1) {
      throw errores.peticionInvalida('La cantidad debe ser al menos 1.');
    }

    const idsMod = [...new Set(modificadores.map(Number).filter(Number.isInteger))];
    const elegidos = await validarModificadores(cx, idProducto, idsMod);

    const [r] = await cx.execute(
      `INSERT INTO orden_detalle
         (id_orden, id_producto, cantidad, precio_unitario, tasa_impuesto,
          tiempo_salida, notas, estado_preparacion)
       VALUES (?, ?, ?, 0, 0, ?, ?, 'en_cola')`,
      [idOrden, idProducto, unidades, Number(tiempoSalida) || 1,
       notas ? String(notas).slice(0, 255) : null]
    );

    for (const m of elegidos) {
      await cx.execute(
        `INSERT INTO orden_detalle_modificador (id_orden_detalle, id_modificador, precio_extra)
         VALUES (?, ?, ?)`,
        [r.insertId, m.id_modificador, m.precio_extra]
      );
    }

    return { idLinea: r.insertId };
  });
}

/**
 * Envia la comanda a cocina.  LA TRANSACCION CRITICA.
 *
 * Todo esto ocurre o no ocurre nada:
 *   1. Congelar precio e impuesto de cada linea nueva      (CA-04)
 *   2. Marcarlas enviadas y en cola                        (RF-12)
 *   3. Descontar el inventario segun la receta             (CA-03)
 *   4. Auditar
 *
 * Si el paso 3 falla, el paso 1 se deshace: no puede quedar una comanda
 * enviada cuyo inventario no se descontó, ni al reves.
 *
 * Los eventos WebSocket se publican DESPUES del commit, nunca dentro: si se
 * publicaran dentro y la transaccion hiciera rollback, el KDS mostraria una
 * comanda que no existe.
 */
export async function enviarACocina({ idOrden, idUsuario, ipOrigen, momento = new Date() }) {
  const resultado = await transaccion(async (cx) => {
    const [ordenes] = await cx.execute(
      `SELECT o.id_orden, o.id_mesa, o.id_mesero, o.estado, m.numero AS mesa
         FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
        WHERE o.id_orden = ? FOR UPDATE`,
      [idOrden]
    );
    if (!ordenes.length) throw errores.noEncontrado('La comanda');
    const orden = ordenes[0];

    if (['cerrada', 'anulada'].includes(orden.estado)) {
      throw errores.reglaDeNegocio('Esa comanda ya está cerrada.');
    }

    // Solo las lineas que aun no se enviaron. Reenviar una comanda con lineas
    // nuevas no debe volver a descontar el stock de las viejas.
    const [pendientes] = await cx.execute(
      `SELECT od.id_orden_detalle, od.id_producto, od.cantidad, od.notas,
              p.nombre AS producto, p.precio_base, p.tasa_impuesto, p.disponible,
              c.destino_preparacion
         FROM orden_detalle od
         JOIN producto p  ON p.id_producto = od.id_producto
         JOIN categoria c ON c.id_categoria = p.id_categoria
        WHERE od.id_orden = ? AND od.enviado_en IS NULL
          AND od.estado_preparacion <> 'anulado'
        FOR UPDATE`,
      [idOrden]
    );

    if (!pendientes.length) {
      throw errores.reglaDeNegocio('No hay líneas nuevas que enviar a cocina.');
    }

    const criticos = [];
    const enviadas = [];

    for (const linea of pendientes) {
      // Un plato agotado entre la toma y el envio no se manda a cocina.
      if (!linea.disponible) {
        throw errores.reglaDeNegocio(
          `"${linea.producto}" se agotó mientras tomaba el pedido. Quítelo de la comanda para poder enviarla.`,
          { idLinea: linea.id_orden_detalle, agotado: true }
        );
      }

      // ---- CA-04: congelado del precio ----
      // Se resuelve la variante vigente AHORA y se copia a la linea. A partir
      // de aqui, editar el catalogo no altera lo ya vendido.
      const [variantes] = await cx.execute(
        `SELECT id_precio, nombre, precio, hora_inicio, hora_fin,
                fecha_inicio, fecha_fin, dias_semana, activo
           FROM producto_precio
          WHERE id_producto = ? AND activo = TRUE`,
        [linea.id_producto]
      );
      const vigente = resolverPrecio(
        { precio_base: linea.precio_base, tasa_impuesto: linea.tasa_impuesto },
        variantes,
        momento
      );

      await cx.execute(
        `UPDATE orden_detalle
            SET precio_unitario = ?, tasa_impuesto = ?,
                estado_preparacion = 'en_cola', enviado_en = NOW()
          WHERE id_orden_detalle = ?`,
        [vigente.precio, vigente.tasaImpuesto, linea.id_orden_detalle]
      );

      // ---- CA-03: descuento de inventario, misma transaccion ----
      const alertas = await descontarPorReceta(cx, {
        idOrdenDetalle: linea.id_orden_detalle,
        idProducto: linea.id_producto,
        cantidad: linea.cantidad,
        idUsuario,
      });
      criticos.push(...alertas);

      enviadas.push({
        idLinea: linea.id_orden_detalle,
        producto: linea.producto,
        cantidad: linea.cantidad,
        notas: linea.notas,
        // Enrutamiento al KDS que corresponde (FSD 5.5).
        destino: linea.destino_preparacion,
        precioCongelado: vigente.precio,
        variante: vigente.nombre,
      });
    }

    await cx.execute("UPDATE orden SET estado = 'enviada' WHERE id_orden = ?", [idOrden]);

    await auditar(cx, {
      idUsuario,
      accion: 'orden.envio',
      entidad: 'orden',
      idEntidad: idOrden,
      detalle: `Comanda de la mesa ${orden.mesa} enviada: ${enviadas.length} línea(s). ` +
               `Precios congelados. Inventario descontado por receta.`,
      ipOrigen,
    });

    return {
      idOrden,
      idMesa: orden.id_mesa,
      mesa: orden.mesa,
      idMesero: orden.id_mesero,
      lineas: enviadas,
      criticos,
    };
  });

  return resultado;
}

/**
 * Avanza el estado de preparacion de una linea.  RF-14.
 * FSD 5.6: "Flujo de estados estricto: en_cola -> preparando -> listo ->
 * servido (sin retrocesos salvo autorizacion del Administrador; toda
 * transicion guarda timestamp para metricas de tiempos de cocina)."
 */
export async function avanzarEstadoLinea({ idLinea, estadoDestino, idUsuario, ipOrigen }) {
  return transaccion(async (cx) => {
    const [lineas] = await cx.execute(
      `SELECT od.id_orden_detalle, od.id_orden, od.estado_preparacion, od.enviado_en,
              p.nombre AS producto, o.id_mesero, m.numero AS mesa
         FROM orden_detalle od
         JOIN producto p ON p.id_producto = od.id_producto
         JOIN orden o    ON o.id_orden = od.id_orden
         JOIN mesa m     ON m.id_mesa = o.id_mesa
        WHERE od.id_orden_detalle = ? FOR UPDATE`,
      [idLinea]
    );
    if (!lineas.length) throw errores.noEncontrado('La línea de la comanda');
    const linea = lineas[0];

    if (!linea.enviado_en) {
      throw errores.reglaDeNegocio('Esa línea todavía no se ha enviado a cocina.');
    }
    if (linea.estado_preparacion === 'anulado') {
      throw errores.reglaDeNegocio('Esa línea está anulada.');
    }

    // El destino se calcula, no se acepta del cliente: asi el flujo no se
    // puede saltar pasos ni retroceder manipulando la peticion.
    const siguiente = SIGUIENTE_ESTADO[linea.estado_preparacion];
    if (!siguiente) {
      throw errores.reglaDeNegocio(`"${linea.producto}" ya está servido.`);
    }
    if (estadoDestino && estadoDestino !== siguiente) {
      throw errores.reglaDeNegocio(
        `Desde "${linea.estado_preparacion}" solo se puede pasar a "${siguiente}". ` +
        'El flujo de estados no admite saltos ni retrocesos.'
      );
    }

    // Los timestamps alimentan las metricas de tiempos de cocina (FSD 5.6).
    const campoFecha = siguiente === 'listo' ? ', listo_en = NOW()' : '';
    await cx.execute(
      `UPDATE orden_detalle SET estado_preparacion = ?${campoFecha} WHERE id_orden_detalle = ?`,
      [siguiente, idLinea]
    );

    return {
      idLinea,
      idOrden: linea.id_orden,
      idMesero: linea.id_mesero,
      mesa: linea.mesa,
      producto: linea.producto,
      estadoAnterior: linea.estado_preparacion,
      estado: siguiente,
    };
  });
}

/**
 * Anula una linea ya enviada.  CA-08.
 * FSD 5.5: "su anulacion exige permiso ordenes.anular_enviada o autorizacion
 * del Administrador (PIN en modal) y queda auditada con autor y autorizador."
 *
 * El inventario consumido se devuelve con un contra-asiento.
 */
export async function anularLinea({ idLinea, idUsuario, idAutorizador, motivo, ipOrigen }) {
  return transaccion(async (cx) => {
    const [lineas] = await cx.execute(
      `SELECT od.id_orden_detalle, od.id_orden, od.id_producto, od.cantidad,
              od.estado_preparacion, od.enviado_en, p.nombre AS producto,
              m.numero AS mesa, o.id_mesero
         FROM orden_detalle od
         JOIN producto p ON p.id_producto = od.id_producto
         JOIN orden o    ON o.id_orden = od.id_orden
         JOIN mesa m     ON m.id_mesa = o.id_mesa
        WHERE od.id_orden_detalle = ? FOR UPDATE`,
      [idLinea]
    );
    if (!lineas.length) throw errores.noEncontrado('La línea de la comanda');
    const linea = lineas[0];

    if (linea.estado_preparacion === 'anulado') {
      throw errores.reglaDeNegocio('Esa línea ya está anulada.');
    }

    await cx.execute(
      "UPDATE orden_detalle SET estado_preparacion = 'anulado' WHERE id_orden_detalle = ?",
      [idLinea]
    );

    // Solo se devuelve al inventario lo que llego a descontarse: una linea sin
    // enviar nunca lo toco.
    if (linea.enviado_en) {
      await revertirPorReceta(cx, {
        idOrdenDetalle: idLinea,
        idProducto: linea.id_producto,
        cantidad: linea.cantidad,
        idUsuario,
        motivo: `Anulación de línea: ${motivo ?? 'sin motivo indicado'}`,
      });
    }

    // CA-08: el registro guarda autor Y autorizador.
    await auditar(cx, {
      idUsuario,
      idAutorizador: idAutorizador ?? null,
      accion: 'orden.anulacion',
      entidad: 'orden_detalle',
      idEntidad: idLinea,
      detalle: `Anulación de ${linea.cantidad} x "${linea.producto}" en la mesa ${linea.mesa}. ` +
               `Motivo: ${motivo ?? 'no indicado'}.` +
               (linea.enviado_en ? ' Inventario devuelto con contra-asiento.' : '') +
               (idAutorizador ? ' Autorizada con PIN de administrador.' : ''),
      ipOrigen,
    });

    return {
      idLinea,
      idOrden: linea.id_orden,
      idMesero: linea.id_mesero,
      producto: linea.producto,
      mesa: linea.mesa,
      inventarioDevuelto: Boolean(linea.enviado_en),
    };
  });
}

/**
 * Solicita la pre-cuenta.  RF-17.
 * FSD 5.5: "orden a estado precuenta, mesa en amarillo, notificacion push al POS."
 */
export async function solicitarPrecuenta({ idOrden, idUsuario, ipOrigen }) {
  return transaccion(async (cx) => {
    const [ordenes] = await cx.execute(
      `SELECT o.id_orden, o.id_mesa, o.estado, m.numero AS mesa
         FROM orden o JOIN mesa m ON m.id_mesa = o.id_mesa
        WHERE o.id_orden = ? FOR UPDATE`,
      [idOrden]
    );
    if (!ordenes.length) throw errores.noEncontrado('La comanda');
    const orden = ordenes[0];

    if (orden.estado === 'precuenta') {
      throw errores.reglaDeNegocio('La pre-cuenta ya fue solicitada.');
    }
    if (['cerrada', 'anulada'].includes(orden.estado)) {
      throw errores.reglaDeNegocio('Esa comanda ya está cerrada.');
    }

    await cx.execute("UPDATE orden SET estado = 'precuenta' WHERE id_orden = ?", [idOrden]);
    await cx.execute("UPDATE mesa SET estado = 'precuenta' WHERE id_mesa = ?", [orden.id_mesa]);

    await auditar(cx, {
      idUsuario,
      accion: 'orden.precuenta',
      entidad: 'orden',
      idEntidad: idOrden,
      detalle: `Pre-cuenta solicitada para la mesa ${orden.mesa}.`,
      ipOrigen,
    });

    return { idOrden, idMesa: orden.id_mesa, mesa: orden.mesa };
  });
}
