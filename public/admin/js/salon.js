/**
 * Vista 2: Diseñador de Distribución y Mapa de Mesas.  RF-04.
 *
 * FSD 4.1 vista 2:
 *  - HTML5 Drag and Drop API: arrastrar formas de la paleta al lienzo.
 *  - Al soltar se abre el panel de propiedades: numero unico (validado en vivo
 *    contra la API), capacidad 1-30, forma.
 *  - mousedown/mousemove para reposicionar; snap a rejilla de 10 px.
 *  - "Guardar distribucion" persiste en lote (PUT /salon/zonas/:id/mesas).
 *  - Confirmacion antes de eliminar una mesa con historial (solo baja logica).
 *  - Tablet: arrastre tactil. Movil: solo lectura.
 *
 * FSD 6.4: "Alternativas accesibles a Drag & Drop (mover por botones) en el
 * diseñador de salon". Aqui hay tres formas de colocar una mesa: arrastrarla,
 * pulsar la forma en la paleta (aparece en el centro), y moverla con las
 * flechas del teclado o los botones del panel. El arrastre nunca es la unica via.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar } from '/comun/ui.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('salon.ver');
if (!sesion) throw new Error('sin sesion');

const puedeEditar = tienePermiso('salon.gestionar');

/** Rejilla de 10 px que pide el FSD. Se traduce a % segun el ancho del lienzo. */
const REJILLA_PX = 10;

/** Tamaño inicial (en % del lienzo) de cada forma al crearla. */
const TAMANO_POR_FORMA = {
  redonda:     { ancho: 12, alto: 16 },
  cuadrada:    { ancho: 10, alto: 14 },
  rectangular: { ancho: 20, alto: 16 },
  barra:       { ancho: 8,  alto: 10 },
};

const CAPACIDAD_POR_FORMA = { redonda: 4, cuadrada: 2, rectangular: 6, barra: 1 };

const estado = {
  zonas: [],
  zonaActiva: null,
  /** Mesas de la zona activa, con los cambios sin guardar. */
  mesas: [],
  /** Copia tal como esta en el servidor, para poder descartar. */
  original: [],
  /**
   * Mesa cuyas propiedades se editan en el panel lateral.
   *
   * Con varias mesas seleccionadas es la última que se tocó: el panel edita
   * una sola, porque cambiar el número o la forma de un grupo entero no tiene
   * sentido (el número es único por zona).
   */
  seleccionada: null,
  /**
   * Selección múltiple: conjunto de `idLocal`.
   *
   * Se guarda aparte de `seleccionada` en vez de sustituirla porque son dos
   * cosas distintas: esta decide qué se resalta y qué se borra en lote;
   * aquella, qué se edita en el panel. Siempre contiene a `seleccionada`.
   */
  seleccion: new Set(),
  contadorNuevas: 0,
};

const $ = (id) => document.getElementById(id);
const lienzo = $('lienzo');

/* ---------------------------------------------------------------
   Utilidades de geometria
   --------------------------------------------------------------- */

/** Ajusta un valor en % a la rejilla de 10 px del lienzo actual. */
function ajustarARejilla(porcentaje, dimensionPx) {
  const px = (porcentaje / 100) * dimensionPx;
  const ajustado = Math.round(px / REJILLA_PX) * REJILLA_PX;
  return (ajustado / dimensionPx) * 100;
}

/** Mantiene la mesa dentro del lienzo. */
function acotar(valor, tamano) {
  return Math.max(0, Math.min(100 - tamano, valor));
}

function hayCambios() {
  if (estado.mesas.length !== estado.original.length) return true;
  return estado.mesas.some((m) => {
    const o = estado.original.find((x) => x.id === m.id);
    if (!o) return true;
    return o.numero !== m.numero || o.forma !== m.forma || o.capacidad !== m.capacidad ||
           Math.abs(o.posX - m.posX) > 0.01 || Math.abs(o.posY - m.posY) > 0.01 ||
           Math.abs(o.ancho - m.ancho) > 0.01 || Math.abs(o.alto - m.alto) > 0.01;
  });
}

function marcarCambio() {
  const cambios = hayCambios();
  $('barra-guardado').classList.toggle('oculto', !cambios || !puedeEditar);
  $('marca-sin-guardar').classList.toggle('oculto', !cambios);
  if (cambios) {
    $('texto-pendientes').textContent =
      `Hay cambios sin guardar en "${estado.zonaActiva?.nombre}".`;
  }
  $('conteo-mesas').textContent = `${estado.mesas.length} mesa(s)`;
}

/* ---------------------------------------------------------------
   Pestañas de zona
   --------------------------------------------------------------- */
function pintarZonas() {
  reemplazar($('zonas-pestanas'), ...estado.zonas.map((z) => {
    const activa = estado.zonaActiva?.id === z.id;
    return el('button', {
      clase: `zona-pestana ${activa ? 'zona-pestana--activa' : ''} ${z.activa ? '' : 'zona-pestana--inactiva'}`,
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(activa) },
      on: { click: () => seleccionarZona(z) },
    },
      z.nombre,
      el('span', { clase: 'zona-pestana__conteo', texto: String(z.mesas.length) }),
      z.activa ? null : el('span', { attrs: { title: 'Zona desactivada' } }, '⊘')
    );
  }));
}

async function seleccionarZona(zona) {
  if (hayCambios()) {
    const ok = await confirmar({
      titulo: 'Cambios sin guardar',
      mensaje: `Tiene cambios sin guardar en "${estado.zonaActiva.nombre}". Si cambia de zona se perderán.`,
      textoConfirmar: 'Descartar y continuar',
      peligro: true,
    });
    if (!ok) return;
  }

  estado.zonaActiva = zona;
  // Copia profunda: se edita sobre ella sin tocar el original hasta guardar.
  estado.mesas = zona.mesas.map((m) => ({ ...m }));
  estado.original = zona.mesas.map((m) => ({ ...m }));
  estado.seleccionada = null;
  estado.seleccion.clear();

  $('zona-titulo').textContent = zona.nombre;
  pintarZonas();
  pintarAccionesZona();
  pintarLienzo();
  pintarPropiedades();
  marcarCambio();
}

