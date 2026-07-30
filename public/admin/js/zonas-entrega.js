/**
 * Configuración de cobertura de domicilios.  Vista /admin/zonas-entrega
 *
 * La herramienta de radar que pedía el enunciado: el administrador dibuja
 * círculos sobre el mapa y a cada uno le pone radio, precio de envío y pedido
 * mínimo.
 *
 * TRES DECISIONES QUE CONVIENE ENTENDER ANTES DE TOCAR ESTE ARCHIVO
 *
 * 1. EL MAPA NUNCA ES LA ÚNICA FORMA DE HACER ALGO. Arrastrar el borde del
 *    círculo es cómodo, pero la seccion «Accesibilidad» del README exige que todo se pueda hacer
 *    sin ratón. Por eso el centro y el radio tienen campos numéricos que son
 *    la fuente de verdad: el mapa los escribe, el formulario los lee. Es el
 *    mismo patrón que el diseñador de salón, que acompaña el arrastre con
 *    `moverConTeclado`.
 *
 * 2. EL SOLAPE NO SE CALCULA AQUÍ. Qué zona gana cuando los círculos se pisan
 *    lo decide el servidor (`server/servicios/entregas.js`), y la pestaña
 *    "Probar" se lo pregunta por HTTP en vez de repetir la fórmula. Si se
 *    hubiera duplicado, un día el administrador vería un precio y el cliente
 *    otro.
 *
 * 3. LAS TESELAS SON DE CASA. Se piden a /api/v1/mapa/teselas, un proxy con
 *    caché en disco. El navegador no habla con ningún tercero y el CSP sigue
 *    intacto.
 */
import { api, ErrorPeticion } from '/comun/api.js';
import { el, reemplazar, aviso, confirmar, retrasar, formatearDinero } from '/comun/ui.js';
import { iniciarShell, tienePermiso } from './shell.js';

const sesion = await iniciarShell('config.entregas.ver');
if (!sesion) throw new Error('sin sesión');

const puedeGestionar = tienePermiso('config.entregas.gestionar');
const $ = (id) => document.getElementById(id);

const estado = {
  zonas: [],
  /** Zona en edición: objeto de `zonas`, o null para una nueva. */
  editando: null,
  /** Círculos de Leaflet ya pintados, por id de zona. */
  capas: new Map(),
  /** Círculo provisional de la zona que se está editando. */
  borrador: null,
  marcadorPrueba: null,
  /**
   * Punto de partida del mapa, y con él el de una zona nueva.
   *
   * Este valor es solo el ÚLTIMO recurso: al cargar se sustituye por el centro
   * de la cobertura existente y, si no hay ninguna, por la ficha del
   * restaurante (ver el bloque de carga inicial). Solo sobrevive en una
   * instalación recién puesta, donde no hay ni zonas ni ficha y hay que mirar a
   * alguna parte.
   */
  centroLocal: { lat: 4.5981, lng: -74.0758 },
};

/* =====================================================================
   Mapa
   ===================================================================== */

const mapa = L.map('mapa', {
  center: [estado.centroLocal.lat, estado.centroLocal.lng],
  zoom: 13,
  // El zoom con rueda se deja activo, pero el teclado también funciona:
  // Leaflet mueve el mapa con las flechas y hace zoom con +/- cuando tiene
  // el foco. Es la alternativa sin ratón para explorar.
  keyboard: true,
});

L.tileLayer('/api/v1/mapa/teselas/{z}/{x}/{y}.png', {
  maxZoom: 19,
  minZoom: 3,
  // Atribución obligatoria por la licencia de OpenStreetMap, aunque las
  // teselas pasen por nuestro proxy.
  attribution: '© OpenStreetMap',
}).addTo(mapa);

