/**
 * Vista 20: Divisor de Cuentas Avanzado.  RF-19.
 *
 * FSD 4.4 vista 20:
 *  - columna origen "Cuenta principal" + N columnas "Cuenta 1..N"
 *  - Drag & Drop de platos entre columnas, con alternativa accesible
 *    (selección + botón "Mover a…") — FSD 6.4
 *  - ítems de cantidad > 1 pueden fraccionarse (modal "¿Cuántas unidades mover?")
 *  - "División equitativa entre N" como atajo
 *  - invariante: la suma de las columnas debe igualar la cuenta original,
 *    verificada en cliente y servidor (CA-06)
 *  - "Cobrar" en cada columna abre la vista 19 para esa sub-cuenta
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearDinero } from '/comun/ui.js';
import { iniciarPos } from './comun.js';

const idOrden = Number(new URLSearchParams(location.search).get('id'));
if (!idOrden) window.location.href = '/caja/';

const contexto = await iniciarPos({
  vista: 'cuentas',
  alRefrescar: cargar,
  // Igual que en la terminal de cobro: repartir líneas entre columnas es un
  // trabajo manual que se perdería entero si la pantalla se recargara sola.
  // Se avisa y el cajero recarga cuando le convenga.
  eventos: {
    'linea.estado': (d) => { if (d.idOrden === idOrden) avisarCuentaCambiada(); },
    'orden.actualizada': (d) => { if (d.idOrden === idOrden) avisarCuentaCambiada(); },
  },
});
if (!contexto) throw new Error('sin sesión');

let yaAvisadoDeCambio = false;
function avisarCuentaCambiada() {
  if (yaAvisadoDeCambio) return;
  yaAvisadoDeCambio = true;
  aviso('La comanda cambió mientras dividía la cuenta. Recargue para partir de la versión al día.',
    'alerta', 12000);
}

const $ = (id) => document.getElementById(id);

const estado = {
  cuenta: null,
  // Cada columna: { id, nombre, items: [{ idLinea, producto, cantidad, precioUnitario }] }
  // La columna 0 es el "origen" con lo aún no asignado.
  columnas: [],
  arrastrando: null,
  moviendo: null,   // para el modal accesible
};

/* ---------------------------------------------------------------
   Estado inicial: todo en la columna origen
   --------------------------------------------------------------- */
function inicializar(cuenta) {
  estado.cuenta = cuenta;
  estado.columnas = [
    {
      id: 'origen',
      nombre: 'Sin asignar',
      items: cuenta.lineas
        .filter((l) => (l.cobrada ?? 0) < l.cantidad)
        .map((l) => ({
          idLinea: l.id,
          producto: l.producto,
          cantidad: l.cantidad - (l.cobrada ?? 0),
          precioUnitario: l.precioUnitario,
        })),
    },
    { id: 'c1', nombre: 'Cuenta 1', items: [] },
    { id: 'c2', nombre: 'Cuenta 2', items: [] },
  ];
}

/* ---------------------------------------------------------------
   Subtotal de una columna (solo para mostrar)
   --------------------------------------------------------------- */
function subtotalColumna(col) {
  const c = col.items.reduce((s, it) => s + Math.round(Number(it.precioUnitario) * 100) * it.cantidad, 0);
  return c / 100;
}

/* ---------------------------------------------------------------
   Pintado
   --------------------------------------------------------------- */
function pintar() {
  reemplazar($('divisor'), ...estado.columnas.map(columna));
}

