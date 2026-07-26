/**
 * Vista 11: Mapa de Salón para Servicio.  RF-10.
 *
 * FSD 4.2 vista 11:
 *  - lienzo del plano en solo lectura reproduciendo la distribución del admin
 *  - cada mesa es un botón táctil coloreado por estado
 *  - estados sincronizados por WebSocket
 *  - touchend sobre mesa libre abre modal "¿Cuántas personas?"; "Iniciar comanda"
 *  - tocar una mesa ocupada propia navega a su resumen
 *  - mesas de otros meseros aparecen atenuadas (según permiso)
 *  - alternativa de vista en lista para pantallas muy pequeñas
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso } from '/comun/ui.js';
import { iniciarComandero, sesion } from './comun.js';

const contexto = await iniciarComandero({ alRefrescar: cargarSalon });
if (!contexto) throw new Error('sin sesión');
const { canal } = contexto;

const estado = {
  zonas: [],
  ordenes: [],
  zonaActiva: null,
  vistaLista: false,
  mesaSeleccionada: null,
  comensales: 2,
};

const $ = (id) => document.getElementById(id);

const ICONO_ESTADO = { libre: '✓', ocupada: '●', precuenta: '🧾', bloqueada: '⊘' };

/** Cruza el estado base de la mesa con las órdenes vivas para saber de quién es. */
function estadoDeMesa(mesa) {
  const orden = estado.ordenes.find((o) => o.idMesa === mesa.id);
  return {
    ...mesa,
    orden,
    // Una mesa ocupada por otro mesero se muestra atenuada (FSD 4.2 vista 11).
    ajena: orden && orden.idMesero !== sesion.usuario.id,
  };
}

/* ---------------------------------------------------------------
   Zonas
   --------------------------------------------------------------- */
function pintarZonas() {
  reemplazar($('zonas'), ...estado.zonas.map((z) => el('button', {
    clase: `zona-chip ${estado.zonaActiva === z.id ? 'zona-chip--activa' : ''}`,
    attrs: { type: 'button', role: 'tab', 'aria-selected': String(estado.zonaActiva === z.id) },
    on: { click: () => { estado.zonaActiva = z.id; pintar(); } },
  }, z.nombre)));
}

/* ---------------------------------------------------------------
   Plano y lista
   --------------------------------------------------------------- */
function botonMesa(mesa) {
  const e = estadoDeMesa(mesa);
  return el('button', {
    clase: `mesa-btn mesa-btn--${mesa.forma} mesa-btn--${mesa.estado} ${e.ajena ? 'mesa-btn--ajena' : ''}`,
    attrs: {
      type: 'button',
      style: `left:${mesa.posX}%; top:${mesa.posY}%; width:${mesa.ancho}%; height:${mesa.alto}%`,
      'aria-label': `Mesa ${mesa.numero}, ${etiquetaEstado(mesa.estado)}` +
                    (e.ajena ? `, atendida por ${e.orden.mesero}` : ''),
    },
    on: { click: () => tocarMesa(e) },
  },
    el('span', { clase: 'mesa-btn__num', texto: mesa.numero }),
    // Icono además del color (FSD 6.4).
    el('span', { clase: 'mesa-btn__icono', attrs: { 'aria-hidden': 'true' } }, ICONO_ESTADO[mesa.estado] ?? '')
  );
}

function filaMesa(mesa) {
  const e = estadoDeMesa(mesa);
  return el('button', {
    clase: `mesa-item mesa-item--${mesa.estado}`,
    attrs: { type: 'button' },
    on: { click: () => tocarMesa(e) },
  },
    el('span', { clase: 'mesa-item__num', texto: mesa.numero }),
    el('span', { clase: 'mesa-item__info' },
      etiquetaEstado(mesa.estado),
      e.orden ? ` · ${e.orden.mesero}${e.orden.lineas ? ` · ${e.orden.lineas} ítem(s)` : ''}` : ` · ${mesa.capacidad} personas`
    ),
    el('span', { attrs: { 'aria-hidden': 'true' } }, ICONO_ESTADO[mesa.estado] ?? '')
  );
}

function etiquetaEstado(e) {
  return { libre: 'Libre', ocupada: 'Ocupada', precuenta: 'Pre-cuenta solicitada', bloqueada: 'Bloqueada' }[e] ?? e;
}

function pintarPlano() {
  const zona = estado.zonas.find((z) => z.id === estado.zonaActiva);
  const mesas = zona?.mesas ?? [];

  if (estado.vistaLista) {
    $('plano').classList.add('oculto');
    $('mesas-lista').classList.remove('oculto');
    reemplazar($('mesas-lista'), ...mesas.map(filaMesa));
  } else {
    $('plano').classList.remove('oculto');
    $('mesas-lista').classList.add('oculto');
    if (!mesas.length) {
      reemplazar($('plano'), el('div', { clase: 'lienzo__vacio' },
        el('p', { texto: 'Esta zona no tiene mesas.' })));
    } else {
      reemplazar($('plano'), ...mesas.map(botonMesa));
    }
  }

  const libres = mesas.filter((m) => m.estado === 'libre').length;
  $('resumen-zona').textContent = `${mesas.length} mesas · ${libres} libre(s)`;
}

