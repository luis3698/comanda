package co.sigr.cliente.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import co.sigr.cliente.datos.red.*
import co.sigr.cliente.datos.red.ClienteHttp
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.datos.repo.esSesionCaducada
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.math.BigDecimal

/**
 * Una línea del carrito, viviendo solo en memoria.
 *
 * EL CARRITO NO SE GUARDA EN DISCO a propósito. Los precios se congelan en el
 * servidor cuando se crea el pedido, no cuando se toca "añadir": un carrito
 * recuperado tres días después mostraría precios viejos y platos que quizá ya
 * no están en la carta. Perderlo al cerrar la app es preferible a enseñar un
 * total que no se va a respetar.
 */
data class LineaCarrito(
    val idProducto: Int,
    val nombre: String,
    val urlImagen: String?,
    val precioUnitario: String,
    val cantidad: Int,
    val notas: String? = null,
    val modificadores: List<OpcionModificador> = emptyList(),
) {
    /** Precio de una unidad con sus extras. Informativo: el total lo hace el servidor. */
    val subtotalLinea: BigDecimal
        get() {
            val extras = modificadores.fold(BigDecimal.ZERO) { acc, m -> acc + Formato.aDecimal(m.precioExtra) }
            return (Formato.aDecimal(precioUnitario) + extras) * BigDecimal(cantidad)
        }

    /** Clave para agrupar líneas idénticas: mismo plato, mismos extras, misma nota. */
    val clave: String
        get() = "$idProducto|${modificadores.map { it.id }.sorted().joinToString(",")}|${notas.orEmpty()}"
}

/** Pantalla que corresponde según el estado del servicio y de la sesión. */
enum class Arranque { COMPROBANDO, MANTENIMIENTO, SIN_SESION, LISTO }

/**
 * Convierte lo que se escriba en el campo de dirección en una URL usable.
 *
 * Se acepta "192.168.1.42", "192.168.1.42:3000" o la URL completa: exigir que
 * se escriba "http://" y la barra final es una forma segura de que la dirección
 * salga mal y de que el fallo se atribuya a la red. El puerto 3000 se asume
 * porque es el del proyecto.
 *
 * Está fuera del ViewModel y es `internal` para poder probarla en la JVM: es
 * manipulación de cadenas, y el error de un carácter es justo el que no se ve
 * mirando la pantalla. `EstadoAppTest` cubre los casos.
 *
 * @return null si la entrada está vacía.
 */
internal fun normalizarDireccion(entrada: String): String? {
    var v = entrada.trim()
    if (v.isEmpty()) return null

    val esHttps = v.startsWith("https://")
    if (!v.startsWith("http://") && !esHttps) v = "http://$v"
    v = v.trimEnd('/')

    // El 3000 se asume solo en http, que es el caso de desarrollo. Con https se
    // deja el 443 por defecto: añadirle el 3000 a un dominio bueno lo
    // convertiría en uno que no responde.
    val sinEsquema = v.substringAfter("://")
    if (!esHttps && !sinEsquema.contains(':')) v = "$v:3000"

    return "$v/"
}

/**
 * Estado compartido de la aplicación: sesión, carrito y estado del servicio.
 *
 * Es un único ViewModel de ámbito de actividad en lugar de uno por pantalla.
 * Con un carrito que se llena en el menú, se revisa en el carrito y se envía
 * en el checkout, repartirlo obligaría a pasarlo por argumentos de navegación
 * o a duplicar la fuente de verdad.
 */
class EstadoAppVm(private val repo: RepoSigr) : ViewModel() {

    private val _arranque = MutableStateFlow(Arranque.COMPROBANDO)
    val arranque: StateFlow<Arranque> = _arranque.asStateFlow()

    private val _servicio = MutableStateFlow(EstadoApp())
    val servicio: StateFlow<EstadoApp> = _servicio.asStateFlow()

    private val _mensajeMantenimiento = MutableStateFlow<String?>(null)
    val mensajeMantenimiento: StateFlow<String?> = _mensajeMantenimiento.asStateFlow()

    /** Direccion del servidor en uso. Se muestra en la pantalla de conexion. */
    private val _servidorEnUso = MutableStateFlow(ClienteHttp.servidor)
    val servidorEnUso: StateFlow<String> = _servidorEnUso.asStateFlow()

