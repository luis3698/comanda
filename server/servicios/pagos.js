/**
 * Pago de los domicilios con comprobante verificado a mano.
 *
 * El cliente transfiere por su cuenta a la llave que publica el restaurante
 * (Nequi, Bancolombia, DaviPlata), fotografia el comprobante y lo sube. Caja
 * lo mira y decide. No hay pasarela de pago: ver el porque en db/06_pagos.sql.
 *
 * LA REGLA QUE SOSTIENE TODO
 * Un pedido cuyo pago no este verificado NO se puede aceptar. Se comprueba en
 * `servicios/domicilios.js` antes de abrir la comanda, que es el unico sitio
 * por donde un pedido entra en cocina. Contra entrega queda exento: no hay
 * pago por adelantado que mirar.
 *
 * ESTADOS DEL PAGO
 *
 *   no_requerido ─────────────────────────────────> (contra entrega, listo)
 *
 *   pendiente ──sube comprobante──> por_verificar ──verifica──> verificado
 *       ^                                │
 *       └──────────rechaza───────────────┘
 *
 * El rechazo devuelve a `pendiente` y no a un estado final: el cliente casi
 * siempre se equivoco de captura, y obligarle a rehacer el pedido entero
 * seria absurdo. Puede subir otro comprobante.
 */
import { consultar, consultarUno, pool, transaccion } from '../db.js';
import { errores } from '../middleware/errores.js';
import { borrarImagen } from './imagenes.js';
import { auditar } from './auditoria.js';
import { notificar } from './push.js';

/** Estados desde los que un pedido SI se puede aceptar. */
export const PAGOS_ACEPTABLES = ['no_requerido', 'verificado'];

/** Forma con la que se devuelve un metodo de pago. */
function comoDto(m, { conLlave }) {
  return {
    codigo: m.codigo,
    nombre: m.nombre,
    requiereComprobante: Boolean(m.requiere_comprobante),
    activo: Boolean(m.activo),
    ordenVisual: m.orden_visual,
    // Los datos de la cuenta solo se envian cuando quien pregunta los
    // necesita para transferir. El listado del backoffice los trae siempre.
    ...(conLlave
      ? { llave: m.llave, titular: m.titular, tipoCuenta: m.tipo_cuenta, banco: m.banco }
      : {}),
  };
}

/**
 * Metodos que el cliente puede elegir en la aplicacion.
 *
 * Solo los ACTIVOS, y con sus datos de cuenta: son justo lo que el cliente
 * necesita para transferir. No es informacion sensible -- es la cuenta que el
 * restaurante publica a proposito para cobrar -- pero el endpoint exige sesion
 * de cliente igualmente, para no dejarla a merced de cualquier robot.
 */
export async function metodosParaCliente() {
  const filas = await consultar(
    `SELECT * FROM metodo_pago_app WHERE activo = TRUE ORDER BY orden_visual, nombre`
  );
  return filas.map((m) => comoDto(m, { conLlave: true }));
}

/** Todos los metodos, activos o no, para la pantalla de configuracion. */
export async function metodosParaAdmin() {
  const filas = await consultar(
    'SELECT * FROM metodo_pago_app ORDER BY orden_visual, nombre'
  );
  return filas.map((m) => comoDto(m, { conLlave: true }));
}

/**
 * Guarda la configuracion de un metodo.
 *
 * NO DEJA ACTIVAR UN METODO SIN LLAVE. Publicar "Nequi" sin numero manda al
 * cliente a transferir al vacio: veria la opcion, la elegiria, y se quedaria
 * mirando una pantalla sin ningun dato al que pagar.
 */
