/**
 * Pantalla de login. RF-01.
 *
 * FSD 5.1: "JS del cliente valida formato (correo RegExp, PIN ^\d{4}$) solo
 * como UX; la API revalida todo." Nada de lo que hay aqui es seguridad: es
 * comodidad para el usuario. La comprobacion real vive en el servidor.
 *
 * FSD 5.1 (salidas): "sesion iniciada con menu filtrado por permisos". El
 * destino tras entrar depende del rol, para que cada quien caiga directo en
 * su interfaz.
 */
import { api, fijarTokenCsrf, cargarSesionActual, ErrorPeticion } from '/comun/api.js';
import { aviso } from '/comun/ui.js';

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_PIN = /^\d{4}$/;

/** Cada rol aterriza en la interfaz que le corresponde (FSD 3.1). */
const DESTINO_POR_ROL = {
  Administrador: '/admin/',
  Cajero: '/caja/',
  Cocinero: '/kds/',
  Mesero: '/comandero/',
};

function destinoDe(rol) {
  return DESTINO_POR_ROL[rol] ?? '/admin/';
}

function mostrarError(idCampo, mensaje) {
  const campo = document.getElementById(idCampo);
  const error = document.getElementById(`error-${idCampo}`);
  if (error) error.textContent = mensaje ?? '';
  if (campo) {
    if (mensaje) campo.setAttribute('aria-invalid', 'true');
    else campo.removeAttribute('aria-invalid');
  }
}

function limpiarErrores(...ids) {
  ids.forEach((id) => mostrarError(id, ''));
}

/** Traduce un error de la API a un mensaje junto al campo o a un aviso. */
function manejarErrorLogin(error, campoPorDefecto) {
  if (!(error instanceof ErrorPeticion)) {
    aviso('Ocurrio un error inesperado.', 'error');
    return;
  }
  if (error.codigo === 'cuenta_bloqueada' || error.codigo === 'cuenta_inactiva') {
    // Merece un aviso destacado: no es un fallo de tecleo.
    aviso(error.message, 'alerta', 9000);
    return;
  }
  mostrarError(campoPorDefecto, error.message);
}

/* ---------------------------------------------------------------
   Pestanas
   --------------------------------------------------------------- */
const tabs = {
  backoffice: document.getElementById('tab-backoffice'),
  operativo: document.getElementById('tab-operativo'),
};
const paneles = {
  backoffice: document.getElementById('panel-backoffice'),
  operativo: document.getElementById('panel-operativo'),
};

function activarPestana(cual) {
  for (const clave of Object.keys(tabs)) {
    const activa = clave === cual;
    tabs[clave].classList.toggle('pestana--activa', activa);
    tabs[clave].setAttribute('aria-selected', String(activa));
    paneles[clave].classList.toggle('oculto', !activa);
  }
  const primero = paneles[cual].querySelector('input:not([readonly])');
  primero?.focus();
}

tabs.backoffice.addEventListener('click', () => activarPestana('backoffice'));
tabs.operativo.addEventListener('click', () => activarPestana('operativo'));

/* ---------------------------------------------------------------
   Acceso de backoffice
   --------------------------------------------------------------- */
const formBackoffice = document.getElementById('form-backoffice');
const btnEntrar = document.getElementById('btn-entrar');

formBackoffice.addEventListener('submit', async (e) => {
  e.preventDefault();
  limpiarErrores('correo', 'password');

  const correo = document.getElementById('correo').value.trim();
  const password = document.getElementById('password').value;

  // Validacion de formato: solo para no gastar un viaje al servidor.
  let hayFallos = false;
  if (!RE_CORREO.test(correo)) {
    mostrarError('correo', 'Escriba un correo valido.');
    hayFallos = true;
  }
  if (!password) {
    mostrarError('password', 'Escriba su contrasena.');
    hayFallos = true;
  }
  if (hayFallos) return;

  btnEntrar.disabled = true;
  btnEntrar.textContent = 'Verificando...';
  try {
    const r = await api.post('/auth/login', { correo, password });
    fijarTokenCsrf(r.tokenCsrf);
    window.location.href = destinoDe(r.usuario.rol);
  } catch (error) {
    manejarErrorLogin(error, 'password');
    btnEntrar.disabled = false;
    btnEntrar.textContent = 'Iniciar sesión';
  }
});

/* ---------------------------------------------------------------
   Acceso operativo (documento + PIN)
   --------------------------------------------------------------- */
const formOperativo = document.getElementById('form-operativo');
const entradaPin = document.getElementById('pin');
const btnEntrarPin = document.getElementById('btn-entrar-pin');
const teclado = document.getElementById('teclado');

function fijarPin(valor) {
  entradaPin.value = valor.slice(0, 4);
}

teclado.addEventListener('click', (e) => {
  const boton = e.target.closest('button');
  if (!boton) return;

  const { tecla, accion } = boton.dataset;
  if (tecla) fijarPin(entradaPin.value + tecla);
  else if (accion === 'borrar') fijarPin(entradaPin.value.slice(0, -1));
  else if (accion === 'limpiar') fijarPin('');

  mostrarError('pin', '');

  // Con los 4 digitos puestos, se envia solo: menos toques en un dispositivo
  // que se usa de pie y con prisa (FSD 6.3: flujos criticos en <= 3 toques).
  if (entradaPin.value.length === 4) {
    formOperativo.requestSubmit();
  }
});

// El teclado fisico tambien funciona: en tablets con funda o en escritorio.
entradaPin.addEventListener('keydown', (e) => {
  if (/^\d$/.test(e.key)) { fijarPin(entradaPin.value + e.key); e.preventDefault(); }
  else if (e.key === 'Backspace') { fijarPin(entradaPin.value.slice(0, -1)); e.preventDefault(); }
});

formOperativo.addEventListener('submit', async (e) => {
  e.preventDefault();
  limpiarErrores('documento', 'pin');

  const documento = document.getElementById('documento').value.trim();
  const pin = entradaPin.value;

  let hayFallos = false;
  if (!documento) {
    mostrarError('documento', 'Escriba su documento o codigo.');
    hayFallos = true;
  }
  if (!RE_PIN.test(pin)) {
    mostrarError('pin', 'El PIN debe tener 4 digitos.');
    hayFallos = true;
  }
  if (hayFallos) return;

  btnEntrarPin.disabled = true;
  btnEntrarPin.textContent = 'Verificando...';
  try {
    const r = await api.post('/auth/login', { documento, pin });
    fijarTokenCsrf(r.tokenCsrf);
    window.location.href = destinoDe(r.usuario.rol);
  } catch (error) {
    manejarErrorLogin(error, 'pin');
    fijarPin('');   // el PIN se borra tras un fallo: nadie lo ve en pantalla
    btnEntrarPin.disabled = false;
    btnEntrarPin.textContent = 'Entrar';
  }
});

/* ---------------------------------------------------------------
   Si ya hay sesion viva, no tiene sentido volver a pedir credenciales.
   --------------------------------------------------------------- */
cargarSesionActual().then((sesion) => {
  if (sesion) window.location.href = destinoDe(sesion.usuario.rol);
}).catch(() => { /* sin sesion: se queda en el login */ });
