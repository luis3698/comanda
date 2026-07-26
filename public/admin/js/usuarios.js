/**
 * Vista 4: Registro de Usuarios y Credenciales.  RF-03.
 *
 * FSD 4.1 vista 4:
 *  - tabla con paginacion y buscador
 *  - validacion en tiempo real (blur/input): correo con RegExp y unicidad via API
 *  - PIN de exactamente 4 digitos con confirmacion
 *  - contrasena con medidor de fortaleza
 *  - "Dar de baja" ejecuta baja logica con confirmacion; nunca borra
 *
 * Recordatorio: nada de esto es seguridad. El servidor revalida todo (6.1) y
 * responde 403 a quien no tenga permiso aunque manipule este archivo (CA-10).
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, formatearFecha, retrasar } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('seguridad.usuarios.ver');
if (!sesion) throw new Error('sin sesion');

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_PIN = /^\d{4}$/;

const puedeGestionar = tienePermiso('seguridad.usuarios.gestionar');

const estado = {
  pagina: 1,
  limite: 20,
  buscar: '',
  roles: [],
  editandoId: null,
};

const $ = (id) => document.getElementById(id);
const cuerpoTabla = $('cuerpo-tabla');
const modal = $('modal-usuario');

/* ---------------------------------------------------------------
   Errores de campo
   --------------------------------------------------------------- */
function marcarError(idCampo, idError, mensaje) {
  const campo = $(idCampo);
  $(idError).textContent = mensaje ?? '';
  if (mensaje) campo.setAttribute('aria-invalid', 'true');
  else campo.removeAttribute('aria-invalid');
}

const CAMPOS = [
  ['f-nombre', 'e-nombre'], ['f-correo', 'e-correo'], ['f-documento', 'e-documento'],
  ['f-rol', 'e-rol'], ['f-rfid', 'e-rfid'], ['f-password', 'e-password'],
  ['f-pin', 'e-pin'], ['f-pin2', 'e-pin2'],
];
function limpiarErrores() {
  CAMPOS.forEach(([c, e]) => marcarError(c, e, ''));
}

/* ---------------------------------------------------------------
   Listado
   --------------------------------------------------------------- */
function filaUsuario(u) {
  // Cada celda declara su etiqueta para el modo tarjeta en movil (admin.css).
  const td = (etiqueta, ...hijos) =>
    el('td', { attrs: { 'data-etiqueta': etiqueta } }, ...hijos);

  // El estado lleva texto ademas de color: 6.4 prohibe comunicar solo por color.
  const insignia = !u.activo
    ? el('span', { clase: 'insignia insignia--neutra' }, '⊘ De baja')
    : u.bloqueado
      ? el('span', { clase: 'insignia insignia--error' }, '🔒 Bloqueado')
      : el('span', { clase: 'insignia insignia--exito' }, '✓ Activo');

  const acciones = el('div', { clase: 'tabla__acciones' });
  if (puedeGestionar) {
    acciones.append(el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: () => abrirModal(u.id) },
    }, 'Editar'));

    if (u.bloqueado) {
      acciones.append(el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button' },
        on: { click: () => desbloquear(u) },
      }, 'Desbloquear'));
    }

    // Nadie puede darse de baja a si mismo: el servidor tambien lo impide.
    if (u.id !== sesion.usuario.id) {
      acciones.append(el('button', {
        clase: `btn btn--sm ${u.activo ? 'btn--peligro' : 'btn--secundario'}`,
        attrs: { type: 'button' },
        on: { click: () => cambiarEstado(u) },
      }, u.activo ? 'Dar de baja' : 'Reactivar'));
    }
  }

  return el('tr', {},
    td('Nombre', el('strong', { texto: u.nombreCompleto })),
    td('Rol', el('span', { clase: 'insignia insignia--info', texto: u.rol })),
    td('Correo', el('span', { clase: 'mono', texto: u.correo })),
    td('Documento', u.documento ?? '—'),
    td('Estado', insignia),
    td('Último acceso', formatearFecha(u.ultimoAcceso)),
    td('Acciones', acciones)
  );
}

