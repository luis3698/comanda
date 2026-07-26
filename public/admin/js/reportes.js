/**
 * Vista 10: Centro de Reportes y Exportación.  RF-22.
 *
 * FSD 4.1 vista 10:
 *  - catálogo de reportes + filtros avanzados + vista previa + exportar PDF/Excel
 *  - validación de rango de fechas (inicio <= fin, máximo 12 meses)
 *  - generación asíncrona con indicador de progreso
 *  - descarga vía Blob
 *  - "los totales de la vista previa se calculan en servidor (nunca en cliente)
 *     para garantizar consistencia contable"
 *
 * Esta pantalla NO suma nada. Pinta lo que devuelve el servidor, y la
 * exportación pide el mismo reporte con ?formato=: por eso el archivo y la
 * pantalla no pueden divergir.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, formatearDinero, formatearFecha } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('reportes.ver');
if (!sesion) throw new Error('sin sesión');

const puedeExportar = tienePermiso('reportes.exportar');
const $ = (id) => document.getElementById(id);

const ICONOS = {
  ventas_por_metodo: '💳',
  cierres_de_caja: '💰',
  rendimiento_personal: '👥',
  costos_produccion: '📉',
  informe_fiscal: '🧾',
};

const estado = { catalogo: [], tipoActivo: null, reporte: null };

/* ---------------------------------------------------------------
   Rangos de fecha
   --------------------------------------------------------------- */
function iso(d) { return d.toISOString().slice(0, 10); }

function aplicarRangoRapido(clave) {
  const hoy = new Date();
  const desde = new Date(hoy);
  let hasta = new Date(hoy);

  if (clave === 'ayer') { desde.setDate(hoy.getDate() - 1); hasta = new Date(desde); }
  else if (clave === 'semana') desde.setDate(hoy.getDate() - 6);
  else if (clave === 'mes') desde.setDate(hoy.getDate() - 29);

  $('r-desde').value = iso(desde);
  $('r-hasta').value = iso(hasta);
}

/**
 * Validación de UX. La autoritativa la hace el servidor (validarRango en
 * server/servicios/reportes.js); esta solo evita un viaje inútil.
 */
function validarRango() {
  const desde = $('r-desde').value;
  const hasta = $('r-hasta').value;
  const err = $('error-rango');
  err.textContent = '';

  if (!desde || !hasta) { err.textContent = 'Indique ambas fechas.'; return null; }
  if (desde > hasta) { err.textContent = 'La fecha inicial no puede ser posterior a la final.'; return null; }

  const dias = (new Date(hasta) - new Date(desde)) / 86400000;
  if (dias > 366) { err.textContent = 'El rango no puede superar los 12 meses.'; return null; }

  return { desde, hasta };
}

/* ---------------------------------------------------------------
   Catálogo
   --------------------------------------------------------------- */
function pintarCatalogo() {
  reemplazar($('catalogo'), ...estado.catalogo.map((r) => el('button', {
    clase: `reporte-item ${estado.tipoActivo === r.tipo ? 'reporte-item--activo' : ''}`,
    attrs: { type: 'button', role: 'option', 'aria-selected': String(estado.tipoActivo === r.tipo) },
    on: { click: () => { estado.tipoActivo = r.tipo; pintarCatalogo(); generar(); } },
  },
    el('span', { clase: 'reporte-item__icono', attrs: { 'aria-hidden': 'true' } }, ICONOS[r.tipo] ?? '📄'),
    el('span', { texto: r.titulo })
  )));
}

/* ---------------------------------------------------------------
   Vista previa
   --------------------------------------------------------------- */
function celda(valor, tipo) {
  if (valor == null || valor === '') return '—';
  if (tipo === 'dinero') return formatearDinero(valor);
  if (tipo === 'entero') return new Intl.NumberFormat('es-CO').format(Number(valor));
  // Fechas de MySQL: 'YYYY-MM-DD HH:mm:ss'
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(valor)) {
    return formatearFecha(valor);
  }
  return String(valor);
}

function claseCelda(tipo) {
  if (tipo === 'dinero') return 'celda-dinero';
  if (tipo === 'entero') return 'celda-entero';
  return '';
}

