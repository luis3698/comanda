/**
 * Pedidos a domicilio en el POS del cajero.
 *
 * ACEPTAR ES LA ACCIÓN IMPORTANTE de esta pantalla, y no es un simple cambio
 * de estado: el servidor crea una comanda real sobre una posición virtual de
 * domicilio (D1…D30) y la manda a cocina. A partir de ahí el pedido recorre el
 * mismo camino que una mesa —KDS, tiempos de salida, cobro— sin ninguna lógica
 * paralela. Todo eso vive en `server/servicios/domicilios.js`; aquí solo se
 * pulsa el botón y se enseña el resultado.
 *
 * Por eso el botón dice qué va a pasar de verdad ("Aceptar y enviar a cocina")
 * en vez de un "Aceptar" a secas: la acción descuenta inventario y pone a
 * cocinar, y quien la pulsa tiene que saberlo.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearFecha, formatearDinero, campana } from '/comun/ui.js';
import { iniciarPos } from './comun.js';

const contexto = await iniciarPos({
  vista: 'domicilios',
  alRefrescar: cargar,
  eventos: {
    'domicilio.creado': (d) => {
      aviso(
        `Pedido nuevo ${d.codigo} · ${d.cliente} · ${formatearDinero(d.total)} · ${d.direccion}`,
        'info', 12000
      );
      campana();
      cargar();
    },
    'domicilio.actualizado': cargar,
  },
});
if (!contexto) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);
const puedeGestionar = contexto.sesion.permisos.includes('domicilios.gestionar');
const puedeVerificarPago = contexto.sesion.permisos.includes('domicilios.verificar_pago');

const estado = { pedidos: [], filtro: 'vivos', seleccionado: null };

/** Icono + texto para cada estado: nunca solo color. */
const ESTADOS = {
  pendiente:      { icono: '⏳', texto: 'Sin aceptar',    clase: 'insignia--alerta' },
  aceptado:       { icono: '✓',  texto: 'Aceptado',       clase: 'insignia--info' },
  en_preparacion: { icono: '🍳', texto: 'En preparación', clase: 'insignia--info' },
  en_camino:      { icono: '🛵', texto: 'En camino',      clase: 'insignia--info' },
  entregado:      { icono: '★',  texto: 'Entregado',      clase: 'insignia--exito' },
  rechazado:      { icono: '✕',  texto: 'Rechazado',      clase: 'insignia--error' },
  cancelado:      { icono: '⊘',  texto: 'Cancelado',      clase: 'insignia--neutra' },
};

/** Siguiente paso del reparto, con el texto que ve el cajero. */
const SIGUIENTE = {
  aceptado:       { estado: 'en_preparacion', texto: '🍳 En preparación' },
  en_preparacion: { estado: 'en_camino',      texto: '🛵 Salió a repartir' },
  en_camino:      { estado: 'entregado',      texto: '★ Entregado' },
};

/**
 * Estado del PAGO. Es un eje distinto del estado del pedido: uno puede estar
 * «en camino» con el pago verificado, o «pendiente» con el pago rechazado.
 * Cada uno lleva icono y texto, nunca solo color.
 */
const PAGOS = {
  no_requerido:  { icono: '💵', texto: 'Paga al recibir',      clase: 'insignia--neutra' },
  pendiente:     { icono: '⏳', texto: 'Sin comprobante',      clase: 'insignia--alerta' },
  por_verificar: { icono: '🧾', texto: 'Comprobante por revisar', clase: 'insignia--info' },
  verificado:    { icono: '✓',  texto: 'Pago confirmado',      clase: 'insignia--exito' },
  rechazado:     { icono: '✕',  texto: 'Comprobante rechazado', clase: 'insignia--error' },
};

/* =====================================================================
   Filtros
   ===================================================================== */

