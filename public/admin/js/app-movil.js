/**
 * Panel de control del canal digital.  Vista /admin/app-movil
 *
 * Reúne cuatro cosas que el administrador necesita a mano: los interruptores
 * de la aplicación, la ficha que ve el cliente al abrirla, las promociones y
 * el listado de clientes registrados.
 *
 * LOS INTERRUPTORES DE AQUÍ NO SON LOS QUE MANDAN. Esta pantalla escribe en la
 * tabla `parametro`; quien de verdad cierra la puerta es
 * `server/middleware/appActiva.js`, que la consulta en cada petición. Es la
 * misma doble capa que el FSD 6.1 exige para los permisos: la interfaz
 * muestra el estado, la API lo impone. Alguien con una versión antigua de la
 * aplicación, o lanzando peticiones a mano, se topa igual con el 503.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar, formatearFecha } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('config.app.ver');
if (!sesion) throw new Error('sin sesión');

const puedeGestionar = tienePermiso('config.app.gestionar');
const puedePromocionar = tienePermiso('promociones.gestionar');
const puedeVerClientes = tienePermiso('clientes.ver');
const $ = (id) => document.getElementById(id);

const puedePagos = tienePermiso('config.pagos.gestionar');
const estado = { parametros: new Map(), promociones: [], metodos: [], editandoPromo: null };

/* =====================================================================
   Pestañas
   ===================================================================== */

const PANELES = ['control', 'restaurante', 'pagos', 'promociones', 'clientes'];
for (const p of PANELES) {
  $(`tab-${p}`).addEventListener('click', () => {
    for (const otro of PANELES) {
      const activo = otro === p;
      $(`tab-${otro}`).classList.toggle('pestana-principal--activa', activo);
      $(`tab-${otro}`).setAttribute('aria-selected', String(activo));
      $(`panel-${otro}`).classList.toggle('oculto', !activo);
    }
    // Las dos listas se cargan al abrir su pestaña, no al entrar en la
    // pantalla: quien solo viene a apagar la aplicación no tiene por qué
    // esperar a que se descarguen clientes y promociones.
    if (p === 'pagos' && !estado.metodos.length) cargarMetodos();
    if (p === 'promociones' && !estado.promociones.length) cargarPromociones();
    if (p === 'clientes') cargarClientes();
  });
}

/* =====================================================================
   Resumen
   ===================================================================== */

function pintarResumen(r) {
  const tarjeta = (etiqueta, valor, nota = null) => el('div', { clase: 'resumen-tarjeta' },
    el('span', { clase: 'resumen-tarjeta__valor mono', texto: String(valor) }),
    el('span', { clase: 'resumen-tarjeta__etiqueta', texto: etiqueta }),
    nota ? el('span', { clase: 'resumen-tarjeta__nota', texto: nota }) : null
  );

  reemplazar($('resumen'),
    tarjeta('Clientes registrados', r.clientes),
    tarjeta('Dispositivos con avisos', r.dispositivos),
    tarjeta('Reservas por resolver', r.reservasPendientes),
    tarjeta('Pedidos por aceptar', r.pedidosPendientes),
    tarjeta('Zonas de entrega activas', r.zonasActivas,
      r.zonasActivas === 0 ? 'Sin zonas no hay domicilios' : null),
    tarjeta('Caché del mapa', `${r.cacheMapa.megas} MB`, `${r.cacheMapa.archivos} teselas`)
  );

  // Si falta configurar Firebase conviene decirlo aquí y no dejar que el
  // administrador descubra por las malas que sus promociones no suenan.
  if (!r.pushConfigurado) {
    $('resumen').append(el('div', { clase: 'aviso-push' },
      el('strong', {}, '⚠ Las notificaciones push no están configuradas. '),
      el('span', {}, 'Los avisos se guardan en la aplicación y el cliente los ve al abrirla, ' +
        'pero no suenan en el móvil. Para activarlas, rellene FCM_PROJECT_ID, ' +
        'FCM_CLIENT_EMAIL y FCM_PRIVATE_KEY en el archivo .env.')
    ));
  }
}

