/**
 * Vista 6: Configurador de Modificadores y Recetario.  RF-06, RF-07.
 *
 * FSD 4.1 vista 6:
 *  - creacion de grupos con reglas obligatorio/opcional y seleccion min/max
 *    (validacion max >= min)
 *  - asociacion de grupos a productos con buscador multi-seleccion
 *  - en fichas tecnicas, autocompletado de insumos (datalist), calculo en vivo
 *    del costo de receta y alerta visual si el costo supera el 40 % del precio
 *
 * El costo que se muestra al escribir es orientativo; el definitivo lo calcula
 * el servidor al guardar, igual que todos los importes (FSD 5.7).
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar, formatearDinero } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('catalogo.ver');
if (!sesion) throw new Error('sin sesion');

const puedeGestionar = tienePermiso('catalogo.gestionar');
const puedeRecetas = tienePermiso('catalogo.recetas.gestionar');
const UMBRAL = 40;   // % del precio de venta (FSD 4.1 vista 6)

const estado = {
  grupos: [],
  productos: [],
  insumos: [],
  grupoEnEdicion: null,
  opciones: [],
  platosAsociados: new Set(),
  fichaActual: null,
  lineas: [],
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Pestañas
   --------------------------------------------------------------- */
for (const [tab, panel] of [['tab-modificadores', 'panel-modificadores'], ['tab-fichas', 'panel-fichas']]) {
  $(tab).addEventListener('click', () => {
    const esModificadores = tab === 'tab-modificadores';
    $('tab-modificadores').classList.toggle('pestana-principal--activa', esModificadores);
    $('tab-fichas').classList.toggle('pestana-principal--activa', !esModificadores);
    $('tab-modificadores').setAttribute('aria-selected', String(esModificadores));
    $('tab-fichas').setAttribute('aria-selected', String(!esModificadores));
    $('panel-modificadores').classList.toggle('oculto', !esModificadores);
    $('panel-fichas').classList.toggle('oculto', esModificadores);
  });
}

/* ---------------------------------------------------------------
   Modificadores
   --------------------------------------------------------------- */
function tarjetaGrupo(g) {
  // Las reglas se describen en palabras: "0-4 opciones" no dice nada a quien
  // no conozca el modelo de datos.
  const regla = g.obligatorio
    ? (g.seleccionMax === 1
        ? 'Obligatorio: debe elegir exactamente una'
        : `Obligatorio: entre ${g.seleccionMin} y ${g.seleccionMax} opciones`)
    : (g.seleccionMax === 1
        ? 'Opcional: puede elegir una'
        : `Opcional: hasta ${g.seleccionMax} opciones`);

  return el('article', { clase: 'grupo' },
    el('div', { clase: 'grupo__cabecera' },
      el('div', { clase: 'crece' },
        el('div', { clase: 'grupo__nombre', texto: g.nombre }),
        el('div', { clase: 'grupo__reglas', texto: regla })
      ),
      g.obligatorio
        ? el('span', { clase: 'insignia insignia--alerta' }, '● Obligatorio')
        : el('span', { clase: 'insignia insignia--neutra' }, '○ Opcional'),
      puedeGestionar
        ? el('button', {
            clase: 'btn btn--secundario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => abrirModalGrupo(g) },
          }, 'Editar')
        : null,
      puedeGestionar
        ? el('button', {
            clase: 'btn btn--peligro btn--sm',
            attrs: { type: 'button', 'aria-label': `Eliminar ${g.nombre}` },
            on: { click: () => eliminarGrupo(g) },
          }, '🗑')
        : null
    ),

    el('div', { clase: 'grupo__opciones' },
      ...(g.opciones.length
        ? g.opciones.map((o) => el('span', { clase: `opcion-chip ${o.activo ? '' : 'opcion-chip--inactiva'}` },
            o.nombre,
            Number(o.precioExtra) > 0
              ? el('span', { clase: 'opcion-chip__precio', texto: `+${formatearDinero(o.precioExtra)}` })
              : null,
            o.activo ? null : el('span', { clase: 'texto-sm' }, '(inactiva)')
          ))
        : [el('span', { clase: 'texto-tenue texto-sm' }, 'Sin opciones todavía.')])
    ),

    el('div', { clase: 'grupo__platos' },
      g.asociados.length
        ? `Se aplica a: ${g.asociados.map((a) => a.nombre).join(', ')}`
        : 'Sin platos asociados: todavía no aparece en el comandero.'
    )
  );
}