function pintarAccionesZona() {
  const z = estado.zonaActiva;
  if (!z || !puedeEditar) return reemplazar($('acciones-zona'));

  reemplazar($('acciones-zona'),
    el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: () => abrirModalZona(z) },
    }, 'Editar zona'),
    el('button', {
      clase: 'btn btn--peligro btn--sm',
      attrs: { type: 'button' },
      on: { click: () => eliminarZona(z) },
    }, 'Eliminar zona')
  );
}

/* ---------------------------------------------------------------
   Lienzo
   --------------------------------------------------------------- */
function pintarLienzo() {
  if (!estado.mesas.length) {
    reemplazar(lienzo, el('div', { clase: 'lienzo__vacio' },
      el('p', {}, 'Esta zona no tiene mesas todavía.'),
      puedeEditar ? el('p', { clase: 'texto-sm' }, 'Arrastre una forma de la paleta, o púlsela para añadirla al centro.') : null
    ));
    return;
  }

  reemplazar(lienzo, ...estado.mesas.map((m) => {
    const enSeleccion = estado.seleccion.has(m.idLocal);
    // La "principal" es la que edita el panel de propiedades. Se marca aparte
    // para que, con varias seleccionadas, se vea cuál se está editando.
    const esPrincipal = estado.seleccionada === m.idLocal;

    const nodo = el('button', {
      clase: [
        'mesa', `mesa--${m.forma}`,
        enSeleccion ? 'mesa--seleccionada' : '',
        esPrincipal && estado.seleccion.size > 1 ? 'mesa--principal' : '',
        m.conOrdenAbierta ? 'mesa--ocupada' : '',
        m.esNueva ? 'mesa--nueva' : '',
      ].filter(Boolean).join(' '),
      attrs: {
        type: 'button',
        style: `left:${m.posX}%; top:${m.posY}%; width:${m.ancho}%; height:${m.alto}%`,
        // El lector de pantalla necesita saber qué mesa es y en qué estado está
        // sin depender del color (6.4).
        'aria-label': `Mesa ${m.numero}, ${m.forma}, capacidad ${m.capacidad}` +
                      (m.conOrdenAbierta ? ', con comanda abierta' : '') +
                      (enSeleccion ? '. Seleccionada' : ''),
        'aria-pressed': String(enSeleccion),
        // Lo lee el repintado rápido del rectángulo de selección, que cambia
        // clases sin recrear los nodos.
        'data-id-local': String(m.idLocal),
      },
      on: {
        // Ctrl (o Cmd en Mac) y Shift añaden o quitan de la selección en vez
        // de reemplazarla, que es la convención de cualquier editor gráfico.
        click: (e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey || e.shiftKey) alternarEnSeleccion(m.idLocal);
          else seleccionarMesa(m.idLocal);
        },
        mousedown: (e) => iniciarArrastre(e, m),
        touchstart: (e) => iniciarArrastre(e, m),
        keydown: (e) => moverConTeclado(e, m),
      },
    },
      el('span', { clase: 'mesa__numero', texto: m.numero }),
      el('span', { clase: 'mesa__capacidad', texto: `${m.capacidad}p` }),
      // El candado no es decorativo: indica que no se puede quitar del plano.
      m.conOrdenAbierta ? el('span', { clase: 'mesa__candado', attrs: { title: 'Comanda abierta' } }, '🔒') : null
    );

    return nodo;
  }));
}

/** Selección exclusiva: descarta lo anterior y deja solo esta mesa. */
function seleccionarMesa(idLocal) {
  estado.seleccionada = idLocal;
  estado.seleccion = new Set(idLocal === null ? [] : [idLocal]);
  pintarLienzo();
  pintarPropiedades();
  pintarAccionesSeleccion();
}

/** Añade o quita una mesa de la selección, sin tocar el resto. */
function alternarEnSeleccion(idLocal) {
  if (estado.seleccion.has(idLocal)) {
    estado.seleccion.delete(idLocal);
    // Si se quitó la que editaba el panel, pasa a editarse otra cualquiera de
    // las que quedan: dejar el panel apuntando a una mesa no seleccionada
    // confundiría sobre qué se está tocando.
    if (estado.seleccionada === idLocal) {
      estado.seleccionada = estado.seleccion.values().next().value ?? null;
    }
  } else {
    estado.seleccion.add(idLocal);
    estado.seleccionada = idLocal;
  }
  pintarLienzo();
  pintarPropiedades();
  pintarAccionesSeleccion();
}

/** Vacía la selección. */
function limpiarSeleccion() {
  estado.seleccionada = null;
  estado.seleccion.clear();
  pintarLienzo();
  pintarPropiedades();
  pintarAccionesSeleccion();
}

/** Selecciona TODAS las mesas de la zona. */
function seleccionarTodas() {
  if (!puedeEditar || !estado.mesas.length) return;
  estado.seleccion = new Set(estado.mesas.map((m) => m.idLocal));
  estado.seleccionada = estado.mesas[0].idLocal;
  pintarLienzo();
  pintarPropiedades();
  pintarAccionesSeleccion();
}

/* ---------------------------------------------------------------
   Arrastre para reposicionar (mouse y táctil)
   FSD 4.1: "mousedown/mousemove para reposicionar; snap a rejilla de 10 px";
   "en tablet se permite arrastre táctil (touchstart/touchmove)".
   --------------------------------------------------------------- */
