/**
 * Cliente del canal de tiempo real.
 *
 * FSD 2.2: "El estado en tiempo real (mesas, comandas) se sincroniza mediante
 * WebSocket o Server-Sent Events con RECONEXION AUTOMATICA y FALLBACK A
 * POLLING CADA 10 s."
 * FSD 6.2: "la PWA muestra estado de conexion y reintenta envios en cola".
 *
 * El fallback no es un adorno: el Wi-Fi de un restaurante se cae, y cuando eso
 * pasa el mesero tiene que poder seguir trabajando. Si el socket no levanta, se
 * pasa a preguntar cada 10 s; cuando vuelve, se corta el polling solo.
 */

const RECONEXION_BASE_MS = 1000;
const RECONEXION_MAX_MS = 15000;
const POLLING_MS = 10000;

export class CanalTiempoReal {
  /**
   * @param {object} opciones
   * @param {'cocina'|'barra'} [opciones.estacion]  Filtra el KDS por estación.
   * @param {Function} [opciones.alRefrescar]  Se llama en cada tick del polling
   *   y al reconectar: debe recargar el estado desde la API.
   */
  constructor({ estacion = null, alRefrescar = null } = {}) {
    this.estacion = estacion;
    this.alRefrescar = alRefrescar;
    this.ws = null;
    this.manejadores = new Map();
    this.intentos = 0;
    this.cerradoAdrede = false;
    this.temporizadorPolling = null;
    this.temporizadorReconexion = null;
    this.estado = 'desconectado';
    this.alCambiarEstado = null;
    this._despertadores = [];
  }

  /**
   * Vuelta a la vida: pantalla desbloqueada o red recuperada.
   *
   * Un mesero deja la tablet en la barra, se apaga la pantalla y el navegador
   * congela los temporizadores; el socket muere sin avisar. Al volver, la
   * reconexion programada podia tardar hasta 15 s en dispararse y durante ese
   * rato la pantalla mostraba mesas de hace media hora como si fueran de ahora.
   *
   * Aqui se corta por lo sano: en cuanto la pestana vuelve a estar visible o el
   * navegador recupera la red, se reconecta YA y se recarga el estado. Es
   * gratis (no hay peticiones mientras nadie mira) y elimina el caso en el que
   * el usuario ve datos viejos sin saberlo.
   */
  _montarDespertadores() {
    const despertar = () => {
      if (this.cerradoAdrede) return;
      if (document.visibilityState === 'hidden') return;

      if (this.ws?.readyState === WebSocket.OPEN) {
        // El socket sobrevivio: no hace falta reconectar, pero pudo perderse
        // algun evento mientras la pestana estaba dormida.
        this.alRefrescar?.();
        return;
      }

      // Se cancela la espera creciente pendiente: el usuario esta delante y
      // esperando, no es momento de respetar un backoff de 15 s.
      clearTimeout(this.temporizadorReconexion);
      this.temporizadorReconexion = null;
      this.intentos = 0;
      this.conectar();
    };

    const visibilidad = () => { if (document.visibilityState === 'visible') despertar(); };
    document.addEventListener('visibilitychange', visibilidad);
    window.addEventListener('online', despertar);
    window.addEventListener('focus', visibilidad);

    this._despertadores = [
      () => document.removeEventListener('visibilitychange', visibilidad),
      () => window.removeEventListener('online', despertar),
      () => window.removeEventListener('focus', visibilidad),
    ];
  }

  /** Suscribe un manejador a un tipo de evento. */
  on(tipo, manejador) {
    if (!this.manejadores.has(tipo)) this.manejadores.set(tipo, []);
    this.manejadores.get(tipo).push(manejador);
    return this;
  }

  _emitir(tipo, datos) {
    for (const m of this.manejadores.get(tipo) ?? []) {
      try {
        m(datos);
      } catch (e) {
        // Un manejador que revienta no debe tumbar el canal entero.
        console.error(`[ws] fallo en el manejador de "${tipo}":`, e);
      }
    }
  }