function pintarGrupos() {
  if (!estado.grupos.length) {
    reemplazar($('grupos-lista'), el('div', { clase: 'tarjeta' },
      el('div', { clase: 'vacio' }, el('p', {}, 'No hay grupos de modificadores.'))));
    return;
  }
  reemplazar($('grupos-lista'), ...estado.grupos.map(tarjetaGrupo));
}

/* ---------------------------------------------------------------
   Modal de grupo
   --------------------------------------------------------------- */
const modalGrupo = $('modal-grupo');

function filaOpcion(o, indice) {
  return el('div', { clase: 'opcion-fila' },
    el('input', {
      clase: 'campo__control',
      attrs: { value: o.nombre ?? '', placeholder: 'Nombre de la opción', 'aria-label': `Nombre de la opción ${indice + 1}` },
      on: { input: (e) => { o.nombre = e.target.value; } },
    }),
    el('input', {
      clase: 'campo__control',
      attrs: { value: o.precioExtra ?? '0', inputmode: 'decimal', 'aria-label': `Precio extra de la opción ${indice + 1}` },
      on: { input: (e) => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); o.precioExtra = e.target.value; } },
    }),
    el('button', {
      clase: 'btn btn--peligro btn--sm',
      attrs: { type: 'button', 'aria-label': `Quitar la opción ${o.nombre || indice + 1}` },
      on: {
        click: () => {
          estado.opciones.splice(indice, 1);
          pintarOpciones();
        },
      },
    }, '🗑')
  );
}

function pintarOpciones() {
  if (!estado.opciones.length) {
    reemplazar($('opciones-lista'), el('p', { clase: 'texto-tenue texto-sm' },
      'Añada al menos una opción.'));
    return;
  }
  reemplazar($('opciones-lista'), ...estado.opciones.map(filaOpcion));
}

$('btn-nueva-opcion').addEventListener('click', () => {
  estado.opciones.push({ id: null, nombre: '', precioExtra: '0' });
  pintarOpciones();
});

function pintarPlatosSeleccion() {
  reemplazar($('platos-seleccion'), ...estado.productos.map((p) => {
    const activo = estado.platosAsociados.has(p.id);
    return el('label', { clase: `plato-chip ${activo ? 'plato-chip--activo' : ''}` },
      el('input', {
        attrs: { type: 'checkbox', checked: activo },
        on: {
          change: (e) => {
            if (e.target.checked) estado.platosAsociados.add(p.id);
            else estado.platosAsociados.delete(p.id);
            pintarPlatosSeleccion();
          },
        },
      }),
      p.nombre
    );
  }));
}

function abrirModalGrupo(g = null) {
  estado.grupoEnEdicion = g;
  ['e-g-nombre', 'e-g-min', 'e-g-max'].forEach((k) => { $(k).textContent = ''; });

  $('titulo-modal-grupo').textContent = g ? 'Editar grupo' : 'Nuevo grupo';
  $('g-nombre').value = g?.nombre ?? '';
  $('g-obligatorio').checked = g?.obligatorio ?? false;
  $('g-min').value = String(g?.seleccionMin ?? 0);
  $('g-max').value = String(g?.seleccionMax ?? 1);

  estado.opciones = g ? g.opciones.map((o) => ({ ...o, precioExtra: String(Number(o.precioExtra)) })) : [];
  estado.platosAsociados = new Set(g ? g.asociados.map((a) => a.id) : []);

  pintarOpciones();
  pintarPlatosSeleccion();
  modalGrupo.showModal();
  $('g-nombre').focus();
}