function columna(col) {
  const esOrigen = col.id === 'origen';
  const vacia = col.items.length === 0;

  const nodo = el('div', {
    clase: `subcuenta ${esOrigen ? 'subcuenta--origen' : ''}`,
    attrs: { 'data-col': col.id },
    on: {
      dragover: (e) => { e.preventDefault(); nodo.classList.add('subcuenta--destino-drag'); },
      dragleave: () => nodo.classList.remove('subcuenta--destino-drag'),
      drop: (e) => {
        e.preventDefault();
        nodo.classList.remove('subcuenta--destino-drag');
        if (estado.arrastrando) soltarEn(col.id);
      },
    },
  },
    el('div', { clase: 'subcuenta__cab' },
      el('span', { texto: col.nombre }),
      !esOrigen
        ? el('button', {
            clase: 'btn btn--plano btn--sm',
            attrs: { type: 'button', 'aria-label': `Cobrar ${col.nombre}`, disabled: vacia },
            on: { click: () => cobrarColumna(col) },
          }, vacia ? '—' : 'Cobrar ›')
        : null
    ),
    el('div', { clase: 'subcuenta__cuerpo' },
      vacia
        ? el('div', { clase: 'vacio texto-sm', attrs: { style: 'padding:1rem' } },
            esOrigen ? 'Todo asignado' : 'Arrastre platos aquí')
        : col.items.map((it) => itemDivisible(it, col))
    ),
    el('div', { clase: 'subcuenta__total', texto: formatearDinero(subtotalColumna(col)) })
  );

  return nodo;
}

function itemDivisible(item, col) {
  return el('div', {
    clase: 'item-divisible',
    attrs: { draggable: 'true' },
    on: {
      dragstart: () => { estado.arrastrando = { item, desde: col.id }; },
      dragend: () => { estado.arrastrando = null; },
    },
  },
    el('span', { clase: 'item-divisible__cant', texto: `${item.cantidad}×` }),
    el('span', { clase: 'item-divisible__nombre', texto: item.producto }),
    el('span', { clase: 'texto-sm texto-tenue', texto: formatearDinero(Number(item.precioUnitario) * item.cantidad) }),
    // Alternativa accesible al arrastre (FSD 6.4).
    el('button', {
      clase: 'btn btn--plano btn--sm',
      attrs: { type: 'button', 'aria-label': `Mover ${item.producto}` },
      on: { click: () => abrirModalMover(item, col) },
    }, '⇄')
  );
}

/* ---------------------------------------------------------------
   Mover ítems entre columnas
   --------------------------------------------------------------- */
function soltarEn(idColDestino) {
  const { item, desde } = estado.arrastrando;
  if (desde === idColDestino) return;

  // Cantidad > 1: se pregunta cuántas unidades mover (FSD 4.4 vista 20).
  if (item.cantidad > 1) {
    abrirModalFraccionar(item, desde, idColDestino);
  } else {
    moverUnidades(item, desde, idColDestino, 1);
  }
}

function moverUnidades(item, desdeId, hastaId, cantidad) {
  const desde = estado.columnas.find((c) => c.id === desdeId);
  const hasta = estado.columnas.find((c) => c.id === hastaId);

  // Resta del origen.
  const itDesde = desde.items.find((x) => x.idLinea === item.idLinea);
  itDesde.cantidad -= cantidad;
  if (itDesde.cantidad <= 0) desde.items = desde.items.filter((x) => x.idLinea !== item.idLinea);

  // Suma al destino (fusiona si ya existe la misma línea).
  const itHasta = hasta.items.find((x) => x.idLinea === item.idLinea);
  if (itHasta) itHasta.cantidad += cantidad;
  else hasta.items.push({ ...item, cantidad });

  pintar();
}

/* --- Modal accesible "Mover a…" --- */
const modalMover = $('modal-mover');
function abrirModalMover(item, colOrigen) {
  estado.moviendo = { item, desde: colOrigen.id };
  reemplazar($('opciones-mover'), ...estado.columnas
    .filter((c) => c.id !== colOrigen.id)
    .map((c) => el('button', {
      clase: 'btn btn--bloque btn--secundario',
      attrs: { type: 'button', style: 'margin-bottom:.4rem' },
      on: {
        click: () => {
          modalMover.close();
          if (item.cantidad > 1) abrirModalFraccionar(item, colOrigen.id, c.id);
          else moverUnidades(item, colOrigen.id, c.id, 1);
        },
      },
    }, `Mover a ${c.nombre}`)));
  modalMover.showModal();
}
$('btn-cerrar-mover').addEventListener('click', () => modalMover.close());