/** Pinta todos los círculos guardados. */
function pintarMapa() {
  for (const capa of estado.capas.values()) capa.remove();
  estado.capas.clear();

  for (const z of estado.zonas) {
    const circulo = L.circle([z.centroLat, z.centroLng], {
      radius: z.radioM,
      color: z.color,
      fillColor: z.color,
      // Las inactivas se dibujan casi transparentes y con línea discontinua:
      // el estado no se comunica solo con color (README «Accesibilidad»), y además
      // la etiqueta lo dice con palabras.
      fillOpacity: z.activa ? 0.15 : 0.04,
      opacity: z.activa ? 0.9 : 0.4,
      dashArray: z.activa ? null : '6 6',
      weight: 2,
    }).addTo(mapa);

    circulo.bindTooltip(
      `${z.nombre} · ${(z.radioM / 1000).toFixed(1)} km · ${formatearDinero(z.costoEnvio)}` +
      (z.activa ? '' : ' · inactiva'),
      { permanent: false, direction: 'top' }
    );

    if (puedeGestionar) circulo.on('click', () => abrirFormulario(z));

    estado.capas.set(z.id, circulo);
  }
}

/** Dibuja o mueve el círculo provisional mientras se edita. */
function pintarBorrador() {
  const lat = Number($('z-lat').value);
  const lng = Number($('z-lng').value);
  const radio = Number($('z-radio').value);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radio) || radio <= 0) {
    estado.borrador?.remove();
    estado.borrador = null;
    return;
  }

  const color = $('z-color').value || '#0f766e';

  if (!estado.borrador) {
    estado.borrador = L.circle([lat, lng], {
      radius: radio, color, fillColor: color, fillOpacity: 0.25, weight: 3,
    }).addTo(mapa);
  } else {
    estado.borrador.setLatLng([lat, lng]);
    estado.borrador.setRadius(radio);
    estado.borrador.setStyle({ color, fillColor: color });
  }
}

/**
 * Un clic en el mapa hace una cosa u otra según la pestaña abierta: sitúa el
 * centro de la zona que se edita, o comprueba una dirección. Es la misma
 * acción física con dos significados, y la ayuda bajo el mapa lo anuncia.
 */
mapa.on('click', (evento) => {
  const { lat, lng } = evento.latlng;

  if ($('panel-probar').classList.contains('oculto')) {
    if (!estado.editando && !$('form-zona').classList.contains('oculto') === false) return;
    if ($('form-zona').classList.contains('oculto')) return;
    $('z-lat').value = lat.toFixed(7);
    $('z-lng').value = lng.toFixed(7);
    pintarBorrador();
  } else {
    $('p-lat').value = lat.toFixed(7);
    $('p-lng').value = lng.toFixed(7);
    probarCobertura();
  }
});

/* =====================================================================
   Pestañas
   ===================================================================== */

const PANELES = ['lista', 'probar'];
for (const p of PANELES) {
  $(`tab-${p}`).addEventListener('click', () => {
    for (const otro of PANELES) {
      const activo = otro === p;
      $(`tab-${otro}`).classList.toggle('pestana-principal--activa', activo);
      $(`tab-${otro}`).setAttribute('aria-selected', String(activo));
      $(`panel-${otro}`).classList.toggle('oculto', !activo);
    }
    $('ayuda-mapa').textContent = p === 'probar'
      ? 'Pulse sobre el mapa para comprobar si esa ubicación tiene cobertura.'
      : 'Pulse sobre el mapa para situar el centro de la zona que esté editando.';
  });
}

/* =====================================================================
   Lista de zonas
   ===================================================================== */