function pintarVistaPrevia(rep) {
  $('titulo-reporte').textContent = rep.titulo;
  $('sub-reporte').textContent =
    `${rep.filas.length} fila(s) · del ${rep.rango.desde} al ${rep.rango.hasta}`;

  if (!rep.filas.length) {
    reemplazar($('vista-previa'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay datos en el rango seleccionado.' })));
    return;
  }

  const tabla = el('table', { clase: 'tabla' },
    el('caption', { clase: 'solo-lectores', texto: rep.titulo }),
    el('thead', {}, el('tr', {}, ...rep.columnas.map((c) =>
      el('th', { attrs: { scope: 'col' }, clase: claseCelda(c.tipo), texto: c.etiqueta })))),
    el('tbody', {}, ...rep.filas.map((f) => el('tr', {}, ...rep.columnas.map((c) =>
      el('td', { clase: claseCelda(c.tipo), texto: celda(f[c.clave], c.tipo) })))))
  );

  // Fila de totales: es la que el contador compara contra el archivo.
  if (rep.totales && Object.keys(rep.totales).length) {
    tabla.append(el('tfoot', {}, el('tr', {}, ...rep.columnas.map((c, i) => {
      if (i === 0) return el('td', { texto: 'TOTALES' });
      const v = rep.totales[c.clave];
      return el('td', { clase: claseCelda(c.tipo), texto: v != null ? celda(v, c.tipo) : '' });
    }))));
  }

  reemplazar($('vista-previa'), tabla);
}

function pintarAccionesExportar() {
  if (!estado.reporte || !puedeExportar) {
    reemplazar($('acciones-exportar'));
    return;
  }
  reemplazar($('acciones-exportar'),
    el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: () => exportar('pdf') },
    }, '📄 Exportar PDF'),
    el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: () => exportar('xlsx') },
    }, '📊 Exportar Excel')
  );
}

/* ---------------------------------------------------------------
   Generación y exportación
   --------------------------------------------------------------- */
async function generar() {
  if (!estado.tipoActivo) return;
  const rango = validarRango();
  if (!rango) return;

  reemplazar($('vista-previa'), el('div', { clase: 'generando' },
    el('span', { clase: 'cargando' }), 'Generando el reporte…'));

  try {
    const p = new URLSearchParams({ desde: rango.desde, hasta: rango.hasta });
    const rep = await api.get(`/reportes/${estado.tipoActivo}?${p}`);
    estado.reporte = rep;
    pintarVistaPrevia(rep);
    pintarAccionesExportar();
  } catch (error) {
    if (error instanceof ErrorPeticion) $('error-rango').textContent = error.message;
    reemplazar($('vista-previa'), el('div', { clase: 'vacio' },
      el('p', { texto: error.message })));
  }
}

/**
 * Descarga vía Blob (FSD 4.1 vista 10).
 * Se usa fetch en vez de un enlace directo para poder mostrar el progreso y
 * capturar un error del servidor en vez de abrir una pestaña con un JSON feo.
 */
async function exportar(formato) {
  const rango = validarRango();
  if (!rango) return;

  const aviso1 = aviso(`Generando ${formato.toUpperCase()}…`, 'info', 0);

  try {
    const p = new URLSearchParams({ desde: rango.desde, hasta: rango.hasta, formato });
    const r = await fetch(`/api/v1/reportes/${estado.tipoActivo}?${p}`, { credentials: 'same-origin' });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.mensaje ?? `Error ${r.status}`);
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${estado.tipoActivo}_${rango.desde}_a_${rango.hasta}.${formato}`;
    document.body.append(a);
    a.click();
    a.remove();
    // Sin revoke, el blob queda en memoria hasta recargar la página.
    URL.revokeObjectURL(url);

    aviso1.remove();
    aviso(`${formato.toUpperCase()} descargado. Sus totales son los mismos de la vista previa.`, 'exito', 5000);
  } catch (error) {
    aviso1.remove();
    aviso(error.message, 'error', 7000);
  }
}

/* ---------------------------------------------------------------
   Inicio
   --------------------------------------------------------------- */
$('btn-generar').addEventListener('click', generar);
$('r-rango').addEventListener('change', (e) => { aplicarRangoRapido(e.target.value); generar(); });

aplicarRangoRapido('hoy');

try {
  const r = await api.get('/reportes');
  estado.catalogo = r.reportes;
  pintarCatalogo();
} catch (error) {
  aviso(error.message, 'error');
}
