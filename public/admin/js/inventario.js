/**
 * Vista 7: Registro de Proveedores, Compras e Inventarios.  RF-08, RF-09.
 *
 * FSD 4.1 vista 7:
 *  - tres pestañas: Proveedores, Compras, Existencias
 *  - "al marcar una compra como Recibida, la API dentro de una transacción suma
 *     stock, recalcula costo promedio ponderado e inserta los movimientos en el
 *     kárdex"
 *  - validaciones de cantidades > 0 y totales cuadrados
 *  - "ajustes manuales de inventario exigen motivo y quedan auditados"
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar, formatearDinero, formatearFecha } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('inventario.ver');
if (!sesion) throw new Error('sin sesión');

const puedeComprar = tienePermiso('inventario.gestionar_compras');
const puedeAjustar = tienePermiso('inventario.ajustar');
const $ = (id) => document.getElementById(id);

const estado = {
  insumos: [], compras: [], proveedores: [],
  buscar: '', lineasCompra: [], compraEnEdicion: null, insumoAjuste: null,
};

/* ---------------------------------------------------------------
   Pestañas
   --------------------------------------------------------------- */
const PANELES = ['existencias', 'compras', 'proveedores'];
for (const p of PANELES) {
  $(`tab-${p}`).addEventListener('click', () => {
    for (const otro of PANELES) {
      const activo = otro === p;
      $(`tab-${otro}`).classList.toggle('pestana-principal--activa', activo);
      $(`tab-${otro}`).setAttribute('aria-selected', String(activo));
      $(`panel-${otro}`).classList.toggle('oculto', !activo);
    }
  });
}

/* ---------------------------------------------------------------
   Existencias
   --------------------------------------------------------------- */
const ETIQUETA_SEMAFORO = {
  normal: '✓ Normal',
  critico: '▼ Bajo mínimo',
  negativo: '⚠ Negativo',
};

function pintarExistencias() {
  let lista = estado.insumos;
  if (estado.buscar) {
    const q = estado.buscar.toLowerCase();
    lista = lista.filter((i) => i.nombre.toLowerCase().includes(q));
  }

  const criticos = estado.insumos.filter((i) => i.estado !== 'normal').length;
  $('conteo-insumos').textContent = `${lista.length} insumo(s)`;
  $('conteo-criticos').textContent = `${criticos} bajo mínimo`;
  $('conteo-criticos').classList.toggle('oculto', criticos === 0);

  if (!lista.length) {
    reemplazar($('tabla-existencias'), el('tr', {}, el('td', { attrs: { colspan: '7' } },
      el('div', { clase: 'vacio' }, el('p', { texto: 'Ningún insumo coincide.' })))));
    return;
  }

  reemplazar($('tabla-existencias'), ...lista.map((i) => el('tr', {
    clase: i.estado === 'negativo' ? 'fila-negativa' : (i.estado === 'critico' ? 'fila-critica' : ''),
  },
    el('td', {}, el('span', { clase: `semaforo semaforo--${i.estado}`, texto: ETIQUETA_SEMAFORO[i.estado] })),
    el('td', {}, el('strong', { texto: i.nombre }),
      i.usadoEn > 0 ? el('div', { clase: 'texto-tenue texto-sm', texto: `en ${i.usadoEn} receta(s)` }) : null),
    el('td', { clase: 'celda-dinero', texto: `${i.stockActual} ${i.unidadMedida}` }),
    el('td', { clase: 'celda-dinero texto-tenue', texto: i.stockMinimo }),
    el('td', { clase: 'celda-dinero', texto: formatearDinero(i.costoPromedio) }),
    el('td', { clase: 'celda-dinero', texto: formatearDinero(i.valorInventario) }),
    el('td', {}, el('div', { clase: 'tabla__acciones' },
      el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button' },
        on: { click: () => abrirKardex(i.id) },
      }, 'Kárdex'),
      puedeAjustar
        ? el('button', {
            clase: 'btn btn--secundario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => abrirAjuste(i) },
          }, 'Ajustar')
        : null
    ))
  )));
}

$('buscar-insumo').addEventListener('input', retrasar((e) => {
  estado.buscar = e.target.value.trim();
  pintarExistencias();
}, 200));

/* ---------------------------------------------------------------
   Kárdex
   --------------------------------------------------------------- */
const ETIQUETA_TIPO = { compra: 'Compra', venta: 'Venta', ajuste: 'Ajuste', merma: 'Merma' };