// Marcar "obligatorio" con mínimo 0 no obliga a nada: se sube a 1 solo.
$('g-obligatorio').addEventListener('change', (e) => {
  if (e.target.checked && Number($('g-min').value) < 1) {
    $('g-min').value = '1';
    aviso('Un grupo obligatorio exige al menos una opción: se ajustó el mínimo a 1.', 'info', 4000);
  }
});

$('btn-nuevo-grupo').addEventListener('click', () => abrirModalGrupo(null));
$('btn-cerrar-grupo').addEventListener('click', () => modalGrupo.close());
$('btn-cancelar-grupo').addEventListener('click', () => modalGrupo.close());
if (!puedeGestionar) $('btn-nuevo-grupo').classList.add('oculto');

$('form-grupo').addEventListener('submit', async (e) => {
  e.preventDefault();
  ['e-g-nombre', 'e-g-min', 'e-g-max'].forEach((k) => { $(k).textContent = ''; });

  const datos = {
    nombre: $('g-nombre').value.trim(),
    obligatorio: $('g-obligatorio').checked,
    seleccionMin: Number($('g-min').value),
    seleccionMax: Number($('g-max').value),
  };

  let fallos = false;
  if (datos.nombre.length < 2) { $('e-g-nombre').textContent = 'Mínimo 2 caracteres.'; fallos = true; }
  if (datos.seleccionMax < datos.seleccionMin) {
    $('e-g-max').textContent = 'El máximo no puede ser menor que el mínimo.';
    fallos = true;
  }
  const opciones = estado.opciones.filter((o) => o.nombre?.trim());
  if (!opciones.length) { aviso('Añada al menos una opción al grupo.', 'error'); fallos = true; }
  if (fallos) return;

  const btn = $('btn-guardar-grupo');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    let id = estado.grupoEnEdicion?.id;
    if (id) await api.put(`/catalogo/modificadores/${id}`, datos);
    else id = (await api.post('/catalogo/modificadores', datos)).id;

    await api.put(`/catalogo/modificadores/${id}/opciones`, {
      opciones: opciones.map((o) => ({
        id: o.id, nombre: o.nombre.trim(), precioExtra: Number(o.precioExtra || 0),
      })),
    });
    await api.put(`/catalogo/modificadores/${id}/productos`, {
      productos: [...estado.platosAsociados],
    });

    aviso(estado.grupoEnEdicion ? 'Grupo actualizado.' : `Grupo "${datos.nombre}" creado.`, 'exito');
    modalGrupo.close();
    await cargarTodo();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos) {
      const mapa = { nombre: 'e-g-nombre', seleccionMin: 'e-g-min', seleccionMax: 'e-g-max' };
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        if (mapa[campo]) $(mapa[campo]).textContent = mensaje;
      }
      aviso('Revise los campos marcados.', 'error');
    } else {
      aviso(error.message, 'error', 8000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
});

async function eliminarGrupo(g) {
  const ok = await confirmar({
    titulo: `Eliminar "${g.nombre}"`,
    mensaje: 'Se eliminarán también sus opciones y sus asociaciones a platos. Si sus opciones ya se usaron en comandas, el sistema lo impedirá para no perder el detalle de esas ventas.',
    textoConfirmar: 'Eliminar',
    peligro: true,
  });
  if (!ok) return;

  try {
    await api.borrar(`/catalogo/modificadores/${g.id}`);
    aviso(`Grupo "${g.nombre}" eliminado.`, 'exito');
    await cargarTodo();
  } catch (error) {
    aviso(error.message, 'error', 9000);
  }
}

/* ---------------------------------------------------------------
   Fichas técnicas
   --------------------------------------------------------------- */

/** Costo estimado mientras se escribe. El definitivo lo calcula el servidor. */
function calcularCostoLocal() {
  let total = 0;
  for (const l of estado.lineas) {
    const insumo = estado.insumos.find((i) => i.id === l.idInsumo);
    if (!insumo) continue;
    total += Number(l.cantidad || 0) * Number(insumo.costoPromedio);
  }
  return total;
}

