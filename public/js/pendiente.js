/**
 * Pantallas de interfaces aun no construidas.
 *
 * Comprueba la sesion igual que las vistas reales: sin sesion, al login. Asi
 * el enrutamiento por rol del login (que ya manda a cada quien a su interfaz)
 * se puede probar de punta a punta desde la fase 1.
 */
import { api, cargarSesionActual } from '/comun/api.js';

const sesion = await cargarSesionActual();
if (!sesion) {
  window.location.href = '/';
}

document.getElementById('btn-salir')?.addEventListener('click', async () => {
  try {
    await api.post('/auth/logout');
  } catch { /* aunque falle, se sale igual */ }
  window.location.href = '/';
});