const FILTROS = { vivos: 'vivos', pendiente: 'pendiente', todos: '' };
for (const clave of Object.keys(FILTROS)) {
  $(`f-${clave}`).addEventListener('click', () => {
    estado.filtro = clave;
    for (const otro of Object.keys(FILTROS)) {
      const activo = otro === clave;
      $(`f-${otro}`).classList.toggle('filtro-estado--activo', activo);
      $(`f-${otro}`).setAttribute('aria-selected', String(activo));
    }
    cargar();
  });
}

/* =====================================================================
   Pintado
   ===================================================================== */

function tarjeta(p) {
  const est = ESTADOS[p.estado] ?? { icono: '?', texto: p.estado, clase: 'insignia--neutra' };

  return el('article', {
    clase: `canal-tarjeta ${p.estado === 'pendiente' ? 'canal-tarjeta--urgente' : ''}`,
  },
    el('div', { clase: 'canal-tarjeta__cab' },
      el('span', { clase: 'canal-tarjeta__codigo mono', texto: p.codigo }),
      el('span', { clase: `insignia ${est.clase}` }, `${est.icono} ${est.texto}`),
      // El pago es un eje aparte: se ve de un vistazo si el pedido está
      // frenado por dinero o por cocina.
      (() => {
        const pg = PAGOS[p.estadoPago] ?? PAGOS.no_requerido;
        return el('span', { clase: `insignia ${pg.clase}` }, `${pg.icono} ${pg.texto}`);
      })(),
      // La posición virtual se enseña en cuanto existe: es lo que cocina ve en
      // el KDS, y es por donde el cajero encuentra la cuenta para cobrarla.
      p.mesa ? el('span', { clase: 'insignia insignia--neutra' }, `📍 ${p.mesa}`) : null,
      el('span', { clase: 'crece' }),
      el('span', { clase: 'canal-tarjeta__cuando', texto: formatearFecha(p.creadoEn) })
    ),

    el('div', { clase: 'canal-tarjeta__cuerpo' },
      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Cliente' }),
        el('strong', { texto: p.cliente })
      ),
      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Teléfono' }),
        el('a', { clase: 'mono', attrs: { href: `tel:${p.telefono}` }, texto: p.telefono })
      ),
      el('div', { clase: 'canal-tarjeta__direccion' },
        el('span', { attrs: { 'aria-hidden': 'true' } }, '📍'),
        el('div', {},
          el('div', { texto: p.direccion }),
          p.referencia ? el('div', { clase: 'texto-sm texto-tenue', texto: p.referencia }) : null,
          el('div', { clase: 'texto-sm texto-tenue',
                      texto: `${p.zonaEntrega ?? 'Sin zona'} · entrega en ~${p.tiempoEstimadoMin ?? '?'} min` })
        )
      ),

      // Las líneas: es lo que el cajero necesita leer para decidir si acepta.
      el('ul', { clase: 'canal-lineas' }, ...p.lineas.map((l) => el('li', {},
        el('span', { clase: 'mono canal-lineas__cant', texto: `${l.cantidad}×` }),
        el('span', { clase: 'crece' },
          l.producto,
          l.modificadores.length
            ? el('span', { clase: 'texto-sm texto-tenue',
                           texto: ` » ${l.modificadores.map((m) => m.nombre).join(', ')}` })
            : null,
          l.notas
            ? el('div', { clase: 'canal-lineas__nota' },
                el('span', { attrs: { 'aria-hidden': 'true' } }, '⚠'),
                el('span', { texto: l.notas }))
            : null
        ),
        el('span', { clase: 'mono', texto: formatearDinero(l.precioUnitario) })
      ))),

      el('dl', { clase: 'canal-totales' },
        el('dt', { texto: 'Subtotal' }),  el('dd', { clase: 'mono', texto: formatearDinero(p.subtotal) }),
        el('dt', { texto: 'Impuestos' }), el('dd', { clase: 'mono', texto: formatearDinero(p.impuestos) }),
        el('dt', { texto: 'Envío' }),     el('dd', { clase: 'mono', texto: formatearDinero(p.costoEnvio) }),
        el('dt', { clase: 'canal-totales__total', texto: 'Total' }),
        el('dd', { clase: 'mono canal-totales__total', texto: formatearDinero(p.total) })
      ),

      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Pago' }),
        el('span', {}, p.metodoNombre ?? p.metodoPago)
      ),

      // El comprobante: miniatura que abre la imagen a tamaño completo. Es lo
      // que el cajero tiene que mirar antes de dejar entrar el pedido a cocina.
      p.urlComprobante
        ? el('button', {
            clase: 'comprobante-mini',
            attrs: { type: 'button', title: 'Ver el comprobante a tamaño completo' },
            on: { click: () => abrirComprobante(p) },
          },
            el('img', { attrs: { src: p.urlComprobante, alt: '' } }),
            el('span', {},
              el('strong', { texto: 'Ver comprobante' }),
              el('div', { clase: 'texto-sm texto-tenue',
                          texto: `Enviado ${formatearFecha(p.comprobanteEn)}` })
            )
          )
        : null,

      // Por qué está frenado y qué hace falta. Sin esto, el cajero ve el botón
      // de aceptar deshabilitado y no sabe a qué esperar.
      p.estadoPago === 'pendiente'
        ? el('div', { clase: 'canal-tarjeta__notas' },
            el('span', { attrs: { 'aria-hidden': 'true' } }, '⏳'),
            el('span', { texto: 'Esperando a que el cliente suba el comprobante de pago. ' +
                                'No se puede aceptar hasta entonces.' }))
        : null,
      p.motivoPago && p.estadoPago !== 'verificado'
        ? el('p', { clase: 'texto-sm texto-tenue', texto: `Comprobante rechazado: ${p.motivoPago}` })
        : null,
      p.estadoPago === 'verificado' && p.verificadoPor
        ? el('p', { clase: 'texto-sm texto-tenue',
                    texto: `Pago verificado por ${p.verificadoPor} el ${formatearFecha(p.verificadoEn)}.` })
        : null,

      // El cambio, calculado por el servidor: el repartidor tiene que llevarlo
      // encima, y sacar la cuenta en la puerta es como se pierde dinero.
      p.metodoPago === 'contra_entrega' && p.pagaCon
        ? el('div', { clase: 'canal-tarjeta__cambio' },
            `Paga con ${formatearDinero(p.pagaCon)} · llevar cambio de ` +
            `${formatearDinero(Number(p.pagaCon) - Number(p.total))}`)
        : null,

      p.notas
        ? el('div', { clase: 'canal-tarjeta__notas' },
            el('span', { attrs: { 'aria-hidden': 'true' } }, '💬'),
            el('span', { texto: p.notas }))
        : null,
      p.motivoGestion
        ? el('p', { clase: 'texto-sm texto-tenue', texto: `Motivo: ${p.motivoGestion}` })
        : null
    ),

    puedeGestionar ? acciones(p) : null
  );
}

