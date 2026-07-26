/**
 * Vista 3: Gestor de Roles y Matriz de Permisos.  RF-02.
 *
 * FSD 4.1 vista 3:
 *  - filas = permisos agrupados por modulo (acordeones), celdas con checkbox
 *  - "cambio de checkbox marca la fila como pendiente (resaltado ambar) y
 *     habilita la barra flotante Guardar cambios / Descartar"
 *  - guardado por lote (PUT /api/v1/roles/:id/permisos)
 *  - buscador con filtrado instantaneo (input + debounce 200 ms)
 *  - "los roles de sistema muestran candado y no permiten su eliminacion"
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('seguridad.roles.ver');
if (!sesion) throw new Error('sin sesion');

const puedeGestionar = tienePermiso('seguridad.roles.gestionar');

const estado = {
  roles: [],
  modulos: [],
  rolActivo: null,
  /** Permisos tal como estan guardados en el servidor. */
  original: new Set(),
  /** Permisos con los cambios sin guardar del usuario. */
  actual: new Set(),
  filtro: '',
  editandoRol: null,
};

const $ = (id) => document.getElementById(id);

/** Diferencia entre lo guardado y lo que hay en pantalla. */
function pendientes() {
  const cambios = [];
  for (const id of estado.actual) if (!estado.original.has(id)) cambios.push(id);
  for (const id of estado.original) if (!estado.actual.has(id)) cambios.push(id);
  return cambios;
}

function hayPendiente(idPermiso) {
  return estado.actual.has(idPermiso) !== estado.original.has(idPermiso);
}

/* ---------------------------------------------------------------
   Lista de roles
   --------------------------------------------------------------- */
function pintarRoles() {
  reemplazar($('roles-lista'), ...estado.roles.map((rol) => {
    const activo = estado.rolActivo?.id === rol.id;
    return el('button', {
      clase: `rol-item ${activo ? 'rol-item--activo' : ''}`,
      attrs: { type: 'button', role: 'option', 'aria-selected': String(activo) },
      on: { click: () => seleccionarRol(rol) },
    },
      // El candado marca los roles de sistema (FSD 4.1 vista 3).
      rol.esSistema
        ? el('span', { attrs: { title: 'Rol del sistema: no se puede eliminar', 'aria-label': 'Rol del sistema' } }, '🔒')
        : el('span', { attrs: { 'aria-hidden': 'true' } }, '　'),
      el('span', { clase: 'rol-item__nombre' },
        el('div', { texto: rol.nombre }),
        el('div', { clase: 'rol-item__meta',
          texto: `${rol.usuarios} usuario(s) · ${rol.permisos} permiso(s)` })
      )
    );
  }));
}

/* ---------------------------------------------------------------
   Matriz de permisos
   --------------------------------------------------------------- */
function filaPermiso(permiso) {
  const concedido = estado.actual.has(permiso.id);
  const pendiente = hayPendiente(permiso.id);

  const casilla = el('input', {
    clase: 'permiso-fila__control',
    attrs: {
      type: 'checkbox',
      id: `p-${permiso.id}`,
      checked: concedido,
      disabled: !puedeGestionar,
    },
    on: {
      change: (e) => {
        if (e.target.checked) estado.actual.add(permiso.id);
        else estado.actual.delete(permiso.id);
        pintarMatriz();
        actualizarBarra();
      },
    },
  });

  return el('div', { clase: `permiso-fila ${pendiente ? 'permiso-fila--pendiente' : ''}` },
    casilla,
    el('label', { clase: 'crece', attrs: { for: `p-${permiso.id}` } },
      el('div', { clase: 'permiso-fila__desc', texto: permiso.descripcion }),
      el('div', { clase: 'permiso-fila__codigo', texto: permiso.codigo })
    ),
    // El estado pendiente se marca con fondo ambar Y con texto (FSD 6.4).
    pendiente ? el('span', { clase: 'permiso-fila__marca', texto: 'sin guardar' }) : null
  );
}

