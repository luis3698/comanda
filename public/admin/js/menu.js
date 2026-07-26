/**
 * Vista 5: Editor de Menú, Precios y Categorías.  RF-05.
 *
 * FSD 4.1 vista 5:
 *  - CRUD completo de categorias y platos.
 *  - Subida de imagen con vista previa (FileReader) y validacion de tipo/peso.
 *  - Precio con mascara monetaria y CHECK >= 0.
 *  - Editor de variantes de precio por horario/temporada validando que no se
 *    solapen ventanas.
 *  - Selector de tasa de IVA.
 *  - Arbol de categorias reordenable por arrastre.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar, formatearDinero } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('catalogo.ver');
if (!sesion) throw new Error('sin sesion');

const puedeGestionar = tienePermiso('catalogo.gestionar');
const MAX_IMAGEN = 2 * 1024 * 1024;   // 2 MB (FSD 6.1)
const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

const estado = {
  categorias: [],
  productos: [],
  categoriaActiva: null,
  buscar: '',
  verInactivos: false,
  platoEnEdicion: null,
  variantes: [],
  imagenNueva: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Categorías
   --------------------------------------------------------------- */
const ETIQUETA_DESTINO = { cocina: 'Cocina', barra: 'Barra', ninguno: 'No se prepara' };

function pintarCategorias() {
  const items = [
    { id: null, nombre: 'Todas', productos: estado.productos.length, destinoPreparacion: null },
    ...estado.categorias,
  ];

  reemplazar($('categorias-lista'), ...items.map((c, indice) => {
    const activa = estado.categoriaActiva === c.id;
    const esReal = c.id !== null;

    const nodo = el('div', {
      clase: `categoria-item ${activa ? 'categoria-item--activa' : ''}`,
      attrs: {
        role: 'listitem',
        draggable: String(esReal && puedeGestionar),
        'data-id': c.id ?? '',
      },
      on: {
        click: (e) => {
          if (e.target.closest('button')) return;
          estado.categoriaActiva = c.id;
          pintarCategorias();
          pintarProductos();
        },
        dragstart: (e) => {
          if (!esReal || !puedeGestionar) return;
          e.dataTransfer.setData('text/plain', String(c.id));
          nodo.classList.add('categoria-item--arrastrando');
        },
        dragend: () => nodo.classList.remove('categoria-item--arrastrando'),
        dragover: (e) => { if (esReal && puedeGestionar) { e.preventDefault(); nodo.classList.add('categoria-item--destino'); } },
        dragleave: () => nodo.classList.remove('categoria-item--destino'),
        drop: (e) => {
          e.preventDefault();
          nodo.classList.remove('categoria-item--destino');
          reordenarCategoria(Number(e.dataTransfer.getData('text/plain')), c.id);
        },
      },
    },
      esReal && puedeGestionar
        ? el('span', { clase: 'categoria-item__asa', attrs: { 'aria-hidden': 'true' } }, '⠿')
        : null,
      el('span', { clase: 'categoria-item__nombre' },
        el('div', { texto: c.nombre }),
        // El destino se muestra con texto: no se comunica solo por color (6.4).
        esReal ? el('span', {
          clase: `categoria-item__destino categoria-item__destino--${c.destinoPreparacion}`,
          texto: ETIQUETA_DESTINO[c.destinoPreparacion],
        }) : null
      ),
      el('span', { clase: 'categoria-item__conteo', texto: String(c.productos ?? 0) }),

      // Alternativa accesible al arrastre para reordenar (6.4).
      esReal && puedeGestionar
        ? el('span', { clase: 'categorias-orden-botones' },
            el('button', {
              attrs: { type: 'button', 'aria-label': `Subir ${c.nombre}`, disabled: indice <= 1 },
              on: { click: (e) => { e.stopPropagation(); moverCategoria(c.id, -1); } },
            }, '▲'),
            el('button', {
              attrs: { type: 'button', 'aria-label': `Bajar ${c.nombre}`, disabled: indice >= items.length - 1 },
              on: { click: (e) => { e.stopPropagation(); moverCategoria(c.id, 1); } },
            }, '▼')
          )
        : null,
      esReal && puedeGestionar
        ? el('button', {
            clase: 'btn btn--plano btn--sm',
            attrs: { type: 'button', 'aria-label': `Editar ${c.nombre}` },
            on: { click: (e) => { e.stopPropagation(); abrirModalCategoria(c); } },
          }, '✎')
        : null
    );

    return nodo;
  }));

  // Espejo del árbol para móvil (FSD 4.1 vista 5).
  reemplazar($('select-categoria'), ...items.map((c) =>
    el('option', {
      attrs: { value: c.id ?? '', selected: estado.categoriaActiva === c.id },
      texto: `${c.nombre} (${c.productos ?? 0})`,
    })));
}

