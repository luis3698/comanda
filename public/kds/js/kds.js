/**
 * KDS de Cocina y Barra.  RF-14, RF-15, RF-16  ·  Vistas 15, 16, 17.
 *
 * FSD 4.3:
 *  - Vista 15: carrusel de tarjetas por antigüedad, cronómetro con código de
 *    color, notas de alergia en rojo, botón gigante de avance, chime al llegar
 *    una comanda nueva.
 *  - Vista 16: consolidado por producto, tocar expande las comandas.
 *  - Vista 17: switch disponible/agotado, se propaga por WebSocket (CA-02).
 *
 * La estación (cocina/barra) se toma de la sesión: el rol Cocinero podría
 * atender ambas, así que se permite fijarla por querystring (?estacion=barra).
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar } from '/comun/ui.js';
import { cargarSesionActual, alPerderSesion } from '/comun/api.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';

const sesion = await cargarSesionActual();
if (!sesion) { window.location.href = '/'; }
if (!sesion.permisos.includes('kds.ver')) {
  document.body.innerHTML = '<div class="kds-vacio">Esta pantalla es para el personal de cocina.</div>';
  throw new Error('sin permiso');
}

// La estación por defecto es cocina; se puede forzar barra por URL, y desde el
// conmutador de la cabecera. El cocinero puede atender ambas (FSD 4.3), así que
// no es fija: cambiarla recarga la vista activa con la cola de esa estación.
let estacion = new URLSearchParams(location.search).get('estacion') === 'barra' ? 'barra' : 'cocina';

const estado = {
  vista: 'comandas',
  comandas: [],
  produccion: [],
  stock: [],
  buscarStock: '',
  idsPrevias: new Set(),   // para detectar comandas nuevas y sonar el chime
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Cabecera y conmutador de estación (Cocina / Barra)
   --------------------------------------------------------------- */
function pintarEstacionActiva() {
  for (const est of ['cocina', 'barra']) {
    const activa = est === estacion;
    const btn = $(`est-${est}`);
    btn.classList.toggle('kds-estacion-activa', activa);
    btn.setAttribute('aria-selected', String(activa));
  }
  document.title = `KDS ${estacion === 'barra' ? 'Barra' : 'Cocina'} · SIGR`;
}

function cambiarEstacion(nueva) {
  if (nueva === estacion) return;
  estacion = nueva;
  // Se refleja en la URL para poder recargar o compartir la vista de barra.
  const url = new URL(location.href);
  url.searchParams.set('estacion', estacion);
  history.replaceState(null, '', url);
  // El servidor filtra los eventos por estación en el handshake del WebSocket
  // (una comanda de barra no se difunde al KDS de cocina). Para recibir en vivo
  // lo de la nueva estación hay que rehacer la conexión con el nuevo filtro.
  canal.estacion = estacion;
  canal.cerrar();
  canal.conectar();
  pintarEstacionActiva();
  estado.idsPrevias = new Set();   // que la nueva cola no marque todo como "nuevo"
  cargarVistaActual();
}

$('est-cocina').addEventListener('click', () => cambiarEstacion('cocina'));
$('est-barra').addEventListener('click', () => cambiarEstacion('barra'));

function actualizarReloj() {
  $('reloj').textContent = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}
actualizarReloj();
setInterval(actualizarReloj, 10000);

alPerderSesion(() => { window.location.href = '/'; });

$('btn-salir').addEventListener('click', async () => {
  try { await api.post('/auth/logout'); } catch { /* se sale igual */ }
  canal.cerrar();
  window.location.href = '/';
});

/* ---------------------------------------------------------------
   Chime de comanda nueva (Web Audio, sin archivo externo)
   FSD 4.3 vista 15: "nuevas comandas llegan con chime sonoro".
   --------------------------------------------------------------- */
let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ahora = audioCtx.currentTime;
    // Dos tonos ascendentes, breves y claros.
    for (const [freq, t] of [[660, 0], [880, 0.12]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ahora + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ahora + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ahora + t + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(ahora + t);
      osc.stop(ahora + t + 0.3);
    }
  } catch { /* si el navegador bloquea el audio, no pasa nada grave */ }
}

/* ---------------------------------------------------------------
   Pestañas
   --------------------------------------------------------------- */
for (const v of ['comandas', 'produccion', 'stock']) {
  $(`tab-${v}`).addEventListener('click', () => {
    estado.vista = v;
    for (const otra of ['comandas', 'produccion', 'stock']) {
      const activa = otra === v;
      $(`tab-${otra}`).classList.toggle('kds-tab--activo', activa);
      $(`tab-${otra}`).setAttribute('aria-selected', String(activa));
      $(`panel-${otra}`).classList.toggle('oculto', !activa);
    }
    cargarVistaActual();
  });
}