function pintarMatriz() {
  if (!estado.rolActivo) {
    reemplazar($('matriz'), el('div', { clase: 'vacio' },
      el('p', { texto: 'Seleccione un rol de la izquierda para ver sus permisos.' })));
    return;
  }

  const filtro = estado.filtro.toLowerCase();
  const modulos = estado.modulos
    .map((m) => ({
      ...m,
      permisos: m.permisos.filter((p) =>
        !filtro ||
        p.codigo.toLowerCase().includes(filtro) ||
        p.descripcion.toLowerCase().includes(filtro) ||
        m.nombre.toLowerCase().includes(filtro)),
    }))
    .filter((m) => m.permisos.length);

  if (!modulos.length) {
    reemplazar($('matriz'), el('div', { clase: 'vacio' },
      el('p', { texto: `Ningún permiso coincide con "${estado.filtro}".` })));
    return;
  }

  reemplazar($('matriz'), ...modulos.map((m) => {
    const concedidos = m.permisos.filter((p) => estado.actual.has(p.id)).length;

    return el('details', {
      clase: 'modulo',
      // Con un filtro activo se abren todos: si no, el resultado quedaría oculto.
      attrs: { open: Boolean(filtro) || concedidos > 0 },
    },
      el('summary', { clase: 'modulo__resumen' },
        el('span', { texto: m.nombre }),
        el('span', { clase: 'modulo__conteo', texto: `${concedidos}/${m.permisos.length}` })
      ),
      ...m.permisos.map(filaPermiso)
    );
  }));
}

function actualizarBarra() {
  const cambios = pendientes();
  const barra = $('barra-guardado');

  if (!cambios.length) {
    barra.classList.add('oculto');
    return;
  }
  barra.classList.remove('oculto');
  $('texto-pendientes').textContent =
    `${cambios.length} cambio(s) sin guardar en el rol "${estado.rolActivo.nombre}".`;
}

/* ---------------------------------------------------------------
   Seleccion de rol
   --------------------------------------------------------------- */
async function seleccionarRol(rol) {
  // Evita perder cambios por un clic despistado.
  if (pendientes().length) {
    const ok = await confirmar({
      titulo: 'Cambios sin guardar',
      mensaje: `Tiene cambios sin guardar en "${estado.rolActivo.nombre}". Si cambia de rol se perderán.`,
      textoConfirmar: 'Descartar y continuar',
      peligro: true,
    });
    if (!ok) return;
  }

  estado.rolActivo = rol;
  $('rol-titulo').textContent = rol.nombre;
  $('rol-descripcion').textContent = rol.descripcion ?? '';

  pintarAccionesRol(rol);
  pintarRoles();

  try {
    const r = await api.get(`/roles/${rol.id}/permisos`);
    estado.original = new Set(r.permisos);
    estado.actual = new Set(r.permisos);
    pintarMatriz();
    actualizarBarra();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

function pintarAccionesRol(rol) {
  const acciones = [];

  if (puedeGestionar) {
    acciones.push(el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: () => abrirModalRol(rol) },
    }, 'Editar'));

    // Los roles de sistema no se eliminan (FSD 3.1). El servidor lo impide
    // igualmente: este botón oculto es comodidad, no seguridad.
    if (!rol.esSistema) {
      acciones.push(el('button', {
        clase: 'btn btn--peligro btn--sm',
        attrs: { type: 'button' },
        on: { click: () => eliminarRol(rol) },
      }, 'Eliminar'));
    }
  }
  if (rol.esSistema) {
    acciones.push(el('span', { clase: 'insignia insignia--neutra' }, '🔒 Rol del sistema'));
  }

  reemplazar($('rol-acciones'), ...acciones);
}

/* ---------------------------------------------------------------
   Guardado por lote
   --------------------------------------------------------------- */