function pintarResumen() {
  if (!estado.fichaActual) return;

  const precio = Number(estado.fichaActual.precioBase);
  const costo = calcularCostoLocal();
  const porcentaje = precio > 0 ? (costo / precio) * 100 : 0;
  const supera = porcentaje > UMBRAL;
  const margen = precio - costo;

  reemplazar($('resumen-ficha'),
    el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Precio de venta'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(precio) })
    ),
    el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Costo de la receta'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(costo) })
    ),
    // FSD 4.1 vista 6: alerta si el costo supera el 40 % del precio.
    el('div', { clase: `resumen-tarjeta ${supera ? 'resumen-tarjeta--alerta' : 'resumen-tarjeta--bien'}` },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, '% de costo'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: `${porcentaje.toFixed(1)} %` }),
      el('div', { clase: 'barra-costo' },
        el('div', {
          clase: 'barra-costo__relleno',
          attrs: {
            style: `width:${Math.min(100, porcentaje)}%; background:${supera ? 'var(--c-error)' : 'var(--c-exito)'}`,
          },
        }),
        el('div', { clase: 'barra-costo__umbral', attrs: { title: 'Umbral del 40 %' } })
      ),
      // El aviso va en texto además del color (6.4).
      supera
        ? el('div', { clase: 'texto-sm', attrs: { style: 'margin-top:.3rem;font-weight:600' } },
            `⚠ Supera el ${UMBRAL} % recomendado`)
        : el('div', { clase: 'texto-sm texto-tenue', attrs: { style: 'margin-top:.3rem' } },
            `Por debajo del ${UMBRAL} % recomendado`)
    ),
    el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Margen bruto'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(margen) })
    )
  );
}

function filaInsumo(l, indice) {
  const insumo = estado.insumos.find((i) => i.id === l.idInsumo);
  const costoLinea = insumo ? Number(l.cantidad || 0) * Number(insumo.costoPromedio) : 0;

  return el('div', { clase: 'insumo-fila' },
    el('select', {
      clase: 'campo__control',
      attrs: { 'aria-label': `Insumo de la línea ${indice + 1}`, disabled: !puedeRecetas },
      on: {
        change: (e) => {
          l.idInsumo = Number(e.target.value);
          pintarLineas();
        },
      },
    },
      el('option', { attrs: { value: '' }, texto: 'Seleccione un insumo…' }),
      ...estado.insumos.map((i) => el('option', {
        attrs: { value: String(i.id), selected: i.id === l.idInsumo },
        texto: i.nombre,
      }))
    ),
    el('input', {
      clase: 'campo__control',
      attrs: {
        value: l.cantidad ?? '', inputmode: 'decimal', placeholder: 'Cantidad',
        'aria-label': `Cantidad de la línea ${indice + 1}`, disabled: !puedeRecetas,
      },
      on: {
        input: (e) => {
          e.target.value = e.target.value.replace(/[^\d.]/g, '');
          l.cantidad = e.target.value;
          // Cálculo en vivo (FSD 4.1 vista 6): sin repintar toda la fila, para
          // no perder el foco del input mientras se escribe.
          pintarResumen();
          const celda = e.target.closest('.insumo-fila')?.querySelector('.insumo-fila__costo');
          if (celda && insumo) {
            celda.textContent = formatearDinero(Number(l.cantidad || 0) * Number(insumo.costoPromedio));
          }
        },
      },
    }),
    el('span', { clase: 'insumo-fila__unidad', texto: insumo?.unidadMedida ?? '—' }),
    el('span', { clase: 'insumo-fila__costo', texto: formatearDinero(costoLinea) }),
    puedeRecetas
      ? el('button', {
          clase: 'btn btn--peligro btn--sm',
          attrs: { type: 'button', 'aria-label': `Quitar la línea ${indice + 1}` },
          on: {
            click: () => {
              estado.lineas.splice(indice, 1);
              pintarLineas();
            },
          },
        }, '🗑')
      : null
  );
}

function pintarLineas() {
  if (!estado.lineas.length) {
    reemplazar($('lineas-ficha'), el('div', { clase: 'vacio' },
      el('p', { clase: 'texto-sm' }, 'Sin insumos. Este plato no descontará inventario al venderse.')));
  } else {
    reemplazar($('lineas-ficha'), ...estado.lineas.map(filaInsumo));
  }
  pintarResumen();
}