    private val _cliente = MutableStateFlow<Cliente?>(null)
    val cliente: StateFlow<Cliente?> = _cliente.asStateFlow()

    private val _carrito = MutableStateFlow<List<LineaCarrito>>(emptyList())
    val carrito: StateFlow<List<LineaCarrito>> = _carrito.asStateFlow()

    private val _noLeidas = MutableStateFlow(0)
    val noLeidas: StateFlow<Int> = _noLeidas.asStateFlow()

    init { comprobarArranque() }

    /**
     * Decide qué pantalla mostrar al abrir.
     *
     * El orden importa: primero se pregunta si el servicio está encendido y
     * solo después si hay sesión. Si la aplicación está apagada, mandar al
     * cliente al login sería cruel: entraría bien y luego todo le respondería
     * 503 sin explicación.
     */
    /**
     * Busca un servidor que responda antes de dar por perdida la conexión.
     *
     * EN PRODUCCIÓN NO HACE NADA: devuelve true sin probar. La dirección viene
     * fijada en la compilación y el comensal se limita a abrir la app; no se le
     * pide una IP ni se le hace esperar a que se sondeen candidatos que en su
     * teléfono no existen. Si el servidor está caído, lo dirá la llamada a
     * `/estado` que viene justo después, con su mensaje real.
     *
     * En depuración prueba en orden, y sin pedir nada:
     *
     *   1. La dirección que ya funcionó la última vez (instantáneo).
     *   2. `10.0.2.2` — el emulador.
     *   3. `localhost` — el móvil por cable con `adb reverse tcp:3000 tcp:3000`.
     *
     * La primera que conteste se fija y se guarda, así los arranques siguientes
     * son inmediatos. Esto es lo que hace que ya no haya que editar
     * `gradle.properties` ni recompilar para cambiar de emulador a móvil.
     *
     * @return true si encontró uno.
     */
    private suspend fun buscarServidor(): Boolean {
        if (!ClienteHttp.configurable) return true

        val guardado = repo.servidorGuardado()
        val aProbar = buildList {
            if (!guardado.isNullOrBlank()) add(guardado)
            addAll(ClienteHttp.CANDIDATOS)
        }.distinct()

        for (url in aProbar) {
            if (ClienteHttp.responde(url)) {
                usarServidor(url)
                return true
            }
        }
        return false
    }

    private suspend fun usarServidor(url: String) {
        ClienteHttp.servidor = url
        repo.guardarServidor(url)
        _servidorEnUso.value = ClienteHttp.servidor
    }

    fun comprobarArranque() {
        viewModelScope.launch {
            _arranque.value = Arranque.COMPROBANDO

            // Si no hay ningún servidor alcanzable no tiene sentido seguir: se
            // muestra la pantalla que permite escribir la dirección.
            if (!buscarServidor()) {
                // Mensaje de desarrollo: solo se llega aquí en depuración, y el
                // motivo casi siempre es el puente del cable sin abrir.
                _mensajeMantenimiento.value =
                    "No encontramos el servidor. Si está probando con el móvil por " +
                    "cable, abra el puente desde el PC:\n\n" +
                    "adb reverse tcp:3000 tcp:3000"
                _arranque.value = Arranque.MANTENIMIENTO
                return@launch
            }

            when (val r = repo.estado()) {
                is Resultado.Exito -> {
                    _servicio.value = r.datos
                    if (!r.datos.activa) {
                        _mensajeMantenimiento.value = r.datos.mensaje
                            ?: "El servicio no está disponible en este momento."
                        _arranque.value = Arranque.MANTENIMIENTO
                        return@launch
                    }
                }
                is Resultado.SinConexion -> {
                    _mensajeMantenimiento.value = r.mensaje
                    _arranque.value = Arranque.MANTENIMIENTO
                    return@launch
                }
                is Resultado.Fallo -> {
                    _mensajeMantenimiento.value = r.mensaje
                    _arranque.value = Arranque.MANTENIMIENTO
                    return@launch
                }
            }

            // Sin token guardado no hay nada que validar: al login directo, sin
            // gastar una petición que va a fallar.
            if (repo.token.first() == null) {
                _arranque.value = Arranque.SIN_SESION
                return@launch
            }

            // Con token, se valida pidiendo el perfil.
            //
            // OJO AL CASO DE ERROR: sin red NO se manda al login. Es la
            // diferencia entre "su sesión ya no vale" y "ahora mismo no llego
            // al servidor", y confundirlas expulsa al cliente y le obliga a
            // reescribir su contraseña por un corte de un segundo — con la
            // sesión todavía válida en el servidor, además.
            //
            // Solo se cierra sesión cuando el servidor lo dice: un 401 significa
            // que el token murió (caducó, o el cliente cambió su contraseña, lo
            // que cierra todas las sesiones). En ese caso el interceptor de
            // ClienteHttp ya lo borró del almacén local.
            when (val p = repo.perfil()) {
                is Resultado.Exito -> {
                    _cliente.value = p.datos
                    _arranque.value = Arranque.LISTO
                    refrescarNoLeidas()
                }
                is Resultado.SinConexion -> {
                    _mensajeMantenimiento.value = p.mensaje
                    _arranque.value = Arranque.MANTENIMIENTO
                }
                is Resultado.Fallo ->
                    _arranque.value =
                        if (p.esSesionCaducada()) {
                            Arranque.SIN_SESION
                        } else {
                            _mensajeMantenimiento.value = p.mensaje
                            Arranque.MANTENIMIENTO
                        }
            }
        }
    }