function iniciarArrastre(evento, mesa) {
  if (!puedeEditar) return;
  if (evento.type === 'mousedown' && evento.button !== 0) return;

  evento.preventDefault();
  seleccionarMesa(mesa.idLocal);

  const rect = lienzo.getBoundingClientRect();
  const punto = evento.touches ? evento.touches[0] : evento;

  // Desplazamiento entre el punto agarrado y la esquina de la mesa: sin esto
  // la mesa "salta" al cursor al empezar a arrastrar.
  const inicioX = ((punto.clientX - rect.left) / rect.width) * 100 - mesa.posX;
  const inicioY = ((punto.clientY - rect.top) / rect.height) * 100 - mesa.posY;

  let movio = false;

  const mover = (e) => {
    const p = e.touches ? e.touches[0] : e;
    const x = ((p.clientX - rect.left) / rect.width) * 100 - inicioX;
    const y = ((p.clientY - rect.top) / rect.height) * 100 - inicioY;

    mesa.posX = acotar(ajustarARejilla(x, rect.width), mesa.ancho);
    mesa.posY = acotar(ajustarARejilla(y, rect.height), mesa.alto);
    movio = true;

    // Se mueve el nodo directamente en vez de repintar todo el lienzo: repintar
    // en cada mousemove destruiría el nodo que se está arrastrando.
    const nodo = lienzo.querySelector('.mesa--seleccionada');
    if (nodo) {
      nodo.style.left = `${mesa.posX}%`;
      nodo.style.top = `${mesa.posY}%`;
    }
  };

  const soltar = () => {
    document.removeEventListener('mousemove', mover);
    document.removeEventListener('mouseup', soltar);
    document.removeEventListener('touchmove', mover);
    document.removeEventListener('touchend', soltar);
    if (movio) { pintarPropiedades(); marcarCambio(); }
  };

  document.addEventListener('mousemove', mover);
  document.addEventListener('mouseup', soltar);
  document.addEventListener('touchmove', mover, { passive: false });
  document.addEventListener('touchend', soltar);
}

/**
 * Alternativa accesible al arrastre (FSD 6.4): mover con las flechas.
 * Shift acelera el desplazamiento; sin Shift avanza de a un paso de rejilla.
 */
function moverConTeclado(evento, mesa) {
  if (!puedeEditar) return;

  const pasos = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const paso = pasos[evento.key];

  if (evento.key === 'Delete' || evento.key === 'Backspace') {
    evento.preventDefault();
    return quitarMesa(mesa);
  }
  if (!paso) return;

  evento.preventDefault();
  const rect = lienzo.getBoundingClientRect();
  const avanceX = (REJILLA_PX / rect.width) * 100 * (evento.shiftKey ? 5 : 1);
  const avanceY = (REJILLA_PX / rect.height) * 100 * (evento.shiftKey ? 5 : 1);

  mesa.posX = acotar(mesa.posX + paso[0] * avanceX, mesa.ancho);
  mesa.posY = acotar(mesa.posY + paso[1] * avanceY, mesa.alto);

  seleccionarMesa(mesa.idLocal);
  marcarCambio();
  // Se devuelve el foco a la mesa: el repintado lo habría perdido y el
  // usuario que navega con teclado quedaría desorientado.
  lienzo.querySelector('.mesa--seleccionada')?.focus();
}

/* ---------------------------------------------------------------
   Alta de mesas: arrastre desde la paleta y pulsación directa
   --------------------------------------------------------------- */
function crearMesa(forma, posX, posY) {
  const tam = TAMANO_POR_FORMA[forma];
  estado.contadorNuevas++;

  // Número tentativo, único dentro de lo que hay en pantalla. El usuario lo
  // cambia en el panel; la unicidad real la valida el servidor.
  const prefijo = (estado.zonaActiva.nombre[0] ?? 'M').toUpperCase();
  let n = estado.mesas.length + 1;
  let numero = `${prefijo}${n}`;
  while (estado.mesas.some((m) => m.numero === numero)) {
    n++;
    numero = `${prefijo}${n}`;
  }

  const mesa = {
    id: null,
    idLocal: `nueva-${estado.contadorNuevas}`,
    idZona: estado.zonaActiva.id,
    numero,
    forma,
    capacidad: CAPACIDAD_POR_FORMA[forma],
    posX: acotar(posX, tam.ancho),
    posY: acotar(posY, tam.alto),
    ancho: tam.ancho,
    alto: tam.alto,
    estado: 'libre',
    activa: true,
    conOrdenAbierta: false,
    esNueva: true,
  };

  estado.mesas.push(mesa);
  seleccionarMesa(mesa.idLocal);
  marcarCambio();
  return mesa;
}