/* =====================================================================
   Parámetros
   ===================================================================== */

const CAMPOS_CONTROL = {
  'app.movil.activa': 'i-app',
  'app.movil.reservas_activas': 'i-reservas',
  'app.movil.domicilios_activos': 'i-domicilios',
  'app.movil.mensaje_inactiva': 'i-mensaje',
  'reservas.anticipacion_min_horas': 'i-anticipacion',
  'reservas.dias_max': 'i-dias',
  'reservas.personas_max': 'i-personas',
  'domicilios.pedido_minimo_global': 'i-minimo',
};

const CAMPOS_RESTAURANTE = {
  'restaurante.nombre': 'r-nombre',
  'restaurante.descripcion': 'r-descripcion',
  'restaurante.direccion': 'r-direccion',
  'restaurante.telefono': 'r-telefono',
  'restaurante.horario': 'r-horario',
  'restaurante.lat': 'r-lat',
  'restaurante.lng': 'r-lng',
};

function volcarEnFormularios() {
  for (const [clave, id] of Object.entries({ ...CAMPOS_CONTROL, ...CAMPOS_RESTAURANTE })) {
    const nodo = $(id);
    if (!nodo) continue;
    const valor = estado.parametros.get(clave);
    nodo.value = typeof valor === 'boolean' ? String(valor) : String(valor ?? '');
  }
}

/** Recoge un grupo de campos y manda solo lo que cambió. */
async function guardar(campos, botonId, estadoId) {
  const cambios = {};
  for (const [clave, id] of Object.entries(campos)) {
    const nodo = $(id);
    if (!nodo) continue;
    const previo = estado.parametros.get(clave);
    const actual = typeof previo === 'boolean'
      ? nodo.value === 'true'
      : typeof previo === 'number' ? Number(nodo.value) : nodo.value;
    if (String(actual) !== String(previo)) cambios[clave] = actual;
  }

  if (!Object.keys(cambios).length) {
    $(estadoId).textContent = 'No hay nada que guardar.';
    return;
  }

  const boton = $(botonId);
  boton.disabled = true;
  boton.textContent = 'Guardando…';

  try {
    await api.put('/configuracion/parametros', cambios);
    for (const [clave, valor] of Object.entries(cambios)) estado.parametros.set(clave, valor);

    // Apagar la aplicación es la acción con más consecuencias de esta
    // pantalla: se confirma con un aviso explícito, no con un "guardado".
    if (cambios['app.movil.activa'] === false) {
      aviso('Aplicación móvil APAGADA. Los clientes ven ahora la pantalla de mantenimiento.', 'alerta', 9000);
    } else if (cambios['app.movil.activa'] === true) {
      aviso('Aplicación móvil encendida.', 'exito', 5000);
    } else {
      aviso('Cambios guardados.', 'exito');
    }

    $(estadoId).textContent = `Guardado a las ${new Date().toLocaleTimeString('es-CO')}.`;
    await cargarResumen();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Guardar cambios';
  }
}

$('form-control').addEventListener('submit', (e) => {
  e.preventDefault();
  guardar(CAMPOS_CONTROL, 'btn-guardar-control', 'estado-guardado');
});

$('form-restaurante').addEventListener('submit', (e) => {
  e.preventDefault();
  guardar(CAMPOS_RESTAURANTE, 'btn-guardar-restaurante', 'estado-restaurante');
});

/* =====================================================================
   Métodos de pago
   ===================================================================== */

/**
 * Cada método es una tarjeta con su formulario.
 *
 * Contra entrega no tiene campos: no hay cuenta a la que transferir. Se pinta
 * igualmente, para que el administrador vea que existe y pueda apagarlo si
 * quiere cobrar todo por adelantado.
 */