export async function guardarMetodo(codigo, datos, { idUsuario, ipOrigen } = {}) {
  const metodo = await consultarUno(
    'SELECT * FROM metodo_pago_app WHERE codigo = ?', [codigo]
  );
  if (!metodo) throw errores.noEncontrado('El metodo de pago');

  const activo = datos.activo === true || datos.activo === 'true';
  const llave = String(datos.llave ?? '').trim();
  const titular = String(datos.titular ?? '').trim();

  if (metodo.requiere_comprobante && activo) {
    const fallos = {};
    if (!llave) fallos.llave = 'Indique el numero o la llave a la que transfiere el cliente.';
    if (!titular) fallos.titular = 'Indique a nombre de quien esta la cuenta.';
    if (Object.keys(fallos).length) {
      throw errores.peticionInvalida(
        `No se puede activar ${metodo.nombre} sin sus datos de cuenta: el cliente veria ` +
        'la opcion y no sabria a donde pagar.',
        { campos: fallos }
      );
    }
  }

  await pool.execute(
    `UPDATE metodo_pago_app
        SET llave = ?, titular = ?, tipo_cuenta = ?, banco = ?, activo = ?
      WHERE codigo = ?`,
    [
      llave || null,
      titular || null,
      datos.tipoCuenta ? String(datos.tipoCuenta).trim().slice(0, 30) : null,
      datos.banco ? String(datos.banco).trim().slice(0, 60) : null,
      activo ? 1 : 0,
      codigo,
    ]
  );

  // Se audita porque cambiar la cuenta a la que cobran los clientes es la
  // accion mas delicada de toda la configuracion: quien la altere estaria
  // desviando el dinero de los pedidos.
  await auditar(null, {
    idUsuario,
    accion: 'config.metodo_pago',
    entidad: 'metodo_pago_app',
    detalle: `Metodo ${metodo.nombre}: ${activo ? 'ACTIVADO' : 'desactivado'}` +
             (llave ? `, llave ${llave}` : '') + (titular ? `, titular ${titular}` : '') + '.',
    ipOrigen,
  });

  const fila = await consultarUno('SELECT * FROM metodo_pago_app WHERE codigo = ?', [codigo]);
  return comoDto(fila, { conLlave: true });
}

/**
 * Estado de pago inicial de un pedido, segun su metodo.
 * Devuelve tambien el metodo validado, para que el pedido no pueda guardar
 * un codigo inventado ni uno que el administrador tiene desactivado.
 */
export async function estadoInicial(codigoMetodo) {
  const metodo = await consultarUno(
    'SELECT * FROM metodo_pago_app WHERE codigo = ? AND activo = TRUE',
    [codigoMetodo]
  );
  if (!metodo) {
    throw errores.peticionInvalida(
      'Ese metodo de pago no esta disponible. Elija otro.',
      { campos: { metodoPago: 'Metodo no disponible.' } }
    );
  }

  return {
    metodo,
    estadoPago: metodo.requiere_comprobante ? 'pendiente' : 'no_requerido',
  };
}

/**
 * El cliente sube el comprobante de su pago.
 *
 * El filtro por id_cliente es la autorizacion: sin el, cualquiera podria
 * adjuntar un comprobante al pedido de otro cambiando el id de la URL.
 */
export async function subirComprobante(idCliente, idPedido, rutaPublica) {
  const pedido = await consultarUno(
    `SELECT id_pedido, codigo, estado, estado_pago, url_comprobante
       FROM pedido_domicilio WHERE id_pedido = ? AND id_cliente = ?`,
    [idPedido, idCliente]
  );
  if (!pedido) throw errores.noEncontrado('El pedido');

  if (pedido.estado_pago === 'no_requerido') {
    throw errores.reglaDeNegocio(
      'Este pedido es contra entrega: se paga al recibirlo, no hace falta comprobante.'
    );
  }
  if (pedido.estado_pago === 'verificado') {
    throw errores.reglaDeNegocio('Su pago ya fue verificado. No hace falta subir nada mas.');
  }
  if (['rechazado', 'cancelado'].includes(pedido.estado)) {
    throw errores.reglaDeNegocio('Ese pedido ya no esta activo.');
  }

  const anterior = pedido.url_comprobante;

  await pool.execute(
    `UPDATE pedido_domicilio
        SET url_comprobante = ?, comprobante_en = NOW(), estado_pago = 'por_verificar',
            motivo_pago = NULL
      WHERE id_pedido = ?`,
    [rutaPublica, idPedido]
  );

  // Si estaba reemplazando uno rechazado, el viejo se borra del disco DESPUES
  // de que el nuevo este guardado: un fallo aqui deja un archivo huerfano, que
  // es mucho mejor que quedarse sin comprobante.
  if (anterior && anterior !== rutaPublica) {
    await borrarImagen(anterior).catch(() => {});
  }

  return { codigo: pedido.codigo, estadoPago: 'por_verificar' };
}