/** Estados de pago desde los que SÍ se puede aceptar. Igual que en el servidor. */
const PAGO_LISTO = ['no_requerido', 'verificado'];

function acciones(p) {
  const botones = [];

  // Revisar el comprobante va PRIMERO cuando hay uno esperando: es lo que
  // desbloquea todo lo demás.
  if (p.estadoPago === 'por_verificar' && puedeVerificarPago) {
    botones.push(el('button', {
      clase: 'btn btn--primario',
      attrs: { type: 'button' },
      on: { click: () => abrirComprobante(p) },
    }, '🧾 Revisar el pago'));
  }

  if (p.estado === 'pendiente') {
    const pagoListo = PAGO_LISTO.includes(p.estadoPago);
    botones.push(el('button', {
      clase: 'btn btn--primario',
      // Deshabilitado, no escondido: el cajero tiene que ver que la acción
      // existe y que está esperando al pago. El servidor lo rechaza igual
      // aunque alguien fuerce el clic (FSD 6.1, doble capa).
      attrs: { type: 'button', disabled: !pagoListo || false,
               title: pagoListo ? false : 'El pago de este pedido todavía no está confirmado' },
      on: { click: (e) => aceptar(p, e.currentTarget) },
    }, pagoListo ? '✓ Aceptar y enviar a cocina' : '🔒 Esperando el pago'));
    botones.push(el('button', {
      clase: 'btn btn--peligro',
      attrs: { type: 'button' },
      on: { click: () => abrirRechazar(p) },
    }, '✕ Rechazar'));
  }

  const siguiente = SIGUIENTE[p.estado];
  if (siguiente) {
    botones.push(el('button', {
      clase: 'btn btn--primario',
      attrs: { type: 'button' },
      on: { click: () => avanzar(p, siguiente.estado) },
    }, siguiente.texto));
  }

  // La comanda existe: se puede saltar directo a cobrarla.
  if (p.idOrden && ['aceptado', 'en_preparacion', 'en_camino'].includes(p.estado)) {
    botones.push(el('a', {
      clase: 'btn btn--secundario',
      attrs: { href: `/caja/cobro.html?id=${p.idOrden}` },
    }, '🧾 Cobrar'));
  }

  if (!botones.length) return null;
  return el('div', { clase: 'canal-tarjeta__acciones' }, ...botones);
}