function pintarMetodos() {
  if (!estado.metodos.length) {
    reemplazar($('lista-metodos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No hay métodos de pago configurados.' })));
    return;
  }

  reemplazar($('lista-metodos'), ...estado.metodos.map((m) => {
    const id = (campo) => `pm-${m.codigo}-${campo}`;

    // El estado se dice con icono y palabra, no solo con el color de la
    // insignia: «activo» y «sin configurar» son dos cosas distintas.
    const insignia = m.activo
      ? el('span', { clase: 'insignia insignia--exito' }, '✓ Visible en la app')
      : el('span', { clase: 'insignia insignia--neutra' }, '○ Oculto para el cliente');

    const campos = m.requiereComprobante
      ? el('div', { clase: 'tarjeta__cuerpo' },
          el('div', { clase: 'campo' },
            el('label', { clase: 'campo__etiqueta', attrs: { for: id('llave') } },
              'Llave o número de cuenta ', el('span', { clase: 'campo__requerido' }, '*')),
            el('input', {
              clase: 'campo__control mono', id: id('llave'), type: 'text', maxLength: 60,
              value: m.llave ?? '',
              attrs: { placeholder: m.codigo === 'bancolombia' ? '123-456789-01' : '300 123 4567' },
            }),
            el('p', { clase: 'campo__ayuda', texto: 'Es a donde el cliente va a transferir.' }),
            el('p', { clase: 'campo__error', id: `e-${id('llave')}`, attrs: { role: 'alert' } })
          ),
          el('div', { clase: 'campo' },
            el('label', { clase: 'campo__etiqueta', attrs: { for: id('titular') } },
              'Titular de la cuenta ', el('span', { clase: 'campo__requerido' }, '*')),
            el('input', {
              clase: 'campo__control', id: id('titular'), type: 'text', maxLength: 120,
              value: m.titular ?? '',
            }),
            el('p', { clase: 'campo__ayuda',
              texto: 'El cliente lo comprueba antes de transferir, para no pagar a la cuenta equivocada.' }),
            el('p', { clase: 'campo__error', id: `e-${id('titular')}`, attrs: { role: 'alert' } })
          ),
          el('div', { clase: 'form-dos-columnas' },
            el('div', { clase: 'campo' },
              el('label', { clase: 'campo__etiqueta', attrs: { for: id('tipoCuenta') } }, 'Tipo de cuenta'),
              el('select', { clase: 'campo__control', id: id('tipoCuenta') },
                ...['', 'Ahorros', 'Corriente', 'Nequi', 'DaviPlata'].map((v) =>
                  el('option', { value: v, texto: v || '— sin especificar —', selected: (m.tipoCuenta ?? '') === v })))
            ),
            el('div', { clase: 'campo' },
              el('label', { clase: 'campo__etiqueta', attrs: { for: id('banco') } }, 'Banco'),
              el('input', {
                clase: 'campo__control', id: id('banco'), type: 'text', maxLength: 60,
                value: m.banco ?? '',
              }),
              el('p', { clase: 'campo__ayuda', texto: 'Necesario para una transferencia interbancaria.' })
            )
          )
        )
      : el('div', { clase: 'tarjeta__cuerpo' },
          el('p', { clase: 'campo__ayuda', style: 'margin:0' },
            'Se paga en la puerta, así que no hay cuenta que configurar. ' +
            'Caja puede aceptar estos pedidos directamente, sin esperar comprobante.')
        );

    return el('form', { clase: 'tarjeta metodo-pago', attrs: { novalidate: true },
      on: { submit: (e) => { e.preventDefault(); guardarMetodo(m); } } },
      el('div', { clase: 'tarjeta__cabecera' },
        el('h3', { texto: m.nombre }),
        insignia
      ),
      campos,
      el('div', { clase: 'tarjeta__cabecera zona-form__pie' },
        el('div', { clase: 'campo', style: 'margin:0' },
          el('label', { clase: 'solo-lectores', attrs: { for: id('activo') } },
            `Mostrar ${m.nombre} en la aplicación`),
          el('select', { clase: 'campo__control interruptor__control', id: id('activo') },
            el('option', { value: 'true', texto: '✓ Visible en la app', selected: m.activo }),
            el('option', { value: 'false', texto: '○ Oculto', selected: !m.activo }))
        ),
        puedePagos
          ? el('button', { clase: 'btn btn--primario', attrs: { type: 'submit' } }, 'Guardar')
          : null
      )
    );
  }));
}

