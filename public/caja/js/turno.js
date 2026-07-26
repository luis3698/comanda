/**
 * Vista 21: Gestión de Flujo de Caja y Turnos.  RF-20.
 *
 * FSD 4.4 vista 21: tres estados de pantalla — Apertura, Turno activo,
 * Cierre (arqueo ciego).
 *
 * CA-07 — el arqueo es CIEGO: el sistema no muestra el esperado hasta que el
 * cajero confirma el conteo. Aquí eso se respeta a rajatabla: la pantalla de
 * conteo no pide ni muestra ningún número del sistema; el esperado llega solo
 * en la respuesta del cierre, y recién entonces se pinta.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, formatearDinero, formatearFecha } from '/comun/ui.js';
import { iniciarPos, turnoActivo, refrescarTurno } from './comun.js';

const contexto = await iniciarPos({ vista: 'turno', alRefrescar: cargar });
if (!contexto) throw new Error('sin sesión');

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Teclado numérico reutilizable
   Acumula centavos: cada dígito desplaza; se muestra como decimal.
   --------------------------------------------------------------- */
function montarTeclado(idTeclado, idVisor, onChange) {
  let centavos = 0;
  const pintar = () => {
    $(idVisor).textContent = formatearDinero(centavos / 100);
    onChange?.(centavos);
  };
  $(idTeclado).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.d != null) centavos = Math.min(centavos * 10 + Number(b.dataset.d), 9999999999);
    else if (b.dataset.a === '00') centavos = Math.min(centavos * 100, 9999999999);
    else if (b.dataset.a === 'borrar') centavos = Math.floor(centavos / 10);
    pintar();
  });
  pintar();
  return {
    valor: () => centavos,
    reset: () => { centavos = 0; pintar(); },
  };
}

const tecladoFondo = montarTeclado('teclado-fondo', 'visor-fondo');

/* ---------------------------------------------------------------
   Apertura de turno
   --------------------------------------------------------------- */
$('btn-abrir-turno').addEventListener('click', async () => {
  const btn = $('btn-abrir-turno');
  btn.disabled = true;
  btn.textContent = 'Abriendo…';
  try {
    await api.post('/caja/turnos', { fondoInicial: (tecladoFondo.valor() / 100).toFixed(2) });
    aviso('Turno abierto. Ya puede cobrar.', 'exito');
    await refrescarTurno();
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Abrir turno';
  }
});

/* ---------------------------------------------------------------
   Turno activo
   --------------------------------------------------------------- */
const ETIQUETA_METODO = {
  efectivo: 'Efectivo', tarjeta_credito: 'T. Crédito', tarjeta_debito: 'T. Débito',
  transferencia: 'Transferencia', otro: 'Otro',
};

function pintarActivo(turno) {
  $('info-turno').textContent =
    `Abierto ${formatearFecha(turno.abiertoEn)} · Fondo inicial ${formatearDinero(turno.fondoInicial)}`;

  // Resumen de ventas por método (sin revelar esperado alguno).
  const tarjetas = [
    el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Facturas'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: String(turno.facturas) })),
    el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, 'Total facturado'),
      el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(turno.totalFacturado) })),
    ...turno.porMetodo.map((m) => el('div', { clase: 'resumen-tarjeta' },
      el('div', { clase: 'resumen-tarjeta__etiqueta' }, ETIQUETA_METODO[m.metodo] ?? m.metodo),
      el('div', { clase: 'resumen-tarjeta__valor', texto: formatearDinero(m.total) }),
      el('div', { clase: 'texto-tenue texto-sm', texto: `${m.cantidad} pago(s)` }))),
  ];
  reemplazar($('resumen-ventas'), ...tarjetas);

  // Movimientos.
  if (!turno.movimientos.length) {
    reemplazar($('tabla-movimientos'), el('tr', {}, el('td', { attrs: { colspan: '3' } },
      el('div', { clase: 'vacio texto-sm' }, 'Sin movimientos de efectivo.'))));
  } else {
    reemplazar($('tabla-movimientos'), ...turno.movimientos.map((m) => el('tr', {},
      el('td', { texto: m.tipo === 'ingreso' ? 'Ingreso' : 'Salida' }),
      el('td', { texto: String(m.cantidad) }),
      el('td', { texto: formatearDinero(m.total) })
    )));
  }
}

/* ---------------------------------------------------------------
   Salida de efectivo
   --------------------------------------------------------------- */
const modalSalida = $('modal-salida');
$('btn-salida').addEventListener('click', () => {
  $('s-monto').value = '';
  $('s-motivo').value = '';
  $('e-s-monto').textContent = '';
  $('e-s-motivo').textContent = '';
  modalSalida.showModal();
});
$('btn-cerrar-salida').addEventListener('click', () => modalSalida.close());
$('btn-cancelar-salida').addEventListener('click', () => modalSalida.close());
$('s-monto').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); });

$('form-salida').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('e-s-monto').textContent = '';
  $('e-s-motivo').textContent = '';

  const monto = $('s-monto').value.trim();
  const motivo = $('s-motivo').value.trim();
  if (!monto || Number(monto) <= 0) { $('e-s-monto').textContent = 'Indique un monto mayor que cero.'; return; }
  if (motivo.length < 3) { $('e-s-motivo').textContent = 'El motivo es obligatorio.'; return; }

  try {
    await api.post(`/caja/turnos/${turnoActivo.idTurno}/movimientos`, { tipo: 'salida', monto, motivo });
    aviso('Salida de efectivo registrada.', 'exito');
    modalSalida.close();
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
});

