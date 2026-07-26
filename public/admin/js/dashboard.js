/**
 * Vista 1: Dashboard de Inteligencia de Negocio.  RF-21, RF-09.
 *
 * FSD 4.1 vista 1:
 *  - 4 tarjetas KPI, gráfica de ventas por hora (líneas), top 10 platos (barras)
 *  - actualización en vivo vía WebSocket
 *  - selector de rango de fechas que redibuja las gráficas sin recargar
 *  - clic en una alerta de stock navega al módulo de inventario
 *  - tooltips en gráficas con mousemove
 *
 * Las gráficas se dibujan en SVG a mano: el FSD 2.1 impone JS vanilla sin
 * frameworks, y cargar una librería de charts sería saltarse esa regla.
 *
 * Los KPIs los calcula el servidor (FSD 5.8). Aquí solo se pintan.
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, formatearDinero } from '/comun/ui.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';
import { iniciarShell } from './shell.js';

const sesion = await iniciarShell('dashboard.ver');
if (!sesion) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const estado = { fecha: new Date().toISOString().slice(0, 10), kpis: null };

/** Crea un elemento SVG (el helper `el()` de ui.js sirve solo para HTML). */
function svg(tag, attrs = {}, ...hijos) {
  const nodo = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== false) nodo.setAttribute(k, String(v));
  }
  for (const h of hijos.flat()) {
    if (h == null) continue;
    nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  }
  return nodo;
}

/* ---------------------------------------------------------------
   Tooltip
   --------------------------------------------------------------- */
let tooltip = null;
function mostrarTooltip(texto, evento) {
  if (!tooltip) {
    tooltip = el('div', { clase: 'tooltip', attrs: { role: 'tooltip' } });
    document.body.append(tooltip);
  }
  tooltip.textContent = texto;
  tooltip.style.left = `${evento.clientX + 12}px`;
  tooltip.style.top = `${evento.clientY - 32}px`;
  tooltip.style.display = 'block';
}
function ocultarTooltip() { if (tooltip) tooltip.style.display = 'none'; }

/* ---------------------------------------------------------------
   Tarjetas KPI
   --------------------------------------------------------------- */
function pintarKpis(k) {
  const tarjeta = (etiqueta, valor, pie, alerta = false) =>
    el('div', { clase: `kpi ${alerta ? 'kpi--alerta' : ''}` },
      el('div', { clase: 'kpi__etiqueta', texto: etiqueta }),
      el('div', { clase: 'kpi__valor', texto: valor }),
      pie ? el('div', { clase: 'kpi__pie', texto: pie }) : null
    );

  reemplazar($('kpis'),
    tarjeta('Ventas brutas', formatearDinero(k.ventas.bruto),
      `${k.ventas.facturas} factura(s)`),
    tarjeta('Ventas netas', formatearDinero(k.ventas.neto),
      `Impuestos ${formatearDinero(k.ventas.impuestos)}`),
    tarjeta('Ticket promedio', formatearDinero(k.ventas.ticketPromedio),
      k.ventas.descuentos !== '0.00' ? `Descuentos ${formatearDinero(k.ventas.descuentos)}` : 'Sin descuentos'),
    tarjeta('Ocupación', `${k.ocupacion.porcentaje} %`,
      `${k.ocupacion.ocupadas} de ${k.ocupacion.activas} mesas`)
  );
}

/* ---------------------------------------------------------------
   Gráfica de ventas por hora (líneas)
   --------------------------------------------------------------- */