// Arrastre desde la paleta (HTML5 Drag and Drop API, FSD 4.1).
for (const item of document.querySelectorAll('.paleta__item')) {
  item.addEventListener('dragstart', (e) => {
    if (!puedeEditar) return e.preventDefault();
    e.dataTransfer.setData('text/plain', item.dataset.forma);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Alternativa accesible: pulsar la forma la coloca en el centro (6.4).
  item.addEventListener('click', () => {
    if (!puedeEditar || !estado.zonaActiva) return;
    const m = crearMesa(item.dataset.forma, 45, 45);
    aviso(`Mesa ${m.numero} añadida al centro. Muévala con las flechas o arrastrándola.`, 'info', 4000);
  });
}

lienzo.addEventListener('dragover', (e) => {
  if (!puedeEditar) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  lienzo.classList.add('lienzo--soltando');
});
lienzo.addEventListener('dragleave', () => lienzo.classList.remove('lienzo--soltando'));

lienzo.addEventListener('drop', (e) => {
  if (!puedeEditar || !estado.zonaActiva) return;
  e.preventDefault();
  lienzo.classList.remove('lienzo--soltando');

  const forma = e.dataTransfer.getData('text/plain');
  if (!TAMANO_POR_FORMA[forma]) return;

  const rect = lienzo.getBoundingClientRect();
  const tam = TAMANO_POR_FORMA[forma];
  // Se centra la forma en el punto donde se soltó.
  const x = ajustarARejilla(((e.clientX - rect.left) / rect.width) * 100 - tam.ancho / 2, rect.width);
  const y = ajustarARejilla(((e.clientY - rect.top) / rect.height) * 100 - tam.alto / 2, rect.height);

  crearMesa(forma, x, y);
});

/* ---------------------------------------------------------------
   Panel de propiedades
   --------------------------------------------------------------- */
const validarNumeroEnServidor = retrasar(async (mesa, valor, spanError, spanAviso) => {
  if (!valor) return;
  try {
    const params = new URLSearchParams({ numero: valor, idZona: String(estado.zonaActiva.id) });
    if (mesa.id) params.set('excluir', String(mesa.id));
    const r = await api.get(`/salon/mesas/disponibilidad?${params}`);

    // Colisión contra otra mesa del lienzo aún sin guardar: el servidor no
    // puede saberlo todavía, así que se comprueba también en local.
    const chocaEnLienzo = estado.mesas.some(
      (m) => m.idLocal !== mesa.idLocal && m.numero === valor
    );

    if (!r.disponible || chocaEnLienzo) {
      spanError.textContent = 'Ya hay una mesa con ese número en esta zona.';
      spanAviso.textContent = '';
    } else {
      spanError.textContent = '';
      // El número lo conserva una mesa retirada del plano. No es un fallo: al
      // guardar vuelve esa misma mesa con su historial. Va en un texto de ayuda
      // y no en el span con role="alert", que lo leería como un error.
      spanAviso.textContent = r.reactivara
        ? 'Ese número pertenece a una mesa retirada; al guardar volverá al plano con su historial de ventas.'
        : '';
    }
  } catch { /* si falla, el servidor lo rechazará al guardar */ }
}, 300);

function pintarPropiedades() {
  const mesa = estado.mesas.find((m) => m.idLocal === estado.seleccionada);

  if (!mesa) {
    reemplazar($('cuerpo-props'), el('div', { clase: 'vacio' },
      el('p', { clase: 'texto-sm', texto: 'Seleccione una mesa del plano para ver sus propiedades.' })));
    return;
  }

  const errorNumero = el('span', { clase: 'campo__error', attrs: { role: 'alert' } });
  const avisoNumero = el('p', { clase: 'campo__ayuda' });

  const campoNumero = el('div', { clase: 'campo' },
    el('label', { clase: 'campo__etiqueta', attrs: { for: 'p-numero' } }, 'Número'),
    el('input', {
      clase: 'campo__control',
      attrs: { id: 'p-numero', value: mesa.numero, maxlength: '10', disabled: !puedeEditar },
      on: {
        input: (e) => {
          mesa.numero = e.target.value.trim();
          validarNumeroEnServidor(mesa, mesa.numero, errorNumero, avisoNumero);
          lienzo.querySelector('.mesa--seleccionada .mesa__numero')?.replaceChildren(mesa.numero);
          marcarCambio();
        },
      },
    }),
    errorNumero,
    avisoNumero
  );

  const campoCapacidad = el('div', { clase: 'campo' },
    el('label', { clase: 'campo__etiqueta', attrs: { for: 'p-capacidad' } }, 'Capacidad (1 a 30)'),
    el('input', {
      clase: 'campo__control',
      attrs: { id: 'p-capacidad', type: 'number', min: '1', max: '30', value: String(mesa.capacidad), disabled: !puedeEditar },
      on: {
        input: (e) => {
          const v = Number(e.target.value);
          // El CHECK del esquema exige 1..30; aquí se acota para que el usuario
          // no llegue a enviar algo que la base va a rechazar.
          mesa.capacidad = Math.max(1, Math.min(30, Number.isFinite(v) ? v : 1));
          lienzo.querySelector('.mesa--seleccionada .mesa__capacidad')?.replaceChildren(`${mesa.capacidad}p`);
          marcarCambio();
        },
      },
    })
  );

  const campoForma = el('div', { clase: 'campo' },
    el('label', { clase: 'campo__etiqueta', attrs: { for: 'p-forma' } }, 'Forma'),
    el('select', {
      clase: 'campo__control',
      attrs: { id: 'p-forma', disabled: !puedeEditar },
      on: {
        change: (e) => {
          mesa.forma = e.target.value;
          const tam = TAMANO_POR_FORMA[mesa.forma];
          mesa.ancho = tam.ancho;
          mesa.alto = tam.alto;
          pintarLienzo();
          marcarCambio();
        },
      },
    },
      ...Object.keys(TAMANO_POR_FORMA).map((f) =>
        el('option', { attrs: { value: f, selected: f === mesa.forma }, texto: f }))
    )
  );

  // Movimiento por botones: la alternativa accesible al arrastre (6.4).
  const botonMover = (etiqueta, dx, dy, aria) => el('button', {
    clase: 'btn btn--secundario',
    attrs: { type: 'button', 'aria-label': aria, disabled: !puedeEditar },
    on: {
      click: () => {
        const rect = lienzo.getBoundingClientRect();
        mesa.posX = acotar(mesa.posX + dx * (REJILLA_PX / rect.width) * 100, mesa.ancho);
        mesa.posY = acotar(mesa.posY + dy * (REJILLA_PX / rect.height) * 100, mesa.alto);
        pintarLienzo();
        pintarPropiedades();
        marcarCambio();
      },
    },
  }, etiqueta);

  reemplazar($('cuerpo-props'),
    campoNumero,
    campoCapacidad,
    campoForma,

    el('div', { clase: 'campo' },
      el('span', { clase: 'campo__etiqueta' }, 'Posición'),
      el('div', { clase: 'mover-botones' },
        el('span', {}), botonMover('↑', 0, -1, 'Mover arriba'), el('span', {}),
        botonMover('←', -1, 0, 'Mover a la izquierda'),
        el('span', { clase: 'mover-botones__centro' }, `${Math.round(mesa.posX)},${Math.round(mesa.posY)}`),
        botonMover('→', 1, 0, 'Mover a la derecha'),
        el('span', {}), botonMover('↓', 0, 1, 'Mover abajo'), el('span', {})
      ),
      el('p', { clase: 'campo__ayuda' },
        'También puede usar las flechas del teclado con la mesa enfocada. Shift para ir más rápido.')
    ),

    mesa.conOrdenAbierta
      ? el('p', { clase: 'insignia insignia--error' }, '🔒 Tiene una comanda abierta')
      : null,

    puedeEditar
      ? el('button', {
          clase: 'btn btn--peligro btn--bloque',
          attrs: { type: 'button', disabled: mesa.conOrdenAbierta },
          on: { click: () => quitarMesa(mesa) },
        }, 'Quitar del plano')
      : null
  );
}

/**
 * Quita una mesa del lienzo. La consecuencia real (borrado o baja logica) la
 * decide el servidor al guardar, segun tenga historial o no.
 */
async function quitarMesa(mesa) {
  if (!puedeEditar) return;

  if (mesa.conOrdenAbierta) {
    aviso('Esa mesa tiene una comanda abierta. Ciérrela antes de quitarla del plano.', 'error', 6000);
    return;
  }

  // Las mesas ya guardadas pueden tener historial de ventas: el FSD exige
  // confirmar antes (vista 2), porque en ese caso solo se dan de baja.
  if (mesa.id) {
    const ok = await confirmar({
      titulo: `Quitar la mesa ${mesa.numero}`,
      mensaje: 'Si la mesa tiene ventas registradas, se dará de baja pero conservará su historial. Si no tiene ninguna, se eliminará. El cambio se aplica al guardar la distribución.',
      textoConfirmar: 'Quitar del plano',
      peligro: true,
    });
    if (!ok) return;
  }

  estado.mesas = estado.mesas.filter((m) => m.idLocal !== mesa.idLocal);
  estado.seleccionada = null;
  estado.seleccion.clear();
  pintarLienzo();
  pintarPropiedades();
  marcarCambio();
}

/* ---------------------------------------------------------------
   Selección por arrastre sobre el lienzo (rectángulo elástico)

   Arrastrar sobre una zona VACÍA del lienzo dibuja un rectángulo y selecciona
   todas las mesas que toca. Arrastrar sobre una mesa la mueve, como hasta
   ahora: el gesto se decide por dónde empieza, que es lo que hace cualquier
   editor gráfico.

   NO ES LA ÚNICA VÍA (README «Accesibilidad», FSD 6.4). Sin ratón se llega a lo
   mismo: Tab entre las mesas, Ctrl+Espacio para ir sumándolas, Ctrl+A para
   todas, Supr para quitarlas. El rectángulo es comodidad, no requisito.
   --------------------------------------------------------------- */

/** Rectángulo visible mientras se arrastra. Se crea y se destruye en el gesto. */
let nodoRectangulo = null;

function iniciarSeleccionPorArrastre(evento) {
  if (!puedeEditar) return;
  if (evento.button !== 0) return;
  // Si el gesto empieza encima de una mesa es un movimiento, no una selección.
  if (evento.target.closest('.mesa')) return;

  evento.preventDefault();
  const rect = lienzo.getBoundingClientRect();
  const inicioX = evento.clientX - rect.left;
  const inicioY = evento.clientY - rect.top;

  // Sin Ctrl ni Shift el arrastre empieza de cero. Con ellos suma a lo ya
  // seleccionado, lo que permite juntar dos grupos separados del plano.
  const acumula = evento.ctrlKey || evento.metaKey || evento.shiftKey;
  const previa = acumula ? new Set(estado.seleccion) : new Set();

  let arrastro = false;

  const mover = (e) => {
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Umbral de 4 px: evita que un clic con la mano poco firme se interprete
    // como arrastre y cambie la selección sin querer.
    if (!arrastro && Math.abs(x - inicioX) < 4 && Math.abs(y - inicioY) < 4) return;

    if (!arrastro) {
      arrastro = true;
      nodoRectangulo = el('div', { clase: 'lienzo__seleccion' });
      lienzo.append(nodoRectangulo);
      lienzo.classList.add('lienzo--seleccionando');
    }

    const izq = Math.min(inicioX, x);
    const arr = Math.min(inicioY, y);
    const ancho = Math.abs(x - inicioX);
    const alto = Math.abs(y - inicioY);

    Object.assign(nodoRectangulo.style, {
      left: `${izq}px`, top: `${arr}px`, width: `${ancho}px`, height: `${alto}px`,
    });

    // Las mesas guardan su posición en % del lienzo y el rectángulo está en
    // píxeles: hay que llevarlo al mismo sistema para poder compararlos.
    const caja = {
      x1: (izq / rect.width) * 100,
      y1: (arr / rect.height) * 100,
      x2: ((izq + ancho) / rect.width) * 100,
      y2: ((arr + alto) / rect.height) * 100,
    };

    const dentro = estado.mesas.filter((m) => seSolapan(m, caja));
    estado.seleccion = new Set([...previa, ...dentro.map((m) => m.idLocal)]);

    // Se cambian solo las clases, sin repintar el lienzo: recrear los nodos en
    // cada mousemove destruiría el rectángulo que se está dibujando.
    for (const nodo of lienzo.querySelectorAll('.mesa')) {
      const marcada = dentro.some((m) => String(m.idLocal) === nodo.dataset.idLocal) ||
        [...previa].some((id) => String(id) === nodo.dataset.idLocal);
      nodo.classList.toggle('mesa--seleccionada', marcada);
      nodo.setAttribute('aria-pressed', String(marcada));
    }
  };

  const soltar = () => {
    document.removeEventListener('mousemove', mover);
    document.removeEventListener('mouseup', soltar);
    nodoRectangulo?.remove();
    nodoRectangulo = null;
    lienzo.classList.remove('lienzo--seleccionando');

    if (!arrastro) {
      // Fue un clic en el vacío: se entiende como "deseleccionar todo".
      if (!acumula) limpiarSeleccion();
      return;
    }

    // La principal pasa a ser una de las seleccionadas: dejar el panel de
    // propiedades apuntando a una mesa que ya no está marcada confundiría
    // sobre qué se está editando.
    if (!estado.seleccion.has(estado.seleccionada)) {
      estado.seleccionada = estado.seleccion.values().next().value ?? null;
    }
    pintarLienzo();
    pintarPropiedades();
    pintarAccionesSeleccion();
  };

  document.addEventListener('mousemove', mover);
  document.addEventListener('mouseup', soltar);
}

/** ¿La mesa toca el rectángulo? Basta con que se solapen, no con contenerla. */
function seSolapan(mesa, caja) {
  return mesa.posX < caja.x2 && mesa.posX + mesa.ancho > caja.x1 &&
         mesa.posY < caja.y2 && mesa.posY + mesa.alto > caja.y1;
}

lienzo.addEventListener('mousedown', iniciarSeleccionPorArrastre);

/* ---------------------------------------------------------------
   Barra de selección múltiple
   --------------------------------------------------------------- */

/**
 * Barra flotante con lo que se puede hacer con la selección.
 *
 * Solo aparece con dos o más mesas: con una sola, el panel de propiedades ya
 * tiene su botón de quitar y otra barra sería ruido.
 */
function pintarAccionesSeleccion() {
  const barra = $('barra-seleccion');
  if (!barra) return;

  const n = estado.seleccion.size;
  const visible = puedeEditar && n > 1;
  barra.classList.toggle('oculto', !visible);
  if (!visible) return;

  const mesas = estado.mesas.filter((m) => estado.seleccion.has(m.idLocal));
  const conComanda = mesas.filter((m) => m.conOrdenAbierta);

  reemplazar(barra,
    el('span', { clase: 'barra-seleccion__conteo' }, `${n} mesas seleccionadas`),
    // Se avisa ANTES de pulsar, no después de fallar: si en el grupo hay mesas
    // con comanda abierta, esas no se van a poder quitar.
    conComanda.length
      ? el('span', { clase: 'barra-seleccion__aviso' },
          `⚠ ${conComanda.length} con comanda abierta, no se quitarán`)
      : null,
    el('span', { clase: 'crece' }),
    el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: limpiarSeleccion },
    }, 'Deseleccionar'),
    el('button', {
      clase: 'btn btn--peligro',
      attrs: { type: 'button' },
      on: { click: quitarSeleccionadas },
    }, `Quitar ${n - conComanda.length} del plano`)
  );
}