async function abrirKardex(idInsumo) {
  try {
    const k = await api.get(`/inventario/kardex/${idInsumo}`);
    $('titulo-kardex').textContent = `Kárdex · ${k.insumo.nombre}`;

    reemplazar($('cuerpo-kardex'),
      el('div', { clase: 'kardex-resumen' },
        el('div', { clase: 'resumen-tarjeta' },
          el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Stock actual'),
          el('div', { clase: 'resumen-tarjeta__valor', texto: `${k.insumo.stockActual}` }),
          el('div', { clase: 'texto-tenue texto-sm', texto: k.insumo.unidadMedida })),
        el('div', { clase: 'resumen-tarjeta' },
          el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Mínimo'),
          el('div', { clase: 'resumen-tarjeta__valor', texto: k.insumo.stockMinimo })),
        el('div', { clase: 'resumen-tarjeta' },
          el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Costo promedio'),
          el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(k.insumo.costoPromedio) }))
      ),
      k.insumo.negativo
        ? el('div', { clase: 'integridad integridad--rota' },
            '⚠ Stock negativo: el sistema registró más consumo del que hubo entradas. ' +
            'La venta no se detiene por esto (así lo exige la operación), pero conviene conciliar con un conteo físico.')
        : null,
      el('h3', {}, 'Movimientos'),
      ...(k.movimientos.length
        ? k.movimientos.map((m) => el('div', { clase: 'kardex-mov' },
            el('span', { clase: 'kardex-mov__tipo', texto: ETIQUETA_TIPO[m.tipo] ?? m.tipo }),
            el('span', {
              clase: `kardex-mov__cantidad ${m.entrada ? 'kardex-mov__cantidad--entrada' : 'kardex-mov__cantidad--salida'}`,
              texto: `${m.entrada ? '+' : ''}${m.cantidad}`,
            }),
            el('span', { clase: 'kardex-mov__info' },
              el('div', { clase: 'kardex-mov__fecha', texto: `${formatearFecha(m.fecha)} · ${m.usuario}` }),
              m.motivo ? el('div', { clase: 'texto-sm', texto: m.motivo }) : null,
              m.idReferencia ? el('div', { clase: 'texto-tenue texto-sm', texto: `ref. #${m.idReferencia}` }) : null
            )
          ))
        : [el('div', { clase: 'vacio texto-sm' }, 'Sin movimientos registrados.')])
    );

    $('modal-kardex').showModal();
  } catch (error) {
    aviso(error.message, 'error');
  }
}
$('btn-cerrar-kardex').addEventListener('click', () => $('modal-kardex').close());

/* ---------------------------------------------------------------
   Ajuste manual (exige motivo, FSD 5.4)
   --------------------------------------------------------------- */
function abrirAjuste(insumo) {
  estado.insumoAjuste = insumo;
  $('ajuste-insumo').textContent =
    `${insumo.nombre} · stock actual ${insumo.stockActual} ${insumo.unidadMedida}`;
  $('a-cantidad').value = '';
  $('a-motivo').value = '';
  $('e-a-cantidad').textContent = '';
  $('e-a-motivo').textContent = '';
  $('modal-ajuste').showModal();
  $('a-cantidad').focus();
}
$('btn-cerrar-ajuste').addEventListener('click', () => $('modal-ajuste').close());
$('btn-cancelar-ajuste').addEventListener('click', () => $('modal-ajuste').close());
$('a-cantidad').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d.-]/g, '');
});

$('form-ajuste').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('e-a-cantidad').textContent = '';
  $('e-a-motivo').textContent = '';

  const cantidad = Number($('a-cantidad').value);
  const motivo = $('a-motivo').value.trim();

  if (!Number.isFinite(cantidad) || cantidad === 0) {
    $('e-a-cantidad').textContent = 'Indique una cantidad distinta de cero.'; return;
  }
  if (motivo.length < 3) {
    $('e-a-motivo').textContent = 'El motivo es obligatorio.'; return;
  }

  try {
    const r = await api.post('/inventario/ajustes', {
      idInsumo: estado.insumoAjuste.id,
      cantidad, tipo: $('a-tipo').value, motivo,
    });
    aviso(`Ajuste registrado: ${r.stockAnterior} → ${r.stockActual}.` +
          (r.critico ? ' El insumo quedó bajo su mínimo.' : ''), 'exito', 6000);
    $('modal-ajuste').close();
    await cargarExistencias();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos?.motivo) {
      $('e-a-motivo').textContent = error.campos.motivo;
    } else {
      aviso(error.message, 'error', 7000);
    }
  }
});

