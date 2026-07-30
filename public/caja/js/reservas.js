/**
 * Reservas de mesa en el POS del cajero.
 *
 * AQUÍ ATERRIZA LA "NOTIFICACIÓN AUTOMÁTICA AL ROL DE CAJA" DEL ENUNCIADO.
 * Cuando un cliente reserva desde la aplicación, el servidor publica
 * `reserva.creada` filtrado por el permiso `reservas.ver`
 * (`server/realtime.js`), de modo que llega a Caja y al Administrador pero no
 * a cocina. Esta vista la recibe por el mismo canal que ya usaba el POS para
 * las pre-cuentas: no hubo que inventar ningún mecanismo nuevo.
 *
 * El aviso es de tres capas, y cada una cubre un fallo de la anterior:
 *   1. Aviso emergente — para quien está mirando la pantalla.
 *   2. Campana         — para quien no lo está.
 *   3. Globo en el nav — para quien no estaba delante cuando sonó. Se queda
 *                        hasta que la reserva se resuelve.
 *
 * POR QUÉ CONFIRMA UNA PERSONA Y NO EL SISTEMA
 * Asignar la mesa automáticamente sería fácil y estaría mal: `mesa.estado`
 * describe el momento presente, no las dos de la tarde del jueves. Quien
 * conoce el ritmo real del salón es el cajero; el sistema le lleva la petición
 * y le deja decidir.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearFecha, campana } from '/comun/ui.js';
import { iniciarPos } from './comun.js';

const contexto = await iniciarPos({
  vista: 'reservas',
  alRefrescar: cargar,
  eventos: {
    'reserva.creada': (d) => {
      aviso(
        `Nueva reserva de ${d.cliente} · ${d.personas} personas · ${formatearFecha(d.fechaHora)}`,
        'info', 12000
      );
      campana();
      cargar();
    },
    // Otro cajero la resolvió desde su terminal: la lista se pone al día sola
    // para que nadie intente confirmar algo ya resuelto.
    'reserva.actualizada': cargar,
  },
});
if (!contexto) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);
const puedeGestionar = contexto.sesion.permisos.includes('reservas.gestionar');

const estado = { reservas: [], filtro: 'vivas', seleccionada: null };

/** Cómo se pinta cada estado. Icono + texto: nunca solo color. */
const ESTADOS = {
  pendiente:  { icono: '⏳', texto: 'Por resolver', clase: 'insignia--alerta' },
  confirmada: { icono: '✓',  texto: 'Confirmada',   clase: 'insignia--exito' },
  rechazada:  { icono: '✕',  texto: 'Rechazada',    clase: 'insignia--error' },
  cancelada:  { icono: '⊘',  texto: 'Cancelada',    clase: 'insignia--neutra' },
  cumplida:   { icono: '★',  texto: 'Cumplida',     clase: 'insignia--exito' },
  no_asistio: { icono: '—',  texto: 'No asistió',   clase: 'insignia--neutra' },
};

/* =====================================================================
   Filtros
   ===================================================================== */

const FILTROS = { vivas: 'vivas', pendiente: 'pendiente', todas: '' };
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