/**
 * Quita del plano todas las mesas seleccionadas de un solo golpe.
 *
 * UNA SOLA CONFIRMACIÓN para todo el grupo: preguntar mesa por mesa
 * convertiría esta función en algo más lento que borrarlas de una en una, que
 * es justo lo que se quiere evitar.
 *
 * Las que tienen comanda abierta se saltan en lugar de abortar la operación
 * entera: quitar las otras diez sigue siendo lo que el usuario quería.
 */
async function quitarSeleccionadas() {
  if (!puedeEditar) return;

  const mesas = estado.mesas.filter((m) => estado.seleccion.has(m.idLocal));
  const quitables = mesas.filter((m) => !m.conOrdenAbierta);
  const bloqueadas = mesas.filter((m) => m.conOrdenAbierta);

  if (!quitables.length) {
    aviso('Todas las mesas seleccionadas tienen una comanda abierta. Ciérrelas antes de quitarlas.',
      'error', 7000);
    return;
  }

  const nombres = quitables.map((m) => m.numero).join(', ');
  const ok = await confirmar({
    titulo: `Quitar ${quitables.length} mesa(s) del plano`,
    mensaje:
      `Se quitarán: ${nombres}.` +
      (bloqueadas.length
        ? ` Se conservarán ${bloqueadas.map((m) => m.numero).join(', ')}, que tienen comanda abierta.`
        : '') +
      ' Las que tengan ventas o reservas registradas se darán de baja conservando su historial; ' +
      'el resto se eliminarán. El cambio se aplica al guardar la distribución.',
    textoConfirmar: `Quitar ${quitables.length}`,
    peligro: true,
  });
  if (!ok) return;

  const aQuitar = new Set(quitables.map((m) => m.idLocal));
  estado.mesas = estado.mesas.filter((m) => !aQuitar.has(m.idLocal));

  // Las bloqueadas siguen seleccionadas: así se ve cuáles quedaron y por qué.
  estado.seleccion = new Set(bloqueadas.map((m) => m.idLocal));
  estado.seleccionada = estado.seleccion.values().next().value ?? null;

  pintarLienzo();
  pintarPropiedades();
  pintarAccionesSeleccion();
  marcarCambio();

  aviso(
    `${quitables.length} mesa(s) quitadas del plano.` +
    (bloqueadas.length ? ` ${bloqueadas.length} no se pudo por tener comanda abierta.` : '') +
    ' Pulse «Guardar distribución» para aplicarlo.',
    bloqueadas.length ? 'alerta' : 'exito', 7000
  );
}

