/**
 * Base compartida del POS del cajero.
 * Verifica sesión, monta cabecera con estado de turno y canal de tiempo real.
 */
import { cargarSesionActual, api, alPerderSesion } from '/comun/api.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';
import { el, reemplazar, aviso } from '/comun/ui.js';

export let sesion = null;
export let turnoActivo = null;

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
 * @param {string} opciones.vista  'cuentas' | 'turno' — para marcar el nav.
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

  const canal = new CanalTiempoReal({ alRefrescar });
  const indic = document.getElementById('indicador-conexion');
  if (indic) indic.append(crearIndicadorConexion(canal));
  canal.on('sesion.invalida', () => { window.location.href = '/'; });
  if (eventos) for (const [tipo, fn] of Object.entries(eventos)) canal.on(tipo, fn);
  canal.conectar();

  document.getElementById('btn-salir-pos')?.addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* se sale igual */ }
    canal.cerrar();
    window.location.href = '/';
  });

  return { sesion, canal, refrescarTurno };
}

export { refrescarTurno, el, reemplazar, aviso };
