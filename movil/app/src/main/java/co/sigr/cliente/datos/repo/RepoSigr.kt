package co.sigr.cliente.datos.repo

import co.sigr.cliente.datos.local.SesionStore
import co.sigr.cliente.datos.red.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/**
 * Único punto de acceso a los datos.
 *
 * Las pantallas hablan solo con esta clase: no conocen Retrofit, ni el token,
 * ni los códigos HTTP. Eso permite que la lógica de sesión —guardar el token
 * al entrar, borrarlo al salir— viva en un sitio y no repartida por la interfaz.
 */
class RepoSigr(
    private val api: ApiSigr,
    private val sesion: SesionStore,
) {

    /** Token guardado. La navegación lo observa para decidir la pantalla inicial. */
    val token: Flow<String?> = sesion.token
    val nombreGuardado: Flow<String?> = sesion.nombre

    /* =================================================================
       Dirección del servidor

       Se guarda con la sesión pero NO se borra al cerrarla: dónde está el
       servidor no tiene nada que ver con quién está dentro.
       ================================================================= */

    suspend fun servidorGuardado(): String? = sesion.servidor.first()

    suspend fun guardarServidor(url: String) = sesion.guardarServidor(url)

    /* =================================================================
       Estado del servicio
       ================================================================= */

    /**
     * Se consulta al arrancar. Es el ÚNICO endpoint que responde aunque el
     * administrador haya apagado la aplicación, y por eso la app puede mostrar
     * la pantalla de mantenimiento con el mensaje real en lugar de un error de
     * red genérico.
     */
    suspend fun estado(): Resultado<EstadoApp> = llamar { api.estado() }

    /* =================================================================
       Cuenta
       ================================================================= */

    suspend fun registrar(
        nombreCompleto: String,
        correo: String,
        telefono: String,
        documento: String,
        password: String,
    ): Resultado<Cliente> {
        val r = llamar {
            api.registro(PeticionRegistro(nombreCompleto, correo, telefono, documento, password))
        }
        return guardarSesionSi(r)
    }

    /** Acepta correo o cédula en el mismo campo: el servidor distingue por la forma. */
    suspend fun iniciarSesion(identificador: String, password: String): Resultado<Cliente> {
        val r = llamar { api.login(PeticionLogin(identificador, password)) }
        return guardarSesionSi(r)
    }

    private suspend fun guardarSesionSi(r: Resultado<RespuestaSesion>): Resultado<Cliente> =
        when (r) {
            is Resultado.Exito -> {
                sesion.guardar(
                    token = r.datos.token,
                    nombre = r.datos.cliente.nombre,
                    correo = r.datos.cliente.correo,
                    expiraEn = r.datos.expiraEn,
                )
                Resultado.Exito(r.datos.cliente)
            }
            is Resultado.Fallo -> r
            is Resultado.SinConexion -> r
        }

    /**
     * Cierra sesión.
     *
     * El token del dispositivo se manda al servidor para que lo dé de baja: si
     * no, el móvil seguiría recibiendo notificaciones de una cuenta cuya sesión
     * ya se cerró. La sesión local se limpia PASE LO QUE PASE con la petición —
     * si el servidor no responde, el usuario igualmente quiere salir.
     */
    suspend fun cerrarSesion(tokenFcm: String? = null) {
        llamar { api.logout(if (tokenFcm != null) mapOf("tokenFcm" to tokenFcm) else emptyMap()) }
        sesion.limpiar()
    }

    suspend fun perfil(): Resultado<Cliente> =
        llamar { api.perfil() }.mapear { it.cliente }

    suspend fun actualizarPerfil(
        nombreCompleto: String? = null,
        telefono: String? = null,
        aceptaPromociones: Boolean? = null,
    ): Resultado<Cliente> {
        val r = llamar { api.actualizarPerfil(PeticionPerfil(nombreCompleto, telefono, aceptaPromociones)) }
        if (r is Resultado.Exito) sesion.actualizarDatos(r.datos.cliente.nombre, r.datos.cliente.correo)
        return r.mapear { it.cliente }
    }

    suspend fun cambiarCorreo(correo: String, password: String): Resultado<Cliente> {
        val r = llamar { api.cambiarCorreo(PeticionCorreo(correo, password)) }
        if (r is Resultado.Exito) sesion.actualizarDatos(r.datos.cliente.nombre, r.datos.cliente.correo)
        return r.mapear { it.cliente }
    }

    /**
     * Cambia la contraseña. El servidor cierra TODAS las sesiones, incluida
     * esta, así que la local se limpia y la app vuelve al login: es lo que hace
     * útil el cambio de contraseña cuando alguien sospecha que le robaron la
     * cuenta.
     */
    suspend fun cambiarPassword(actual: String, nueva: String): Resultado<Unit> {
        val r = llamar { api.cambiarPassword(PeticionPassword(actual, nueva)) }
        if (r is Resultado.Exito) sesion.limpiar()
        return r.mapear { }
    }

    suspend fun subirFoto(archivo: File): Resultado<Cliente> {
        val cuerpo = archivo.asRequestBody("image/*".toMediaTypeOrNull())
        val parte = MultipartBody.Part.createFormData("imagen", archivo.name, cuerpo)
        return llamar { api.subirFoto(parte) }.mapear { it.cliente }
    }

    /** Da de baja la cuenta. El servidor anonimiza; aquí solo se limpia la sesión. */
    suspend fun eliminarCuenta(password: String): Resultado<Unit> {
        val r = llamar { api.eliminarCuenta(PeticionBaja(password)) }
        if (r is Resultado.Exito) sesion.limpiar()
        return r.mapear { }
    }

    /* =================================================================
       Direcciones
       ================================================================= */

    suspend fun direcciones(): Resultado<List<Direccion>> =
        llamar { api.direcciones() }.mapear { it.direcciones }

    suspend fun crearDireccion(d: PeticionDireccion): Resultado<Unit> =
        llamar { api.crearDireccion(d) }.mapear { }

    suspend fun actualizarDireccion(id: Int, d: PeticionDireccion): Resultado<Unit> =
        llamar { api.actualizarDireccion(id, d) }.mapear { }

    suspend fun borrarDireccion(id: Int): Resultado<Unit> =
        llamar { api.borrarDireccion(id) }.mapear { }

    /* =================================================================
       Restaurante y carta
       ================================================================= */

    suspend fun restaurante(): Resultado<Restaurante> =
        llamar { api.restaurante() }.mapear { it.restaurante }

    suspend fun menu(): Resultado<RespuestaMenu> = llamar { api.menu() }

    suspend fun plato(id: Int): Resultado<ProductoDetalle> =
        llamar { api.plato(id) }.mapear { it.producto }

    suspend fun zonasEntrega(): Resultado<List<ZonaEntrega>> =
        llamar { api.zonasEntrega() }.mapear { it.zonas }

    /**
     * Direccion escrita del punto donde esta el pin, o null.
     *
     * DEVUELVE null EN VEZ DE UN Resultado CON ERROR, a proposito. Quien llama
     * a esto esta rellenando una casilla por comodidad; si el servicio de mapas
     * no contesta, lo correcto es no tocar el campo y dejar que el cliente
     * escriba, no ensenarle un error por algo que no pidio.
     */
    suspend fun direccionDePunto(lat: Double, lng: Double): String? =
        llamar { api.direccionDePunto(lat, lng) }
            .datosONull()
            ?.takeIf { it.disponible }
            ?.direccion
            ?.takeIf { it.isNotBlank() }

    /** Formas de pago activas, con la llave a la que transferir. */
    suspend fun metodosPago(): Resultado<List<MetodoPago>> =
        llamar { api.metodosPago() }.mapear { it.metodos }

    suspend fun promociones(): Resultado<List<Promocion>> =
        llamar { api.promociones() }.mapear { it.promociones }

    /* =================================================================
       Reservas
       ================================================================= */

    suspend fun reservas(): Resultado<List<Reserva>> =
        llamar { api.reservas() }.mapear { it.reservas }

    suspend fun crearReserva(fechaHora: String, personas: Int, notas: String?): Resultado<Reserva> =
        llamar { api.crearReserva(PeticionReserva(fechaHora, personas, notas)) }.mapear { it.reserva }

    suspend fun cancelarReserva(id: Int): Resultado<Unit> =
        llamar { api.cancelarReserva(id) }.mapear { }

    /* =================================================================
       Domicilios
       ================================================================= */

    /**
     * Cotiza una entrega. Devuelve `Exito` incluso cuando NO hay cobertura:
     * el servidor responde 200 con `cubierto = false` y un motivo, porque "no
     * llegamos ahí" y "te falta pedido mínimo" son dos pantallas distintas.
     */
    suspend fun cotizar(lat: Double, lng: Double, subtotal: String): Resultado<Cotizacion> =
        llamar { api.cotizar(PeticionCotizar(lat, lng, subtotal)) }

    suspend fun pedidos(): Resultado<List<Pedido>> =
        llamar { api.pedidos() }.mapear { it.pedidos }

    suspend fun pedido(id: Int): Resultado<Pedido> =
        llamar { api.pedido(id) }.mapear { it.pedido }

    suspend fun crearPedido(p: PeticionPedido): Resultado<Pedido> =
        llamar { api.crearPedido(p) }.mapear { it.pedido }

    /**
     * Sube el comprobante de pago. Mismo pipeline que la foto de perfil: el
     * servidor valida los magic bytes, asi que un archivo que no sea una
     * imagen real se rechaza aunque tenga extension .png.
     */
    suspend fun subirComprobante(idPedido: Int, archivo: File): Resultado<RespuestaComprobante> {
        val cuerpo = archivo.asRequestBody("image/*".toMediaTypeOrNull())
        val parte = MultipartBody.Part.createFormData("imagen", archivo.name, cuerpo)
        return llamar { api.subirComprobante(idPedido, parte) }
    }

    suspend fun cancelarPedido(id: Int): Resultado<Unit> =
        llamar { api.cancelarPedido(id) }.mapear { }

    /* =================================================================
       Notificaciones
       ================================================================= */

    suspend fun notificaciones(): Resultado<RespuestaNotificaciones> =
        llamar { api.notificaciones() }

    suspend fun marcarLeida(id: Long): Resultado<Unit> =
        llamar { api.marcarLeida(id) }.mapear { }

    suspend fun marcarTodasLeidas(): Resultado<Unit> =
        llamar { api.marcarTodasLeidas() }.mapear { }

    /**
     * Borra un aviso.
     *
     * Devuelve Boolean y no Resultado porque quien llama —el gesto de deslizar—
     * ya quitó la tarjeta de la pantalla antes de esperar la respuesta. Lo único
     * que necesita saber después es si hay que devolverla a su sitio.
     */
    suspend fun borrarNotificacion(id: Long): Boolean =
        llamar { api.borrarNotificacion(id) } is Resultado.Exito

    suspend fun borrarNotificacionesLeidas(): Resultado<Unit> =
        llamar { api.borrarNotificacionesLeidas() }.mapear { }

    /**
     * Registra el token de notificaciones.
     *
     * Falla en silencio a propósito: que el push no se registre no debe
     * molestar al cliente ni bloquear nada. Los avisos siguen llegando a la
     * bandeja de la aplicación, que es la vía fiable.
     */
    suspend fun registrarDispositivo(token: String, modelo: String?) {
        llamar { api.registrarDispositivo(PeticionDispositivo(token, "android", modelo)) }
    }

    suspend fun borrarDispositivo(token: String) {
        llamar { api.borrarDispositivo(token) }
    }
}

/** Transforma el contenido de un `Exito` conservando los casos de error. */
private inline fun <T, R> Resultado<T>.mapear(bloque: (T) -> R): Resultado<R> = when (this) {
    is Resultado.Exito -> Resultado.Exito(bloque(datos))
    is Resultado.Fallo -> this
    is Resultado.SinConexion -> this
}