/* ---------------------------------------------------------------
   Atajos de teclado sobre el plano

   Es la vía SIN RATÓN a todo lo anterior, y por eso no es opcional.
   --------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (!puedeEditar) return;

  // No se secuestra el teclado mientras se escribe en un campo.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  const enElPlano = lienzo.contains(e.target) || e.target === lienzo;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && enElPlano) {
    e.preventDefault();
    seleccionarTodas();
    return;
  }

  if (e.key === 'Escape' && estado.seleccion.size) {
    limpiarSeleccion();
    return;
  }

  // Ctrl+Espacio suma la mesa enfocada a la selección: el equivalente sin
  // ratón al Ctrl+clic.
  if ((e.ctrlKey || e.metaKey) && e.key === ' ' && e.target.classList?.contains('mesa')) {
    e.preventDefault();
    const mesa = estado.mesas.find((m) => String(m.idLocal) === e.target.dataset.idLocal);
    if (mesa) alternarEnSeleccion(mesa.idLocal);
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && enElPlano && estado.seleccion.size > 1) {
    e.preventDefault();
    quitarSeleccionadas();
  }
});

/* ---------------------------------------------------------------
   Guardado en lote (FSD 4.1 vista 2)
   --------------------------------------------------------------- */
$('btn-guardar').addEventListener('click', async () => {
  const btn = $('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const r = await api.put(`/salon/zonas/${estado.zonaActiva.id}/mesas`, {
      mesas: estado.mesas.map((m) => ({
        id: m.id, numero: m.numero, forma: m.forma, capacidad: m.capacidad,
        posX: m.posX, posY: m.posY, ancho: m.ancho, alto: m.alto,
      })),
    });

    const partes = [];
    if (r.creadas) partes.push(`${r.creadas} creada(s)`);
    if (r.reactivadas) partes.push(`${r.reactivadas} reactivada(s) con su historial`);
    if (r.actualizadas) partes.push(`${r.actualizadas} actualizada(s)`);
    if (r.eliminadas) partes.push(`${r.eliminadas} eliminada(s)`);
    if (r.desactivadas) partes.push(`${r.desactivadas} dada(s) de baja por tener historial`);
    aviso(`Distribución guardada: ${partes.join(', ') || 'sin cambios'}.`, 'exito', 6000);

    olvidarConflicto();
    await cargarPlano();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.datos?.campos) {
      const detalle = Object.values(error.datos.campos).join(' ');
      aviso(`${error.message} ${detalle}`, 'error', 9000);
    } else {
      aviso(error.message, 'error', 9000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar distribución';
  }
});