async function guardarMetodo(metodo) {
  const id = (campo) => `pm-${metodo.codigo}-${campo}`;
  for (const c of ['llave', 'titular']) {
    const nodo = $(`e-${id(c)}`);
    if (nodo) nodo.textContent = '';
  }

  const cuerpo = { activo: $(id('activo')).value === 'true' };
  if (metodo.requiereComprobante) {
    cuerpo.llave = $(id('llave')).value.trim();
    cuerpo.titular = $(id('titular')).value.trim();
    cuerpo.tipoCuenta = $(id('tipoCuenta')).value;
    cuerpo.banco = $(id('banco')).value.trim();
  }

  try {
    await api.put(`/configuracion/metodos-pago/${metodo.codigo}`, cuerpo);
    aviso(
      cuerpo.activo
        ? `${metodo.nombre} ya aparece como forma de pago en la aplicación.`
        : `${metodo.nombre} dejó de mostrarse a los clientes.`,
      'exito', 6000
    );
    await cargarMetodos();
  } catch (error) {
    // El servidor impide activar un método sin llave, y dice qué falta.
    if (error instanceof ErrorPeticion && error.campos) {
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        const nodo = $(`e-${id(campo)}`);
        if (nodo) nodo.textContent = mensaje;
      }
      aviso(error.message, 'alerta', 8000);
    } else {
      aviso(error.message, 'error', 7000);
    }
  }
}

async function cargarMetodos() {
  if (!puedePagos) {
    reemplazar($('lista-metodos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No tiene permiso para configurar los métodos de pago.' })));
    return;
  }
  try {
    const r = await api.get('/configuracion/metodos-pago');
    estado.metodos = r.metodos;
    pintarMetodos();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* =====================================================================
   Promociones
   ===================================================================== */

function pintarPromociones() {
  $('contador-promos').textContent = estado.promociones.length === 1
    ? '1 promoción'
    : `${estado.promociones.length} promociones`;

  if (!estado.promociones.length) {
    reemplazar($('lista-promos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'Todavía no hay promociones.' }),
      el('p', { clase: 'texto-sm texto-tenue' },
        'Una promoción llega como notificación al móvil y queda en la bandeja de la aplicación.')
    ));
    return;
  }

  reemplazar($('lista-promos'), ...estado.promociones.map((p) => el('div', { clase: 'tarjeta promo' },
    el('div', { clase: 'tarjeta__cuerpo' },
      el('div', { clase: 'fila fila--entre', style: 'align-items:flex-start;gap:.5rem' },
        el('div', { clase: 'crece' },
          el('strong', { texto: p.titulo }),
          el('p', { clase: 'texto-sm', texto: p.cuerpo, style: 'margin:.25rem 0 0' })
        ),
        p.enviadaEn
          ? el('span', { clase: 'insignia insignia--exito' }, '✓ Enviada')
          : p.activa
            ? el('span', { clase: 'insignia insignia--info' }, '○ Sin enviar')
            : el('span', { clase: 'insignia insignia--neutra' }, '○ Inactiva')
      ),
      el('p', { clase: 'texto-sm texto-tenue', style: 'margin:.5rem 0 0' },
        p.enviadaEn
          ? `Enviada el ${formatearFecha(p.enviadaEn)} a ${p.totalEnviados} cliente(s).`
          : `Creada el ${formatearFecha(p.creadoEn)}${p.creadaPor ? ` por ${p.creadaPor}` : ''}.`
      ),
      p.vigenteHasta
        ? el('p', { clase: 'texto-sm texto-tenue', style: 'margin:.15rem 0 0',
                    texto: `Vigente hasta el ${formatearFecha(p.vigenteHasta, { conHora: false })}.` })
        : null,
      puedePromocionar
        ? el('div', { clase: 'tabla__acciones', style: 'margin-top:.6rem' },
            p.enviadaEn
              ? null
              : el('button', {
                  clase: 'btn btn--primario btn--sm',
                  attrs: { type: 'button' },
                  on: { click: () => enviarPromocion(p) },
                }, 'Enviar ahora'),
            el('button', {
              clase: 'btn btn--secundario btn--sm',
              attrs: { type: 'button' },
              on: { click: () => abrirPromo(p) },
            }, 'Editar'),
            el('button', {
              clase: 'btn btn--peligro btn--sm',
              attrs: { type: 'button' },
              on: { click: () => borrarPromocion(p) },
            }, 'Eliminar')
          )
        : null
    )
  )));
}

function abrirPromo(promo = null) {
  estado.editandoPromo = promo;
  $('e-p-titulo').textContent = '';
  $('e-p-cuerpo').textContent = '';
  $('titulo-promo').textContent = promo ? 'Editar promoción' : 'Nueva promoción';
  $('p-titulo').value = promo?.titulo ?? '';
  $('p-cuerpo').value = promo?.cuerpo ?? '';
  $('p-desde').value = promo?.vigenteDesde ? String(promo.vigenteDesde).slice(0, 10) : '';
  $('p-hasta').value = promo?.vigenteHasta ? String(promo.vigenteHasta).slice(0, 10) : '';
  $('form-promo').classList.remove('oculto');
  $('p-titulo').focus();
}

$('btn-nueva-promo').addEventListener('click', () => abrirPromo(null));
$('btn-cancelar-promo').addEventListener('click', () => {
  estado.editandoPromo = null;
  $('form-promo').classList.add('oculto');
});

$('form-promo').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('e-p-titulo').textContent = '';
  $('e-p-cuerpo').textContent = '';

  const cuerpo = {
    titulo: $('p-titulo').value.trim(),
    cuerpo: $('p-cuerpo').value.trim(),
    vigenteDesde: $('p-desde').value || null,
    vigenteHasta: $('p-hasta').value || null,
    activa: true,
  };

  try {
    if (estado.editandoPromo) {
      await api.put(`/configuracion/promociones/${estado.editandoPromo.id}`, cuerpo);
    } else {
      await api.post('/configuracion/promociones', cuerpo);
    }
    aviso('Promoción guardada.', 'exito');
    $('form-promo').classList.add('oculto');
    estado.editandoPromo = null;
    await cargarPromociones();
  } catch (error) {
    if (error instanceof ErrorPeticion && error.campos) {
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        const nodo = $(`e-p-${campo}`);
        if (nodo) nodo.textContent = mensaje;
      }
    } else {
      aviso(error.message, 'error', 7000);
    }
  }
});

