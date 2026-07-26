/**
 * Estructura comun del backoffice: header, sidebar y guardia de sesion.
 *
 * FSD 4: "<header> fijo (logo, usuario, reloj) + <aside> sidebar de navegacion
 * colapsable + <main> contenido".
 * FSD 5.1: "sesion iniciada con menu filtrado por permisos" -- el menu solo
 * muestra lo que el usuario puede abrir. Ojo: esconder una opcion NO es
 * seguridad (la API revalida igual, CA-10); es claridad para el usuario.
 */
import { cargarSesionActual, api, alPerderSesion } from '/comun/api.js';
import { el, reemplazar, aviso } from '/comun/ui.js';

/**
 * Menu del backoffice. Cada entrada declara el permiso que la habilita.
 * Las vistas de fases posteriores quedan marcadas como pendientes.
 */
const MENU = [
  {
    grupo: 'Operación',
    items: [
      { texto: 'Dashboard', icono: '📊', href: '/admin/', permiso: 'dashboard.ver' },
    ],
  },
  {
    grupo: 'Configuración',
    items: [
      { texto: 'Salón', icono: '🪑', href: '/admin/salon.html', permiso: 'salon.ver' },
      { texto: 'Menú y precios', icono: '🍽', href: '/admin/menu.html', permiso: 'catalogo.ver' },
      { texto: 'Recetas', icono: '📋', href: '/admin/recetas.html', permiso: 'catalogo.ver' },
    ],
  },
  {
    grupo: 'Seguridad',
    items: [
      { texto: 'Usuarios', icono: '👤', href: '/admin/usuarios.html', permiso: 'seguridad.usuarios.ver' },
      { texto: 'Roles y permisos', icono: '🔑', href: '/admin/permisos.html', permiso: 'seguridad.roles.ver' },
    ],
  },
  {
    grupo: 'Inteligencia',
    items: [
      { texto: 'Inventario', icono: '📦', href: '/admin/inventario.html', permiso: 'inventario.ver' },
      { texto: 'Auditoría', icono: '🛡', href: '/admin/auditoria.html', permiso: 'auditoria.ver' },
      { texto: 'Reportes', icono: '📈', href: '/admin/reportes.html', permiso: 'reportes.ver' },
    ],
  },
];

/** Sesion activa, disponible para las vistas que importen este modulo. */
export let sesion = null;

export function tienePermiso(codigo) {
  return Boolean(sesion?.permisos.includes(codigo));
}

function construirCabecera() {
  const reloj = el('span', { clase: 'cabecera__reloj', attrs: { 'aria-live': 'off' } });

  const actualizarReloj = () => {
    reloj.textContent = new Date().toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  };
  actualizarReloj();
  setInterval(actualizarReloj, 1000);

  const btnAlternar = el('button', {
    clase: 'btn btn--secundario cabecera__alternar',
    attrs: { type: 'button', 'aria-label': 'Mostrar u ocultar el menú', 'aria-expanded': 'false' },
    on: {
      click: () => {
        const lateral = document.querySelector('.lateral');
        const abierta = lateral.classList.toggle('lateral--abierta');
        // En escritorio el sidebar no se oculta, se colapsa a iconos.
        if (window.innerWidth > 768) lateral.classList.toggle('lateral--colapsada');
        btnAlternar.setAttribute('aria-expanded', String(abierta));
      },
    },
  }, '☰');

  return el('header', { clase: 'cabecera' },
    btnAlternar,
    el('div', { clase: 'cabecera__marca' },
      el('span', { attrs: { 'aria-hidden': 'true' } }, '🍽'),
      el('span', {}, 'SIGR')
    ),
    el('div', { clase: 'crece' }),
    reloj,
    el('div', { clase: 'cabecera__usuario' },
      el('span', { texto: sesion.usuario.nombre }),
      el('span', { clase: 'cabecera__rol', texto: sesion.usuario.rol })
    ),
    el('button', {
      clase: 'btn btn--secundario btn--sm',
      attrs: { type: 'button' },
      on: { click: cerrarSesion },
    }, 'Salir')
  );
}

function construirLateral() {
  const rutaActual = window.location.pathname;
  const nav = el('nav', { clase: 'nav', attrs: { 'aria-label': 'Navegación principal' } });

  for (const grupo of MENU) {
    // Solo se pintan los grupos con al menos una opcion permitida.
    const visibles = grupo.items.filter((i) => tienePermiso(i.permiso));
    if (!visibles.length) continue;

    nav.append(el('div', { clase: 'nav__grupo-titulo', texto: grupo.grupo }));

    for (const item of visibles) {
      const activo = rutaActual === item.href ||
        (item.href !== '/admin/' && rutaActual.startsWith(item.href));

      nav.append(el('a', {
        clase: `nav__enlace ${activo ? 'nav__enlace--activo' : ''}`,
        attrs: {
          href: item.pendiente ? '#' : item.href,
          'aria-current': activo ? 'page' : false,
          'aria-disabled': item.pendiente ? 'true' : false,
          title: item.pendiente ? 'Disponible en una fase posterior' : false,
        },
        on: item.pendiente
          ? { click: (e) => { e.preventDefault(); aviso('Esa vista aún no está construida. Llega en una fase posterior.', 'info'); } }
          : {},
      },
        el('span', { clase: 'nav__icono', attrs: { 'aria-hidden': 'true' } }, item.icono),
        el('span', { clase: 'nav__texto' }, item.texto),
        item.pendiente
          ? el('span', { clase: 'insignia insignia--neutra', texto: 'pronto' })
          : null
      ));
    }
  }

  return el('aside', { clase: 'lateral' }, nav);
}

async function cerrarSesion() {
  try {
    await api.post('/auth/logout');
  } catch { /* aunque falle, se sale igual */ }
  window.location.href = '/';
}

/**
 * Prepara la pagina: verifica sesion, monta header y sidebar.
 * Devuelve la sesion, o redirige al login si no hay ninguna.
 *
 * @param {string} [permisoRequerido]  Si se indica y falta, se avisa y se sale.
 */
export async function iniciarShell(permisoRequerido) {
  sesion = await cargarSesionActual();

  if (!sesion) {
    window.location.href = '/';
    return null;
  }

  // Si la sesion cae mientras se navega, se vuelve al login sin dejar la
  // pantalla a medias.
  alPerderSesion(() => {
    window.location.href = '/';
  });

  if (permisoRequerido && !tienePermiso(permisoRequerido)) {
    document.body.prepend(el('div', { clase: 'vacio' },
      el('h1', { texto: 'Sin acceso' }),
      el('p', { texto: 'No tiene permiso para ver esta pantalla.' }),
      el('a', { clase: 'btn btn--primario', attrs: { href: '/admin/usuarios.html' } }, 'Volver')
    ));
    return null;
  }

  document.body.classList.add('admin');
  document.body.prepend(construirCabecera(), construirLateral());

  return sesion;
}

export { reemplazar };