function pintar() {
  const n = estado.pedidos.length;
  $('conteo-pedidos').textContent = n === 1 ? '1 pedido' : `${n} pedidos`;

  if (!n) {
    reemplazar($('lista-pedidos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay pedidos que mostrar.' }),
      el('p', { clase: 'texto-sm texto-tenue',
                texto: 'Los pedidos que hagan los clientes desde la aplicación aparecerán aquí solos.' })
    ));
    return;
  }

  reemplazar($('lista-pedidos'), ...estado.pedidos.map(tarjeta));
}

/* =====================================================================
   Acciones
   ===================================================================== */

/**
 * Aceptar descuenta inventario y pone a cocinar, así que se confirma antes.
 * El botón queda deshabilitado mientras dura: la operación abre una comanda y
 * un doble clic intentaría abrir dos.
 */
async function aceptar(pedido, boton) {
  const ok = await confirmar({
    titulo: `Aceptar el pedido ${pedido.codigo}`,
    mensaje: `Se abrirá una comanda y las ${pedido.lineas.length} línea(s) entrarán en cocina. ` +
             'Se descuenta el inventario según las recetas. El cliente recibirá el aviso.',
    textoConfirmar: 'Aceptar y enviar',
  });
  if (!ok) return;

  boton.disabled = true;
  boton.textContent = 'Enviando a cocina…';

  try {
    const r = await api.post(`/domicilios/${pedido.id}/aceptar`);
    aviso(`Pedido ${r.pedido.codigo} aceptado. Comanda abierta en la posición ${r.pedido.mesa}.`,
      'exito', 8000);
    await cargar();
  } catch (error) {
    // Los dos fallos previsibles —sin posiciones libres y sin inventario—
    // llegan como regla de negocio con su explicación; el servicio ya deshizo
    // la comanda, así que no queda nada a medias.
    aviso(error.message, 'error', 10000);
    boton.disabled = false;
    boton.textContent = '✓ Aceptar y enviar a cocina';
  }
}