/**
 * Enviar es irreversible y alcanza a todos los clientes a la vez, así que se
 * confirma con el botón rojo. El servidor además impide el segundo envío
 * (`enviada_en` no vuelve a NULL): un doble clic no puede duplicar el aviso.
 */
async function enviarPromocion(promo) {
  const ok = await confirmar({
    titulo: 'Enviar la promoción',
    mensaje: `Se enviará «${promo.titulo}» a TODOS los clientes que aceptan promociones. ` +
             'No se puede deshacer, y una promoción solo se envía una vez.',
    textoConfirmar: 'Enviar ahora',
    peligro: true,
  });
  if (!ok) return;

  try {
    const r = await api.post(`/configuracion/promociones/${promo.id}/enviar`);
    aviso(
      `Enviada a ${r.clientes} cliente(s).` +
      (r.pushConfigurado
        ? ` ${r.pushEnviados} notificación(es) entregadas al móvil.`
        : ' Firebase no está configurado: quedó en la bandeja de la aplicación, sin aviso sonoro.'),
      'exito', 9000
    );
    await cargarPromociones();
  } catch (error) {
    aviso(error.message, 'error', 8000);
  }
}

async function borrarPromocion(promo) {
  const ok = await confirmar({
    titulo: 'Eliminar la promoción',
    mensaje: `Se elimina «${promo.titulo}». Los avisos ya enviados siguen en la bandeja ` +
             'de los clientes que los recibieron.',
    textoConfirmar: 'Eliminar',
    peligro: true,
  });
  if (!ok) return;

  try {
    await api.borrar(`/configuracion/promociones/${promo.id}`);
    aviso('Promoción eliminada.', 'exito');
    await cargarPromociones();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function cargarPromociones() {
  if (!puedePromocionar) {
    reemplazar($('lista-promos'), el('div', { clase: 'vacio' },
      el('p', { texto: 'No tiene permiso para gestionar promociones.' })));
    $('btn-nueva-promo').classList.add('oculto');
    return;
  }
  try {
    const r = await api.get('/configuracion/promociones');
    estado.promociones = r.promociones;
    pintarPromociones();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

/* =====================================================================
   Clientes
   ===================================================================== */

async function cargarClientes() {
  if (!puedeVerClientes) {
    reemplazar($('tabla-clientes'), el('tr', {},
      el('td', { attrs: { colspan: '6' } },
        el('div', { clase: 'vacio' }, el('p', { texto: 'No tiene permiso para ver los clientes.' })))));
    return;
  }

  try {
    const r = await api.get(`/configuracion/clientes?buscar=${encodeURIComponent($('buscar-cliente').value)}`);

    if (!r.clientes.length) {
      reemplazar($('tabla-clientes'), el('tr', {},
        el('td', { attrs: { colspan: '6' } },
          el('div', { clase: 'vacio' }, el('p', { texto: 'Ningún cliente coincide con la búsqueda.' })))));
      return;
    }

    reemplazar($('tabla-clientes'), ...r.clientes.map((c) => el('tr', {},
      el('td', { attrs: { 'data-etiqueta': 'Cliente' } },
        el('strong', { texto: c.nombre }),
        el('div', { clase: 'texto-sm texto-tenue', texto: `Alta ${formatearFecha(c.creadoEn, { conHora: false })}` })
      ),
      el('td', { clase: 'mono', attrs: { 'data-etiqueta': 'Cédula' }, texto: c.documento }),
      el('td', { attrs: { 'data-etiqueta': 'Contacto' } },
        el('div', { texto: c.correo }),
        el('div', { clase: 'texto-sm texto-tenue', texto: c.telefono })
      ),
      el('td', { clase: 'mono', attrs: { 'data-etiqueta': 'Pedidos' }, texto: String(c.pedidos) }),
      el('td', { clase: 'mono', attrs: { 'data-etiqueta': 'Reservas' }, texto: String(c.reservas) }),
      el('td', { attrs: { 'data-etiqueta': 'Estado' } },
        c.activo
          ? el('span', { clase: 'insignia insignia--exito' }, '✓ Activa')
          // Una cuenta dada de baja se anonimiza, no se borra: por eso sigue
          // apareciendo en la lista aunque ya no tenga datos reales.
          : el('span', { clase: 'insignia insignia--neutra' }, '○ Eliminada')
      )
    )));
  } catch (error) {
    aviso(error.message, 'error');
  }
}

$('buscar-cliente').addEventListener('input', retrasar(cargarClientes, 300));

/* =====================================================================
   Carga inicial
   ===================================================================== */

async function cargarResumen() {
  const r = await api.get('/configuracion/resumen');
  pintarResumen(r);
}

async function cargarParametros() {
  const r = await api.get('/configuracion/parametros');
  estado.parametros = new Map(r.parametros.map((p) => [p.clave, p.valor]));
  volcarEnFormularios();
}

try {
  await Promise.all([cargarResumen(), cargarParametros()]);

  if (!puedeGestionar) {
    // Solo lectura: se desactivan los controles en vez de esconderlos, para
    // que el administrador de turno vea la configuración vigente.
    for (const id of [...Object.values(CAMPOS_CONTROL), ...Object.values(CAMPOS_RESTAURANTE)]) {
      const nodo = $(id);
      if (nodo) nodo.disabled = true;
    }
    $('btn-guardar-control').classList.add('oculto');
    $('btn-guardar-restaurante').classList.add('oculto');
    aviso('Puede consultar la configuración, pero no modificarla.', 'info', 6000);
  }
} catch (error) {
  aviso(error.message, 'error', 8000);
}
