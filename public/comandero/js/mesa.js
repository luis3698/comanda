/**
 * Vistas 12 y 13: Toma de pedido + Resumen y división de tiempos.  RF-11, RF-12.
 *
 * FSD 4.2 vista 12:
 *  - búsqueda instantánea sobre catálogo cacheado localmente
 *  - al tocar un plato se abre bottom sheet con grupos de modificadores:
 *    radios para obligatorios, checkboxes para opcionales con precio visible,
 *    campo de comentarios, stepper de cantidad
 *  - "Agregar" deshabilitado hasta cumplir los modificadores obligatorios
 * FSD 4.2 vista 13:
 *  - líneas agrupadas por tiempo de salida
 *  - editar/eliminar líneas no enviadas; las enviadas quedan bloqueadas
 *  - "Confirmar y Enviar a Cocina"; "Solicitar pre-cuenta"
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearDinero, retrasar } from '/comun/ui.js';
import { iniciarComandero, sesion } from './comun.js';

const idOrden = Number(new URLSearchParams(location.search).get('id'));
if (!idOrden) { window.location.href = '/comandero/'; }

const contexto = await iniciarComandero({ alRefrescar: cargarTodo });
if (!contexto) throw new Error('sin sesión');
const { canal } = contexto;

const TIEMPOS = {
  1: '1er tiempo — Entradas',
  2: '2º tiempo — Fuertes',
  3: '3er tiempo — Postres',
  4: '4º tiempo',
};

const estado = {
  orden: null,
  categorias: [],
  productos: [],
  categoriaActiva: null,
  buscar: '',
  // Selección temporal dentro del bottom sheet.
  platoActual: null,
  grupos: [],
  seleccion: new Map(),   // idGrupo -> Set(idModificador)
  cantidad: 1,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Pestañas
   --------------------------------------------------------------- */
function mostrarPanel(cual) {
  const esMenu = cual === 'menu';
  $('tab-menu').classList.toggle('zona-chip--activa', esMenu);
  $('tab-resumen').classList.toggle('zona-chip--activa', !esMenu);
  $('tab-menu').setAttribute('aria-selected', String(esMenu));
  $('tab-resumen').setAttribute('aria-selected', String(!esMenu));
  $('panel-menu').classList.toggle('oculto', !esMenu);
  $('panel-resumen').classList.toggle('oculto', esMenu);
  $('barra-carrito').classList.toggle('oculto', !esMenu || !contarNoEnviadas());
}
$('tab-menu').addEventListener('click', () => mostrarPanel('menu'));
$('tab-resumen').addEventListener('click', () => mostrarPanel('resumen'));
$('btn-ir-resumen').addEventListener('click', () => mostrarPanel('resumen'));
$('btn-volver').addEventListener('click', () => { window.location.href = '/comandero/'; });

/* ---------------------------------------------------------------
   Menú (vista 12)
   --------------------------------------------------------------- */
function pintarCategorias() {
  const items = [{ id: null, nombre: 'Todas' }, ...estado.categorias];
  reemplazar($('categorias'), ...items.map((c) => el('button', {
    clase: `zona-chip ${estado.categoriaActiva === c.id ? 'zona-chip--activa' : ''}`,
    attrs: { type: 'button', role: 'tab' },
    on: { click: () => { estado.categoriaActiva = c.id; pintarMenu(); } },
  }, c.nombre)));
}