function pintarLista() {
  $('contador-zonas').textContent = estado.zonas.length === 1
    ? '1 zona configurada'
    : `${estado.zonas.length} zonas configuradas`;

  if (!estado.zonas.length) {
    reemplazar($('lista-zonas'), el('div', { clase: 'vacio' },
      el('p', { texto: 'Todavía no hay ninguna zona de cobertura.' }),
      el('p', { clase: 'texto-sm texto-tenue' },
        'Sin zonas activas, la aplicación rechaza todos los pedidos a domicilio por falta de cobertura.')
    ));
    return;
  }

  reemplazar($('lista-zonas'), ...estado.zonas.map((z) => el('div', {
    clase: `zona-tarjeta ${estado.editando?.id === z.id ? 'zona-tarjeta--activa' : ''}`,
  },
    el('div', { clase: 'zona-tarjeta__cabecera' },
      el('span', { clase: 'zona-tarjeta__color', attrs: { 'aria-hidden': 'true', style: `background:${z.color}` } }),
      el('strong', { clase: 'crece', texto: z.nombre }),
      z.activa
        ? el('span', { clase: 'insignia insignia--exito' }, '✓ Activa')
        : el('span', { clase: 'insignia insignia--neutra' }, '○ Inactiva')
    ),
    el('dl', { clase: 'zona-tarjeta__datos' },
      el('dt', { texto: 'Radio' }),
      el('dd', { clase: 'mono', texto: `${(z.radioM / 1000).toFixed(2)} km` }),
      el('dt', { texto: 'Envío' }),
      el('dd', { clase: 'mono', texto: formatearDinero(z.costoEnvio) }),
      el('dt', { texto: 'Mínimo' }),
      el('dd', { clase: 'mono', texto: Number(z.pedidoMinimo) > 0 ? formatearDinero(z.pedidoMinimo) : '—' }),
      el('dt', { texto: 'Entrega' }),
      el('dd', { clase: 'mono', texto: `${z.tiempoEstimadoMin} min` }),
      el('dt', { texto: 'Prioridad' }),
      el('dd', { clase: 'mono', texto: String(z.prioridad) })
    ),
    el('div', { clase: 'tabla__acciones' },
      el('button', {
        clase: 'btn btn--secundario btn--sm',
        attrs: { type: 'button' },
        on: { click: () => { mapa.setView([z.centroLat, z.centroLng], 13); } },
      }, 'Ver en el mapa'),
      puedeGestionar
        ? el('button', {
            clase: 'btn btn--secundario btn--sm',
            attrs: { type: 'button' },
            on: { click: () => abrirFormulario(z) },
          }, 'Editar')
        : null
    )
  )));
}

/* =====================================================================
   Formulario
   ===================================================================== */

function limpiarErrores() {
  for (const campo of ['nombre', 'centro', 'radioM', 'costoEnvio', 'pedidoMinimo', 'tiempoEstimadoMin']) {
    const nodo = $(`e-z-${campo}`);
    if (nodo) nodo.textContent = '';
  }
}

/** Abre el formulario. Sin argumento, crea una zona nueva centrada en la vista. */
function abrirFormulario(zona = null) {
  if (!puedeGestionar) return;

  estado.editando = zona;
  limpiarErrores();

  const centro = zona
    ? { lat: zona.centroLat, lng: zona.centroLng }
    : mapa.getCenter();

  $('titulo-form').textContent = zona ? `Editar «${zona.nombre}»` : 'Nueva zona';
  $('z-nombre').value = zona?.nombre ?? '';
  $('z-lat').value = Number(centro.lat).toFixed(7);
  $('z-lng').value = Number(centro.lng).toFixed(7);
  $('z-radio').value = zona?.radioM ?? 2000;
  $('z-radio-rango').value = Math.min(20000, zona?.radioM ?? 2000);
  $('z-costo').value = zona ? Number(zona.costoEnvio) : 0;
  $('z-minimo').value = zona ? Number(zona.pedidoMinimo) : 0;
  $('z-tiempo').value = zona?.tiempoEstimadoMin ?? 30;
  $('z-prioridad').value = zona?.prioridad ?? 0;
  $('z-color').value = zona?.color ?? '#0f766e';
  $('z-activa').value = String(zona ? zona.activa : true);

  $('btn-borrar').classList.toggle('oculto', !zona);
  $('form-zona').classList.remove('oculto');

  actualizarKm();
  pintarBorrador();
  pintarLista();
  $('z-nombre').focus();
}

function cerrarFormulario() {
  estado.editando = null;
  $('form-zona').classList.add('oculto');
  estado.borrador?.remove();
  estado.borrador = null;
  pintarLista();
}

/** Traduce el radio a kilómetros, que es como piensa un humano. */
function actualizarKm() {
  const metros = Number($('z-radio').value);
  $('z-radio-km').textContent = Number.isFinite(metros) && metros > 0
    ? `Equivale a ${(metros / 1000).toFixed(2)} km a la redonda.`
    : '';
}

