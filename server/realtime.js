/**
 * Canal de tiempo real.  WS /realtime
 *
 * FSD 2.2: "El estado en tiempo real (mesas, comandas) se sincroniza mediante
 * WebSocket o Server-Sent Events con reconexion automatica y fallback a
 * polling cada 10 s."
 * FSD 8: eventos orden.creada, linea.estado, producto.agotado, mesa.estado,
 * precuenta.solicitada.
 *
 * De esto dependen CA-01 (la comanda llega al KDS en < 1 s) y CA-02 (un plato
 * agotado desaparece de todos los comanderos en < 1 s).
 *
 * AUTENTICACION
 * El handshake reutiliza la cookie de sesion: un WebSocket la envia igual que
 * cualquier peticion HTTP. No se acepta el token por querystring porque las
 * URLs acaban en logs y en el historial del navegador.
 */
import { WebSocketServer } from 'ws';
import { consultar, consultarUno } from './db.js';
import { COOKIE_SESION } from './middleware/auth.js';

/** Eventos que publica el sistema (FSD 8). */
export const EVENTOS = {
  ORDEN_CREADA: 'orden.creada',
  ORDEN_ENVIADA: 'orden.enviada',
  // Cambios en el contenido de una comanda que todavia no ha ido a cocina:
  // lineas anadidas o quitadas y reordenacion de tiempos de salida. Sin esto,
  // dos meseros sobre la misma mesa (o el mismo mesero en tablet y movil) se
  // pisan sin enterarse.
  ORDEN_ACTUALIZADA: 'orden.actualizada',
  LINEA_ESTADO: 'linea.estado',
  PRODUCTO_AGOTADO: 'producto.agotado',
  MESA_ESTADO: 'mesa.estado',
  PRECUENTA_SOLICITADA: 'precuenta.solicitada',
  SALON_ACTUALIZADO: 'salon.actualizado',
  STOCK_CRITICO: 'stock.critico',
};

/** Clientes conectados: Set de { ws, usuario, permisos }. */
const clientes = new Set();