/* ---------------------------------------------------------------
   Compras
   --------------------------------------------------------------- */
const INSIGNIA_ESTADO = {
  borrador: ['insignia--neutra', '✎ Borrador'],
  recibida: ['insignia--exito', '✓ Recibida'],
  anulada: ['insignia--error', '⊘ Anulada'],
};

function pintarCompras() {
  if (!estado.compras.length) {
    reemplazar($('tabla-compras'), el('tr', {}, el('td', { attrs: { colspan: '7' } },
      el('div', { clase: 'vacio' }, el('p', { texto: 'No hay compras registradas.' })))));
    return;
  }

  reemplazar($('tabla-compras'), ...estado.compras.map((c) => {
    const [clase, texto] = INSIGNIA_ESTADO[c.estado];
    const acciones = el('div', { clase: 'tabla__acciones' });

    if (puedeComprar) {
      if (c.estado === 'borrador') {
        acciones.append(
          el('button', {
            clase: 'btn btn--primario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => recibir(c) },
          }, 'Recibir'),
          el('button', {
            clase: 'btn btn--secundario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => abrirCompra(c.id) },
          }, 'Editar')
        );
      }
      if (c.estado !== 'anulada') {
        acciones.append(el('button', {
          clase: 'btn btn--peligro btn--sm',
          attrs: { type: 'button' },
          on: { click: () => anular(c) },
        }, 'Anular'));
      }
    }

    return el('tr', {},
      el('td', { texto: formatearFecha(c.fecha, { conHora: false }) }),
      el('td', { texto: c.proveedor }),
      el('td', { clase: 'mono', texto: c.numeroFacturaProv ?? '—' }),
      el('td', { clase: 'celda-entero', texto: String(c.lineas) }),
      el('td', { clase: 'celda-dinero', texto: formatearDinero(c.total) }),
      el('td', {}, el('span', { clase: `insignia ${clase}`, texto })),
      el('td', {}, acciones)
    );
  }));
}

async function recibir(compra) {
  const ok = await confirmar({
    titulo: 'Recibir la compra',
    mensaje: `Se sumará el stock de ${compra.lineas} insumo(s) y se recalculará su costo promedio ponderado. Esta acción no se puede editar después.`,
    textoConfirmar: 'Recibir',
  });
  if (!ok) return;

  try {
    const r = await api.post(`/inventario/compras/${compra.id}/recibir`, {});
    const detalle = r.cambios
      .map((c) => `${c.insumo}: costo ${c.costoAnterior} → ${c.costoNuevo}`)
      .join(' · ');
    aviso(`Compra recibida. ${detalle}`, 'exito', 9000);
    await Promise.all([cargarCompras(), cargarExistencias()]);
  } catch (error) {
    aviso(error.message, 'error', 8000);
  }
}

async function anular(compra) {
  const ok = await confirmar({
    titulo: 'Anular la compra',
    mensaje: compra.estado === 'recibida'
      ? 'La compra ya está recibida: se revertirá el stock con contra-asientos. El kárdex conservará ambos movimientos.'
      : 'La compra está en borrador y no movió stock.',
    textoConfirmar: 'Anular',
    peligro: true,
  });
  if (!ok) return;

  // El motivo es obligatorio: se pide antes de llamar a la API.
  const motivo = prompt('Motivo de la anulación (obligatorio):');
  if (!motivo || motivo.trim().length < 3) {
    aviso('La anulación necesita un motivo de al menos 3 caracteres.', 'error');
    return;
  }

  try {
    const r = await api.post(`/inventario/compras/${compra.id}/anular`, { motivo: motivo.trim() });
    aviso(r.revertido
      ? 'Compra anulada y stock revertido con contra-asientos.'
      : 'Compra en borrador anulada.', 'exito', 6000);
    await Promise.all([cargarCompras(), cargarExistencias()]);
  } catch (error) {
    aviso(error.message, 'error', 8000);
  }
}

