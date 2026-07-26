/**
 * Base compartida por las vistas del comandero.
 *
 * Verifica la sesion (debe ser un mesero o alguien con permiso operativo),
 * monta el indicador de conexion y expone helpers comunes.
 */
import { cargarSesionActual, api, alPerderSesion } from '/comun/api.js';
import { CanalTiempoReal, crearIndicadorConexion } from '/comun/ws.js';
import { aviso } from '/comun/ui.js';

export let sesion = null;

export async function iniciarComandero({ alRefrescar } = {}) {
  sesion = await cargarSesionActual();
  if (!sesion) {
    window.location.href = '/';
    return null;
  }
  // Sin permiso para operar el salon, no hay nada que hacer aqui.
  if (!sesion.permisos.includes('salon.ver')) {
    document.body.innerHTML = '<div class="vacio"><h1>Sin acceso</h1>' +
      '<p>Esta interfaz es para el personal de sala.</p>' +
      '<a class="btn btn--primario" href="/">Volver</a></div>';
    return null;
  }

  const nombre = document.getElementById('nombre-mesero');
  if (nombre) nombre.textContent = sesion.usuario.nombre;

  alPerderSesion(() => { window.location.href = '/'; });

  // Canal de tiempo real con reconexion y fallback a polling (FSD 2.2).
  const canal = new CanalTiempoReal({ alRefrescar });
  const indicador = document.getElementById('indicador-conexion');
  if (indicador) indicador.append(crearIndicadorConexion(canal));
  canal.on('sesion.invalida', () => { window.location.href = '/'; });

  // ---- Avisos que valen en CUALQUIER vista del comandero ----
  // Estaban solo en la pantalla de seguimiento, así que un mesero que estuviera
  // mirando el plano o tomando nota en otra mesa no se enteraba de que su plato
  // ya estaba listo hasta que recargaba. Al vivir aquí, suenan en las tres.

  canal.on('linea.estado', (d) => {
    // FSD 4.2 vista 14: al marcar "Listo", el dispositivo vibra y avisa.
    // Solo al mesero dueño de la mesa: si no, cada plato del turno haría sonar
    // la tableta de todo el mundo y el aviso dejaría de significar nada.
    if (d.estado !== 'listo') return;
    if (d.idMesero && d.idMesero !== sesion.usuario.id) return;

    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    aviso(`¡${d.producto} listo para servir en la mesa ${d.mesa}!`, 'exito', 8000);
  });

  // El plano cambió (el administrador movió mesas, creó una zona, retiró una
  // mesa…). Se recarga la vista actual, sea cual sea.
  canal.on('salon.actualizado', () => alRefrescar?.());

  canal.conectar();

  document.getElementById('btn-salir')?.addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* se sale igual */ }
    canal.cerrar();
    window.location.href = '/';
  });

  return { sesion, canal };
}

export { aviso };