// El deslizador y el campo numérico escriben el mismo valor. El campo llega
// hasta 50 km; el deslizador se queda en 20, que es el rango cómodo en ciudad.
$('z-radio-rango').addEventListener('input', () => {
  $('z-radio').value = $('z-radio-rango').value;
  actualizarKm();
  pintarBorrador();
});
$('z-radio').addEventListener('input', () => {
  const v = Number($('z-radio').value);
  if (Number.isFinite(v)) $('z-radio-rango').value = Math.min(20000, Math.max(100, v));
  actualizarKm();
  pintarBorrador();
});

for (const id of ['z-lat', 'z-lng', 'z-color']) {
  $(id).addEventListener('input', retrasar(pintarBorrador, 150));
}

$('btn-nueva').addEventListener('click', () => abrirFormulario(null));
$('btn-cancelar').addEventListener('click', cerrarFormulario);

// «Centrar» vuelve a encuadrar la cobertura entera, que es lo que se quiere ver
// después de haberse ido de paseo por el mapa. Solo cae al punto guardado
// cuando todavía no hay ninguna zona dibujada.
$('btn-centrar').addEventListener('click', () => {
  if (!encuadrarEnCobertura()) {
    mapa.setView([estado.centroLocal.lat, estado.centroLocal.lng], 14);
  }
});

$('form-zona').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  limpiarErrores();

  const cuerpo = {
    nombre: $('z-nombre').value.trim(),
    centroLat: Number($('z-lat').value),
    centroLng: Number($('z-lng').value),
    radioM: Number($('z-radio').value),
    costoEnvio: Number($('z-costo').value || 0),
    pedidoMinimo: Number($('z-minimo').value || 0),
    tiempoEstimadoMin: Number($('z-tiempo').value || 30),
    color: $('z-color').value,
    prioridad: Number($('z-prioridad').value || 0),
    activa: $('z-activa').value === 'true',
  };

  const boton = $('btn-guardar');
  boton.disabled = true;
  boton.textContent = 'Guardando…';

  try {
    if (estado.editando) {
      await api.put(`/configuracion/zonas-entrega/${estado.editando.id}`, cuerpo);
      aviso(`Zona «${cuerpo.nombre}» actualizada.`, 'exito');
    } else {
      await api.post('/configuracion/zonas-entrega', cuerpo);
      aviso(`Zona «${cuerpo.nombre}» creada.`, 'exito');
    }
    cerrarFormulario();
    await cargar();
  } catch (error) {
    // El servidor devuelve el campo exacto que falla; se pinta bajo su input
    // en vez de un aviso genérico que obligue a adivinar.
    if (error instanceof ErrorPeticion && error.campos) {
      for (const [campo, mensaje] of Object.entries(error.campos)) {
        const nodo = $(`e-z-${campo}`);
        if (nodo) nodo.textContent = mensaje;
      }
      aviso('Revise los campos marcados.', 'alerta');
    } else {
      aviso(error.message, 'error', 7000);
    }
  } finally {
    boton.disabled = false;
    boton.textContent = 'Guardar';
  }
});

$('btn-borrar').addEventListener('click', async () => {
  if (!estado.editando) return;

  const ok = await confirmar({
    titulo: 'Eliminar la zona',
    mensaje: `Se elimina «${estado.editando.nombre}». Si ya tiene pedidos en el histórico ` +
             'se desactivará en vez de borrarse, para no dejar esos pedidos sin explicación.',
    textoConfirmar: 'Eliminar',
    peligro: true,
  });
  if (!ok) return;

  try {
    const r = await api.borrar(`/configuracion/zonas-entrega/${estado.editando.id}`);
    aviso(r?.mensaje ?? 'Zona eliminada.', 'exito', 6000);
    cerrarFormulario();
    await cargar();
  } catch (error) {
    aviso(error.message, 'error', 7000);
  }
});

/* =====================================================================
   Comprobador de cobertura
   ===================================================================== */

async function probarCobertura() {
  const lat = Number($('p-lat').value);
  const lng = Number($('p-lng').value);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    reemplazar($('resultado-prueba'), el('div', { clase: 'vacio' },
      el('p', { texto: 'Indique una latitud y una longitud, o pulse en el mapa.' })));
    return;
  }

  try {
    const r = await api.post('/configuracion/zonas-entrega/previsualizar', {
      lat, lng, subtotal: Number($('p-subtotal').value || 0),
    });

    estado.marcadorPrueba?.remove();
    estado.marcadorPrueba = L.marker([lat, lng]).addTo(mapa)
      .bindTooltip(r.zona ? `Cubierto por ${r.zona.nombre}` : 'Sin cobertura', { permanent: false });

    pintarResultado(r);
  } catch (error) {
    aviso(error.message, 'error');
  }
}