function tarjeta(r) {
  const est = ESTADOS[r.estado] ?? { icono: '?', texto: r.estado, clase: 'insignia--neutra' };
  const esPendiente = r.estado === 'pendiente';

  return el('article', {
    clase: `canal-tarjeta ${esPendiente ? 'canal-tarjeta--urgente' : ''}`,
  },
    el('div', { clase: 'canal-tarjeta__cab' },
      el('span', { clase: 'canal-tarjeta__codigo mono', texto: r.codigo }),
      el('span', { clase: `insignia ${est.clase}` }, `${est.icono} ${est.texto}`),
      el('span', { clase: 'crece' }),
      el('span', { clase: 'canal-tarjeta__cuando', texto: formatearFecha(r.fechaHora) })
    ),

    el('div', { clase: 'canal-tarjeta__cuerpo' },
      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Cliente' }),
        el('strong', { texto: r.cliente })
      ),
      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Teléfono' }),
        // Enlace tel: para poder llamar desde una tablet sin copiar el número.
        el('a', { clase: 'mono', attrs: { href: `tel:${r.telefono}` }, texto: r.telefono })
      ),
      el('div', { clase: 'canal-dato' },
        el('span', { clase: 'canal-dato__etiqueta', texto: 'Personas' }),
        el('strong', { texto: String(r.numPersonas) })
      ),
      r.mesa
        ? el('div', { clase: 'canal-dato' },
            el('span', { clase: 'canal-dato__etiqueta', texto: 'Mesa' }),
            el('strong', { texto: `${r.mesa}${r.zona ? ` · ${r.zona}` : ''}` }))
        : null,
      r.notas
        ? el('div', { clase: 'canal-tarjeta__notas' },
            el('span', { attrs: { 'aria-hidden': 'true' } }, '💬'),
            el('span', { texto: r.notas }))
        : null,
      r.motivoGestion
        ? el('p', { clase: 'texto-sm texto-tenue', texto: `Motivo: ${r.motivoGestion}` })
        : null,
      r.gestionadaPor
        ? el('p', { clase: 'texto-sm texto-tenue',
                    texto: `Gestionada por ${r.gestionadaPor} el ${formatearFecha(r.gestionadaEn)}.` })
        : null
    ),

    puedeGestionar ? acciones(r) : null
  );
}

/** Los botones que tienen sentido según el estado. */
function acciones(r) {
  const botones = [];

  if (r.estado === 'pendiente') {
    botones.push(el('button', {
      clase: 'btn btn--primario',
      attrs: { type: 'button' },
      on: { click: () => abrirConfirmar(r) },
    }, '✓ Confirmar'));
    botones.push(el('button', {
      clase: 'btn btn--peligro',
      attrs: { type: 'button' },
      on: { click: () => abrirRechazar(r) },
    }, '✕ Rechazar'));
  }

  if (r.estado === 'confirmada') {
    botones.push(el('button', {
      clase: 'btn btn--primario',
      attrs: { type: 'button' },
      on: { click: () => transicion(r, 'cumplida', 'El cliente llegó y se sentó.') },
    }, '★ Llegó'));
    botones.push(el('button', {
      clase: 'btn btn--secundario',
      attrs: { type: 'button' },
      on: { click: () => transicion(r, 'no-asistio', 'Se registra que no se presentó.') },
    }, 'No asistió'));
    botones.push(el('button', {
      clase: 'btn btn--plano',
      attrs: { type: 'button' },
      on: { click: () => abrirRechazar(r, 'cancelar') },
    }, 'Cancelar'));
  }

  if (!botones.length) return null;
  return el('div', { clase: 'canal-tarjeta__acciones' }, ...botones);
}

function pintar() {
  const n = estado.reservas.length;
  $('conteo-reservas').textContent = n === 1 ? '1 reserva' : `${n} reservas`;

  if (!n) {
    reemplazar($('lista-reservas'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay reservas que mostrar.' }),
      el('p', { clase: 'texto-sm texto-tenue',
                texto: 'Las reservas que hagan los clientes desde la aplicación aparecerán aquí solas.' })
    ));
    return;
  }

  reemplazar($('lista-reservas'), ...estado.reservas.map(tarjeta));
}

/* =====================================================================
   Acciones
   ===================================================================== */