/* --- Modal de compra --- */
function filaLineaCompra(l, i) {
  const insumo = estado.insumos.find((x) => x.id === l.idInsumo);
  const subtotal = (Number(l.cantidad || 0) * Number(l.costoUnitario || 0)).toFixed(2);

  return el('div', { clase: 'linea-compra' },
    el('select', {
      clase: 'campo__control',
      attrs: { 'aria-label': `Insumo de la línea ${i + 1}` },
      on: { change: (e) => { l.idInsumo = Number(e.target.value); pintarLineasCompra(); } },
    },
      el('option', { attrs: { value: '' }, texto: 'Seleccione…' }),
      ...estado.insumos.map((x) => el('option', {
        attrs: { value: String(x.id), selected: x.id === l.idInsumo },
        texto: `${x.nombre} (${x.unidadMedida})`,
      }))
    ),
    el('input', {
      clase: 'campo__control',
      attrs: { value: l.cantidad ?? '', inputmode: 'decimal', placeholder: 'Cantidad',
               'aria-label': `Cantidad de la línea ${i + 1}` },
      on: {
        input: (e) => {
          e.target.value = e.target.value.replace(/[^\d.]/g, '');
          l.cantidad = e.target.value;
          actualizarSubtotales();
        },
      },
    }),
    el('input', {
      clase: 'campo__control',
      attrs: { value: l.costoUnitario ?? '', inputmode: 'decimal', placeholder: 'Costo unit.',
               'aria-label': `Costo unitario de la línea ${i + 1}` },
      on: {
        input: (e) => {
          e.target.value = e.target.value.replace(/[^\d.]/g, '');
          l.costoUnitario = e.target.value;
          actualizarSubtotales();
        },
      },
    }),
    el('button', {
      clase: 'btn btn--peligro btn--sm',
      attrs: { type: 'button', 'aria-label': `Quitar la línea ${i + 1}` },
      on: { click: () => { estado.lineasCompra.splice(i, 1); pintarLineasCompra(); } },
    }, '🗑')
  );
}

/** Recalcula los subtotales sin repintar, para no perder el foco al escribir. */
function actualizarSubtotales() {
  const total = estado.lineasCompra.reduce(
    (s, l) => s + Number(l.cantidad || 0) * Number(l.costoUnitario || 0), 0);
  $('total-compra').textContent = `Total: ${formatearDinero(total.toFixed(2))}`;
}

function pintarLineasCompra() {
  if (!estado.lineasCompra.length) {
    reemplazar($('lineas-compra'), el('p', { clase: 'texto-tenue texto-sm' },
      'Añada al menos un insumo.'));
  } else {
    reemplazar($('lineas-compra'), ...estado.lineasCompra.map(filaLineaCompra));
  }
  actualizarSubtotales();
}

async function abrirCompra(id = null) {
  estado.compraEnEdicion = id;
  $('titulo-compra').textContent = id ? 'Editar compra (borrador)' : 'Nueva compra';

  reemplazar($('c-proveedor'), ...estado.proveedores.map((p) =>
    el('option', { attrs: { value: String(p.id) }, texto: p.razonSocial })));

  if (id) {
    try {
      const c = await api.get(`/inventario/compras/${id}`);
      $('c-proveedor').value = String(c.idProveedor);
      $('c-factura').value = c.numeroFacturaProv ?? '';
      estado.lineasCompra = c.lineas.map((l) => ({
        idInsumo: l.idInsumo,
        cantidad: String(Number(l.cantidad)),
        costoUnitario: String(Number(l.costoUnitario)),
      }));
    } catch (error) {
      aviso(error.message, 'error');
      return;
    }
  } else {
    $('c-factura').value = '';
    estado.lineasCompra = [{ idInsumo: null, cantidad: '', costoUnitario: '' }];
  }

  pintarLineasCompra();
  $('modal-compra').showModal();
}

$('btn-nueva-compra').addEventListener('click', () => abrirCompra(null));
$('btn-cerrar-compra').addEventListener('click', () => $('modal-compra').close());
$('btn-cancelar-compra').addEventListener('click', () => $('modal-compra').close());
$('btn-linea-compra').addEventListener('click', () => {
  estado.lineasCompra.push({ idInsumo: null, cantidad: '', costoUnitario: '' });
  pintarLineasCompra();
});
if (!puedeComprar) {
  $('btn-nueva-compra').classList.add('oculto');
  $('btn-nuevo-proveedor').classList.add('oculto');
}