function pintarHoras(porHora) {
  const cont = $('grafica-horas');
  const W = cont.clientWidth || 600;
  const H = 240;
  const M = { arriba: 16, derecha: 16, abajo: 28, izquierda: 56 };
  const ancho = W - M.izquierda - M.derecha;
  const alto = H - M.arriba - M.abajo;

  cont.setAttribute('viewBox', `0 0 ${W} ${H}`);
  reemplazar(cont);

  // El restaurante abre a mediodía: se muestran las horas con actividad, y si
  // no hay ninguna, una franja razonable para que el eje no quede vacío.
  const horas = porHora.length
    ? porHora.map((h) => h.hora)
    : [];
  const min = horas.length ? Math.min(...horas) : 11;
  const max = horas.length ? Math.max(...horas) : 23;
  const rango = [];
  for (let h = min; h <= max; h++) rango.push(h);

  const datos = rango.map((h) => {
    const d = porHora.find((x) => x.hora === h);
    return { hora: h, total: d ? Number(d.total) : 0, facturas: d ? d.facturas : 0 };
  });

  const maxTotal = Math.max(1, ...datos.map((d) => d.total));
  const x = (i) => M.izquierda + (datos.length > 1 ? (i / (datos.length - 1)) * ancho : ancho / 2);
  const y = (v) => M.arriba + alto - (v / maxTotal) * alto;

  // Rejilla y etiquetas del eje Y.
  for (let i = 0; i <= 4; i++) {
    const valor = (maxTotal / 4) * i;
    const py = y(valor);
    cont.append(
      svg('line', { class: 'grafica__rejilla', x1: M.izquierda, y1: py, x2: W - M.derecha, y2: py }),
      svg('text', { class: 'grafica__etiqueta', x: M.izquierda - 6, y: py + 3, 'text-anchor': 'end' },
        formatearDinero(valor))
    );
  }

  // Área + línea.
  if (datos.some((d) => d.total > 0)) {
    const puntos = datos.map((d, i) => `${x(i)},${y(d.total)}`).join(' ');
    cont.append(
      svg('polygon', {
        class: 'grafica__area',
        points: `${M.izquierda},${y(0)} ${puntos} ${x(datos.length - 1)},${y(0)}`,
      }),
      svg('polyline', { class: 'grafica__linea', points: puntos })
    );
  }

  // Puntos con tooltip (FSD 4.1: "tooltips en gráficas con mousemove").
  datos.forEach((d, i) => {
    const punto = svg('circle', { class: 'grafica__punto', cx: x(i), cy: y(d.total), r: 4 });
    punto.addEventListener('mousemove', (e) =>
      mostrarTooltip(`${String(d.hora).padStart(2, '0')}:00 — ${formatearDinero(d.total)} · ${d.facturas} factura(s)`, e));
    punto.addEventListener('mouseleave', ocultarTooltip);
    cont.append(punto);

    // Etiqueta del eje X: se saltea si hay muchas horas para no amontonarlas.
    if (datos.length <= 14 || i % 2 === 0) {
      cont.append(svg('text', {
        class: 'grafica__etiqueta', x: x(i), y: H - 8, 'text-anchor': 'middle',
      }, `${String(d.hora).padStart(2, '0')}h`));
    }
  });

  cont.append(
    svg('line', { class: 'grafica__eje', x1: M.izquierda, y1: M.arriba + alto, x2: W - M.derecha, y2: M.arriba + alto })
  );

  $('resumen-horas').textContent = datos.some((d) => d.total > 0)
    ? `Pico a las ${String(datos.reduce((a, b) => (b.total > a.total ? b : a)).hora).padStart(2, '0')}:00`
    : 'Sin ventas en el día';
}

/* ---------------------------------------------------------------
   Gráfica de platos estrella (barras horizontales)
   --------------------------------------------------------------- */
function pintarTop(topPlatos) {
  const cont = $('grafica-top');
  const W = cont.clientWidth || 320;
  const filas = topPlatos.slice(0, 8);
  const H = Math.max(240, filas.length * 28 + 20);

  cont.setAttribute('viewBox', `0 0 ${W} ${H}`);
  cont.style.height = `${H}px`;
  reemplazar(cont);

  if (!filas.length) {
    cont.append(svg('text', {
      class: 'grafica__etiqueta', x: W / 2, y: H / 2, 'text-anchor': 'middle',
    }, 'Sin ventas en el día'));
    return;
  }

  const maxU = Math.max(...filas.map((p) => p.unidades));
  const anchoBarra = W - 150;

  filas.forEach((p, i) => {
    const py = 12 + i * 28;
    const w = Math.max(2, (p.unidades / maxU) * anchoBarra);

    const barra = svg('rect', { class: 'barra', x: 100, y: py, width: w, height: 18, rx: 3 });
    barra.addEventListener('mousemove', (e) =>
      mostrarTooltip(`${p.nombre}: ${p.unidades} uds · ${formatearDinero(p.total)}`, e));
    barra.addEventListener('mouseleave', ocultarTooltip);

    cont.append(
      // El nombre se recorta con ellipsis nativo del SVG vía textLength no es
      // fiable; se corta en JS para que no invada la barra.
      svg('text', { class: 'barra__texto', x: 94, y: py + 13, 'text-anchor': 'end' },
        p.nombre.length > 16 ? `${p.nombre.slice(0, 15)}…` : p.nombre),
      barra,
      svg('text', { class: 'barra__valor', x: 100 + w + 6, y: py + 13 }, String(p.unidades))
    );
  });
}