$('btn-descartar').addEventListener('click', async () => {
  estado.mesas = estado.original.map((m) => ({ ...m }));
  estado.seleccionada = null;
  estado.seleccion.clear();
  olvidarConflicto();
  // Se recarga del servidor en vez de volver a la copia local: si se descarta
  // es justamente porque alguien más tocó el plano y se quiere su versión.
  await cargarPlano();
  aviso('Cambios descartados.', 'info', 2500);
});

/* ---------------------------------------------------------------
   Zonas: alta, edición y baja
   --------------------------------------------------------------- */
const modalZona = $('modal-zona');
let zonaEnEdicion = null;

function abrirModalZona(zona = null) {
  zonaEnEdicion = zona;
  $('e-z-nombre').textContent = '';
  $('titulo-modal-zona').textContent = zona ? 'Editar zona' : 'Nueva zona';
  $('z-nombre').value = zona?.nombre ?? '';
  $('z-orden').value = String(zona?.ordenVisual ?? estado.zonas.length);
  modalZona.showModal();
  $('z-nombre').focus();
}

$('btn-nueva-zona').addEventListener('click', () => abrirModalZona(null));
$('btn-cerrar-zona').addEventListener('click', () => modalZona.close());
$('btn-cancelar-zona').addEventListener('click', () => modalZona.close());
if (!puedeEditar) $('btn-nueva-zona').classList.add('oculto');

$('form-zona').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('z-nombre').value.trim();
  const ordenVisual = Number($('z-orden').value) || 0;

  if (nombre.length < 2) {
    $('e-z-nombre').textContent = 'Mínimo 2 caracteres.';
    return;
  }

  try {
    if (zonaEnEdicion) {
      await api.put(`/salon/zonas/${zonaEnEdicion.id}`, { nombre, ordenVisual, activa: true });
      aviso('Zona actualizada.', 'exito');
    } else {
      await api.post('/salon/zonas', { nombre, ordenVisual });
      aviso(`Zona "${nombre}" creada.`, 'exito');
    }
    modalZona.close();
    await cargarPlano(zonaEnEdicion?.id);
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
});

