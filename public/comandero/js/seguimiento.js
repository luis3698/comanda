/**
 * Vista 14: Estado de Preparación de la Sala.  RF-13.
 *
 * FSD 4.2 vista 14:
 *  - lista de tarjetas por mesa asignada al mesero
 *  - chips de estado: En espera → Preparando → Listo para servir (pulsante)
 *  - actualización push por WebSocket
 *  - cuando cocina marca "Listo", el dispositivo vibra (navigator.vibrate) y
 *    muestra una notificación destacada
 *  - botón "Servido" en cada plato listo
 *  - badge con conteo de platos listos en la barra inferior
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, formatearFecha } from '/comun/ui.js';
import { iniciarComandero, sesion } from './comun.js';

const contexto = await iniciarComandero({ alRefrescar: cargar });
if (!contexto) throw new Error('sin sesión');
const { canal } = contexto;

const $ = (id) => document.getElementById(id);
const estado = { ordenes: [] };

const ETIQUETA = { en_cola: 'En espera', preparando: 'Preparando', listo: '¡Listo para servir!', servido: 'Servido' };

function pintar() {
  // Solo las mesas del mesero con algo enviado a cocina.
  const conActividad = estado.ordenes.filter((o) =>
    o.lineas.some((l) => l.enviada && l.estadoPreparacion !== 'anulado' && l.estadoPreparacion !== 'servido')
  );

  if (!conActividad.length) {
    reemplazar($('tarjetas-mesas'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay platos en preparación.' }),
      el('p', { clase: 'texto-sm' }, 'Cuando envíe una comanda a cocina, su avance aparecerá aquí.')));
    actualizarBadge(0);
    return;
  }

  reemplazar($('tarjetas-mesas'), ...conActividad.map(tarjetaMesa));
  const listos = contarListos();
  actualizarBadge(listos);
}

function tarjetaMesa(orden) {
  const lineas = orden.lineas.filter((l) =>
    l.enviada && l.estadoPreparacion !== 'anulado' && l.estadoPreparacion !== 'servido');

  return el('div', { clase: 'tarjeta-mesa' },
    el('div', { clase: 'tarjeta-mesa__cab' },
      el('span', { texto: `Mesa ${orden.mesa}` }),
      el('span', { clase: 'texto-tenue texto-sm', attrs: { style: 'font-weight:400;margin-left:auto' },
        texto: `${orden.numComensales} personas` })
    ),
    ...lineas.map((l) => el('div', { clase: 'fila-seguimiento' },
      el('span', { clase: 'linea-pedido__cant', texto: `${l.cantidad}×` }),
      el('span', { clase: 'fila-seguimiento__nombre' },
        l.producto,
        l.notas ? el('div', { clase: 'linea-pedido__notas', texto: `📝 ${l.notas}` }) : null
      ),
      // El estado se comunica con texto además del color (FSD 6.4).
      el('span', { clase: `chip-estado chip-estado--${l.estadoPreparacion}` },
        ETIQUETA[l.estadoPreparacion] ?? l.estadoPreparacion),
      // "Servido" solo aparece cuando el plato está listo (FSD 4.2 vista 14).
      l.estadoPreparacion === 'listo'
        ? el('button', {
            clase: 'btn btn--primario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => marcarServido(l) },
          }, 'Servido')
        : null
    ))
  );
}

function contarListos() {
  return estado.ordenes.reduce((s, o) =>
    s + o.lineas.filter((l) => l.estadoPreparacion === 'listo').length, 0);
}

function actualizarBadge(n) {
  const badge = $('badge-listos');
  badge.textContent = String(n);
  badge.classList.toggle('oculto', n === 0);
}

async function marcarServido(linea) {
  try {
    await api.patch(`/kds/lineas/${linea.id}/servido`, {});
    await cargar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Tiempo real: la alerta de "Listo" es el corazón de esta vista
   --------------------------------------------------------------- */
// La notificación con vibración vive en comun.js, para que suene también
// cuando el mesero está en el plano o dentro de otra mesa (FSD 4.2 vista 14).
// Aquí solo queda repintar la lista.
canal.on('linea.estado', () => cargar());
canal.on('orden.actualizada', () => cargar());

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargar() {
  try {
    const activas = await api.get('/ordenes/activas');
    // Se traen los detalles de cada mesa propia con líneas.
    const propias = activas.ordenes.filter((o) => o.propia && o.lineas > 0);
    const detalles = await Promise.all(propias.map((o) => api.get(`/ordenes/${o.id}`)));
    estado.ordenes = detalles;
    pintar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

await cargar();