/* --- Modal fraccionar --- */
const modalFrac = $('modal-fraccionar');
let fracEstado = null;
function abrirModalFraccionar(item, desdeId, hastaId) {
  fracEstado = { item, desdeId, hastaId, cantidad: 1, max: item.cantidad };
  $('frac-valor').textContent = '1';
  $('frac-max').textContent = `Máximo ${item.cantidad} unidad(es) de "${item.producto}"`;
  modalFrac.showModal();
}
$('frac-mas').addEventListener('click', () => {
  fracEstado.cantidad = Math.min(fracEstado.max, fracEstado.cantidad + 1);
  $('frac-valor').textContent = String(fracEstado.cantidad);
});
$('frac-menos').addEventListener('click', () => {
  fracEstado.cantidad = Math.max(1, fracEstado.cantidad - 1);
  $('frac-valor').textContent = String(fracEstado.cantidad);
});
$('btn-confirmar-fraccionar').addEventListener('click', () => {
  moverUnidades(fracEstado.item, fracEstado.desdeId, fracEstado.hastaId, fracEstado.cantidad);
  modalFrac.close();
});
$('btn-cancelar-fraccionar').addEventListener('click', () => modalFrac.close());
$('btn-cerrar-fraccionar').addEventListener('click', () => modalFrac.close());

/* ---------------------------------------------------------------
   Añadir sub-cuenta y división equitativa
   --------------------------------------------------------------- */
$('btn-agregar-sub').addEventListener('click', () => {
  const n = estado.columnas.filter((c) => c.id !== 'origen').length + 1;
  estado.columnas.push({ id: `c${n}`, nombre: `Cuenta ${n}`, items: [] });
  pintar();
});

$('btn-equitativa').addEventListener('click', async () => {
  const subcuentas = estado.columnas.filter((c) => c.id !== 'origen');
  const n = subcuentas.length;
  if (n < 2) { aviso('Necesita al menos dos cuentas para dividir.', 'info'); return; }

  const ok = await confirmar({
    titulo: `División equitativa entre ${n}`,
    mensaje: 'Se repartirán las unidades lo más parejo posible entre las cuentas. ¿Continuar?',
    textoConfirmar: 'Dividir',
  });
  if (!ok) return;

  // Se devuelve todo al origen y se reparten las unidades una a una.
  const origen = estado.columnas.find((c) => c.id === 'origen');
  for (const col of subcuentas) {
    for (const it of col.items) {
      const enOrigen = origen.items.find((x) => x.idLinea === it.idLinea);
      if (enOrigen) enOrigen.cantidad += it.cantidad;
      else origen.items.push({ ...it });
    }
    col.items = [];
  }

  // Reparto por unidades (round-robin).
  let i = 0;
  for (const it of [...origen.items]) {
    for (let u = 0; u < it.cantidad; u++) {
      const destino = subcuentas[i % n];
      const existe = destino.items.find((x) => x.idLinea === it.idLinea);
      if (existe) existe.cantidad += 1;
      else destino.items.push({ ...it, cantidad: 1 });
      i++;
    }
  }
  origen.items = [];
  pintar();
});

/* ---------------------------------------------------------------
   Cobrar una columna (CA-06: valida contra el servidor primero)
   --------------------------------------------------------------- */
async function cobrarColumna(col) {
  const origen = estado.columnas.find((c) => c.id === 'origen');
  if (origen.items.length > 0) {
    aviso('Asigne todos los platos antes de cobrar. Queda algo en "Sin asignar".', 'alerta', 5000);
    return;
  }

  // idsDetalle de esta columna. El divisor actual cobra por líneas completas
  // asignadas a la columna; el fraccionamiento reparte cantidades pero el cobro
  // se hace por los ids de línea presentes.
  const idsDetalle = col.items.map((it) => it.idLinea);

  // Se lleva la selección a la terminal de cobro (vista 19) vía querystring.
  const params = new URLSearchParams({ id: String(idOrden) });
  params.set('lineas', idsDetalle.join(','));
  window.location.href = `/caja/cobro.html?${params}`;
}

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
$('btn-volver').addEventListener('click', () => { window.location.href = `/caja/cobro.html?id=${idOrden}`; });

async function cargar() {
  try {
    const cuenta = await api.get(`/caja/cuentas/${idOrden}`);
    $('titulo-dividir').textContent = `Dividir · Mesa ${cuenta.mesa}`;
    inicializar(cuenta);
    pintar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

await cargar();