/**
 * Caja verifica o rechaza el comprobante.
 *
 * @param {'verificado'|'rechazado'} decision
 */
export async function decidirPago(idPedido, decision, { idUsuario, motivo, ipOrigen } = {}) {
  if (!['verificado', 'rechazado'].includes(decision)) {
    throw errores.peticionInvalida('Decision de pago no valida.');
  }

  const resultado = await transaccion(async (cx) => {
    const [filas] = await cx.execute(
      `SELECT id_pedido, codigo, id_cliente, estado_pago, total
         FROM pedido_domicilio WHERE id_pedido = ? FOR UPDATE`,
      [idPedido]
    );
    if (!filas.length) throw errores.noEncontrado('El pedido');
    const pedido = filas[0];

    if (pedido.estado_pago === 'no_requerido') {
      throw errores.reglaDeNegocio(
        'Ese pedido es contra entrega: no hay pago por adelantado que verificar.'
      );
    }
    if (pedido.estado_pago === 'pendiente') {
      throw errores.reglaDeNegocio(
        'El cliente todavia no ha subido el comprobante. No hay nada que mirar.'
      );
    }
    if (pedido.estado_pago === 'verificado' && decision === 'verificado') {
      throw errores.reglaDeNegocio('Ese pago ya estaba verificado.');
    }

    if (decision === 'rechazado' && !String(motivo ?? '').trim()) {
      throw errores.peticionInvalida(
        'Explique por que se rechaza el comprobante: el cliente lo va a leer para corregirlo.',
        { campos: { motivo: 'Indique el motivo.' } }
      );
    }

    // Rechazar devuelve a 'pendiente', no a un estado final: el cliente casi
    // siempre se equivoco de captura y puede subir otra.
    const nuevo = decision === 'verificado' ? 'verificado' : 'pendiente';

    await cx.execute(
      `UPDATE pedido_domicilio
          SET estado_pago = ?, id_usuario_pago = ?, verificado_en = NOW(),
              motivo_pago = ?
        WHERE id_pedido = ?`,
      [nuevo, idUsuario, motivo ? String(motivo).slice(0, 255) : null, idPedido]
    );

    await auditar(cx, {
      idUsuario,
      accion: `domicilio.pago.${decision}`,
      entidad: 'pedido_domicilio',
      idEntidad: idPedido,
      detalle: `Pago del pedido ${pedido.codigo} (${pedido.total}) ${decision}` +
               (motivo ? `. Motivo: ${motivo}` : '.'),
      ipOrigen,
    });

    return { pedido, nuevo };
  });

  // El aviso va despues del commit: si la transaccion fallara, el cliente no
  // puede haber recibido la noticia de algo que no ocurrio.
  const { pedido } = resultado;
  const aviso = decision === 'verificado'
    ? {
        titulo: 'Pago confirmado',
        cuerpo: `Confirmamos su pago del pedido ${pedido.codigo}. Ya lo estamos preparando.`,
      }
    : {
        titulo: 'Problema con su comprobante',
        cuerpo: `No pudimos confirmar el pago del pedido ${pedido.codigo}. ${motivo ?? ''} ` +
                'Suba otro comprobante desde la aplicacion.',
      };

  await notificar(pedido.id_cliente, { tipo: 'pedido', referencia: pedido.codigo, ...aviso })
    .catch((e) => console.error('[pagos] no se pudo notificar:', e.message));

  return { estadoPago: resultado.nuevo, codigo: pedido.codigo };
}

/** Cuantos comprobantes esperan revision. Alimenta el globo de Caja. */
export async function contarPorVerificar() {
  const fila = await consultarUno(
    "SELECT COUNT(*) AS n FROM pedido_domicilio WHERE estado_pago = 'por_verificar'"
  );
  return Number(fila.n);
}