async function cargarUsuarios() {
  reemplazar(cuerpoTabla, el('tr', {},
    el('td', { attrs: { colspan: '7' } },
      el('div', { clase: 'vacio' }, el('span', { clase: 'cargando' }), ' Cargando…'))
  ));

  try {
    const params = new URLSearchParams({
      pagina: String(estado.pagina),
      limite: String(estado.limite),
    });
    if (estado.buscar) params.set('buscar', estado.buscar);

    const r = await api.get(`/usuarios?${params}`);

    $('conteo-total').textContent = `${r.paginacion.total} en total`;

    if (!r.usuarios.length) {
      reemplazar(cuerpoTabla, el('tr', {},
        el('td', { attrs: { colspan: '7' } },
          el('div', { clase: 'vacio' },
            el('p', { texto: estado.buscar
              ? `Ningún usuario coincide con "${estado.buscar}".`
              : 'Todavía no hay usuarios.' })))
      ));
    } else {
      reemplazar(cuerpoTabla, ...r.usuarios.map(filaUsuario));
    }

    pintarPaginacion(r.paginacion);
  } catch (error) {
    reemplazar(cuerpoTabla, el('tr', {},
      el('td', { attrs: { colspan: '7' } },
        el('div', { clase: 'vacio' }, el('p', { texto: error.message })))
    ));
  }
}

function pintarPaginacion(p) {
  const desde = p.total === 0 ? 0 : (p.pagina - 1) * p.limite + 1;
  const hasta = Math.min(p.pagina * p.limite, p.total);

  reemplazar($('paginacion'),
    el('span', { texto: `${desde}–${hasta} de ${p.total}` }),
    el('div', { clase: 'fila' },
      el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button', disabled: p.pagina <= 1 },
        on: { click: () => { estado.pagina--; cargarUsuarios(); } },
      }, '‹ Anterior'),
      el('span', { clase: 'texto-sm', texto: `Página ${p.pagina} de ${Math.max(1, p.paginas)}` }),
      el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button', disabled: p.pagina >= p.paginas },
        on: { click: () => { estado.pagina++; cargarUsuarios(); } },
      }, 'Siguiente ›')
    )
  );
}

/* ---------------------------------------------------------------
   Acciones
   --------------------------------------------------------------- */
