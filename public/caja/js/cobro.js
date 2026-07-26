/**
 * Vista 19: Terminal de Cobro y Facturación.  RF-18.
 *
 * FSD 4.4 vista 19:
 *  - desglose del consumo (líneas, subtotal, descuento, impuestos, propina, TOTAL)
 *  - teclado + botones de método de pago
 *  - descuento con motivo del catálogo (con la matriz validada, el cajero no
 *    tiene tope: no se pide PIN por el monto)
 *  - propina sugerida 0/5/10/valor libre
 *  - efectivo: cálculo de cambio en vivo
 *  - pago mixto: se agregan pagos hasta cubrir el total; el cierre se habilita
 *    solo cuando saldo = 0, validado también en servidor (CA-05)
 *
 * IMPORTANTE: los totales que se muestran son los que devuelve el servidor. El
 * cliente NO calcula el total definitivo; solo compone los pagos. El servidor
 * recalcula y rechaza el cierre si no cuadra (FSD 5.7, CA-05).
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearDinero } from '/comun/ui.js';
import { iniciarPos, turnoActivo } from './comun.js';

const params = new URLSearchParams(location.search);
const idOrden = Number(params.get('id'));
if (!idOrden) window.location.href = '/caja/';

// Sub-cuenta de la división (vista 20): solo estas líneas se cobran.
const idsDetalle = (params.get('lineas') || '')
  .split(',').map(Number).filter(Boolean);
const esSubcuenta = idsDetalle.length > 0;

const contexto = await iniciarPos({
  vista: 'cuentas',
  alRefrescar: cargarCuenta,
  // Aquí NO se recarga sola la pantalla. El cajero puede estar tecleando el
  // importe recibido con el cliente delante y la tarjeta en la mano; repintar
  // debajo de sus dedos sería peor que la información desactualizada. Se avisa
  // y él decide cuándo. El total definitivo lo calcula el servidor al cobrar,
  // así que aunque siguiera con la cifra vieja no podría cobrar de menos.
  eventos: {
    'linea.estado': (d) => { if (d.idOrden === idOrden) avisarCuentaCambiada(); },
    'orden.actualizada': (d) => { if (d.idOrden === idOrden) avisarCuentaCambiada(); },
  },
});
if (!contexto) throw new Error('sin sesión');

let yaAvisadoDeCambio = false;
function avisarCuentaCambiada() {
  if (yaAvisadoDeCambio) return;   // una sola vez, no un aluvión de avisos
  yaAvisadoDeCambio = true;
  aviso('La comanda de esta mesa acaba de cambiar. Recargue antes de cobrar para ver el total al día.',
    'alerta', 12000);
}

const $ = (id) => document.getElementById(id);

const estado = {
  cuenta: null,
  motivos: [],
  descuentoCentavos: 0,
  idMotivoDescuento: null,
  propinaCentavos: 0,
  metodoActual: 'efectivo',
  pagos: [],           // { metodo, montoCentavos, recibidoCentavos }
};

/* ---------------------------------------------------------------
   Cálculo local SOLO para mostrar (el definitivo lo da el servidor)
   --------------------------------------------------------------- */
function subtotalC() { return Math.round(Number(estado.cuenta?.subtotal ?? 0) * 100); }
function impuestosC() { return Math.round(Number(estado.cuenta?.impuestos ?? 0) * 100); }
function totalC() {
  return subtotalC() - estado.descuentoCentavos + impuestosC() + estado.propinaCentavos;
}
function pagadoC() { return estado.pagos.reduce((s, p) => s + p.montoCentavos, 0); }
function saldoC() { return totalC() - pagadoC(); }

/* ---------------------------------------------------------------
   Desglose
   --------------------------------------------------------------- */
