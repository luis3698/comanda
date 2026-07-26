/**
 * Utilidades de interfaz.
 *
 * FSD 6.1 (XSS): "en JS se usa textContent/plantillas seguras, nunca innerHTML
 * con datos de usuario".
 *
 * Por eso el DOM se construye con el() y nunca concatenando HTML. Es una
 * decision deliberada: en este sistema hay campos de texto libre que escribe
 * el personal y que se muestran en otras pantallas -- las notas de una comanda
 * se pintan en el KDS. Un innerHTML ahi seria un XSS almacenado.
 */

/**
 * Crea un elemento del DOM de forma segura.
 *
 * @param {string} etiqueta  Nombre de la etiqueta.
 * @param {object} [props]   Propiedades. `clase`, `texto`, `attrs`, `on` y
 *                           cualquier propiedad directa del elemento.
 * @param {...(Node|string|null)} hijos  Los strings se insertan como TEXTO.
 *
 * @example
 *   el('td', { texto: usuario.nombre })        // seguro aunque el nombre lleve <script>
 *   el('button', { clase: 'btn', on: { click: guardar } }, 'Guardar')
 */
export function el(etiqueta, props = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  const { clase, texto, attrs, on, ...resto } = props ?? {};

  if (clase) nodo.className = clase;
  if (texto != null) nodo.textContent = String(texto);

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      nodo.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (on) {
    for (const [evento, fn] of Object.entries(on)) nodo.addEventListener(evento, fn);
  }
  for (const [k, v] of Object.entries(resto)) nodo[k] = v;

  for (const hijo of hijos.flat()) {
    if (hijo == null || hijo === false) continue;
    // Los strings se convierten en nodos de texto: nunca se interpretan como HTML.
    nodo.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
  }
  return nodo;
}

/** Vacia un contenedor y le pone hijos nuevos. */
export function reemplazar(contenedor, ...hijos) {
  contenedor.replaceChildren(...hijos.flat().filter((h) => h != null && h !== false));
  return contenedor;
}

/* ---------------------------------------------------------------
   Avisos flotantes
   --------------------------------------------------------------- */

function contenedorAvisos() {
  let c = document.querySelector('.avisos');
  if (!c) {
    c = el('div', {
      clase: 'avisos',
      attrs: {
        // 6.4: las actualizaciones dinamicas se anuncian a lectores de pantalla.
        'aria-live': 'polite',
        'aria-atomic': 'false',
        role: 'status',
      },
    });
    document.body.append(c);
  }
  return c;
}

/**
 * Muestra un aviso temporal.
 * @param {string} mensaje
 * @param {'info'|'exito'|'error'|'alerta'} tipo
 */
export function aviso(mensaje, tipo = 'info', ms = 4500) {
  const prefijo = { exito: 'Listo:', error: 'Error:', alerta: 'Atencion:', info: '' }[tipo] ?? '';

  const nodo = el('div', { clase: `aviso aviso--${tipo}` },
    el('span', { clase: 'aviso__texto' },
      // El prefijo textual acompana al color: 6.4 prohibe comunicar solo por color.
      prefijo ? el('strong', { texto: `${prefijo} ` }) : null,
      String(mensaje)
    ),
    el('button', {
      clase: 'btn btn--plano btn--sm',
      attrs: { 'aria-label': 'Cerrar aviso', type: 'button' },
      on: { click: () => nodo.remove() },
    }, '×')
  );

  contenedorAvisos().append(nodo);
  if (ms > 0) setTimeout(() => nodo.remove(), ms);
  return nodo;
}

/* ---------------------------------------------------------------
   Confirmacion
   FSD 6.3: "Acciones destructivas siempre con confirmacion".
   --------------------------------------------------------------- */

/**
 * Pide confirmacion en un <dialog> accesible.
 * @returns {Promise<boolean>}
 */
export function confirmar({ titulo, mensaje, textoConfirmar = 'Confirmar', peligro = false }) {
  return new Promise((resolver) => {
    const dlg = el('dialog', { attrs: { role: 'dialog', 'aria-modal': 'true' } });
    let respuesta = false;

    dlg.append(
      el('div', { clase: 'modal__cabecera' }, el('h2', { texto: titulo })),
      el('div', { clase: 'modal__cuerpo' }, el('p', { texto: mensaje })),
      el('div', { clase: 'modal__pie' },
        el('button', {
          clase: 'btn btn--secundario',
          attrs: { type: 'button' },
          on: { click: () => { respuesta = false; dlg.close(); } },
        }, 'Cancelar'),
        el('button', {
          clase: `btn ${peligro ? 'btn--peligro' : 'btn--primario'}`,
          attrs: { type: 'button' },
          on: { click: () => { respuesta = true; dlg.close(); } },
        }, textoConfirmar)
      )
    );

    dlg.addEventListener('close', () => { dlg.remove(); resolver(respuesta); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* ---------------------------------------------------------------
   Formato
   --------------------------------------------------------------- */

/** Fecha legible en espanol. Devuelve un guion si no hay valor. */
export function formatearFecha(valor, { conHora = true } = {}) {
  if (!valor) return '—';
  // El servidor envia 'YYYY-MM-DD HH:mm:ss'; Safari no lo parsea sin la T.
  const fecha = new Date(String(valor).replace(' ', 'T'));
  if (Number.isNaN(fecha.getTime())) return '—';

  const opciones = conHora
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return fecha.toLocaleString('es-CO', opciones);
}

const FORMATO_MONEDA = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2,
});

/**
 * Formatea un importe.
 * El servidor envia los DECIMAL como string para no perder precision; aqui
 * solo se convierte para MOSTRAR. Ningun total se calcula en el cliente: los
 * calculos monetarios son del servidor (FSD 5.7).
 */
export function formatearDinero(valor) {
  if (valor == null) return '—';
  return FORMATO_MONEDA.format(Number(valor));
}

/** Retrasa la ejecucion: usado en buscadores (FSD 4.1 vista 3: debounce 200 ms). */
export function retrasar(fn, ms = 200) {
  let temporizador;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), ms);
  };
}