async function abrirFicha(idProducto) {
  try {
    const f = await api.get(`/catalogo/recetas/${idProducto}`);
    estado.fichaActual = f;
    estado.lineas = f.lineas.map((l) => ({
      idInsumo: l.idInsumo,
      cantidad: String(Number(l.cantidad)),
    }));

    reemplazar($('ficha'),
      el('div', { clase: 'fila fila--entre', attrs: { style: 'margin-bottom:1rem' } },
        el('div', {},
          el('h2', { attrs: { style: 'margin:0' }, texto: f.producto }),
          el('p', { clase: 'texto-tenue texto-sm', attrs: { style: 'margin:0' } },
            'Cantidades por porción. Es lo que se descuenta del inventario en cada venta.')
        )
      ),
      el('div', { clase: 'ficha__resumen', attrs: { id: 'resumen-ficha' } }),
      el('div', { clase: 'tarjeta' },
        el('div', { clase: 'tarjeta__cabecera' },
          el('h3', { attrs: { style: 'margin:0' } }, 'Insumos'),
          puedeRecetas
            ? el('button', {
                clase: 'btn btn--secundario btn--sm',
                attrs: { type: 'button' },
                on: {
                  click: () => {
                    estado.lineas.push({ idInsumo: null, cantidad: '' });
                    pintarLineas();
                  },
                },
              }, '+ Insumo')
            : null
        ),
        el('div', { attrs: { id: 'lineas-ficha' } }),
        puedeRecetas
          ? el('div', { clase: 'modal__pie' },
              el('button', {
                clase: 'btn btn--primario',
                attrs: { type: 'button', id: 'btn-guardar-ficha' },
                on: { click: guardarFicha },
              }, 'Guardar ficha técnica')
            )
          : null
      )
    );

    pintarLineas();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function guardarFicha() {
  const lineas = estado.lineas.filter((l) => l.idInsumo && Number(l.cantidad) > 0);

  // Se avisa de lo que se va a descartar en vez de perderlo en silencio.
  const incompletas = estado.lineas.length - lineas.length;
  if (incompletas > 0) {
    const ok = await confirmar({
      titulo: 'Hay líneas incompletas',
      mensaje: `${incompletas} línea(s) sin insumo o sin cantidad se descartarán al guardar. ¿Continuar?`,
      textoConfirmar: 'Guardar de todos modos',
    });
    if (!ok) return;
  }

  const btn = $('btn-guardar-ficha');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    await api.put(`/catalogo/recetas/${estado.fichaActual.idProducto}`, {
      lineas: lineas.map((l) => ({ idInsumo: l.idInsumo, cantidad: Number(l.cantidad) })),
    });
    aviso('Ficha técnica guardada.', 'exito');
    await abrirFicha(estado.fichaActual.idProducto);
  } catch (error) {
    aviso(error.message, 'error', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar ficha técnica';
  }
}

// Buscador de plato con autocompletado (FSD 4.1 vista 6: datalist).
$('buscar-plato').addEventListener('input', retrasar((e) => {
  const texto = e.target.value.trim().toLowerCase();
  const plato = estado.productos.find((p) => p.nombre.toLowerCase() === texto);
  if (plato) abrirFicha(plato.id);
}, 300));

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarTodo() {
  const [mods, prods, insumos] = await Promise.all([
    api.get('/catalogo/modificadores'),
    api.get('/catalogo/productos'),
    api.get('/catalogo/insumos'),
  ]);

  estado.grupos = mods.grupos;
  estado.productos = prods.productos;
  estado.insumos = insumos.insumos;

  pintarGrupos();
  reemplazar($('lista-platos'), ...estado.productos.map((p) =>
    el('option', { attrs: { value: p.nombre } })));

  // Si hay una ficha abierta, se refresca con los datos nuevos.
  if (estado.fichaActual) await abrirFicha(estado.fichaActual.idProducto);
}

try {
  await cargarTodo();
} catch (error) {
  aviso(error.message, 'error');
}
