/**
 * Base compartida del POS del cajero.
 * Verifica sesión, monta cabecera con estado de turno y canal de tiempo real.
 */
import { cargarSesionActual, api, alPerderSesion } from '/comun/api.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';
import { el, reemplazar, aviso, campana } from '/comun/ui.js';

export let sesion = null;
export let turnoActivo = null;

/**
 * Pinta el globo de pendientes sobre una entrada del nav.
 *
 * Existe porque las reservas y los domicilios que entran por la aplicación
 * llegan a CUALQUIER pantalla de caja, no solo a la suya: un cajero que está
 * cobrando tiene que poder ver que hay algo esperando sin cambiar de vista. El
 * aviso emergente se va a los pocos segundos; el globo se queda hasta que se
 * resuelve.
 *
 * @param {string} idNav  Id del enlace, por ejemplo 'nav-reservas'.
 * @param {number} n      Pendientes. Con 0 se esconde.
 */
export function pintarPendientes(idNav, n) {
  const enlace = document.getElementById(idNav);
  if (!enlace) return;

  let globo = enlace.querySelector('.pos-nav__globo');
  if (!n) { globo?.remove(); return; }

  if (!globo) {
    globo = el('span', { clase: 'pos-nav__globo' });
    enlace.append(globo);
  }
  globo.textContent = String(n);
  // El número solo no basta para un lector de pantalla: fuera de contexto,
  // "3" no dice nada.
  globo.setAttribute('aria-label', `${n} sin resolver`);
}

/**
 * Consulta cuántas reservas y domicilios esperan respuesta, y actualiza los
 * globos. Se llama al arrancar y cada vez que llega un evento del canal.
 */
export async function refrescarPendientes() {
  const permisos = sesion?.permisos ?? [];

  if (permisos.includes('reservas.ver')) {
    await api.get('/reservas?estado=vivas')
      .then((r) => pintarPendientes('nav-reservas', r.pendientes))
      .catch(() => {});
  }
  if (permisos.includes('domicilios.ver')) {
    await api.get('/domicilios?estado=vivos')
      .then((r) => pintarPendientes('nav-domicilios', r.pendientes))
      .catch(() => {});
  }
}

async function refrescarTurno() {
  try {
    const r = await api.get('/caja/turno-activo');
    turnoActivo = r.turno;
  } catch {
    turnoActivo = null;
  }
  pintarEstadoTurno();
  return turnoActivo;
}

function pintarEstadoTurno() {
  const cont = document.getElementById('estado-turno');
  if (!cont) return;
  if (turnoActivo) {
    cont.className = 'pos-cab__turno';
    cont.textContent = `● Turno abierto`;
  } else {
    cont.className = 'pos-cab__turno pos-cab__turno--cerrado';
    cont.textContent = '○ Sin turno';
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.vista  'cuentas' | 'turno' | 'reservas' | 'domicilios'.
 * @param {Function} [opciones.alRefrescar]  Recarga al reconectar/polling.
 * @param {object} [opciones.eventos]  { tipoEvento: manejador } del WebSocket.
 */
export async function iniciarPos({ vista, alRefrescar, eventos } = {}) {
  sesion = await cargarSesionActual();
  if (!sesion) { window.location.href = '/'; return null; }

  if (!sesion.permisos.includes('caja.cobrar') && !sesion.permisos.includes('caja.turno.abrir')) {
    document.body.innerHTML = '<div class="vacio"><h1>Sin acceso</h1>' +
      '<p>Esta terminal es para el personal de caja.</p>' +
      '<a class="btn btn--primario" href="/">Volver</a></div>';
    return null;
  }

  alPerderSesion(() => { window.location.href = '/'; });

  // Reloj.
  const reloj = document.getElementById('reloj-pos');
  if (reloj) {
    const tick = () => { reloj.textContent = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }); };
    tick();
    setInterval(tick, 10000);
  }

  // Usuario.
  const nombreU = document.getElementById('nombre-cajero');
  if (nombreU) nombreU.textContent = sesion.usuario.nombre;

  // Nav activo.
  document.getElementById(`nav-${vista}`)?.classList.add('pos-nav__item--activo');

  // El turno se carga ANTES de conectar el canal, y no después: al abrirse el
  // WebSocket se dispara `alRefrescar`, y si la vista consultara `turnoActivo`
  // con el turno aún sin cargar concluiría que no hay ninguno. La terminal de
  // cobro llegó a expulsar al cajero a la pantalla de apertura por esto.
  await refrescarTurno();

  // Las entradas de reservas y domicilios se esconden si el cajero no tiene
  // esos permisos. Es solo claridad: la API revalida igual (FSD 6.1, CA-10).
  for (const [id, permiso] of [['nav-reservas', 'reservas.ver'], ['nav-domicilios', 'domicilios.ver']]) {
    if (!sesion.permisos.includes(permiso)) document.getElementById(id)?.remove();
  }

  const canal = new CanalTiempoReal({ alRefrescar });
  const indic = document.getElementById('indicador-conexion');
  if (indic) indic.append(crearIndicadorConexion(canal));
  canal.on('sesion.invalida', () => { window.location.href = '/'; });

  // Los globos del nav se actualizan en TODAS las vistas de caja, no solo en
  // las de reservas y domicilios: quien está cobrando también tiene que
  // enterarse de que entró algo por la aplicación.
  const alLlegarAlgo = () => { refrescarPendientes(); };
  for (const tipo of ['reserva.creada', 'reserva.actualizada', 'domicilio.creado', 'domicilio.actualizado']) {
    canal.on(tipo, alLlegarAlgo);
  }

  if (eventos) for (const [tipo, fn] of Object.entries(eventos)) canal.on(tipo, fn);
  canal.conectar();

  refrescarPendientes();

  document.getElementById('btn-salir-pos')?.addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* se sale igual */ }
    canal.cerrar();
    window.location.href = '/';
  });

  return { sesion, canal, refrescarTurno };
}

export { refrescarTurno, el, reemplazar, aviso, campana };