async function cambiarEstado(u) {
  const dandoBaja = u.activo;
  const ok = await confirmar({
    titulo: dandoBaja ? 'Dar de baja' : 'Reactivar usuario',
    mensaje: dandoBaja
      ? `${u.nombreCompleto} dejará de poder entrar. Su historial de ventas y auditoría se conserva intacto; el registro no se elimina.`
      : `${u.nombreCompleto} podrá volver a iniciar sesión.`,
    textoConfirmar: dandoBaja ? 'Dar de baja' : 'Reactivar',
    peligro: dandoBaja,
  });
  if (!ok) return;

  try {
    await api.patch(`/usuarios/${u.id}/estado`, { activo: !u.activo });
    aviso(dandoBaja ? `${u.nombreCompleto} fue dado de baja.` : `${u.nombreCompleto} fue reactivado.`, 'exito');
    cargarUsuarios();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}

async function desbloquear(u) {
  try {
    await api.patch(`/usuarios/${u.id}/desbloquear`, {});
    aviso(`Cuenta de ${u.nombreCompleto} desbloqueada.`, 'exito');
    cargarUsuarios();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Medidor de fortaleza (FSD 4.1 vista 4)
   Orientativo: la regla que manda es la del servidor (minimo 8 caracteres).
   --------------------------------------------------------------- */
function evaluarFortaleza(clave) {
  if (!clave) return { nivel: 0, texto: '', color: 'transparent' };

  let puntos = 0;
  if (clave.length >= 8) puntos++;
  if (clave.length >= 12) puntos++;
  if (/[a-z]/.test(clave) && /[A-Z]/.test(clave)) puntos++;
  if (/\d/.test(clave)) puntos++;
  if (/[^A-Za-z0-9]/.test(clave)) puntos++;

  const escala = [
    { texto: 'Muy débil', color: 'var(--c-error)' },
    { texto: 'Débil', color: 'var(--c-error)' },
    { texto: 'Aceptable', color: 'var(--c-alerta)' },
    { texto: 'Buena', color: 'var(--c-alerta)' },
    { texto: 'Fuerte', color: 'var(--c-exito)' },
    { texto: 'Muy fuerte', color: 'var(--c-exito)' },
  ];
  return { nivel: puntos, ...escala[puntos] };
}

$('f-password').addEventListener('input', (e) => {
  const { nivel, texto, color } = evaluarFortaleza(e.target.value);
  const relleno = $('fortaleza-relleno');
  relleno.style.width = `${(nivel / 5) * 100}%`;
  relleno.style.background = color;
  // El texto acompana a la barra de color (6.4).
  $('fortaleza-texto').textContent = texto;
  $('fortaleza-texto').style.color = color;
});

/* ---------------------------------------------------------------
   Validacion en vivo con comprobacion de unicidad contra la API
   (FSD 4.1 vista 4: "verificacion de unicidad via API")
   --------------------------------------------------------------- */
const comprobarUnicidad = retrasar(async (campo, valor) => {
  if (!valor) return;

  const mapa = {
    correo: ['f-correo', 'e-correo', 'Ese correo ya está registrado.'],
    documento: ['f-documento', 'e-documento', 'Ese documento ya está registrado.'],
    uidRfid: ['f-rfid', 'e-rfid', 'Esa tarjeta ya está emparejada con otro usuario.'],
  };
  const [idCampo, idError, mensaje] = mapa[campo];

  try {
    const params = new URLSearchParams({ [campo]: valor });
    if (estado.editandoId) params.set('excluir', String(estado.editandoId));
    const r = await api.get(`/usuarios/disponibilidad?${params}`);
    if (r[campo] && !r[campo].disponible) marcarError(idCampo, idError, mensaje);
    else marcarError(idCampo, idError, '');
  } catch { /* si la comprobacion falla, el servidor lo rechazara al guardar */ }
}, 350);

$('f-correo').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (v && !RE_CORREO.test(v)) return marcarError('f-correo', 'e-correo', 'Formato de correo inválido.');
  marcarError('f-correo', 'e-correo', '');
  comprobarUnicidad('correo', v);
});
$('f-documento').addEventListener('input', (e) => comprobarUnicidad('documento', e.target.value.trim()));
$('f-rfid').addEventListener('input', (e) => comprobarUnicidad('uidRfid', e.target.value.trim()));

// Solo digitos en los PIN.
for (const id of ['f-pin', 'f-pin2']) {
  $(id).addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
}

// Emparejamiento RFID: en produccion el lector actua como teclado y "teclea"
// el uid. Aqui se captura lo que llegue mientras el boton este activo.
$('btn-rfid').addEventListener('click', () => {
  const campo = $('f-rfid');
  campo.value = '';
  campo.placeholder = 'Acerque la tarjeta al lector…';
  campo.focus();
  aviso('Acerque la tarjeta al lector. También puede escribir el UID a mano.', 'info');
});

/* ---------------------------------------------------------------
   Modal
   --------------------------------------------------------------- */
async function cargarRoles() {
  if (estado.roles.length) return estado.roles;
  const r = await api.get('/roles');
  estado.roles = r.roles;
  return estado.roles;
}

async function abrirModal(id = null) {
  limpiarErrores();
  estado.editandoId = id;
  $('form-usuario').reset();
  $('fortaleza-relleno').style.width = '0';
  $('fortaleza-texto').textContent = '';

  const roles = await cargarRoles();
  reemplazar($('f-rol'),
    el('option', { attrs: { value: '' }, texto: 'Seleccione…' }),
    ...roles.map((r) => el('option', { attrs: { value: String(r.id) }, texto: r.nombre }))
  );

  if (id) {
    $('titulo-modal').textContent = 'Editar usuario';
    // Al editar, credenciales vacias significa "no cambiar".
    $('req-password').classList.add('oculto');
    $('req-pin').classList.add('oculto');
    $('nota-credenciales').textContent =
      'Deje la contraseña y el PIN vacíos para conservar los actuales. Si los cambia, se cerrarán las sesiones abiertas del usuario.';

    try {
      const u = await api.get(`/usuarios/${id}`);
      $('f-nombre').value = u.nombreCompleto ?? '';
      $('f-correo').value = u.correo ?? '';
      $('f-documento').value = u.documento ?? '';
      $('f-rol').value = String(u.idRol);
      $('f-rfid').value = u.uidRfid ?? '';
    } catch (error) {
      aviso(error.message, 'error');
      return;
    }
  } else {
    $('titulo-modal').textContent = 'Nuevo usuario';
    $('req-password').classList.remove('oculto');
    $('req-pin').classList.remove('oculto');
    $('nota-credenciales').textContent =
      'Las credenciales se guardan cifradas y no se pueden consultar después.';
  }

  modal.showModal();
  $('f-nombre').focus();
}

$('btn-nuevo').addEventListener('click', () => abrirModal(null));
$('btn-cerrar-modal').addEventListener('click', () => modal.close());
$('btn-cancelar').addEventListener('click', () => modal.close());

if (!puedeGestionar) $('btn-nuevo').classList.add('oculto');

/* ---------------------------------------------------------------
   Guardado
   --------------------------------------------------------------- */
$('form-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  limpiarErrores();

  const esNuevo = !estado.editandoId;
  const datos = {
    nombreCompleto: $('f-nombre').value.trim(),
    correo: $('f-correo').value.trim(),
    documento: $('f-documento').value.trim() || null,
    idRol: Number($('f-rol').value) || null,
    uidRfid: $('f-rfid').value.trim() || null,
  };

  const password = $('f-password').value;
  const pin = $('f-pin').value;
  const pin2 = $('f-pin2').value;

  // Validacion de formato antes de gastar un viaje al servidor.
  let fallos = false;
  if (datos.nombreCompleto.length < 3) {
    marcarError('f-nombre', 'e-nombre', 'Mínimo 3 caracteres.'); fallos = true;
  }
  if (!RE_CORREO.test(datos.correo)) {
    marcarError('f-correo', 'e-correo', 'Formato de correo inválido.'); fallos = true;
  }
  if (!datos.idRol) {
    marcarError('f-rol', 'e-rol', 'Seleccione un rol.'); fallos = true;
  }
  if (esNuevo || password) {
    if (password.length < 8) {
      marcarError('f-password', 'e-password', 'Mínimo 8 caracteres.'); fallos = true;
    }
  }
  if (esNuevo || pin) {
    if (!RE_PIN.test(pin)) {
      marcarError('f-pin', 'e-pin', 'Deben ser exactamente 4 dígitos.'); fallos = true;
    } else if (pin !== pin2) {
      marcarError('f-pin2', 'e-pin2', 'Los PIN no coinciden.'); fallos = true;
    }
  }
  if (fallos) return;

  if (password) datos.password = password;
  if (pin) datos.pin = pin;

  const btn = $('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    if (esNuevo) {
      await api.post('/usuarios', datos);
      aviso(`Usuario ${datos.correo} creado.`, 'exito');
    } else {
      await api.put(`/usuarios/${estado.editandoId}`, datos);
      aviso('Cambios guardados.', 'exito');
    }
    modal.close();
    cargarUsuarios();
  } catch (error) {
    // El servidor devuelve los errores por campo: se pintan junto a cada input.
    if (error instanceof ErrorPeticion && error.campos) {
      const mapa = {
        nombreCompleto: ['f-nombre', 'e-nombre'], correo: ['f-correo', 'e-correo'],
        documento: ['f-documento', 'e-documento'], idRol: ['f-rol', 'e-rol'],
        password: ['f-password', 'e-password'], pin: ['f-pin', 'e-pin'],
      };
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        const destino = mapa[campo];
        if (destino) marcarError(destino[0], destino[1], mensaje);
      }
      aviso('Revise los campos marcados.', 'error');
    } else {
      aviso(error.message, 'error', 7000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
});

/* ---------------------------------------------------------------
   Buscador con debounce (FSD 4.1: filtrado instantaneo)
   --------------------------------------------------------------- */
$('buscar').addEventListener('input', retrasar((e) => {
  estado.buscar = e.target.value.trim();
  estado.pagina = 1;   // un filtro nuevo siempre arranca en la primera pagina
  cargarUsuarios();
}, 250));

cargarUsuarios();