async function transicion(reserva, accion, confirmacionTexto) {
  const ok = await confirmar({
    titulo: `Reserva ${reserva.codigo}`,
    mensaje: confirmacionTexto,
    textoConfirmar: 'Sí, continuar',
  });
  if (!ok) return;

  try {
    await api.post(`/reservas/${reserva.id}/${accion}`);
    aviso('Reserva actualizada.', 'exito');
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

// --- Confirmar (elige mesa) ---

async function abrirConfirmar(reserva) {
  estado.seleccionada = reserva;
  $('e-c-mesa').textContent = '';
  $('resumen-confirmar').textContent =
    `${reserva.cliente} · ${reserva.numPersonas} personas · ${formatearFecha(reserva.fechaHora)}`;

  try {
    const r = await api.get(`/reservas/mesas-disponibles?personas=${reserva.numPersonas}`);

    if (!r.mesas.length) {
      $('e-c-mesa').textContent =
        `No hay ninguna mesa con capacidad para ${reserva.numPersonas} personas.`;
      reemplazar($('c-mesa'));
    } else {
      reemplazar($('c-mesa'), ...r.mesas.map((m) => el('option', {
        value: String(m.id),
        // El estado va en palabras dentro de la propia opción: un <select> no
        // admite iconos de color, y el cajero necesita el dato para decidir.
        texto: `${m.numero} · ${m.zona} · ${m.capacidad} personas · ahora ${m.estadoActual}`,
      })));
    }
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }

  $('modal-confirmar').showModal();
}

$('btn-cerrar-confirmar').addEventListener('click', () => $('modal-confirmar').close());

$('form-confirmar').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  $('e-c-mesa').textContent = '';

  const idMesa = Number($('c-mesa').value);
  if (!Number.isInteger(idMesa) || idMesa <= 0) {
    $('e-c-mesa').textContent = 'Elija una mesa.';
    return;
  }

  try {
    const r = await api.post(`/reservas/${estado.seleccionada.id}/confirmar`, { idMesa });
    aviso(`Reserva ${r.reserva.codigo} confirmada en la mesa ${r.reserva.mesa}. ` +
          'El cliente ya recibió el aviso.', 'exito', 8000);
    $('modal-confirmar').close();
    await cargar();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos?.idMesa) {
      $('e-c-mesa').textContent = error.campos.idMesa;
    } else {
      $('e-c-mesa').textContent = error.message;
    }
  }
});

// --- Rechazar / cancelar (motivo obligatorio) ---

let accionMotivo = 'rechazar';

function abrirRechazar(reserva, accion = 'rechazar') {
  estado.seleccionada = reserva;
  accionMotivo = accion;
  $('e-r-motivo').textContent = '';
  $('r-motivo').value = '';
  $('titulo-rechazar').textContent = accion === 'cancelar'
    ? 'Cancelar la reserva'
    : 'Rechazar la reserva';
  $('resumen-rechazar').textContent =
    `${reserva.codigo} · ${reserva.cliente} · ${formatearFecha(reserva.fechaHora)}`;
  $('modal-rechazar').showModal();
  $('r-motivo').focus();
}

$('btn-cerrar-rechazar').addEventListener('click', () => $('modal-rechazar').close());

$('form-rechazar').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  $('e-r-motivo').textContent = '';

  const motivo = $('r-motivo').value.trim();
  if (!motivo) {
    // El motivo lo lee el cliente en su móvil: un rechazo sin explicación es
    // peor que no tener la función.
    $('e-r-motivo').textContent = 'Escriba el motivo: el cliente lo va a leer.';
    return;
  }

  try {
    await api.post(`/reservas/${estado.seleccionada.id}/${accionMotivo}`, { motivo });
    aviso('Reserva actualizada. El cliente recibió el aviso.', 'exito', 6000);
    $('modal-rechazar').close();
    await cargar();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos?.motivo) {
      $('e-r-motivo').textContent = error.campos.motivo;
    } else {
      $('e-r-motivo').textContent = error.message;
    }
  }
});

/* =====================================================================
   Carga
   ===================================================================== */

async function cargar() {
  try {
    const filtro = FILTROS[estado.filtro];
    const r = await api.get(`/reservas${filtro ? `?estado=${filtro}` : ''}`);
    estado.reservas = r.reservas;
    pintar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

await cargar();