/* ---------------------------------------------------------------
   Cierre con arqueo ciego (CA-07)
   --------------------------------------------------------------- */
const modalArqueo = $('modal-arqueo');
let tecladoConteo = null;
let conteoConfirmado = false;

$('btn-cerrar-turno').addEventListener('click', () => {
  // Reinicia el modal al estado de conteo.
  $('paso-conteo').classList.remove('oculto');
  $('paso-resultado').classList.add('oculto');
  $('pie-arqueo').style.display = 'none';
  $('campo-comentario').classList.add('oculto');
  $('a-comentario').value = '';
  conteoConfirmado = false;

  if (!tecladoConteo) tecladoConteo = montarTeclado('teclado-conteo', 'visor-conteo');
  else tecladoConteo.reset();

  modalArqueo.showModal();
});
$('btn-cerrar-arqueo').addEventListener('click', () => modalArqueo.close());

$('btn-confirmar-conteo').addEventListener('click', async () => {
  const btn = $('btn-confirmar-conteo');
  const totalContado = (tecladoConteo.valor() / 100).toFixed(2);
  const comentario = $('a-comentario').value.trim() || null;

  btn.disabled = true;
  btn.textContent = 'Cerrando…';

  try {
    // Aquí y solo aquí el servidor calcula y revela el esperado (CA-07).
    const r = await api.post(`/caja/turnos/${turnoActivo.idTurno}/cierre`, { totalContado, comentario });
    mostrarResultado(r);
  } catch (error) {
    // Si el conteo no cuadra, el servidor pide comentario: se muestra el campo.
    if (error instanceof ErrorPeticion && error.datos?.requiereComentario) {
      $('campo-comentario').classList.remove('oculto');
      aviso('El conteo no cuadra. Escriba un comentario justificativo para cerrar.', 'alerta', 7000);
      $('a-comentario').focus();
    } else {
      aviso(error.message, 'error', 7000);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar conteo y revelar arqueo';
  }
});

function mostrarResultado(r) {
  conteoConfirmado = true;
  $('paso-conteo').classList.add('oculto');
  $('paso-resultado').classList.remove('oculto');
  $('pie-arqueo').style.display = 'flex';

  const color = r.tipo === 'cuadrado' ? 'exito' : (r.tipo === 'sobrante' ? 'info' : 'error');
  const etiquetaTipo = { cuadrado: 'Caja cuadrada', sobrante: 'Sobrante', faltante: 'Faltante' }[r.tipo];

  reemplazar($('resultado-arqueo'),
    el('div', { clase: `saldo saldo--${r.tipo === 'cuadrado' ? 'completo' : (r.tipo === 'faltante' ? 'exceso' : 'pendiente')}` },
      `${etiquetaTipo}: ${formatearDinero(r.diferencia)}`),

    el('div', { clase: 'tarjeta__cuerpo' },
      el('div', { clase: 'desglose-sub' }, el('span', {}, 'Fondo inicial'), el('span', { texto: formatearDinero(r.desglose.fondoInicial) })),
      el('div', { clase: 'desglose-sub' }, el('span', {}, 'Ventas en efectivo'), el('span', { texto: formatearDinero(r.desglose.ventaEfectivo) })),
      el('div', { clase: 'desglose-sub' }, el('span', {}, 'Ingresos'), el('span', { texto: formatearDinero(r.desglose.ingresos) })),
      el('div', { clase: 'desglose-sub' }, el('span', {}, 'Salidas'), el('span', { texto: `−${formatearDinero(r.desglose.salidas)}` })),
      el('div', { clase: 'desglose-linea', attrs: { style: 'font-weight:700;margin-top:.5rem' } },
        el('span', {}, 'Esperado por sistema'), el('span', { texto: formatearDinero(r.esperado) })),
      el('div', { clase: 'desglose-linea', attrs: { style: 'font-weight:700' } },
        el('span', {}, 'Contado físico'), el('span', { texto: formatearDinero(r.contado) }))
    ),
    el('p', { clase: 'texto-tenue texto-sm', attrs: { style: 'margin-top:.75rem' } },
      'El turno quedó cerrado e inmutable. El reporte se envió al administrador.')
  );
}

$('btn-finalizar-arqueo').addEventListener('click', async () => {
  modalArqueo.close();
  await refrescarTurno();
  await cargar();
});

// Evita cerrar el modal a mitad del arqueo con Escape antes de confirmar.
modalArqueo.addEventListener('cancel', (e) => {
  if (!conteoConfirmado && tecladoConteo?.valor() > 0) {
    e.preventDefault();
    aviso('Termine o cancele el arqueo con los botones.', 'info', 3000);
  }
});

/* ---------------------------------------------------------------
   Carga
   --------------------------------------------------------------- */
async function cargar() {
  const turno = await refrescarTurno();
  if (turno) {
    $('panel-apertura').classList.add('oculto');
    $('panel-activo').classList.remove('oculto');
    pintarActivo(turno);
  } else {
    $('panel-apertura').classList.remove('oculto');
    $('panel-activo').classList.add('oculto');
    tecladoFondo.reset();
  }
}

await cargar();