/* ---------------------------------------------------------------
   Vista 15: órdenes entrantes
   --------------------------------------------------------------- */

/** Código de color del cronómetro (FSD 4.3: verde <10, ámbar 10-20, rojo >20). */
function nivelCrono(segundos) {
  const min = segundos / 60;
  if (min < 10) return 'verde';
  if (min < 20) return 'ambar';
  return 'rojo';
}

function formatoCrono(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function tarjetaComanda(c) {
  const nivel = nivelCrono(c.segundosEspera);
  const esNueva = !estado.idsPrevias.has(c.idOrden);

  // ¿Todas las líneas ya están "preparando"? Entonces el botón pasa a "Listo".
  const todasPreparando = c.lineas.every((l) => l.estado === 'preparando');
  const accion = todasPreparando ? 'listo' : 'preparar';

  return el('div', {
    clase: `comanda-card comanda-card--${nivel} ${esNueva ? 'comanda-card--nueva' : ''}`,
    attrs: { 'data-orden': String(c.idOrden) },
  },
    el('div', { clase: 'comanda-card__cab' },
      // La mesa es un botón: abre la comanda completa (cocina + barra) para no
      // perder de vista lo que se prepara en la otra estación.
      el('button', {
        clase: 'comanda-card__mesa comanda-card__mesa--boton',
        attrs: { type: 'button', title: 'Ver comanda completa' },
        on: { click: (e) => { e.stopPropagation(); abrirComandaCompleta(c); } },
      }, `Mesa ${c.mesa} 🔍`),
      el('span', { clase: 'comanda-card__mesero', texto: c.mesero }),
      el('span', { clase: `comanda-card__crono comanda-card__crono--${nivel}`,
        texto: formatoCrono(c.segundosEspera) })
    ),
    el('div', { clase: 'comanda-card__cuerpo' },
      ...c.lineas.map((l) => el('div', { clase: `kds-linea ${l.estado === 'preparando' ? 'kds-linea--preparando' : ''}` },
        el('div', { clase: 'kds-linea__titulo' },
          el('span', { clase: 'kds-linea__cant', texto: `${l.cantidad}×` }),
          el('span', { clase: 'kds-linea__nombre', texto: l.producto })
        ),
        l.modificadores.length
          ? el('div', { clase: 'kds-linea__mods', texto: `» ${l.modificadores.join(', ')}` })
          : null,
        // Notas resaltadas en rojo con ⚠ (FSD 4.3 vista 15). textContent: XSS-seguro.
        l.notas
          ? el('div', { clase: 'kds-linea__notas' },
              el('span', { attrs: { 'aria-hidden': 'true' } }, '⚠'),
              el('span', { texto: l.notas })
            )
          : null
      ))
    ),
    el('div', { clase: 'comanda-card__pie' },
      el('button', {
        clase: `kds-boton-gigante kds-boton-gigante--${accion}`,
        attrs: { type: 'button' },
        on: { click: (e) => avanzarComanda(c, accion, e.currentTarget) },
      }, accion === 'listo' ? '✓ Marcar LISTO' : '▶ Empezar a preparar')
    )
  );
}

function pintarComandas() {
  if (!estado.comandas.length) {
    reemplazar($('panel-comandas'), el('div', { clase: 'kds-vacio' },
      el('div', {},
        el('div', { attrs: { style: 'font-size:3rem' } }, '🍳'),
        el('div', { texto: 'Sin órdenes pendientes' })
      )));
  } else {
    reemplazar($('panel-comandas'), ...estado.comandas.map(tarjetaComanda));
  }
  // Se memoriza qué comandas ya se vieron, para el flash de las nuevas.
  estado.idsPrevias = new Set(estado.comandas.map((c) => c.idOrden));
}

/**
 * Avanza todas las líneas de una comanda: en_cola->preparando, o
 * preparando->listo. FSD 4.3 vista 15: "por plato o por tarjeta completa".
 */
async function avanzarComanda(comanda, accion, boton) {
  boton.disabled = true;

  try {
    const lineasAAvanzar = comanda.lineas.filter((l) =>
      accion === 'listo' ? l.estado === 'preparando' : l.estado === 'en_cola'
    );

    for (const l of lineasAAvanzar) {
      await api.patch(`/kds/lineas/${l.id}/estado`, {});
    }

    if (accion === 'listo') {
      // Animación de archivado antes de recargar (FSD 4.3 vista 15).
      const card = $('panel-comandas').querySelector(`[data-orden="${comanda.idOrden}"]`);
      if (card) {
        card.classList.add('comanda-card--archivando');
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await cargarComandas();
  } catch (error) {
    aviso(error.message, 'error');
    boton.disabled = false;
  }
}

/* ---------------------------------------------------------------
   Vista 16: consolidado por producto
   --------------------------------------------------------------- */
function pintarProduccion() {
  if (!estado.produccion.length) {
    reemplazar($('panel-produccion'), el('div', { clase: 'kds-vacio' }, 'Sin producción pendiente'));
    return;
  }

  reemplazar($('panel-produccion'), ...estado.produccion.map((p) =>
    el('div', {
      clase: 'prod-card',
      attrs: { role: 'button', tabindex: '0', 'aria-label': `${p.unidades} de ${p.producto}, ver detalle` },
      on: {
        click: () => abrirDetalle(p),
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDetalle(p); } },
      },
    },
      el('div', { clase: 'prod-card__cant', texto: String(p.unidades) }),
      el('div', { clase: 'prod-card__nombre', texto: p.producto }),
      p.modificadores.length
        ? el('div', { clase: 'prod-card__mods',
            texto: p.modificadores.map((m) => `${m.unidades} ${m.nombre}`).join(' · ') })
        : null,
      el('div', { clase: 'prod-card__detalle', texto: `en ${p.comandas} comanda(s)` })
    )
  ));
}

const modalDetalle = $('modal-detalle');
async function abrirDetalle(producto) {
  $('titulo-detalle').textContent = `${producto.unidades} × ${producto.producto}`;
  reemplazar($('cuerpo-detalle'), el('p', {}, 'Cargando…'));
  modalDetalle.showModal();

  try {
    const r = await api.get(`/kds/produccion/${producto.idProducto}?estacion=${estacion}`);
    reemplazar($('cuerpo-detalle'), ...r.lineas.map((l) =>
      el('div', { clase: 'kds-linea' },
        el('div', { clase: 'kds-linea__titulo' },
          el('span', { clase: 'kds-linea__cant', texto: `${l.cantidad}×` }),
          el('span', { clase: 'kds-linea__nombre', texto: `Mesa ${l.mesa}` }),
          el('span', { clase: 'comanda-card__mesero', attrs: { style: 'margin-left:auto' },
            texto: `${Math.floor(l.segundosEspera / 60)} min` })
        ),
        l.notas ? el('div', { clase: 'kds-linea__notas' }, el('span', {}, '⚠ '), l.notas) : null
      )));
  } catch (error) {
    reemplazar($('cuerpo-detalle'), el('p', { texto: error.message }));
  }
}
$('btn-cerrar-detalle').addEventListener('click', () => modalDetalle.close());

/**
 * Abre la comanda COMPLETA: todas sus líneas, sean de cocina o de barra, con su
 * estado. Resuelve el problema de que, con la orden repartida entre dos
 * estaciones, el cocinero solo veía "algunos productos" en su cola.
 */
const ETIQUETA_ESTADO = {
  sin_enviar: 'Sin enviar', en_cola: 'En cola', preparando: 'Preparando',
  listo: 'Listo', servido: 'Servido',
};
const ETIQUETA_DESTINO = { cocina: '🍳 Cocina', barra: '🍹 Barra', ninguno: '— Sin preparación' };

async function abrirComandaCompleta(comanda) {
  $('titulo-detalle').textContent = `Mesa ${comanda.mesa} · comanda completa`;
  reemplazar($('cuerpo-detalle'), el('p', {}, 'Cargando…'));
  modalDetalle.showModal();

  try {
    const r = await api.get(`/kds/comandas/${comanda.idOrden}`);
    reemplazar($('cuerpo-detalle'),
      el('p', { clase: 'texto-sm', attrs: { style: 'opacity:.7;margin-bottom:.5rem' },
        texto: `${r.mesero} · ${r.numComensales} comensal(es) · orden ${r.estado}` }),
      ...r.lineas.map((l) => el('div', { clase: 'kds-linea' },
        el('div', { clase: 'kds-linea__titulo' },
          el('span', { clase: 'kds-linea__cant', texto: `${l.cantidad}×` }),
          el('span', { clase: 'kds-linea__nombre', texto: l.producto }),
          el('span', { clase: 'comanda-card__mesero', attrs: { style: 'margin-left:auto' },
            texto: `${ETIQUETA_DESTINO[l.destino] ?? l.destino} · ${ETIQUETA_ESTADO[l.estado] ?? l.estado}` })
        ),
        l.modificadores.length
          ? el('div', { clase: 'kds-linea__mods', texto: `» ${l.modificadores.join(', ')}` })
          : null,
        l.notas ? el('div', { clase: 'kds-linea__notas' }, el('span', {}, '⚠ '), l.notas) : null
      ))
    );
  } catch (error) {
    reemplazar($('cuerpo-detalle'), el('p', { texto: error.message }));
  }
}

/* ---------------------------------------------------------------
   Vista 17: control de agotados
   --------------------------------------------------------------- */
function pintarStock() {
  let lista = estado.stock;
  if (estado.buscarStock) {
    const q = estado.buscarStock.toLowerCase();
    lista = lista.filter((p) => p.nombre.toLowerCase().includes(q));
  }

  if (!lista.length) {
    reemplazar($('lista-stock'), el('div', { clase: 'kds-vacio' }, 'Sin platos'));
    return;
  }

  reemplazar($('lista-stock'), ...lista.map((p) =>
    el('div', { clase: `stock-item ${p.disponible ? '' : 'stock-item--agotado'}` },
      el('div', { clase: 'crece' },
        el('div', { clase: 'stock-item__nombre', texto: p.nombre }),
        el('div', { clase: 'stock-item__cat', texto: p.categoria }),
        p.enCola > 0
          ? el('div', { clase: 'stock-item__cola', texto: `⚠ ${p.enCola} en cola` })
          : null
      ),
      // Switch grande (FSD 4.3 vista 17: >= 56 px).
      el('label', { clase: 'switch-kds' },
        el('input', {
          attrs: { type: 'checkbox', checked: p.disponible, 'aria-label': `Disponibilidad de ${p.nombre}` },
          on: { change: (e) => alternarDisponible(p, e.target.checked, e.target) },
        }),
        el('span', { clase: 'switch-kds__pista', attrs: { 'aria-hidden': 'true' } }),
        el('span', { clase: 'switch-kds__perilla', attrs: { 'aria-hidden': 'true' } }),
        el('span', { clase: 'switch-kds__texto switch-kds__texto--si', attrs: { 'aria-hidden': 'true' } }, 'SÍ'),
        el('span', { clase: 'switch-kds__texto switch-kds__texto--no', attrs: { 'aria-hidden': 'true' } }, 'NO')
      )
    )));
}

async function alternarDisponible(producto, disponible, input) {
  // FSD 4.3 vista 17: confirmación previa si el plato tiene unidades en cola.
  if (!disponible && producto.enCola > 0) {
    const ok = await confirmar({
      titulo: `Agotar "${producto.nombre}"`,
      mensaje: `Hay ${producto.enCola} unidad(es) ya comandadas en cola. Seguirán preparándose, pero el plato dejará de poder pedirse. ¿Confirmar?`,
      textoConfirmar: 'Marcar agotado',
      peligro: true,
    });
    if (!ok) { input.checked = true; return; }
  }

  try {
    const r = await api.patch(`/kds/productos/${producto.id}/disponibilidad`, { disponible });
    producto.disponible = disponible;
    // Confirmación de que la difusión llegó a los comanderos (CA-02).
    aviso(
      `"${producto.nombre}" ${disponible ? 'disponible' : 'agotado'}. ${r.clientesNotificados} dispositivo(s) actualizados.`,
      'exito', 3000
    );
    pintarStock();
  } catch (error) {
    input.checked = producto.disponible;
    aviso(error.message, 'error');
  }
}

$('buscar-stock').addEventListener('input', (e) => {
  estado.buscarStock = e.target.value.trim();
  pintarStock();
});

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarComandas() {
  const r = await api.get(`/kds/comandas?estacion=${estacion}`);
  estado.comandas = r.comandas;
  pintarComandas();
}
async function cargarProduccion() {
  const r = await api.get(`/kds/produccion?estacion=${estacion}`);
  estado.produccion = r.productos;
  pintarProduccion();
}
async function cargarStock() {
  const r = await api.get(`/kds/menu?estacion=${estacion}`);
  estado.stock = r.productos;
  pintarStock();
}

async function cargarVistaActual() {
  try {
    if (estado.vista === 'comandas') await cargarComandas();
    else if (estado.vista === 'produccion') await cargarProduccion();
    else await cargarStock();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Tiempo real
   --------------------------------------------------------------- */
const canal = new CanalTiempoReal({ estacion, alRefrescar: cargarVistaActual });
$('indicador-conexion').append(crearIndicadorConexion(canal));
canal.on('sesion.invalida', () => { window.location.href = '/'; });

// CA-01: una comanda enviada debe aparecer aquí en < 1 s, con chime y flash.
canal.on('orden.enviada', () => {
  chime();
  if (estado.vista === 'comandas') cargarComandas();
  else cargarVistaActual();
});
canal.on('linea.estado', () => cargarVistaActual());
canal.on('producto.agotado', () => { if (estado.vista === 'stock') cargarStock(); });

canal.conectar();

// El cronómetro avanza en pantalla sin recargar del servidor cada segundo.
setInterval(() => { if (estado.vista === 'comandas' && estado.comandas.length) {
  for (const c of estado.comandas) c.segundosEspera++;
  pintarComandas();
} }, 1000);

await cargarComandas();