function pintarResultado(r) {
  // El estado nunca se comunica solo con color: cada caso lleva icono y texto.
  const cabecera = r.cubierto
    ? el('div', { clase: 'prueba-veredicto prueba-veredicto--si' },
        el('span', { attrs: { 'aria-hidden': 'true' } }, '✓'),
        el('strong', { texto: 'Sí llegamos a esta dirección' }))
    : r.zona
      ? el('div', { clase: 'prueba-veredicto prueba-veredicto--parcial' },
          el('span', { attrs: { 'aria-hidden': 'true' } }, '⚠'),
          el('strong', { texto: 'Hay cobertura, pero falta pedido mínimo' }))
      : el('div', { clase: 'prueba-veredicto prueba-veredicto--no' },
          el('span', { attrs: { 'aria-hidden': 'true' } }, '✕'),
          el('strong', { texto: 'Sin cobertura en esta dirección' }));

  const detalle = r.zona
    ? el('dl', { clase: 'zona-tarjeta__datos' },
        el('dt', { texto: 'Zona' }),
        el('dd', { texto: r.zona.nombre }),
        el('dt', { texto: 'Distancia' }),
        el('dd', { clase: 'mono', texto: `${(r.zona.distanciaM / 1000).toFixed(2)} km del centro` }),
        el('dt', { texto: 'Envío' }),
        el('dd', { clase: 'mono', texto: formatearDinero(r.costoEnvio) }),
        el('dt', { texto: 'Mínimo' }),
        el('dd', { clase: 'mono', texto: formatearDinero(r.pedidoMinimo) }),
        Number(r.faltaParaMinimo) > 0 ? el('dt', { texto: 'Le falta' }) : null,
        Number(r.faltaParaMinimo) > 0
          ? el('dd', { clase: 'mono', texto: formatearDinero(r.faltaParaMinimo) })
          : null,
        el('dt', { texto: 'Entrega' }),
        el('dd', { clase: 'mono', texto: `~${r.tiempoEstimadoMin} min` })
      )
    : el('p', { clase: 'texto-tenue texto-sm' },
        'Ninguna zona activa alcanza ese punto. Amplíe el radio de una zona o cree una nueva.');

  // Por qué ganó esa y no otra: con círculos solapados es la pregunta
  // inmediata del administrador, y sin esta tabla habría que adivinarlo.
  const comparativa = r.distancias?.length
    ? el('div', { clase: 'tabla-contenedor' },
        el('table', { clase: 'tabla tabla--tarjetas' },
          el('caption', { clase: 'texto-sm texto-tenue' }, 'Distancia a cada zona activa'),
          el('thead', {}, el('tr', {},
            el('th', {}, 'Zona'), el('th', {}, 'Distancia'), el('th', {}, 'Radio'), el('th', {}, 'Cubre')
          )),
          el('tbody', {}, ...r.distancias
            .sort((a, b) => a.distanciaM - b.distanciaM)
            .map((d) => el('tr', { clase: d.gana ? 'zona-fila--gana' : '' },
              el('td', { attrs: { 'data-etiqueta': 'Zona' } },
                d.nombre, d.gana ? el('span', { clase: 'insignia insignia--exito' }, '★ gana') : null),
              el('td', { clase: 'mono', attrs: { 'data-etiqueta': 'Distancia' },
                         texto: `${(d.distanciaM / 1000).toFixed(2)} km` }),
              el('td', { clase: 'mono', attrs: { 'data-etiqueta': 'Radio' },
                         texto: `${(d.radioM / 1000).toFixed(2)} km` }),
              el('td', { attrs: { 'data-etiqueta': 'Cubre' } }, d.dentro ? '✓ Sí' : '✕ No')
            ))
          )
        ))
    : null;

  reemplazar($('resultado-prueba'), el('div', { clase: 'tarjeta prueba-resultado' },
    el('div', { clase: 'tarjeta__cuerpo' }, cabecera, detalle, comparativa)
  ));
}