  _fijarEstado(nuevo) {
    if (this.estado === nuevo) return;
    this.estado = nuevo;
    this.alCambiarEstado?.(nuevo);
  }

  conectar() {
    this.cerradoAdrede = false;
    // Se montan una sola vez, en la primera conexión: reconectar no debe ir
    // acumulando escuchadores duplicados sobre document y window.
    if (!this._despertadores.length) this._montarDespertadores();

    const protocolo = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocolo}//${window.location.host}/realtime`);
    if (this.estacion) url.searchParams.set('estacion', this.estacion);

    try {
      this.ws = new WebSocket(url);
    } catch {
      this._activarPolling();
      this._programarReconexion();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.intentos = 0;
      this._fijarEstado('conectado');
      // Con el socket vivo, preguntar cada 10 s sobra.
      this._desactivarPolling();
      // Al reconectar puede haberse perdido algún evento: se recarga todo.
      this.alRefrescar?.();
    });

    this.ws.addEventListener('message', (evento) => {
      let mensaje;
      try {
        mensaje = JSON.parse(evento.data);
      } catch {
        return;
      }
      this._emitir(mensaje.tipo, mensaje.datos);
      this._emitir('*', mensaje);
    });

    this.ws.addEventListener('close', (evento) => {
      this._fijarEstado('desconectado');
      if (this.cerradoAdrede) return;

      // 1008/4401: el servidor rechazó la sesión. Reintentar no arregla nada.
      if (evento.code === 1008) {
        this._emitir('sesion.invalida', {});
        return;
      }

      this._activarPolling();
      this._programarReconexion();
    });

    this.ws.addEventListener('error', () => {
      // El evento 'close' llega siempre detrás: se deja que él decida.
      this._fijarEstado('reconectando');
    });
  }

  /**
   * Reconexión con espera creciente: reintentar cada 100 ms contra un servidor
   * caído solo consume batería del dispositivo del mesero.
   */
  _programarReconexion() {
    if (this.temporizadorReconexion || this.cerradoAdrede) return;

    this.intentos++;
    const espera = Math.min(RECONEXION_BASE_MS * 2 ** (this.intentos - 1), RECONEXION_MAX_MS);
    this._fijarEstado('reconectando');

    this.temporizadorReconexion = setTimeout(() => {
      this.temporizadorReconexion = null;
      this.conectar();
    }, espera);
  }

  /** Fallback del FSD 2.2: sin socket, se pregunta cada 10 s. */
  _activarPolling() {
    if (this.temporizadorPolling || !this.alRefrescar) return;
    this.temporizadorPolling = setInterval(() => this.alRefrescar(), POLLING_MS);
  }

  _desactivarPolling() {
    if (!this.temporizadorPolling) return;
    clearInterval(this.temporizadorPolling);
    this.temporizadorPolling = null;
  }

  cerrar() {
    this.cerradoAdrede = true;
    this._desactivarPolling();
    clearTimeout(this.temporizadorReconexion);
    this.temporizadorReconexion = null;
    for (const quitar of this._despertadores) quitar();
    this._despertadores = [];
    this.ws?.close();
    this._fijarEstado('desconectado');
  }
}

/**
 * Indicador de conexión. FSD 6.2: "la PWA muestra estado de conexión".
 * El mesero necesita saber si lo que ve está vivo o congelado.
 */
export function crearIndicadorConexion(canal) {
  const nodo = document.createElement('div');
  nodo.className = 'conexion';
  nodo.setAttribute('role', 'status');
  nodo.setAttribute('aria-live', 'polite');

  const pintar = (estado) => {
    nodo.className = `conexion conexion--${estado}`;
    // Texto además del color: 6.4 prohíbe comunicar solo por color.
    const etiquetas = {
      conectado: '● En vivo',
      reconectando: '◐ Reconectando…',
      desconectado: '○ Sin conexión',
    };
    nodo.textContent = etiquetas[estado] ?? estado;
  };

  canal.alCambiarEstado = pintar;
  pintar(canal.estado);
  return nodo;
}