$('select-categoria').addEventListener('change', (e) => {
  estado.categoriaActiva = e.target.value ? Number(e.target.value) : null;
  pintarCategorias();
  pintarProductos();
});

async function moverCategoria(id, delta) {
  const orden = estado.categorias.map((c) => c.id);
  const i = orden.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= orden.length) return;

  [orden[i], orden[j]] = [orden[j], orden[i]];
  await guardarOrden(orden);
}

async function reordenarCategoria(idArrastrada, idDestino) {
  if (!idArrastrada || !idDestino || idArrastrada === idDestino) return;

  const orden = estado.categorias.map((c) => c.id);
  const desde = orden.indexOf(idArrastrada);
  const hasta = orden.indexOf(idDestino);
  if (desde < 0 || hasta < 0) return;

  orden.splice(hasta, 0, orden.splice(desde, 1)[0]);
  await guardarOrden(orden);
}

async function guardarOrden(orden) {
  try {
    await api.put('/catalogo/categorias-orden', { orden });
    await cargarTodo();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Grilla de platos
   --------------------------------------------------------------- */
function tarjetaPlato(p) {
  const insignias = el('div', { clase: 'plato__insignias' });
  // Cada estado lleva texto además del color (6.4).
  if (!p.disponible) insignias.append(el('span', { clase: 'insignia insignia--error' }, '⊘ Agotado'));
  if (!p.activo) insignias.append(el('span', { clase: 'insignia insignia--neutra' }, 'De baja'));
  if (p.variantes > 0) insignias.append(el('span', { clase: 'insignia insignia--info' }, `${p.variantes} precio(s)`));

  const acciones = el('div', { clase: 'plato__acciones' });
  if (puedeGestionar) {
    acciones.append(
      el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button' },
        on: { click: () => abrirModalPlato(p.id) },
      }, 'Editar'),
      el('button', {
        clase: `btn btn--sm ${p.disponible ? 'btn--secundario' : 'btn--primario'}`,
        attrs: { type: 'button' },
        on: { click: () => alternarDisponible(p) },
      }, p.disponible ? 'Agotar' : 'Reactivar'),
    );
    if (p.activo) {
      acciones.append(el('button', {
        clase: 'btn btn--peligro btn--sm',
        attrs: { type: 'button', 'aria-label': `Dar de baja ${p.nombre}` },
        on: { click: () => darDeBaja(p) },
      }, '🗑'));
    }
  }

  return el('article', { clase: `plato ${p.activo ? '' : 'plato--inactivo'}` },
    el('div', { clase: 'plato__foto' },
      p.urlImagen
        ? el('img', { attrs: { src: p.urlImagen, alt: p.nombre, loading: 'lazy' } })
        : el('span', { clase: 'plato__sin-foto', attrs: { 'aria-hidden': 'true' } }, '🍽'),
      insignias
    ),
    el('div', { clase: 'plato__cuerpo' },
      el('div', { clase: 'plato__nombre', texto: p.nombre }),
      el('div', { clase: 'plato__categoria', texto: p.categoria }),
      el('div', { clase: 'plato__precio', texto: formatearDinero(p.precioBase) }),
      el('div', { clase: 'plato__meta' },
        el('span', { clase: 'insignia insignia--neutra', texto: `IVA ${p.tasaImpuesto}%` }),
        p.insumos > 0
          ? el('span', { clase: 'insignia insignia--exito', texto: `${p.insumos} insumo(s)` })
          : el('span', { clase: 'insignia insignia--alerta', texto: 'Sin receta' })
      )
    ),
    acciones
  );
}