$('form-compra').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lineas = estado.lineasCompra.filter((l) => l.idInsumo && Number(l.cantidad) > 0);

  if (!lineas.length) {
    aviso('Añada al menos una línea con insumo y cantidad.', 'error');
    return;
  }
  if (lineas.some((l) => !(Number(l.costoUnitario) >= 0))) {
    aviso('Indique el costo unitario de cada línea.', 'error');
    return;
  }

  const btn = $('btn-guardar-compra');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const cuerpo = {
      idProveedor: Number($('c-proveedor').value),
      numeroFacturaProv: $('c-factura').value.trim() || null,
      lineas: lineas.map((l) => ({
        idInsumo: l.idInsumo,
        cantidad: Number(l.cantidad),
        costoUnitario: Number(l.costoUnitario),
      })),
    };

    if (estado.compraEnEdicion) await api.put(`/inventario/compras/${estado.compraEnEdicion}`, cuerpo);
    else await api.post('/inventario/compras', cuerpo);

    aviso('Compra guardada en borrador. Márquela como recibida para que ingrese al inventario.', 'exito', 7000);
    $('modal-compra').close();
    await cargarCompras();
  } catch (error) {
    aviso(error.message, 'error', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar borrador';
  }
});

/* ---------------------------------------------------------------
   Proveedores
   --------------------------------------------------------------- */
function pintarProveedores() {
  if (!estado.proveedores.length) {
    reemplazar($('tabla-proveedores'), el('tr', {}, el('td', { attrs: { colspan: '6' } },
      el('div', { clase: 'vacio' }, el('p', { texto: 'No hay proveedores.' })))));
    return;
  }

  reemplazar($('tabla-proveedores'), ...estado.proveedores.map((p) => el('tr', {},
    el('td', { attrs: { 'data-etiqueta': 'Razón social' } }, el('strong', { texto: p.razonSocial })),
    el('td', { attrs: { 'data-etiqueta': 'NIT' }, clase: 'mono', texto: p.nit ?? '—' }),
    el('td', { attrs: { 'data-etiqueta': 'Contacto' }, texto: p.contactoNombre ?? '—' }),
    el('td', { attrs: { 'data-etiqueta': 'Teléfono' }, texto: p.telefono ?? '—' }),
    el('td', { attrs: { 'data-etiqueta': 'Compras' }, clase: 'celda-entero', texto: String(p.compras) }),
    el('td', { attrs: { 'data-etiqueta': 'Acciones' } },
      puedeComprar
        ? el('button', {
            clase: 'btn btn--secundario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => editarProveedor(p) },
          }, 'Editar')
        : null)
  )));
}

// Alta y edición sencillas: el FSD pide una "tabla CRUD con datos de contacto",
// sin más ceremonia que eso.
async function editarProveedor(p = null) {
  const razonSocial = prompt('Razón social:', p?.razonSocial ?? '');
  if (!razonSocial || razonSocial.trim().length < 2) return;
  const nit = prompt('NIT:', p?.nit ?? '') ?? '';
  const contactoNombre = prompt('Persona de contacto:', p?.contactoNombre ?? '') ?? '';
  const telefono = prompt('Teléfono:', p?.telefono ?? '') ?? '';
  const correo = prompt('Correo:', p?.correo ?? '') ?? '';

  try {
    const cuerpo = {
      razonSocial: razonSocial.trim(),
      nit: nit.trim() || null,
      contactoNombre: contactoNombre.trim() || null,
      telefono: telefono.trim() || null,
      correo: correo.trim() || null,
      activo: true,
    };
    if (p) await api.put(`/inventario/proveedores/${p.id}`, cuerpo);
    else await api.post('/inventario/proveedores', cuerpo);
    aviso(p ? 'Proveedor actualizado.' : 'Proveedor creado.', 'exito');
    await cargarProveedores();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
}
$('btn-nuevo-proveedor').addEventListener('click', () => editarProveedor(null));

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargarExistencias() {
  const r = await api.get('/inventario/existencias');
  estado.insumos = r.insumos;
  pintarExistencias();
}
async function cargarCompras() {
  const r = await api.get('/inventario/compras');
  estado.compras = r.compras;
  pintarCompras();
}
async function cargarProveedores() {
  const r = await api.get('/inventario/proveedores');
  estado.proveedores = r.proveedores;
  pintarProveedores();
}

try {
  await Promise.all([cargarExistencias(), cargarCompras(), cargarProveedores()]);

  // El dashboard enlaza aquí con ?insumo=N al pulsar una alerta de stock.
  const idInsumo = Number(new URLSearchParams(location.search).get('insumo'));
  if (idInsumo) abrirKardex(idInsumo);
} catch (error) {
  aviso(error.message, 'error');
}