function pintar() {
  pintarZonas();
  pintarPlano();
}

/* ---------------------------------------------------------------
   Interacción con una mesa
   --------------------------------------------------------------- */
function tocarMesa(e) {
  if (e.estado === 'bloqueada') {
    aviso(`La mesa ${e.numero} está bloqueada.`, 'info');
    return;
  }

  // Mesa con comanda: si es propia (o puede ver todas), se abre su resumen.
  if (e.orden) {
    if (e.ajena && !sesion.permisos.includes('ordenes.ver_todas')) {
      aviso(`La mesa ${e.numero} la atiende ${e.orden.mesero}.`, 'info');
      return;
    }
    window.location.href = `/comandero/mesa.html?id=${e.orden.id}`;
    return;
  }

  // Mesa libre: se pregunta cuántas personas (FSD 4.2 vista 11).
  if (!sesion.permisos.includes('ordenes.abrir')) {
    aviso('No tiene permiso para abrir comandas.', 'error');
    return;
  }
  abrirModalComensales(e);
}

/* ---------------------------------------------------------------
   Modal de comensales
   --------------------------------------------------------------- */
const modal = $('modal-comensales');

function abrirModalComensales(mesa) {
  estado.mesaSeleccionada = mesa;
  estado.comensales = Math.min(2, mesa.capacidad);
  $('titulo-comensales').textContent = `Mesa ${mesa.numero}`;
  $('capacidad-mesa').textContent = `Capacidad: ${mesa.capacidad} personas`;
  $('valor-comensales').textContent = String(estado.comensales);
  modal.showModal();
}

function ajustarComensales(delta) {
  const max = estado.mesaSeleccionada?.capacidad ?? 30;
  estado.comensales = Math.max(1, Math.min(max, estado.comensales + delta));
  $('valor-comensales').textContent = String(estado.comensales);
}

$('btn-mas').addEventListener('click', () => ajustarComensales(1));
$('btn-menos').addEventListener('click', () => ajustarComensales(-1));
$('btn-cerrar-comensales').addEventListener('click', () => modal.close());
$('btn-cancelar-comensales').addEventListener('click', () => modal.close());

$('btn-iniciar').addEventListener('click', async () => {
  const mesa = estado.mesaSeleccionada;
  if (!mesa) return;

  const btn = $('btn-iniciar');
  btn.disabled = true;
  btn.textContent = 'Abriendo…';

  try {
    const r = await api.post('/ordenes', {
      idMesa: mesa.id,
      numComensales: estado.comensales,
    });
    modal.close();
    // Directo a la toma de pedido de la comanda recién abierta.
    window.location.href = `/comandero/mesa.html?id=${r.idOrden}`;
  } catch (error) {
    // Si otro mesero abrió la mesa mientras tanto (CA-09), el servidor lo
    // rechaza y aquí se avisa con claridad en vez de dejar un estado a medias.
    aviso(error.message, 'error', 7000);
    btn.disabled = false;
    btn.textContent = 'Iniciar comanda';
    await cargarSalon();
  }
});

/* ---------------------------------------------------------------
   Vista lista / plano
   --------------------------------------------------------------- */
$('btn-vista').addEventListener('click', () => {
  estado.vistaLista = !estado.vistaLista;
  $('btn-vista').textContent = estado.vistaLista ? 'Ver como plano' : 'Ver como lista';
  pintarPlano();
});

/* ---------------------------------------------------------------
   Tiempo real
   --------------------------------------------------------------- */
// Cualquier cambio de mesa (otra apertura, un cobro, una pre-cuenta) recarga
// el salón. Es barato y garantiza que dos meseros ven lo mismo.
canal.on('mesa.estado', cargarSalon);
canal.on('orden.creada', cargarSalon);
canal.on('precuenta.solicitada', cargarSalon);

// Un plato que cocina marca como listo cambia el contador de "listos" del nav
// inferior y el aspecto de la mesa en el plano. Faltaba: el mesero veía el
// plano congelado y tenía que recargar para descubrir que le esperaba comida.
canal.on('linea.estado', cargarSalon);
canal.on('orden.actualizada', cargarSalon);

// El administrador rediseñó la distribución: mesas movidas, zonas nuevas o
// retiradas. El plano se redibuja solo (FSD 5.2).
canal.on('salon.actualizado', cargarSalon);

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarSalon() {
  try {
    const [salon, activas] = await Promise.all([
      api.get('/salon/zonas'),
      api.get('/ordenes/activas'),
    ]);
    estado.zonas = salon.zonas;
    estado.ordenes = activas.ordenes;

    if (!estado.zonaActiva && estado.zonas.length) {
      estado.zonaActiva = estado.zonas[0].id;
    }

    // Badge de platos listos para el nav inferior.
    const listos = estado.ordenes
      .filter((o) => o.idMesero === sesion.usuario.id)
      .reduce((s, o) => s + (o.listas ?? 0), 0);
    const badge = $('badge-listos');
    if (badge) {
      badge.textContent = String(listos);
      badge.classList.toggle('oculto', listos === 0);
    }

    pintar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

await cargarSalon();