function pintarProductos() {
  let lista = estado.productos;
  if (estado.categoriaActiva) lista = lista.filter((p) => p.idCategoria === estado.categoriaActiva);
  if (estado.buscar) {
    const q = estado.buscar.toLowerCase();
    lista = lista.filter((p) => p.nombre.toLowerCase().includes(q) ||
                                (p.descripcion ?? '').toLowerCase().includes(q));
  }

  $('conteo-productos').textContent = `${lista.length} plato(s)`;

  if (!lista.length) {
    reemplazar($('grilla-platos'), el('div', { clase: 'vacio', attrs: { style: 'grid-column:1/-1' } },
      el('p', { texto: estado.buscar ? `Ningún plato coincide con "${estado.buscar}".` : 'No hay platos en esta categoría.' })));
    return;
  }

  reemplazar($('grilla-platos'), ...lista.map(tarjetaPlato));
}

async function alternarDisponible(p) {
  try {
    await api.patch(`/catalogo/productos/${p.id}/disponibilidad`, { disponible: !p.disponible });
    aviso(`"${p.nombre}" marcado como ${p.disponible ? 'agotado' : 'disponible'}.`, 'exito');
    await cargarTodo();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function darDeBaja(p) {
  const ok = await confirmar({
    titulo: `Dar de baja "${p.nombre}"`,
    mensaje: 'Dejará de aparecer en el comandero. El plato no se elimina: conserva su historial de ventas y podrá reactivarse.',
    textoConfirmar: 'Dar de baja',
    peligro: true,
  });
  if (!ok) return;

  try {
    await api.borrar(`/catalogo/productos/${p.id}`);
    aviso(`"${p.nombre}" dado de baja.`, 'exito');
    await cargarTodo();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Modal de plato: pestañas
   --------------------------------------------------------------- */
const PESTANAS = ['generales', 'precios', 'impuestos'];
for (const nombre of PESTANAS) {
  $(`tab-${nombre}`).addEventListener('click', () => {
    for (const otra of PESTANAS) {
      const activa = otra === nombre;
      $(`tab-${otra}`).classList.toggle('pestana-modal--activa', activa);
      $(`tab-${otra}`).setAttribute('aria-selected', String(activa));
      $(`panel-${otra}`).classList.toggle('oculto', !activa);
    }
  });
}

/* ---------------------------------------------------------------
   Máscara monetaria (FSD 4.1 vista 5)
   --------------------------------------------------------------- */
$('p-precio').addEventListener('input', (e) => {
  // Solo dígitos y un separador decimal; el CHECK >= 0 lo garantiza el signo
  // que aquí ni siquiera se permite teclear.
  let v = e.target.value.replace(/[^\d.,]/g, '').replace(',', '.');
  const partes = v.split('.');
  if (partes.length > 2) v = `${partes[0]}.${partes.slice(1).join('')}`;
  e.target.value = v;
});

/* ---------------------------------------------------------------
   Vista previa de la imagen (FileReader, FSD 4.1 vista 5)
   --------------------------------------------------------------- */
$('p-imagen').addEventListener('change', (e) => {
  const archivo = e.target.files?.[0];
  $('e-p-imagen').textContent = '';
  estado.imagenNueva = null;

  if (!archivo) return;

  // Validación de UX: el servidor revalida por magic bytes, que es lo que
  // de verdad protege (FSD 6.1).
  if (archivo.size > MAX_IMAGEN) {
    $('e-p-imagen').textContent = `La imagen pesa ${(archivo.size / 1024 / 1024).toFixed(1)} MB. El máximo es 2 MB.`;
    e.target.value = '';
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(archivo.type)) {
    $('e-p-imagen').textContent = 'Solo se admiten JPG, PNG o WebP.';
    e.target.value = '';
    return;
  }

  estado.imagenNueva = archivo;
  const lector = new FileReader();
  lector.onload = () => {
    reemplazar($('previsualizacion'),
      el('img', { attrs: { src: lector.result, alt: 'Vista previa de la imagen' } }));
  };
  lector.readAsDataURL(archivo);
});

/* ---------------------------------------------------------------
   Variantes de precio
   --------------------------------------------------------------- */
function filaVariante(v, indice) {
  const diasActivos = new Set((v.diasSemana ?? '').split(',').map((d) => d.trim()).filter(Boolean));

  const actualizar = (campo, valor) => { v[campo] = valor; validarSolapesEnVivo(); };

  return el('div', { clase: 'variante', attrs: { 'data-indice': String(indice) } },
    el('div', { clase: 'campo' },
      el('label', { clase: 'campo__etiqueta', attrs: { for: `v-nombre-${indice}` } }, 'Nombre'),
      el('input', {
        clase: 'campo__control',
        attrs: { id: `v-nombre-${indice}`, value: v.nombre ?? '', placeholder: 'Happy hour' },
        on: { input: (e) => actualizar('nombre', e.target.value) },
      })
    ),
    el('div', { clase: 'campo' },
      el('label', { clase: 'campo__etiqueta', attrs: { for: `v-precio-${indice}` } }, 'Precio'),
      el('input', {
        clase: 'campo__control',
        attrs: { id: `v-precio-${indice}`, inputmode: 'decimal', value: v.precio ?? '' },
        on: { input: (e) => actualizar('precio', e.target.value.replace(/[^\d.]/g, '')) },
      })
    ),
    el('div', { clase: 'campo' },
      el('label', { clase: 'campo__etiqueta', attrs: { for: `v-hi-${indice}` } }, 'Desde'),
      el('input', {
        clase: 'campo__control',
        attrs: { id: `v-hi-${indice}`, type: 'time', value: (v.horaInicio ?? '').slice(0, 5) },
        on: { input: (e) => actualizar('horaInicio', e.target.value) },
      })
    ),
    el('div', { clase: 'campo' },
      el('label', { clase: 'campo__etiqueta', attrs: { for: `v-hf-${indice}` } }, 'Hasta'),
      el('input', {
        clase: 'campo__control',
        attrs: { id: `v-hf-${indice}`, type: 'time', value: (v.horaFin ?? '').slice(0, 5) },
        on: { input: (e) => actualizar('horaFin', e.target.value) },
      })
    ),
    el('button', {
      clase: 'btn btn--peligro btn--sm',
      attrs: { type: 'button', 'aria-label': `Quitar la variante ${v.nombre || indice + 1}` },
      on: {
        click: () => {
          estado.variantes.splice(indice, 1);
          pintarVariantes();
        },
      },
    }, '🗑'),

    el('div', { clase: 'variante__dias' },
      el('span', { clase: 'campo__etiqueta', attrs: { style: 'margin:0 .4rem 0 0' } }, 'Días:'),
      ...DIAS.map((d) => {
        const activo = diasActivos.has(d);
        return el('label', { clase: `variante__dia ${activo ? 'variante__dia--activo' : ''}` },
          el('input', {
            attrs: { type: 'checkbox', checked: activo, 'aria-label': `Día ${d}` },
            on: {
              change: (e) => {
                if (e.target.checked) diasActivos.add(d);
                else diasActivos.delete(d);
                // Se conserva el orden de la semana, no el de marcado.
                v.diasSemana = DIAS.filter((x) => diasActivos.has(x)).join(',');
                pintarVariantes();
              },
            },
          }),
          d
        );
      }),
      el('span', { clase: 'texto-tenue texto-sm' }, 'Sin días marcados = todos los días')
    )
  );
}

function pintarVariantes() {
  if (!estado.variantes.length) {
    reemplazar($('variantes-lista'), el('p', { clase: 'texto-tenue texto-sm' },
      'Sin variantes: siempre se cobra el precio base.'));
  } else {
    reemplazar($('variantes-lista'), ...estado.variantes.map(filaVariante));
  }
  validarSolapesEnVivo();
}

/**
 * Aviso de solape en el editor (FSD 5.3: "validacion JS en el editor +
 * verificacion en servidor"). Esto es solo para no hacer perder el viaje al
 * usuario; la comprobacion buena la hace el servidor al guardar.
 */
const validarSolapesEnVivo = retrasar(() => {
  const error = $('e-variantes');
  error.textContent = '';
  document.querySelectorAll('.variante').forEach((n) => n.classList.remove('variante__conflicto'));

  const activas = estado.variantes.filter((v) => v.nombre && v.precio);

  for (let i = 0; i < activas.length; i++) {
    for (let j = i + 1; j < activas.length; j++) {
      if (seSolapan(activas[i], activas[j])) {
        error.textContent =
          `Las variantes "${activas[i].nombre}" y "${activas[j].nombre}" se solapan: ` +
          'coinciden en horario, días y fechas. No se sabría qué precio cobrar.';
        document.querySelector(`.variante[data-indice="${estado.variantes.indexOf(activas[i])}"]`)?.classList.add('variante__conflicto');
        document.querySelector(`.variante[data-indice="${estado.variantes.indexOf(activas[j])}"]`)?.classList.add('variante__conflicto');
        return;
      }
    }
  }
}, 250);

/** Espejo simplificado de la lógica del servidor (server/servicios/precios.js). */
function seSolapan(a, b) {
  const dias = (v) => (v.diasSemana ? new Set(v.diasSemana.split(',')) : null);
  const dA = dias(a), dB = dias(b);
  if (dA && dB && ![...dA].some((d) => dB.has(d))) return false;

  const min = (h) => { if (!h) return null; const [x, y] = h.split(':').map(Number); return x * 60 + y; };
  const iA = min(a.horaInicio), fA = min(a.horaFin), iB = min(b.horaInicio), fB = min(b.horaFin);
  if (iA === null || fA === null || iB === null || fB === null) return true;
  return iA < fB && iB < fA;
}

$('btn-nueva-variante').addEventListener('click', () => {
  estado.variantes.push({ nombre: '', precio: '', horaInicio: '', horaFin: '', diasSemana: '', activo: true });
  pintarVariantes();
});

/* ---------------------------------------------------------------
   Modal de plato: abrir y guardar
   --------------------------------------------------------------- */
const modalPlato = $('modal-plato');

function refrescarAyudaDestino() {
  const cat = estado.categorias.find((c) => c.id === Number($('p-categoria').value));
  $('ayuda-destino').textContent = cat
    ? `Se enviará a: ${ETIQUETA_DESTINO[cat.destinoPreparacion]}.`
    : '';
}
$('p-categoria').addEventListener('change', refrescarAyudaDestino);

async function abrirModalPlato(id = null) {
  estado.platoEnEdicion = id;
  estado.variantes = [];
  estado.imagenNueva = null;

  $('form-plato').reset();
  ['e-p-nombre', 'e-p-categoria', 'e-p-precio', 'e-p-imagen', 'e-variantes']
    .forEach((k) => { $(k).textContent = ''; });
  $('tab-generales').click();
  reemplazar($('previsualizacion'), el('span', { clase: 'texto-tenue texto-sm' }, 'Sin imagen'));

  reemplazar($('p-categoria'),
    el('option', { attrs: { value: '' }, texto: 'Seleccione…' }),
    ...estado.categorias.map((c) => el('option', { attrs: { value: String(c.id) }, texto: c.nombre }))
  );

  if (id) {
    $('titulo-modal-plato').textContent = 'Editar plato';
    try {
      const p = await api.get(`/catalogo/productos/${id}`);
      $('p-nombre').value = p.nombre;
      $('p-descripcion').value = p.descripcion ?? '';
      $('p-categoria').value = String(p.idCategoria);
      $('p-precio').value = String(Number(p.precioBase));

      const tasa = String(Number(p.tasaImpuesto));
      if ([...$('p-impuesto').options].some((o) => o.value === tasa)) $('p-impuesto').value = tasa;
      else $('p-impuesto-otro').value = tasa;

      if (p.urlImagen) {
        reemplazar($('previsualizacion'),
          el('img', { attrs: { src: p.urlImagen, alt: p.nombre } }));
      }

      estado.variantes = p.variantes.map((v) => ({
        nombre: v.nombre,
        precio: String(Number(v.precio)),
        horaInicio: (v.horaInicio ?? '').slice(0, 5),
        horaFin: (v.horaFin ?? '').slice(0, 5),
        diasSemana: v.diasSemana ?? '',
        activo: v.activo,
      }));
    } catch (error) {
      aviso(error.message, 'error');
      return;
    }
  } else {
    $('titulo-modal-plato').textContent = 'Nuevo plato';
    if (estado.categoriaActiva) $('p-categoria').value = String(estado.categoriaActiva);
  }

  refrescarAyudaDestino();
  pintarVariantes();
  modalPlato.showModal();
  $('p-nombre').focus();
}

$('btn-nuevo-plato').addEventListener('click', () => abrirModalPlato(null));
$('btn-cerrar-plato').addEventListener('click', () => modalPlato.close());
$('btn-cancelar-plato').addEventListener('click', () => modalPlato.close());
if (!puedeGestionar) {
  $('btn-nuevo-plato').classList.add('oculto');
  $('btn-nueva-categoria').classList.add('oculto');
}

$('form-plato').addEventListener('submit', async (e) => {
  e.preventDefault();
  ['e-p-nombre', 'e-p-categoria', 'e-p-precio'].forEach((k) => { $(k).textContent = ''; });

  const datos = {
    nombre: $('p-nombre').value.trim(),
    descripcion: $('p-descripcion').value.trim() || null,
    idCategoria: Number($('p-categoria').value) || null,
    precioBase: Number($('p-precio').value),
    tasaImpuesto: Number($('p-impuesto-otro').value || $('p-impuesto').value),
  };

  let fallos = false;
  if (datos.nombre.length < 2) { $('e-p-nombre').textContent = 'Mínimo 2 caracteres.'; fallos = true; }
  if (!datos.idCategoria) { $('e-p-categoria').textContent = 'Seleccione una categoría.'; fallos = true; }
  if (!Number.isFinite(datos.precioBase) || datos.precioBase < 0) {
    $('e-p-precio').textContent = 'Indique un precio mayor o igual a cero.';
    $('tab-precios').click();
    fallos = true;
  }
  if (fallos) return;

  const btn = $('btn-guardar-plato');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    let id = estado.platoEnEdicion;
    if (id) {
      await api.put(`/catalogo/productos/${id}`, { ...datos, activo: true });
    } else {
      const r = await api.post('/catalogo/productos', datos);
      id = r.id;
    }

    // Las variantes van en su propia llamada: el servidor valida los solapes
    // ahí y devuelve un mensaje específico si chocan.
    const variantes = estado.variantes.filter((v) => v.nombre && v.precio);
    await api.put(`/catalogo/productos/${id}/precios`, {
      variantes: variantes.map((v) => ({
        nombre: v.nombre,
        precio: Number(v.precio),
        horaInicio: v.horaInicio || null,
        horaFin: v.horaFin || null,
        diasSemana: v.diasSemana || null,
        activo: true,
      })),
    });

    if (estado.imagenNueva) {
      const cuerpo = new FormData();
      cuerpo.append('imagen', estado.imagenNueva);
      // FormData no pasa por api.js: necesita multipart y que el navegador
      // ponga el boundary por sí mismo.
      const r = await fetch(`/api/v1/catalogo/productos/${id}/imagen`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': (await api.get('/auth/sesion')).tokenCsrf },
        credentials: 'same-origin',
        body: cuerpo,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        aviso(`El plato se guardó, pero la imagen no: ${err.mensaje ?? 'error desconocido'}`, 'alerta', 8000);
      }
    }

    aviso(estado.platoEnEdicion ? 'Plato actualizado.' : `Plato "${datos.nombre}" creado.`, 'exito');
    modalPlato.close();
    await cargarTodo();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.codigo === 'regla_negocio') {
      $('e-variantes').textContent = error.message;
      $('tab-precios').click();
      aviso('Revise las variantes de precio.', 'error', 8000);
    } else if (error instanceof ErrorPeticion && error.campos) {
      const mapa = { nombre: 'e-p-nombre', idCategoria: 'e-p-categoria', precioBase: 'e-p-precio' };
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        if (mapa[campo]) $(mapa[campo]).textContent = mensaje;
      }
      aviso('Revise los campos marcados.', 'error');
    } else {
      aviso(error.message, 'error', 7000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
});

/* ---------------------------------------------------------------
   Modal de categoría
   --------------------------------------------------------------- */
const modalCategoria = $('modal-categoria');
let categoriaEnEdicion = null;

function abrirModalCategoria(cat = null) {
  categoriaEnEdicion = cat;
  $('e-c-nombre').textContent = '';
  $('titulo-modal-cat').textContent = cat ? 'Editar categoría' : 'Nueva categoría';
  $('c-nombre').value = cat?.nombre ?? '';
  $('c-destino').value = cat?.destinoPreparacion ?? 'cocina';
  modalCategoria.showModal();
  $('c-nombre').focus();
}

$('btn-nueva-categoria').addEventListener('click', () => abrirModalCategoria(null));
$('btn-cerrar-cat').addEventListener('click', () => modalCategoria.close());
$('btn-cancelar-cat').addEventListener('click', () => modalCategoria.close());

$('form-categoria').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('c-nombre').value.trim();
  const destinoPreparacion = $('c-destino').value;

  if (nombre.length < 2) { $('e-c-nombre').textContent = 'Mínimo 2 caracteres.'; return; }

  try {
    if (categoriaEnEdicion) {
      await api.put(`/catalogo/categorias/${categoriaEnEdicion.id}`, {
        nombre, destinoPreparacion,
        ordenVisual: categoriaEnEdicion.ordenVisual, activa: true,
      });
      aviso('Categoría actualizada.', 'exito');
    } else {
      await api.post('/catalogo/categorias', {
        nombre, destinoPreparacion, ordenVisual: estado.categorias.length,
      });
      aviso(`Categoría "${nombre}" creada.`, 'exito');
    }
    modalCategoria.close();
    await cargarTodo();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
});

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
$('buscar').addEventListener('input', retrasar((e) => {
  estado.buscar = e.target.value.trim();
  pintarProductos();
}, 250));

$('ver-inactivos').addEventListener('change', (e) => {
  estado.verInactivos = e.target.checked;
  cargarTodo();
});

async function cargarTodo() {
  const [cats, prods] = await Promise.all([
    api.get('/catalogo/categorias?todas=1'),
    api.get(`/catalogo/productos${estado.verInactivos ? '?todos=1' : ''}`),
  ]);
  estado.categorias = cats.categorias;
  estado.productos = prods.productos;
  pintarCategorias();
  pintarProductos();
}

try {
  await cargarTodo();
} catch (error) {
  aviso(error.message, 'error');
}
