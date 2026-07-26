/**
 * Vista 18: Panel Central de Cuentas y Mesas.  RF-17.
 *
 * FSD 4.4 vista 18:
 *  - lista de cuentas activas (mesa, mesero, ítems, tiempo abierto)
 *  - las pre-cuentas solicitadas se destacan en amarillo parpadeante y suben al inicio
 *  - clic en una cuenta abre la terminal de cobro (vista 19)
 *  - sincronización en tiempo real
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, formatearFecha } from '/comun/ui.js';
import { iniciarPos, turnoActivo } from './comun.js';

const contexto = await iniciarPos({
  vista: 'cuentas',
  alRefrescar: cargar,
  // El panel se refresca solo con cualquier cosa que cambie lo que se ve en él:
  // mesas, comandas y el propio plano del salón.
  eventos: {
    'precuenta.solicitada': (d) => { aviso(`Pre-cuenta solicitada en la mesa ${d.mesa}.`, 'info', 5000); cargar(); },
    'mesa.estado': cargar,
    'orden.creada': cargar,
    // El número de platos y el total de la cuenta cambian con cada línea que
    // el mesero añade o que cocina despacha.
    'orden.actualizada': cargar,
    'linea.estado': cargar,
    // El administrador renombró una zona o retiró una mesa: la columna "zona"
    // del panel se queda mintiendo hasta recargar.
    'salon.actualizado': cargar,
  },
});
if (!contexto) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);
const estado = { cuentas: [], buscar: '' };

function pintar() {
  // Sin turno abierto, no se puede cobrar: se invita a abrirlo (FSD 5.7).
  if (!turnoActivo) {
    $('aviso-sin-turno').classList.remove('oculto');
    $('panel-cuentas').classList.add('oculto');
    return;
  }
  $('aviso-sin-turno').classList.add('oculto');
  $('panel-cuentas').classList.remove('oculto');

  let lista = estado.cuentas;
  if (estado.buscar) {
    const q = estado.buscar.toLowerCase();
    lista = lista.filter((c) => c.mesa.toLowerCase().includes(q) || c.mesero.toLowerCase().includes(q));
  }

  $('conteo-cuentas').textContent = `${lista.length} cuenta(s) activa(s)`;

  if (!lista.length) {
    reemplazar($('cuentas-lista'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay cuentas abiertas.' })));
    return;
  }

  reemplazar($('cuentas-lista'), ...lista.map((c) => el('button', {
    clase: `cuenta-fila ${c.precuenta ? 'cuenta-fila--precuenta' : ''}`,
    attrs: { type: 'button' },
    on: { click: () => { window.location.href = `/caja/cobro.html?id=${c.idOrden}`; } },
  },
    el('span', { clase: 'cuenta-fila__mesa', texto: c.mesa }),
    el('span', { clase: 'cuenta-fila__info' },
      el('div', { clase: 'cuenta-fila__mesero', texto: `${c.zona} · ${c.mesero}` }),
      el('div', { clase: 'cuenta-fila__meta',
        texto: `${c.items} ítem(s) · ${c.numComensales} personas · abierta hace ${c.minutos} min` })
    ),
    // La pre-cuenta lleva icono además del color parpadeante (FSD 6.4).
    c.precuenta
      ? el('span', { clase: 'insignia insignia--alerta' }, '🧾 Pre-cuenta')
      : null,
    el('span', { clase: 'cuenta-fila__accion' }, 'Cobrar ›')
  )));
}

$('buscar').addEventListener('input', (e) => { estado.buscar = e.target.value.trim(); pintar(); });

async function cargar() {
  try {
    const r = await api.get('/caja/cuentas');
    estado.cuentas = r.cuentas;
    pintar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

await cargar();