    /**
     * Fija la direccion del servidor a mano y reintenta.
     *
     * Se COMPRUEBA antes de guardarla: si no responde, se dice y no se toca la
     * que estaba. Guardar una direccion muerta dejaria la app inservible hasta
     * borrar sus datos.
     *
     * @return null si fue bien, o el mensaje de error.
     */
    suspend fun fijarServidor(entrada: String): String? {
        val url = normalizarDireccion(entrada)
            ?: return "Escriba una direccion como 192.168.1.42:3000"

        _arranque.value = Arranque.COMPROBANDO
        if (!ClienteHttp.responde(url)) {
            _arranque.value = Arranque.MANTENIMIENTO
            return "No hay respuesta en $url. Revise la direccion, que el servidor este " +
                   "encendido y que el movil este en la misma red."
        }

        ClienteHttp.servidor = url
        repo.guardarServidor(url)
        _servidorEnUso.value = ClienteHttp.servidor
        comprobarArranque()
        return null
    }

    fun alIniciarSesion(c: Cliente) {
        _cliente.value = c
        _arranque.value = Arranque.LISTO
        refrescarNoLeidas()
    }

    fun actualizarCliente(c: Cliente) { _cliente.value = c }

    fun cerrarSesion(tokenFcm: String? = null) {
        viewModelScope.launch {
            repo.cerrarSesion(tokenFcm)
            _cliente.value = null
            _carrito.value = emptyList()
            _arranque.value = Arranque.SIN_SESION
        }
    }

    fun refrescarNoLeidas() {
        viewModelScope.launch {
            val r = repo.notificaciones()
            if (r is Resultado.Exito) _noLeidas.value = r.datos.noLeidas
        }
    }

    /* =================================================================
       Carrito
       ================================================================= */

    /**
     * Añade una línea. Si ya existe una idéntica —mismo plato, mismos extras y
     * la misma nota— se suma la cantidad en vez de crear otra fila: ver el
     * mismo plato repetido tres veces en el carrito es confuso.
     */
    fun agregarAlCarrito(linea: LineaCarrito) {
        val actual = _carrito.value.toMutableList()
        val i = actual.indexOfFirst { it.clave == linea.clave }
        if (i >= 0) {
            actual[i] = actual[i].copy(cantidad = actual[i].cantidad + linea.cantidad)
        } else {
            actual.add(linea)
        }
        _carrito.value = actual
    }

    fun cambiarCantidad(clave: String, cantidad: Int) {
        _carrito.value = if (cantidad <= 0) {
            _carrito.value.filterNot { it.clave == clave }
        } else {
            _carrito.value.map { if (it.clave == clave) it.copy(cantidad = cantidad) else it }
        }
    }

    fun quitarDelCarrito(clave: String) {
        _carrito.value = _carrito.value.filterNot { it.clave == clave }
    }

    fun vaciarCarrito() { _carrito.value = emptyList() }

    /** Subtotal orientativo. El que se cobra lo calcula el servidor (FSD 5.7). */
    val subtotalCarrito: BigDecimal
        get() = _carrito.value.fold(BigDecimal.ZERO) { acc, l -> acc + l.subtotalLinea }

    val unidadesCarrito: Int
        get() = _carrito.value.sumOf { it.cantidad }
}