async function avanzar(pedido, destino) {
  try {
    await api.post(`/domicilios/${pedido.id}/estado`, { estado: destino });
    aviso('Pedido actualizado. El cliente recibió el aviso.', 'exito', 5000);
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

/* =====================================================================
   Comprobante de pago
   ===================================================================== */

function abrirComprobante(pedido) {
  estado.seleccionado = pedido;
  $('resumen-comprobante').textContent =
    `${pedido.codigo} · ${pedido.cliente} · ${pedido.metodoNombre} · ${formatearDinero(pedido.total)}`;
  $('img-comprobante').src = pedido.urlComprobante ?? '';

  // Los botones de decidir solo tienen sentido con un comprobante sin
  // resolver: uno ya verificado se puede volver a mirar, pero no re-verificar.
  const pendiente = pedido.estadoPago === 'por_verificar' && puedeVerificarPago;
  $('btn-verificar-pago').classList.toggle('oculto', !pendiente);
  $('btn-rechazar-pago').classList.toggle('oculto', !pendiente);

  $('modal-comprobante').showModal();
}

$('btn-cerrar-comprobante').addEventListener('click', () => $('modal-comprobante').close());

$('btn-verificar-pago').addEventListener('click', async () => {
  const p = estado.seleccionado;
  const ok = await confirmar({
    titulo: 'Confirmar el pago',
    mensaje: `¿El comprobante corresponde a ${formatearDinero(p.total)} del pedido ${p.codigo}? ` +
             'Al confirmarlo, el pedido queda listo para enviarse a cocina.',
    textoConfirmar: 'Sí, el pago está bien',
  });
  if (!ok) return;

  try {
    await api.post(`/domicilios/${p.id}/pago/verificar`);
    aviso(`Pago del pedido ${p.codigo} confirmado. Ya se puede aceptar.`, 'exito', 7000);
    $('modal-comprobante').close();
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 8000);
  }
});

$('btn-rechazar-pago').addEventListener('click', () => {
  $('modal-comprobante').close();
  $('e-p-motivo').textContent = '';
  $('p-motivo').value = '';
  $('resumen-rechazar-pago').textContent =
    `${estado.seleccionado.codigo} · ${formatearDinero(estado.seleccionado.total)}`;
  $('modal-rechazar-pago').showModal();
  $('p-motivo').focus();
});

$('btn-cerrar-rechazar-pago').addEventListener('click', () => $('modal-rechazar-pago').close());

$('form-rechazar-pago').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  $('e-p-motivo').textContent = '';

  const motivo = $('p-motivo').value.trim();
  if (!motivo) {
    $('e-p-motivo').textContent = 'Escriba qué pasa con el comprobante: el cliente lo va a leer.';
    return;
  }

  try {
    await api.post(`/domicilios/${estado.seleccionado.id}/pago/rechazar`, { motivo });
    aviso('Comprobante rechazado. El cliente puede subir otro; el pedido sigue vivo.',
      'exito', 8000);
    $('modal-rechazar-pago').close();
    await cargar();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos?.motivo) {
      $('e-p-motivo').textContent = error.campos.motivo;
    } else {
      $('e-p-motivo').textContent = error.message;
    }
  }
});

/* =====================================================================
   Rechazo del pedido
   ===================================================================== */

function abrirRechazar(pedido) {
  estado.seleccionado = pedido;
  $('e-d-motivo').textContent = '';
  $('d-motivo').value = '';
  $('resumen-rechazar').textContent =
    `${pedido.codigo} · ${pedido.cliente} · ${formatearDinero(pedido.total)}`;
  $('modal-rechazar').showModal();
  $('d-motivo').focus();
}

$('btn-cerrar-rechazar').addEventListener('click', () => $('modal-rechazar').close());

$('form-rechazar').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  $('e-d-motivo').textContent = '';

  const motivo = $('d-motivo').value.trim();
  if (!motivo) {
    $('e-d-motivo').textContent = 'Escriba el motivo: el cliente lo va a leer.';
    return;
  }

  try {
    await api.post(`/domicilios/${estado.seleccionado.id}/rechazar`, { motivo });
    aviso('Pedido rechazado. El cliente recibió el aviso.', 'exito', 6000);
    $('modal-rechazar').close();
    await cargar();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos?.motivo) {
      $('e-d-motivo').textContent = error.campos.motivo;
    } else {
      $('e-d-motivo').textContent = error.message;
    }
  }
});

/* =====================================================================
   Carga
   ===================================================================== */

async function cargar() {
  try {
    const filtro = FILTROS[estado.filtro];
    const r = await api.get(`/domicilios${filtro ? `?estado=${filtro}` : ''}`);
    estado.pedidos = r.pedidos;
    pintar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

await cargar();