$('btn-probar').addEventListener('click', probarCobertura);

/* =====================================================================
   Carga inicial
   ===================================================================== */

async function cargar() {
  const r = await api.get('/configuracion/zonas-entrega');
  estado.zonas = r.zonas;
  pintarLista();
  pintarMapa();
}

/**
 * Encuadra el mapa sobre la cobertura que ya existe.
 *
 * Se usan los BORDES de cada círculo y no sus centros: encuadrar por los
 * centros deja media zona fuera de la pantalla en cuanto una tiene un radio
 * grande, que es justo lo que se quiere ver.
 *
 * El recuadro de cada círculo se calcula con `L.latLng().toBounds()`, que
 * trabaja solo con geometría, y NO con `L.circle().getBounds()`. Ese último
 * necesita que el círculo esté añadido a un mapa —por dentro llama a
 * `this._map.layerPointToLatLng()`— y sobre un círculo suelto revienta con
 * «Cannot read properties of undefined». Aquí hacen falta los límites ANTES de
 * pintar nada, así que no hay mapa al que añadirlos.
 *
 * @returns {boolean} si había cobertura que encuadrar.
 */
function encuadrarEnCobertura() {
  const conCentro = estado.zonas.filter(
    (z) => Number.isFinite(Number(z.centroLat)) && Number.isFinite(Number(z.centroLng))
  );
  if (!conCentro.length) return false;

  const limites = L.latLngBounds(
    // toBounds recibe el LADO del cuadrado, no el radio: de ahí el ×2.
    conCentro.map((z) => L.latLng(z.centroLat, z.centroLng).toBounds(Number(z.radioM) * 2))
  );

  mapa.fitBounds(limites, { padding: [40, 40], maxZoom: 15 });

  // El centro operativo pasa a ser el de la cobertura. De ahí salen el botón
  // «centrar» y, sobre todo, el punto de partida de una zona NUEVA, que
  // abrirFormulario() toma de mapa.getCenter().
  const centro = limites.getCenter();
  estado.centroLocal = { lat: centro.lat, lng: centro.lng };
  return true;
}

try {
  await cargar();

  // DE DÓNDE SALE EL CENTRO DEL MAPA, en este orden:
  //
  //   1. La cobertura que ya existe.
  //   2. La ficha del restaurante.
  //   3. Las coordenadas de fábrica.
  //
  // La cobertura va primero porque es donde está el trabajo. Antes se
  // empezaba siempre por la ficha —y sin ficha, por unas coordenadas de
  // Bogotá escritas en el código—, así que quien ya tenía sus zonas
  // dibujadas abría la pantalla mirando a otra ciudad y tenía que buscarlas
  // a mano cada vez. Peor aún: una zona nueva nace en el centro de la vista,
  // de modo que el primer clic en «Nueva» la creaba en mitad de Bogotá en
  // lugar de junto a las demás.
  if (!encuadrarEnCobertura()) {
    try {
      const ficha = await api.get('/app/restaurante');
      if (Number.isFinite(Number(ficha.restaurante?.lat))) {
        estado.centroLocal = {
          lat: Number(ficha.restaurante.lat),
          lng: Number(ficha.restaurante.lng),
        };
        mapa.setView([estado.centroLocal.lat, estado.centroLocal.lng], 13);
      }
    } catch {
      // Sin ficha se queda el centro de fábrica. No es motivo para no abrir.
    }
  }

  if (!puedeGestionar) {
    $('btn-nueva').classList.add('oculto');
    aviso('Puede consultar las zonas, pero no modificarlas.', 'info', 6000);
  }

  // El mapa se crea antes de que su contenedor tenga el tamaño definitivo
  // (el shell inyecta cabecera y lateral después). Sin este recálculo,
  // Leaflet pinta las teselas sobre un lienzo del tamaño equivocado y quedan
  // huecos grises hasta que alguien mueve el mapa.
  setTimeout(() => mapa.invalidateSize(), 100);
} catch (error) {
  aviso(error.message, 'error', 8000);
}