/** Lee una cookie de la cabecera cruda del handshake. */
function leerCookie(cabecera, nombre) {
  if (!cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Valida la sesion del handshake y devuelve el usuario con sus permisos.
 * Se releen de la base igual que en HTTP (FSD 5.1: revalidacion por request).
 */
async function autenticarConexion(peticion) {
  const idSesion = leerCookie(peticion.headers.cookie, COOKIE_SESION);
  if (!idSesion) return null;

  const fila = await consultarUno(
    `SELECT u.id_usuario, u.nombre_completo, u.activo, r.id_rol, r.nombre AS rol
       FROM sesion s
       JOIN usuario u ON u.id_usuario = s.id_usuario
       JOIN rol r     ON r.id_rol = u.id_rol
      WHERE s.id_sesion = ? AND s.expira_en > NOW()`,
    [idSesion]
  );
  if (!fila || !fila.activo) return null;

  const permisos = await consultar(
    `SELECT p.codigo FROM rol_permiso rp
       JOIN permiso p ON p.id_permiso = rp.id_permiso
      WHERE rp.id_rol = ?`,
    [fila.id_rol]
  );

  return {
    id: fila.id_usuario,
    nombre: fila.nombre_completo,
    rol: fila.rol,
    permisos: new Set(permisos.map((p) => p.codigo)),
  };
}

/**
 * Publica un evento a los clientes interesados.
 *
 * @param {string} tipo   Uno de EVENTOS.
 * @param {object} datos  Cuerpo del evento.
 * @param {object} [opciones]
 * @param {string} [opciones.permiso]  Solo a quien tenga este permiso.
 * @param {string[]} [opciones.permisos] Solo a quien tenga ALGUNO de estos. Para
 *   un hecho que interesa a dos publicos distintos -- anular una linea le importa
 *   a cocina (kds.ver) y a la sala (salon.ver) -- sin publicarlo dos veces, que
 *   haria refrescar por duplicado a quien tenga los dos permisos.
 * @param {string} [opciones.estacion] Solo al KDS de esta estacion ('cocina'|'barra').
 * @param {number} [opciones.idMesero] Solo a este mesero (y a quien vea todas las mesas).
 */
export function publicar(tipo, datos, opciones = {}) {
  const mensaje = JSON.stringify({ tipo, datos, en: Date.now() });
  let enviados = 0;

  for (const cliente of clientes) {
    if (cliente.ws.readyState !== cliente.ws.OPEN) continue;

    // Nunca se difunde a quien no tendria permiso para consultarlo por HTTP:
    // el canal de tiempo real no puede ser una puerta trasera a los datos.
    if (opciones.permiso && !cliente.usuario.permisos.has(opciones.permiso)) continue;
    if (opciones.permisos && !opciones.permisos.some((p) => cliente.usuario.permisos.has(p))) continue;

    // Cada estacion del KDS ve solo lo suyo (FSD 5.6).
    if (opciones.estacion && cliente.estacion && cliente.estacion !== opciones.estacion) continue;

    // Un mesero solo recibe lo de sus mesas, salvo que pueda ver todas.
    if (opciones.idMesero &&
        cliente.usuario.id !== opciones.idMesero &&
        !cliente.usuario.permisos.has('ordenes.ver_todas')) continue;

    cliente.ws.send(mensaje);
    enviados++;
  }

  return enviados;
}

export function totalConectados() {
  return clientes.size;
}

/**
 * Monta el servidor WebSocket sobre el servidor HTTP existente.
 * Se comparte el puerto: un despliegue detras de un proxy inverso solo tiene
 * que reenviar una ruta, no abrir un segundo puerto.
 */
export function montarRealtime(servidorHttp) {
  const wss = new WebSocketServer({ noServer: true });

  servidorHttp.on('upgrade', async (peticion, socket, cabeza) => {
    if (!peticion.url?.startsWith('/realtime')) {
      socket.destroy();
      return;
    }

    let usuario;
    try {
      usuario = await autenticarConexion(peticion);
    } catch (error) {
      console.error('[realtime] fallo al autenticar el handshake:', error.message);
      socket.destroy();
      return;
    }

    if (!usuario) {
      // 401 explicito: el cliente distingue "sin sesion" de "servidor caido" y
      // no reintenta en bucle contra una sesion muerta.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(peticion, socket, cabeza, (ws) => {
      const url = new URL(peticion.url, 'http://localhost');
      const estacion = url.searchParams.get('estacion');

      const cliente = {
        ws,
        usuario,
        // 'cocina' | 'barra' | null. Solo filtra el KDS.
        estacion: ['cocina', 'barra'].includes(estacion) ? estacion : null,
        vivo: true,
      };
      clientes.add(cliente);

      ws.send(JSON.stringify({
        tipo: 'conectado',
        datos: { usuario: usuario.nombre, rol: usuario.rol, estacion: cliente.estacion },
        en: Date.now(),
      }));

      ws.on('pong', () => { cliente.vivo = true; });
      ws.on('close', () => clientes.delete(cliente));
      ws.on('error', () => clientes.delete(cliente));
    });
  });

  // Un cable de red desconectado no cierra el socket: sin este latido, los
  // clientes muertos se acumularian y publicar() escribiria al vacio.
  const latido = setInterval(() => {
    for (const cliente of clientes) {
      if (!cliente.vivo) {
        cliente.ws.terminate();
        clientes.delete(cliente);
        continue;
      }
      cliente.vivo = false;
      cliente.ws.ping();
    }
  }, 30000);
  latido.unref();

  return {
    cerrar: () => {
      clearInterval(latido);
      for (const c of clientes) c.ws.close();
      clientes.clear();
      wss.close();
    },
  };
}