function pintarMenu() {
  let lista = estado.productos.filter((p) => p.activo);
  if (estado.categoriaActiva) lista = lista.filter((p) => p.idCategoria === estado.categoriaActiva);
  if (estado.buscar) {
    const q = estado.buscar.toLowerCase();
    lista = lista.filter((p) => p.nombre.toLowerCase().includes(q));
  }

  if (!lista.length) {
    reemplazar($('grilla-menu'), el('div', { clase: 'vacio', attrs: { style: 'grid-column:1/-1' } },
      el('p', { texto: 'Sin platos que mostrar.' })));
    return;
  }

  reemplazar($('grilla-menu'), ...lista.map((p) => {
    // Un plato agotado no es pulsable (FSD 4.2 vista 12).
    const agotado = !p.disponible;
    return el('button', {
      clase: `plato-btn ${agotado ? 'plato-btn--agotado' : ''}`,
      attrs: { type: 'button', disabled: agotado, 'aria-label': `${p.nombre}, ${formatearDinero(p.precioBase)}${agotado ? ', agotado' : ''}` },
      on: { click: () => abrirHoja(p) },
    },
      el('div', { clase: 'plato-btn__foto' },
        p.urlImagen
          ? el('img', { attrs: { src: p.urlImagen, alt: '', loading: 'lazy' } })
          : el('span', { attrs: { 'aria-hidden': 'true' }, texto: '🍽' })
      ),
      el('div', { clase: 'plato-btn__cuerpo' },
        el('div', { clase: 'plato-btn__nombre', texto: p.nombre }),
        el('div', { clase: 'plato-btn__precio', texto: formatearDinero(p.precioBase) })
      )
    );
  }));
}

$('buscar-plato').addEventListener('input', retrasar((e) => {
  estado.buscar = e.target.value.trim();
  pintarMenu();
}, 200));

/* ---------------------------------------------------------------
   Bottom sheet de modificadores
   --------------------------------------------------------------- */
const hoja = $('hoja-plato');

async function abrirHoja(producto) {
  estado.platoActual = producto;
  estado.seleccion = new Map();
  estado.cantidad = 1;
  $('hoja-titulo').textContent = producto.nombre;
  $('hoja-cantidad').textContent = '1';
  $('notas-plato').value = '';

  // Se cargan los grupos de modificadores del plato.
  try {
    const r = await api.get(`/catalogo/modificadores`);
    estado.grupos = r.grupos.filter((g) => g.asociados.some((a) => a.id === producto.id));
  } catch {
    estado.grupos = [];
  }

  pintarGrupos();
  hoja.showModal();
}

function pintarGrupos() {
  if (!estado.grupos.length) {
    reemplazar($('grupos-modificadores'), el('p', { clase: 'texto-tenue texto-sm' },
      'Este plato no tiene opciones. Solo indique la cantidad.'));
    validarObligatorios();
    return;
  }

  reemplazar($('grupos-modificadores'), ...estado.grupos.map((g) => {
    // Radios para "exactamente uno", checkboxes para el resto (FSD 4.2 vista 12).
    const exclusivo = g.obligatorio && g.seleccionMax === 1;
    const sel = estado.seleccion.get(g.id) ?? new Set();

    return el('div', { clase: 'grupo-mod' },
      el('div', { clase: 'grupo-mod__titulo' },
        g.nombre,
        g.obligatorio
          ? el('span', { clase: 'insignia insignia--alerta', texto: 'Obligatorio' })
          : el('span', { clase: 'texto-tenue texto-sm', texto: `Hasta ${g.seleccionMax}` })
      ),
      ...g.opciones.filter((o) => o.activo).map((o) => {
        const elegida = sel.has(o.id);
        return el('label', { clase: `opcion-mod ${elegida ? 'opcion-mod--elegida' : ''}` },
          el('input', {
            attrs: {
              type: exclusivo ? 'radio' : 'checkbox',
              name: `grupo-${g.id}`,
              checked: elegida,
            },
            on: { change: () => alternarOpcion(g, o.id, exclusivo) },
          }),
          el('span', { clase: 'opcion-mod__nombre', texto: o.nombre }),
          Number(o.precioExtra) > 0
            ? el('span', { clase: 'opcion-mod__precio', texto: `+${formatearDinero(o.precioExtra)}` })
            : null
        );
      })
    );
  }));

  validarObligatorios();
}

function alternarOpcion(grupo, idOpcion, exclusivo) {
  let sel = estado.seleccion.get(grupo.id) ?? new Set();

  if (exclusivo) {
    sel = new Set([idOpcion]);
  } else if (sel.has(idOpcion)) {
    sel.delete(idOpcion);
  } else {
    if (sel.size >= grupo.seleccionMax) {
      aviso(`En "${grupo.nombre}" puede elegir hasta ${grupo.seleccionMax}.`, 'info', 2500);
      pintarGrupos();
      return;
    }
    sel.add(idOpcion);
  }

  estado.seleccion.set(grupo.id, sel);
  pintarGrupos();
}