/* ---------------------------------------------------------------
   Alertas de stock (RF-09)
   --------------------------------------------------------------- */
function pintarAlertas(stockCritico) {
  $('conteo-alertas').textContent = `${stockCritico.length} insumo(s)`;

  if (!stockCritico.length) {
    reemplazar($('alertas'), el('div', { clase: 'vacio' },
      el('p', { texto: '✓ Ningún insumo por debajo de su mínimo.' })));
    return;
  }

  reemplazar($('alertas'), ...stockCritico.map((i) => el('button', {
    clase: 'alerta-stock',
    attrs: { type: 'button' },
    // FSD 4.1 vista 1: "clic en una alerta de stock navega al módulo de inventario".
    on: { click: () => { window.location.href = `/admin/inventario.html?insumo=${i.id}`; } },
  },
    // El estado lleva icono y texto, no solo color (FSD 6.4).
    i.negativo
      ? el('span', { clase: 'insignia insignia--error' }, '⚠ Negativo')
      : el('span', { clase: 'insignia insignia--alerta' }, '▼ Bajo mínimo'),
    el('span', { clase: 'alerta-stock__nombre', texto: i.nombre }),
    el('span', { clase: 'alerta-stock__cifras texto-tenue' },
      `${i.stockActual} / mín. ${i.stockMinimo} ${i.unidadMedida}`),
    el('span', { clase: 'texto-tenue' }, '›')
  )));
}

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargar() {
  try {
    const k = await api.get(`/dashboard/kpis?fecha=${estado.fecha}`);
    estado.kpis = k;
    pintarKpis(k);
    pintarHoras(k.porHora);
    pintarTop(k.topPlatos);
    pintarAlertas(k.stockCritico);
  } catch (error) {
    aviso(error.message, 'error');
  }
}

$('fecha').value = estado.fecha;
$('fecha').addEventListener('change', (e) => {
  // Redibuja sin recargar la página (FSD 4.1 vista 1).
  estado.fecha = e.target.value;
  cargar();
});
$('btn-hoy').addEventListener('click', () => {
  estado.fecha = new Date().toISOString().slice(0, 10);
  $('fecha').value = estado.fecha;
  cargar();
});

// Las gráficas son responsivas: hay que redibujarlas al cambiar el ancho.
let temporizadorResize;
window.addEventListener('resize', () => {
  clearTimeout(temporizadorResize);
  temporizadorResize = setTimeout(() => {
    if (estado.kpis) { pintarHoras(estado.kpis.porHora); pintarTop(estado.kpis.topPlatos); }
  }, 200);
});

// Actualización en vivo (FSD 4.1 vista 1).
const canal = new CanalTiempoReal({ alRefrescar: cargar });
$('indicador-conexion').append(crearIndicadorConexion(canal));
canal.on('sesion.invalida', () => { window.location.href = '/'; });
// Una venta nueva o un cambio de stock cambian los KPIs al instante.
canal.on('mesa.estado', cargar);
canal.on('stock.critico', cargar);
// Y también abrir una comanda, despachar un plato o rediseñar el salón: todos
// mueven el ocupado de mesas y los tiempos medios que muestra el tablero.
canal.on('orden.creada', cargar);
canal.on('orden.enviada', cargar);
canal.on('linea.estado', cargar);
canal.on('salon.actualizado', cargar);
canal.conectar();

await cargar();