function pintarConsumo() {
  const c = estado.cuenta;
  reemplazar($('lineas-consumo'), ...c.lineas.map((l) => el('div', { clase: 'desglose-linea' },
    el('span', {}, `${l.cantidad}× ${l.producto}`,
      l.modificadores.length ? el('div', { clase: 'texto-tenue texto-sm', texto: l.modificadores.map((m) => m.nombre).join(', ') }) : null,
      l.notas ? el('div', { clase: 'texto-tenue texto-sm', texto: `📝 ${l.notas}` }) : null),
    el('span', { texto: formatearDinero(l.subtotal) })
  )));

  $('v-subtotal').textContent = formatearDinero(subtotalC() / 100);
  $('v-impuestos').textContent = formatearDinero(impuestosC() / 100);

  if (estado.descuentoCentavos > 0) {
    $('fila-descuento').style.display = 'flex';
    $('v-descuento').textContent = `−${formatearDinero(estado.descuentoCentavos / 100)}`;
  } else $('fila-descuento').style.display = 'none';

  if (estado.propinaCentavos > 0) {
    $('fila-propina').style.display = 'flex';
    $('v-propina').textContent = formatearDinero(estado.propinaCentavos / 100);
  } else $('fila-propina').style.display = 'none';

  $('v-total').textContent = formatearDinero(totalC() / 100);
  pintarSaldo();
}

/* ---------------------------------------------------------------
   Descuento
   --------------------------------------------------------------- */
$('sel-descuento').addEventListener('change', (e) => {
  estado.idMotivoDescuento = e.target.value ? Number(e.target.value) : null;
  $('campo-monto-descuento').classList.toggle('oculto', !estado.idMotivoDescuento);
  if (!estado.idMotivoDescuento) {
    estado.descuentoCentavos = 0;
    $('monto-descuento').value = '';
    pintarConsumo();
  }
});
$('monto-descuento').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d.]/g, '');
  const c = Math.round(Number(e.target.value || 0) * 100);
  // No permitir un descuento mayor que el subtotal (el servidor también lo valida).
  estado.descuentoCentavos = Math.min(c, subtotalC());
  pintarConsumo();
});

/* ---------------------------------------------------------------
   Propina
   --------------------------------------------------------------- */
$('propina-botones').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  [...$('propina-botones').children].forEach((x) => x.classList.remove('propina-btn--activa'));
  b.classList.add('propina-btn--activa');

  if (b.dataset.libre) {
    $('propina-libre').classList.remove('oculto');
    $('propina-libre').focus();
  } else {
    $('propina-libre').classList.add('oculto');
    // La propina se calcula sobre subtotal − descuento (la base del servicio).
    const base = subtotalC() - estado.descuentoCentavos + impuestosC();
    estado.propinaCentavos = Math.round(base * Number(b.dataset.pct) / 100);
    pintarConsumo();
  }
});
$('propina-libre').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d.]/g, '');
  estado.propinaCentavos = Math.round(Number(e.target.value || 0) * 100);
  pintarConsumo();
});

/* ---------------------------------------------------------------
   Teclado del pago
   --------------------------------------------------------------- */
let montoPagoC = 0;
function pintarVisorPago() { $('visor-pago').textContent = formatearDinero(montoPagoC / 100); }

$('teclado-pago').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.d != null) montoPagoC = Math.min(montoPagoC * 10 + Number(b.dataset.d), 9999999999);
  else if (b.dataset.a === '00') montoPagoC = Math.min(montoPagoC * 100, 9999999999);
  else if (b.dataset.a === 'borrar') montoPagoC = Math.floor(montoPagoC / 10);
  pintarVisorPago();
});

$('btn-exacto').addEventListener('click', () => {
  // Rellena con el saldo pendiente exacto.
  montoPagoC = Math.max(0, saldoC());
  pintarVisorPago();
});

$('metodos-pago').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  [...$('metodos-pago').children].forEach((x) => x.classList.remove('metodo-btn--activo'));
  b.classList.add('metodo-btn--activo');
  estado.metodoActual = b.dataset.metodo;
});