$('btn-guardar-permisos').addEventListener('click', async () => {
  const btn = $('btn-guardar-permisos');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    await api.put(`/roles/${estado.rolActivo.id}/permisos`, {
      permisos: [...estado.actual],
    });
    estado.original = new Set(estado.actual);
    aviso(`Permisos de "${estado.rolActivo.nombre}" actualizados. El cambio ya afecta a las sesiones abiertas.`, 'exito', 6000);
    await cargarRoles();
    pintarMatriz();
    actualizarBarra();
  } catch (error) {
    // El candado anti-bloqueo del servidor cae aquí: merece un aviso largo.
    aviso(error.message, 'error', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
});

$('btn-descartar').addEventListener('click', () => {
  estado.actual = new Set(estado.original);
  pintarMatriz();
  actualizarBarra();
  aviso('Cambios descartados.', 'info', 2500);
});

/* ---------------------------------------------------------------
   Alta y edicion de roles
   --------------------------------------------------------------- */
const modalRol = $('modal-rol');

function abrirModalRol(rol = null) {
  estado.editandoRol = rol;
  $('e-r-nombre').textContent = '';
  $('r-nombre').removeAttribute('aria-invalid');
  $('titulo-modal-rol').textContent = rol ? 'Editar rol' : 'Nuevo rol';
  $('r-nombre').value = rol?.nombre ?? '';
  $('r-descripcion').value = rol?.descripcion ?? '';
  // Un rol de sistema conserva su nombre: la correspondencia con el FSD 3.1
  // depende de él. El servidor rechaza el renombrado.
  $('r-nombre').disabled = Boolean(rol?.esSistema);
  modalRol.showModal();
  (rol?.esSistema ? $('r-descripcion') : $('r-nombre')).focus();
}

$('btn-nuevo-rol').addEventListener('click', () => abrirModalRol(null));
$('btn-cerrar-rol').addEventListener('click', () => modalRol.close());
$('btn-cancelar-rol').addEventListener('click', () => modalRol.close());
if (!puedeGestionar) $('btn-nuevo-rol').classList.add('oculto');

$('form-rol').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('r-nombre').value.trim();
  const descripcion = $('r-descripcion').value.trim() || null;

  if (nombre.length < 3) {
    $('e-r-nombre').textContent = 'Mínimo 3 caracteres.';
    $('r-nombre').setAttribute('aria-invalid', 'true');
    return;
  }

  try {
    if (estado.editandoRol) {
      await api.put(`/roles/${estado.editandoRol.id}`, { nombre, descripcion });
      aviso('Rol actualizado.', 'exito');
    } else {
      await api.post('/roles', { nombre, descripcion });
      aviso(`Rol "${nombre}" creado. Ahora asígnele permisos.`, 'exito');
    }
    modalRol.close();
    await cargarRoles();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
});

async function eliminarRol(rol) {
  const ok = await confirmar({
    titulo: 'Eliminar rol',
    mensaje: `Se eliminará el rol "${rol.nombre}" y sus permisos. Esta acción no se puede deshacer.`,
    textoConfirmar: 'Eliminar',
    peligro: true,
  });
  if (!ok) return;

  try {
    await api.borrar(`/roles/${rol.id}`);
    aviso(`Rol "${rol.nombre}" eliminado.`, 'exito');
    estado.rolActivo = null;
    $('rol-titulo').textContent = 'Seleccione un rol';
    $('rol-descripcion').textContent = '';
    reemplazar($('rol-acciones'));
    await cargarRoles();
    pintarMatriz();
    actualizarBarra();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

/* ---------------------------------------------------------------
   Buscador (FSD 4.1 vista 3: debounce 200 ms)
   --------------------------------------------------------------- */
$('buscar-permiso').addEventListener('input', retrasar((e) => {
  estado.filtro = e.target.value.trim();
  pintarMatriz();
}, 200));

/* ---------------------------------------------------------------
   Carga inicial
   --------------------------------------------------------------- */
async function cargarRoles() {
  const r = await api.get('/roles');
  estado.roles = r.roles;
  // Refresca el rol activo para que los contadores queden al día.
  if (estado.rolActivo) {
    estado.rolActivo = estado.roles.find((x) => x.id === estado.rolActivo.id) ?? null;
    if (estado.rolActivo) pintarAccionesRol(estado.rolActivo);
  }
  pintarRoles();
}

// Avisa si se intenta salir con cambios sin guardar.
window.addEventListener('beforeunload', (e) => {
  if (pendientes().length) e.preventDefault();
});

try {
  const [, permisos] = await Promise.all([cargarRoles(), api.get('/roles/permisos')]);
  estado.modulos = permisos.modulos;
  pintarMatriz();
  if (estado.roles.length) await seleccionarRol(estado.roles[0]);
} catch (error) {
  aviso(error.message, 'error');
}