/**
 * Habilita "Agregar" solo si se cumplen los grupos obligatorios
 * (FSD 4.2 vista 12). Es UX: el servidor lo revalida igual.
 */
function validarObligatorios() {
  const cumple = estado.grupos.every((g) => {
    if (!g.obligatorio) return true;
    const sel = estado.seleccion.get(g.id) ?? new Set();
    return sel.size >= g.seleccionMin;
  });
  $('btn-agregar').disabled = !cumple;
}

$('hoja-mas').addEventListener('click', () => {
  estado.cantidad = Math.min(99, estado.cantidad + 1);
  $('hoja-cantidad').textContent = String(estado.cantidad);
});
$('hoja-menos').addEventListener('click', () => {
  estado.cantidad = Math.max(1, estado.cantidad - 1);
  $('hoja-cantidad').textContent = String(estado.cantidad);
});
$('btn-cerrar-hoja').addEventListener('click', () => hoja.close());

$('btn-agregar').addEventListener('click', async () => {
  const modificadores = [...estado.seleccion.values()].flatMap((s) => [...s]);

  const btn = $('btn-agregar');
  btn.disabled = true;
  btn.textContent = 'Agregando…';

  try {
    await api.post(`/ordenes/${idOrden}/lineas`, {
      idProducto: estado.platoActual.id,
      cantidad: estado.cantidad,
      notas: $('notas-plato').value.trim() || null,
      tiempoSalida: sugerirTiempo(estado.platoActual),
      modificadores,
    });
    hoja.close();
    aviso(`${estado.cantidad} × ${estado.platoActual.nombre} agregado.`, 'exito', 2000);
    await cargarOrden();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.datos?.agotado) {
      aviso(`"${estado.platoActual.nombre}" se agotó.`, 'error');
      hoja.close();
      await cargarMenu();
    } else {
      aviso(error.message, 'error', 6000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Agregar';
  }
});

/** Sugiere el tiempo de salida según la categoría (entradas=1, postres=3). */
function sugerirTiempo(producto) {
  const cat = estado.categorias.find((c) => c.id === producto.idCategoria);
  const nombre = (cat?.nombre ?? '').toLowerCase();
  if (nombre.includes('entrada')) return 1;
  if (nombre.includes('postre')) return 3;
  if (nombre.includes('bebida') || nombre.includes('coctel')) return 1;
  return 2;
}

/* ---------------------------------------------------------------
   Resumen (vista 13)
   --------------------------------------------------------------- */
function contarNoEnviadas() {
  return (estado.orden?.lineas ?? []).filter((l) => !l.enviada && l.estadoPreparacion !== 'anulado').length;
}

function pintarResumen() {
  const lineas = (estado.orden?.lineas ?? []).filter((l) => l.estadoPreparacion !== 'anulado');

  if (!lineas.length) {
    reemplazar($('lista-resumen'), el('div', { clase: 'vacio' },
      el('p', { texto: 'La comanda está vacía.' }),
      el('p', { clase: 'texto-sm' }, 'Agregue platos desde la pestaña anterior.')));
    reemplazar($('totales'));
    return;
  }

  // Agrupadas por tiempo de salida (FSD 4.2 vista 13).
  const porTiempo = new Map();
  for (const l of lineas) {
    if (!porTiempo.has(l.tiempoSalida)) porTiempo.set(l.tiempoSalida, []);
    porTiempo.get(l.tiempoSalida).push(l);
  }

  const secciones = [...porTiempo.keys()].sort((a, b) => a - b).map((t) =>
    el('div', { clase: 'tiempo-grupo' },
      el('div', { clase: 'tiempo-grupo__titulo' }, TIEMPOS[t] ?? `Tiempo ${t}`),
      ...porTiempo.get(t).map(filaLinea)
    )
  );

  reemplazar($('lista-resumen'), ...secciones);
  pintarTotales(lineas);
}

function filaLinea(l) {
  const subtotal = calcularSubtotalLinea(l);

  const acciones = [];
  if (!l.enviada) {
    // Solo las líneas no enviadas se pueden mover o quitar (FSD 4.2 vista 13).
    acciones.push(
      el('button', {
        clase: 'btn btn--plano btn--sm',
        attrs: { type: 'button', 'aria-label': `Mover ${l.producto} a otro tiempo` },
        on: { click: () => abrirModalTiempo(l) },
      }, '⇄'),
      el('button', {
        clase: 'btn btn--plano btn--sm',
        attrs: { type: 'button', 'aria-label': `Quitar ${l.producto}` },
        on: { click: () => quitarLinea(l) },
      }, '🗑')
    );
  } else {
    // Las enviadas quedan bloqueadas; anularlas es otra operación.
    acciones.push(el('span', { clase: `chip-estado chip-estado--${l.estadoPreparacion}` },
      etiquetaPrep(l.estadoPreparacion)));
  }

  return el('div', { clase: `linea-pedido ${l.enviada ? 'linea-pedido--enviada' : ''}` },
    el('span', { clase: 'linea-pedido__cant', texto: `${l.cantidad}×` }),
    el('div', { clase: 'linea-pedido__cuerpo' },
      el('div', { clase: 'linea-pedido__nombre', texto: l.producto }),
      l.modificadores.length
        ? el('div', { clase: 'linea-pedido__mods', texto: l.modificadores.map((m) => m.nombre).join(', ') })
        : null,
      // Las notas se muestran con textContent: nunca se interpretan como HTML.
      l.notas ? el('div', { clase: 'linea-pedido__notas', texto: `📝 ${l.notas}` }) : null
    ),
    el('div', {},
      el('div', { clase: 'linea-pedido__precio', texto: formatearDinero(subtotal) }),
      el('div', { clase: 'fila fila--fin' }, ...acciones)
    )
  );
}

function etiquetaPrep(e) {
  return { en_cola: 'En cola', preparando: 'Preparando', listo: 'Listo', servido: 'Servido' }[e] ?? e;
}

/**
 * Subtotal de una línea SOLO para mostrar en el comandero. El total real y
 * fiscal lo calcula el servidor al cobrar (FSD 5.7): aquí es orientativo.
 */
function calcularSubtotalLinea(l) {
  const base = Number(l.precioUnitario) ||
    Number(estado.productos.find((p) => p.id === l.idProducto)?.precioBase ?? 0);
  const extras = l.modificadores.reduce((s, m) => s + Number(m.precioExtra), 0);
  return (base + extras) * l.cantidad;
}

function pintarTotales(lineas) {
  // Aviso claro: el precio definitivo lo pone la caja (FSD 5.7).
  const estimado = lineas.reduce((s, l) => s + calcularSubtotalLinea(l), 0);
  reemplazar($('totales'),
    el('div', { clase: 'tarjeta__cuerpo' },
      el('div', { clase: 'fila fila--entre' },
        el('strong', { texto: 'Total estimado' }),
        el('strong', { texto: formatearDinero(estimado) })
      ),
      el('p', { clase: 'texto-tenue texto-sm', attrs: { style: 'margin:.4rem 0 0' } },
        'Valor orientativo. El total final, con impuestos y descuentos, lo calcula la caja.')
    )
  );
}

async function quitarLinea(l) {
  try {
    await api.borrar(`/ordenes/${idOrden}/lineas/${l.id}`);
    await cargarOrden();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Mover entre tiempos
   --------------------------------------------------------------- */
const modalTiempo = $('modal-tiempo');
let lineaAMover = null;

function abrirModalTiempo(l) {
  lineaAMover = l;
  reemplazar($('opciones-tiempo'), ...Object.entries(TIEMPOS).map(([t, nombre]) =>
    el('button', {
      clase: `btn btn--bloque ${l.tiempoSalida === Number(t) ? 'btn--primario' : 'btn--secundario'}`,
      attrs: { type: 'button', style: 'margin-bottom:.4rem' },
      on: { click: () => moverATiempo(Number(t)) },
    }, nombre)
  ));
  modalTiempo.showModal();
}

async function moverATiempo(tiempo) {
  try {
    await api.put(`/ordenes/${idOrden}/tiempos`, {
      lineas: [{ id: lineaAMover.id, tiempoSalida: tiempo }],
    });
    modalTiempo.close();
    await cargarOrden();
  } catch (error) {
    aviso(error.message, 'error');
  }
}
$('btn-cerrar-tiempo').addEventListener('click', () => modalTiempo.close());

/* ---------------------------------------------------------------
   Enviar y pre-cuenta
   --------------------------------------------------------------- */
$('btn-enviar').addEventListener('click', async () => {
  if (!contarNoEnviadas()) {
    aviso('No hay platos nuevos que enviar.', 'info');
    return;
  }

  const btn = $('btn-enviar');
  btn.disabled = true;

  try {
    const r = await api.post(`/ordenes/${idOrden}/enviar`);
    let msg = `Enviado: ${r.aCocina} a cocina, ${r.aBarra} a barra.`;
    aviso(msg, 'exito', 4000);

    // Aviso de stock crítico si el envío lo disparó (RF-09).
    if (r.stockCritico?.length) {
      aviso(`Atención: ${r.stockCritico.map((c) => c.nombre).join(', ')} en stock crítico.`, 'alerta', 6000);
    }
    await cargarOrden();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.datos?.agotado) {
      aviso(error.message, 'error', 8000);
      await cargarMenu();
    } else {
      aviso(error.message, 'error', 7000);
    }
  } finally {
    btn.disabled = false;
  }
});

$('btn-precuenta').addEventListener('click', async () => {
  const ok = await confirmar({
    titulo: 'Solicitar pre-cuenta',
    mensaje: 'La mesa pasará a amarillo y se avisará a la caja. ¿Continuar?',
    textoConfirmar: 'Solicitar',
  });
  if (!ok) return;

  try {
    await api.post(`/ordenes/${idOrden}/precuenta`);
    aviso('Pre-cuenta solicitada. La caja fue notificada.', 'exito');
    await cargarOrden();
  } catch (error) {
    aviso(error.message, 'error');
  }
});

/* ---------------------------------------------------------------
   Tiempo real
   --------------------------------------------------------------- */
// Cuando cocina marca un plato de esta mesa, se refresca el resumen.
canal.on('linea.estado', (d) => {
  if (d.idOrden === idOrden) cargarOrden();
});
// Un plato agotado desde el KDS actualiza el menú (CA-02).
canal.on('producto.agotado', (d) => {
  const p = estado.productos.find((x) => x.id === d.idProducto);
  if (p) { p.disponible = d.disponible; pintarMenu(); }
});

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarMenu() {
  const [cats, prods] = await Promise.all([
    api.get('/catalogo/categorias'),
    api.get('/catalogo/productos'),
  ]);
  estado.categorias = cats.categorias;
  estado.productos = prods.productos;
  pintarCategorias();
  pintarMenu();
}

async function cargarOrden() {
  const orden = await api.get(`/ordenes/${idOrden}`);
  estado.orden = orden;

  $('titulo-mesa').textContent = `Mesa ${orden.mesa}`;
  $('sub-mesa').textContent = `${orden.zona} · ${orden.numComensales} personas · ${orden.mesero}`;

  const noEnviadas = contarNoEnviadas();
  $('conteo-resumen').textContent = orden.lineas.length ? `(${orden.lineas.filter(l=>l.estadoPreparacion!=='anulado').length})` : '';

  // Barra inferior del carrito.
  const barra = $('barra-carrito');
  if (noEnviadas > 0 && !$('panel-menu').classList.contains('oculto')) {
    barra.classList.remove('oculto');
    $('carrito-conteo').textContent = `${noEnviadas} ítem(s) sin enviar`;
    const estimado = orden.lineas.filter((l) => !l.enviada && l.estadoPreparacion !== 'anulado')
      .reduce((s, l) => s + calcularSubtotalLinea(l), 0);
    $('carrito-total').textContent = formatearDinero(estimado);
  } else {
    barra.classList.add('oculto');
  }

  pintarResumen();
}

async function cargarTodo() {
  try {
    await Promise.all([cargarMenu(), cargarOrden()]);
  } catch (error) {
    if (error.estado === 404) {
      aviso('Esa comanda ya no existe.', 'error');
      setTimeout(() => { window.location.href = '/comandero/'; }, 1500);
    } else {
      aviso(error.message, 'error');
    }
  }
}

await cargarTodo();
mostrarPanel('menu');