$('btn-agregar-pago').addEventListener('click', () => {
  if (montoPagoC <= 0) { aviso('Ingrese el monto del pago.', 'info'); return; }

  const esEfectivo = estado.metodoActual === 'efectivo';
  // En efectivo, el monto aplicado a la cuenta no puede exceder el saldo (el
  // resto es cambio). En tarjeta/transferencia debe ser exacto al saldo o menos.
  const saldo = saldoC();
  let montoAplicado = montoPagoC;
  let recibido = montoPagoC;

  if (esEfectivo && montoPagoC > saldo) {
    // Paga con un billete grande: se aplica el saldo y el resto es cambio.
    montoAplicado = saldo;
    recibido = montoPagoC;
  } else if (!esEfectivo && montoPagoC > saldo) {
    aviso('Un pago con tarjeta o transferencia no puede exceder el saldo.', 'error', 5000);
    return;
  }

  estado.pagos.push({
    metodo: estado.metodoActual,
    montoCentavos: montoAplicado,
    recibidoCentavos: recibido,
  });
  montoPagoC = 0;
  pintarVisorPago();
  pintarPagos();
});

/* ---------------------------------------------------------------
   Pagos aplicados y saldo
   --------------------------------------------------------------- */
const ETIQUETA_METODO = {
  efectivo: 'Efectivo', tarjeta_credito: 'T. Crédito', tarjeta_debito: 'T. Débito',
  transferencia: 'Transferencia', otro: 'Otro',
};

function pintarPagos() {
  reemplazar($('pagos-aplicados'), ...estado.pagos.map((p, i) => el('div', { clase: 'pago-aplicado' },
    el('span', {}, ETIQUETA_METODO[p.metodo]),
    el('span', {},
      el('strong', { texto: formatearDinero(p.montoCentavos / 100) }),
      el('button', {
        clase: 'btn btn--plano btn--sm',
        attrs: { type: 'button', 'aria-label': `Quitar pago ${i + 1}` },
        on: { click: () => { estado.pagos.splice(i, 1); pintarPagos(); } },
      }, '×')
    )
  )));
  pintarSaldo();
}

function pintarSaldo() {
  const saldo = saldoC();
  const saldoEl = $('saldo');
  const btn = $('btn-cerrar');

  if (saldo > 0) {
    saldoEl.className = 'saldo saldo--pendiente';
    saldoEl.textContent = `Falta: ${formatearDinero(saldo / 100)}`;
    btn.disabled = true;
    $('cambio-info').textContent = '';
  } else if (saldo === 0) {
    saldoEl.className = 'saldo saldo--completo';
    saldoEl.textContent = '✓ Saldo cubierto';
    btn.disabled = false;
    // Cambio a devolver (si hubo efectivo de más).
    const recibidoC = estado.pagos.reduce((s, p) => s + p.recibidoCentavos, 0);
    const cambio = recibidoC - totalC();
    reemplazar($('cambio-info'), cambio > 0
      ? el('div', { clase: 'saldo saldo--pendiente', texto: `Cambio a devolver: ${formatearDinero(cambio / 100)}` })
      : null);
  } else {
    // saldo < 0 solo pasa con tarjeta; se evita al agregar, pero por si acaso.
    saldoEl.className = 'saldo saldo--exceso';
    saldoEl.textContent = `Sobra: ${formatearDinero(-saldo / 100)}`;
    btn.disabled = true;
  }
}

/* ---------------------------------------------------------------
   Cierre (CA-05: el servidor revalida que los pagos igualen el total)
   --------------------------------------------------------------- */
$('btn-cerrar').addEventListener('click', async () => {
  const btn = $('btn-cerrar');
  btn.disabled = true;
  btn.textContent = 'Procesando…';

  try {
    const r = await api.post(`/caja/cuentas/${idOrden}/cobrar`, {
      pagos: estado.pagos.map((p) => ({
        metodo: p.metodo,
        monto: (p.montoCentavos / 100).toFixed(2),
        recibido: (p.recibidoCentavos / 100).toFixed(2),
      })),
      propina: (estado.propinaCentavos / 100).toFixed(2),
      descuento: (estado.descuentoCentavos / 100).toFixed(2),
      idMotivoDescuento: estado.idMotivoDescuento,
      // Si es una sub-cuenta de la división, se cobran solo esas líneas (CA-06).
      idsDetalle: esSubcuenta ? idsDetalle : undefined,
    });
    mostrarFactura(r);
  } catch (error) {
    // CA-05: si el servidor rechaza porque no cuadra, se muestra su mensaje.
    aviso(error.message, 'error', 8000);
    btn.disabled = false;
    btn.textContent = 'Imprimir factura y cerrar mesa';
  }
});

