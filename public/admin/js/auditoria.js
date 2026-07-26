/**
 * Vista 9: Historial de Auditoría y Logs de Seguridad.  RF-23.
 *
 * FSD 4.1 vista 9:
 *  - filtrado server-side con paginación por cursor (scroll infinito)
 *  - clic en una fila expande el detalle completo (entidad afectada, autorizador)
 *  - exportación del filtro activo a CSV
 *  - "No existe ningún control de edición o borrado."
 *
 * Este archivo no tiene un solo POST/PUT/DELETE. La única escritura posible
 * sobre el log es la que hace el propio sistema al auditar, y ni siquiera la
 * aplicación puede modificarlo después: el usuario de base de datos carece de
 * UPDATE y DELETE sobre `log_auditoria`.
 */
import { api } from '/comun/api.js';
import { el, reemplazar, aviso, formatearFecha } from '/comun/ui.js';
import { iniciarShell } from './shell.js';

const sesion = await iniciarShell('auditoria.ver');
if (!sesion) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);

const estado = {
  eventos: [],
  cursor: null,
  filtros: {},
  expandido: null,
  cargando: false,
};

/* ---------------------------------------------------------------
   Integridad de la cadena de hashes (FSD 5.8)
   --------------------------------------------------------------- */
async function verificarIntegridad() {
  try {
    const r = await api.get('/auditoria/integridad');
    const cont = $('integridad');
    cont.className = `integridad ${r.integra ? 'integridad--ok' : 'integridad--rota'}`;
    reemplazar(cont,
      el('span', { attrs: { 'aria-hidden': 'true' } }, r.integra ? '🔒' : '⚠'),
      el('span', {},
        el('strong', { texto: r.integra ? 'Registro íntegro. ' : 'Registro alterado. ' }),
        r.mensaje
      ),
      !r.integra
        ? el('span', { clase: 'texto-sm' },
            ' Alguien modificó o eliminó registros por fuera de la aplicación, con acceso directo a la base de datos.')
        : null
    );
  } catch (error) {
    $('integridad').textContent = `No se pudo verificar la integridad: ${error.message}`;
  }
}

/* ---------------------------------------------------------------
   Eventos
   --------------------------------------------------------------- */
const ICONO_SEVERIDAD = { alta: '🔴', media: '🟠', baja: '⚪' };
const ETIQUETA_SEVERIDAD = { alta: 'Riesgo alto', media: 'Riesgo medio', baja: 'Informativo' };

function fila(ev) {
  const expandido = estado.expandido === ev.id;

  return el('button', {
    clase: `evento evento--${ev.severidad}`,
    attrs: { type: 'button', 'aria-expanded': String(expandido) },
    on: {
      click: () => {
        estado.expandido = expandido ? null : ev.id;
        pintar();
      },
    },
  },
    el('span', { clase: 'evento__hora', texto: formatearFecha(ev.fecha) }),
    el('span', { clase: 'evento__cuerpo' },
      el('div', { clase: 'fila', attrs: { style: 'gap:.4rem' } },
        // Severidad con icono y texto accesible, no solo color (6.4).
        el('span', { attrs: { title: ETIQUETA_SEVERIDAD[ev.severidad], 'aria-label': ETIQUETA_SEVERIDAD[ev.severidad] } },
          ICONO_SEVERIDAD[ev.severidad]),
        el('span', { clase: 'evento__accion', texto: ev.accion })
      ),
      // textContent: el detalle es texto libre que escribió el sistema a partir
      // de datos del usuario. Nunca innerHTML (FSD 6.1).
      el('div', { clase: 'evento__detalle', texto: ev.detalle }),
      el('div', { clase: 'evento__meta',
        texto: `${ev.usuario}${ev.autorizador ? ` · autorizado por ${ev.autorizador}` : ''}${ev.ipOrigen ? ` · ${ev.ipOrigen}` : ''}` }),

      expandido
        ? el('div', { clase: 'evento__expandido' },
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'Registro'), el('span', { texto: `#${ev.id}` })),
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'Momento'), el('span', { texto: ev.fecha })),
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'Usuario'), el('span', { texto: `${ev.usuario} (id ${ev.idUsuario})` })),
            ev.autorizador
              ? el('div', { clase: 'evento__campo' }, el('strong', {}, 'Autorizador'), el('span', { texto: ev.autorizador }))
              : null,
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'Entidad'),
              el('span', { texto: `${ev.entidad}${ev.idEntidad ? ` #${ev.idEntidad}` : ''}` })),
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'IP de origen'), el('span', { texto: ev.ipOrigen ?? '—' })),
            el('div', { clase: 'evento__campo' }, el('strong', {}, 'Severidad'), el('span', { texto: ETIQUETA_SEVERIDAD[ev.severidad] }))
          )
        : null
    )
  );
}