async function eliminarZona(zona) {
  const ok = await confirmar({
    titulo: `Eliminar la zona "${zona.nombre}"`,
    mensaje: zona.mesas.length
      ? `La zona tiene ${zona.mesas.length} mesa(s). Deberá quitarlas antes.`
      : 'Se eliminará la zona. Esta acción no se puede deshacer.',
    textoConfirmar: 'Eliminar',
    peligro: true,
  });
  if (!ok) return;

  const borrar = (parametros = '') => api.borrar(`/salon/zonas/${zona.id}${parametros}`);

  try {
    let r;
    try {
      r = await borrar();
    } catch (error) {
      if (!(error instanceof ErrorPeticion)) throw error;

      // La zona conserva comandas cerradas sin facturar. Se pueden borrar, pero
      // no a espaldas del usuario: el servidor manda el recuento exacto y aquí
      // se pregunta una segunda vez diciendo qué se va a perder.
      if (error.datos?.requiereConfirmacion) {
        const seguro = await confirmar({
          titulo: `La zona "${zona.nombre}" tiene historial`,
          mensaje: `Conserva ${error.datos.mesas} mesa(s) retirada(s) del plano, con ` +
                   `${error.datos.ordenes} comanda(s) cerradas sin facturar. Al borrar la zona ` +
                   'ese historial se elimina. No se puede deshacer.',
          textoConfirmar: 'Borrar la zona y su historial',
          peligro: true,
        });
        if (!seguro) return;
        r = await borrar('?confirmarHistorial=1');

      // Hay ventas facturadas: eliminarla es imposible, ni siquiera para la
      // aplicación, porque una factura emitida no se borra nunca. La única
      // salida es retirarla del servicio, y se ofrece diciéndolo tal cual.
      } else if (error.datos?.requiereBajaLogica) {
        const seguro = await confirmar({
          titulo: `La zona "${zona.nombre}" tiene ventas facturadas`,
          mensaje: `Conserva ${error.datos.facturas} factura(s) de venta en ${error.datos.mesas} ` +
                   'mesa(s) retirada(s). Una factura emitida es inmutable y no se puede borrar, ' +
                   'así que la zona tampoco. Puede darla de baja: desaparece de comandero y caja, ' +
                   'y se queda aquí marcada con ⊘ por si algún día quiere reactivarla.',
          textoConfirmar: 'Dar de baja la zona',
          peligro: true,
        });
        if (!seguro) return;
        r = await borrar('?bajaLogica=1');

      } else {
        throw error;
      }
    }

    if (r?.bajaLogica) {
      aviso(`Zona "${zona.nombre}" dada de baja. Ya no aparece en comandero ni en caja; ` +
            'sus facturas se conservan.', 'exito', 8000);
    } else {
      aviso(r?.ordenes
        ? `Zona "${zona.nombre}" eliminada junto con ${r.ordenes} comanda(s) de su historial.`
        : `Zona "${zona.nombre}" eliminada.`, 'exito', r?.ordenes ? 7000 : 4000);
    }

    estado.zonaActiva = null;
    await cargarPlano();
  } catch (error) {
    aviso(error.message, 'error', 8000);
  }
}

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarPlano(idPreferida = null) {
  const r = await api.get('/salon/zonas?todas=1');
  estado.zonas = r.zonas.map((z) => ({
    ...z,
    mesas: z.mesas.map((m) => ({ ...m, idLocal: `m-${m.id}`, esNueva: false })),
  }));

  const objetivo = estado.zonas.find((z) => z.id === (idPreferida ?? estado.zonaActiva?.id))
                ?? estado.zonas[0];

  if (!objetivo) {
    estado.zonaActiva = null;
    estado.mesas = [];
    estado.original = [];
    $('zona-titulo').textContent = 'Sin zonas';
    pintarZonas();
    pintarLienzo();
    marcarCambio();
    return;
  }

  estado.zonaActiva = objetivo;
  estado.mesas = objetivo.mesas.map((m) => ({ ...m }));
  estado.original = objetivo.mesas.map((m) => ({ ...m }));
  estado.seleccionada = null;
  estado.seleccion.clear();

  $('zona-titulo').textContent = objetivo.nombre;
  pintarZonas();
  pintarAccionesZona();
  pintarLienzo();
  pintarPropiedades();
  marcarCambio();
}

/* ---------------------------------------------------------------
   Tiempo real
   --------------------------------------------------------------- */
/**
 * El plano cambió por debajo: otro administrador guardó una distribución, o un
 * mesero abrió una comanda y una mesa pasó a estar ocupada (aquí eso importa,
 * porque una mesa con comanda abierta no se puede quitar del lienzo).
 *
 * La regla de oro: NO tocar el lienzo si hay trabajo sin guardar. Redibujar
 * encima del diseño que alguien está montando sería tirar su trabajo por un
 * evento que ni pidió. En ese caso solo se avisa y decide él.
 */
async function refrescarDesdeServidor(porOtro = true) {
  if (hayCambios()) {
    if (!avisoDeCambioExterno) {
      avisoDeCambioExterno = true;
      aviso('Alguien más cambió el plano mientras usted edita. Guarde o descarte sus cambios ' +
            'para ver la versión al día.', 'alerta', 12000);
    }
    return;
  }
  try {
    await cargarPlano();
    if (porOtro) aviso('El plano se actualizó con los cambios de otro usuario.', 'info', 4000);
  } catch { /* el indicador de conexión ya refleja el problema */ }
}

let avisoDeCambioExterno = false;

const canal = new CanalTiempoReal({ alRefrescar: () => refrescarDesdeServidor(false) });
document.getElementById('indicador-conexion')?.append(crearIndicadorConexion(canal));
canal.on('sesion.invalida', () => { window.location.href = '/'; });

canal.on('salon.actualizado', (d) => {
  // Los ecos de los propios cambios se ignoran: esta vista ya se recargó sola
  // al guardar, y un segundo repintado solo haría parpadear la pantalla.
  if (d?.porUsuario === sesion.usuario.id) return;
  refrescarDesdeServidor();
});
// Una mesa que se ocupa o se libera cambia el candado del lienzo.
canal.on('mesa.estado', () => refrescarDesdeServidor(false));
canal.on('orden.creada', () => refrescarDesdeServidor(false));

canal.conectar();

// Al guardar con éxito, el aviso de conflicto deja de tener sentido.
function olvidarConflicto() { avisoDeCambioExterno = false; }

// Redibuja al cambiar el tamaño: la rejilla de 10 px depende del ancho real.
window.addEventListener('resize', retrasar(() => pintarLienzo(), 200));

window.addEventListener('beforeunload', (e) => {
  if (hayCambios()) e.preventDefault();
});

if (!puedeEditar) {
  aviso('Tiene acceso de solo lectura al plano.', 'info', 5000);
  document.getElementById('paleta')?.classList.add('oculto');
}

try {
  await cargarPlano();
} catch (error) {
  aviso(error.message, 'error');
}