function mostrarFactura(r) {
  reemplazar($('cuerpo-factura'),
    el('div', { clase: 'desglose-total', attrs: { style: 'justify-content:center;border:none' },
      texto: r.consecutivo }),
    el('div', { clase: 'desglose-sub' }, el('span', {}, 'Subtotal'), el('span', { texto: formatearDinero(r.subtotal) })),
    Number(r.descuento) > 0 ? el('div', { clase: 'desglose-sub' }, el('span', {}, 'Descuento'), el('span', { texto: `−${formatearDinero(r.descuento)}` })) : null,
    el('div', { clase: 'desglose-sub' }, el('span', {}, 'Impuestos'), el('span', { texto: formatearDinero(r.impuestos) })),
    Number(r.propina) > 0 ? el('div', { clase: 'desglose-sub' }, el('span', {}, 'Propina'), el('span', { texto: formatearDinero(r.propina) })) : null,
    el('div', { clase: 'desglose-linea', attrs: { style: 'font-weight:800;font-size:1.2rem;margin-top:.5rem' } },
      el('span', {}, 'Total'), el('span', { texto: formatearDinero(r.total) })),
    Number(r.cambio) > 0
      ? el('div', { clase: 'saldo saldo--pendiente', attrs: { style: 'margin-top:.75rem' }, texto: `Cambio: ${formatearDinero(r.cambio)}` })
      : null,
    el('p', { clase: 'texto-tenue texto-sm', attrs: { style: 'margin-top:.75rem' } },
      r.mesaLiberada ? 'Mesa liberada. Factura enviada a impresión.' : 'Cobro parcial registrado.')
  );
  $('modal-factura').showModal();
}

$('btn-cerrar-factura').addEventListener('click', () => { window.location.href = '/caja/'; });
$('btn-volver').addEventListener('click', () => { window.location.href = '/caja/'; });
$('enlace-dividir').href = `/caja/dividir.html?id=${idOrden}`;

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarCuenta() {
  try {
    if (!turnoActivo) {
      aviso('Abra un turno de caja antes de cobrar.', 'error', 6000);
      setTimeout(() => { window.location.href = '/caja/turno.html'; }, 1500);
      return;
    }

    // Si es sub-cuenta, se pide el desglose solo de esas líneas.
    const rutaCuenta = esSubcuenta
      ? `/caja/cuentas/${idOrden}?lineas=${idsDetalle.join(',')}`
      : `/caja/cuentas/${idOrden}`;

    const [cuenta, motivos] = await Promise.all([
      api.get(rutaCuenta),
      api.get('/caja/motivos-descuento'),
    ]);
    estado.cuenta = cuenta;
    estado.motivos = motivos.motivos;

    $('titulo-cobro').textContent = `Mesa ${cuenta.mesa} · ${cuenta.mesero}` +
      (esSubcuenta ? ' · sub-cuenta' : '');

    reemplazar($('sel-descuento'),
      el('option', { attrs: { value: '' }, texto: 'Sin descuento' }),
      ...estado.motivos.map((m) => el('option', { attrs: { value: String(m.id) }, texto: m.nombre }))
    );

    pintarConsumo();
    pintarPagos();
  } catch (error) {
    if (error.estado === 404) {
      aviso('Esa cuenta ya no está disponible.', 'error');
      setTimeout(() => { window.location.href = '/caja/'; }, 1500);
    } else {
      aviso(error.message, 'error');
    }
  }
}

await cargarCuenta();