function pintar() {
  $('conteo-eventos').textContent = `${estado.eventos.length} evento(s) cargado(s)`;

  if (!estado.eventos.length) {
    reemplazar($('eventos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay eventos que coincidan con el filtro.' })));
    reemplazar($('paginacion'));
    return;
  }

  reemplazar($('eventos'), ...estado.eventos.map(fila));

  // Paginación por cursor: "cargar más" en vez de números de página, porque el
  // log crece mientras se consulta.
  reemplazar($('paginacion'),
    estado.cursor
      ? el('button', {
          clase: 'btn btn--secundario',
          attrs: { type: 'button', disabled: estado.cargando },
          on: { click: () => cargar({ mas: true }) },
        }, estado.cargando ? 'Cargando…' : 'Cargar más eventos')
      : el('span', { clase: 'texto-tenue texto-sm', texto: 'No hay más eventos.' })
  );
}

/* ---------------------------------------------------------------
   Carga y filtros
   --------------------------------------------------------------- */
function construirQuery(conCursor = false) {
  const p = new URLSearchParams();
  const { desde, hasta, idUsuario, accion } = estado.filtros;
  if (desde) p.set('desde', desde);
  if (hasta) p.set('hasta', hasta);
  if (idUsuario) p.set('idUsuario', idUsuario);
  if (accion) p.set('accion', accion);
  if (conCursor && estado.cursor) p.set('cursor', String(estado.cursor));
  return p;
}

async function cargar({ mas = false } = {}) {
  estado.cargando = true;
  if (!mas) { estado.eventos = []; estado.cursor = null; }
  pintar();

  try {
    const r = await api.get(`/auditoria?${construirQuery(mas)}&limite=50`);
    estado.eventos = mas ? [...estado.eventos, ...r.eventos] : r.eventos;
    estado.cursor = r.cursorSiguiente;
  } catch (error) {
    aviso(error.message, 'error');
  } finally {
    estado.cargando = false;
    pintar();
  }
}

$('btn-filtrar').addEventListener('click', () => {
  estado.filtros = {
    desde: $('f-desde').value || null,
    hasta: $('f-hasta').value || null,
    idUsuario: $('f-usuario').value || null,
    accion: $('f-accion').value || null,
  };
  cargar();
});

$('btn-limpiar').addEventListener('click', () => {
  $('f-desde').value = '';
  $('f-hasta').value = '';
  $('f-usuario').value = '';
  $('f-accion').value = '';
  estado.filtros = {};
  cargar();
});

// Exportación del filtro activo (FSD 4.1 vista 9).
$('btn-csv').addEventListener('click', () => {
  window.location.href = `/api/v1/auditoria-exportar?${construirQuery()}`;
});

/* ---------------------------------------------------------------
   Inicio
   --------------------------------------------------------------- */
try {
  const [usuarios, acciones] = await Promise.all([
    api.get('/usuarios?limite=100'),
    api.get('/auditoria/acciones'),
  ]);

  reemplazar($('f-usuario'),
    el('option', { attrs: { value: '' }, texto: 'Todos' }),
    ...usuarios.usuarios.map((u) => el('option', { attrs: { value: String(u.id) }, texto: u.nombreCompleto }))
  );
  reemplazar($('f-accion'),
    el('option', { attrs: { value: '' }, texto: 'Todas' }),
    ...acciones.acciones.map((a) => el('option', {
      attrs: { value: a.accion }, texto: `${ICONO_SEVERIDAD[a.severidad]} ${a.accion} (${a.veces})`,
    }))
  );
} catch (error) {
  aviso(`No se pudieron cargar los filtros: ${error.message}`, 'error');
}

await Promise.all([verificarIntegridad(), cargar()]);
