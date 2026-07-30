package co.sigr.cliente.datos.red

import okhttp3.MultipartBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Contrato con la API del cliente de SIGR.  /api/v1/app
 *
 * Refleja uno a uno `server/rutas/app.js`. Si cambia allí, cambia aquí — y por
 * eso el proyecto móvil vive en el mismo repositorio que el servidor: un solo
 * commit toca el endpoint y el código que lo consume, así que es imposible que
 * se desincronicen.
 *
 * NINGÚN MÉTODO RECIBE UN `idCliente`. El servidor lo saca siempre del token
 * Bearer, nunca de la petición. Si algún día aparece aquí un parámetro con el
 * id del cliente, es un fallo de seguridad: cualquiera podría leer los pedidos
 * de otra persona cambiando un número.
 *
 * Todo devuelve `Response<T>` en vez de `T` a secas para poder leer el código
 * HTTP: la app necesita distinguir un 401 (sesión caducada, hay que volver al
 * login) de un 503 (la aplicación está apagada, se muestra mantenimiento) de un
 * 422 (regla de negocio, se enseña el mensaje del servidor).
 */
interface ApiSigr {

    // --- Estado. El único endpoint que responde incluso con la app apagada ---

    @GET("api/v1/app/estado")
    suspend fun estado(): Response<EstadoApp>

    // --- Cuenta ---

    @POST("api/v1/app/registro")
    suspend fun registro(@Body cuerpo: PeticionRegistro): Response<RespuestaSesion>

    @POST("api/v1/app/auth/login")
    suspend fun login(@Body cuerpo: PeticionLogin): Response<RespuestaSesion>

    @POST("api/v1/app/auth/logout")
    suspend fun logout(@Body cuerpo: Map<String, String> = emptyMap()): Response<Unit>

    @GET("api/v1/app/perfil")
    suspend fun perfil(): Response<RespuestaCliente>

    @PUT("api/v1/app/perfil")
    suspend fun actualizarPerfil(@Body cuerpo: PeticionPerfil): Response<RespuestaCliente>

    @PUT("api/v1/app/perfil/correo")
    suspend fun cambiarCorreo(@Body cuerpo: PeticionCorreo): Response<RespuestaCliente>

    @PUT("api/v1/app/perfil/password")
    suspend fun cambiarPassword(@Body cuerpo: PeticionPassword): Response<Map<String, Any>>

    @Multipart
    @POST("api/v1/app/perfil/foto")
    suspend fun subirFoto(@Part imagen: MultipartBody.Part): Response<RespuestaCliente>

    /**
     * Da de baja la cuenta. El servidor ANONIMIZA en vez de borrar: conserva la
     * trazabilidad de lo ya facturado y deja libre la cédula para un
     * re-registro. Exige la contraseña actual.
     */
    @retrofit2.http.HTTP(method = "DELETE", path = "api/v1/app/perfil", hasBody = true)
    suspend fun eliminarCuenta(@Body cuerpo: PeticionBaja): Response<Map<String, Any>>

    // --- Direcciones ---

    @GET("api/v1/app/direcciones")
    suspend fun direcciones(): Response<RespuestaDirecciones>

    @POST("api/v1/app/direcciones")
    suspend fun crearDireccion(@Body cuerpo: PeticionDireccion): Response<Map<String, Any>>

    @PUT("api/v1/app/direcciones/{id}")
    suspend fun actualizarDireccion(
        @Path("id") id: Int,
        @Body cuerpo: PeticionDireccion,
    ): Response<Map<String, Any>>

    @DELETE("api/v1/app/direcciones/{id}")
    suspend fun borrarDireccion(@Path("id") id: Int): Response<Unit>

    // --- Información pública ---

    @GET("api/v1/app/restaurante")
    suspend fun restaurante(): Response<RespuestaRestaurante>

    @GET("api/v1/app/menu")
    suspend fun menu(): Response<RespuestaMenu>

    @GET("api/v1/app/menu/{id}")
    suspend fun plato(@Path("id") id: Int): Response<RespuestaProducto>

    @GET("api/v1/app/zonas-entrega")
    suspend fun zonasEntrega(): Response<RespuestaZonas>

    @GET("api/v1/app/metodos-pago")
    suspend fun metodosPago(): Response<RespuestaMetodos>

    @GET("api/v1/app/promociones")
    suspend fun promociones(): Response<RespuestaPromociones>

    // --- Reservas ---

    @GET("api/v1/app/reservas")
    suspend fun reservas(@Query("activas") soloActivas: Boolean? = null): Response<RespuestaReservas>

    @POST("api/v1/app/reservas")
    suspend fun crearReserva(@Body cuerpo: PeticionReserva): Response<RespuestaReserva>

    @POST("api/v1/app/reservas/{id}/cancelar")
    suspend fun cancelarReserva(@Path("id") id: Int): Response<Map<String, Any>>

    // --- Domicilios ---

    @POST("api/v1/app/domicilios/cotizar")
    suspend fun cotizar(@Body cuerpo: PeticionCotizar): Response<Cotizacion>

    @GET("api/v1/app/domicilios")
    suspend fun pedidos(@Query("activos") soloActivos: Boolean? = null): Response<RespuestaPedidos>

    @POST("api/v1/app/domicilios")
    suspend fun crearPedido(@Body cuerpo: PeticionPedido): Response<RespuestaPedido>

    @GET("api/v1/app/domicilios/{id}")
    suspend fun pedido(@Path("id") id: Int): Response<RespuestaPedido>

    /** Sube la captura de la transferencia. El pedido pasa a `por_verificar`. */
    @Multipart
    @POST("api/v1/app/domicilios/{id}/comprobante")
    suspend fun subirComprobante(
        @Path("id") id: Int,
        @Part imagen: MultipartBody.Part,
    ): Response<RespuestaComprobante>

    @POST("api/v1/app/domicilios/{id}/cancelar")
    suspend fun cancelarPedido(@Path("id") id: Int): Response<Map<String, Any>>

    // --- Notificaciones ---

    @GET("api/v1/app/notificaciones")
    suspend fun notificaciones(): Response<RespuestaNotificaciones>

    @POST("api/v1/app/notificaciones/{id}/leida")
    suspend fun marcarLeida(@Path("id") id: Long): Response<Map<String, Any>>

    @POST("api/v1/app/notificaciones/leidas")
    suspend fun marcarTodasLeidas(): Response<Map<String, Any>>

    // --- Dispositivos (push) ---

    @POST("api/v1/app/dispositivos")
    suspend fun registrarDispositivo(@Body cuerpo: PeticionDispositivo): Response<Map<String, Any>>

    @DELETE("api/v1/app/dispositivos/{token}")
    suspend fun borrarDispositivo(@Path("token") token: String): Response<Unit>
}
