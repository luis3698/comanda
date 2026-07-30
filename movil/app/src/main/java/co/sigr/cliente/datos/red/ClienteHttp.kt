package co.sigr.cliente.datos.red

import android.content.Context
import co.sigr.cliente.BuildConfig
import co.sigr.cliente.datos.local.SesionStore
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Construcción del cliente HTTP y de Retrofit.
 *
 * La URL del servidor sale de `BuildConfig.API_BASE_URL`, que a su vez viene
 * de `gradle.properties`. Nunca está escrita a mano en el código: es lo que
 * permite apuntar el mismo APK al emulador, a un PC de la red local o a
 * producción sin tocar Kotlin.
 */
object ClienteHttp {

    /**
     * Dirección del servidor EN USO, con la barra final.
     *
     * POR QUÉ ES UNA VARIABLE Y NO UNA CONSTANTE
     * Antes la URL se incrustaba en la compilación (`BuildConfig.API_BASE_URL`)
     * y cambiarla obligaba a editar `gradle.properties` y recompilar el APK.
     * En la práctica era la causa número uno de "no hay conexión con el
     * restaurante": basta con que el router cambie la IP del PC para que la app
     * deje de funcionar, y arreglarlo exigía un ciclo entero de compilación.
     *
     * Ahora se puede fijar en tiempo de ejecución —la app la detecta sola, y si
     * no, se escribe en su propia pantalla— y se guarda en el DataStore. El
     * valor de `BuildConfig` queda solo como punto de partida.
     *
     * `@Volatile` porque la escribe el hilo de la interfaz y la leen los hilos
     * de red de OkHttp.
     */
    @Volatile
    var servidor: String = BuildConfig.API_BASE_URL
        set(valor) {
            // La barra final es obligatoria para Retrofit y para construir las
            // URLs de imágenes y teselas. Se normaliza aquí una sola vez en vez
            // de confiar en que todos los sitios que la fijan se acuerden.
            field = if (valor.endsWith('/')) valor else "$valor/"
        }

    /**
     * ¿Se puede cambiar la dirección del servidor desde la propia app?
     *
     * SOLO EN DEPURACIÓN, y esto es deliberado.
     *
     * En producción el cliente que se descarga la app NO tiene por qué saber
     * dónde está el servidor del restaurante, ni preguntárselo a nadie: la
     * dirección viene fijada en `API_BASE_URL_RELEASE` (un dominio con HTTPS) y
     * la app se conecta y punto. Un campo de "escriba la IP" en una app
     * publicada sería, además de incomprensible para el comensal, una vía para
     * apuntarla a un servidor ajeno y capturar contraseñas y comprobantes.
     *
     * La búsqueda automática de servidor y la pantalla de configuración existen
     * únicamente para que desarrollar contra un PC de la red local no exija
     * recompilar cada vez que el router cambia la IP.
     */
    val configurable: Boolean = BuildConfig.DEBUG

    /**
     * Candidatos que se prueban al arrancar, en orden, antes de pedir la
     * dirección. Vacío en release: allí solo vale la de la compilación.
     *
     *   10.0.2.2   el emulador de Android ve así el localhost del PC
     *   localhost  un móvil con `adb reverse tcp:3000 tcp:3000`
     *
     * Con estos dos, el emulador y el móvil por cable funcionan SIN configurar
     * nada. Solo hay que escribir la dirección cuando se prueba por WiFi.
     */
    val CANDIDATOS: List<String> =
        if (configurable) {
            listOf("http://10.0.2.2:3000/", "http://localhost:3000/")
        } else {
            emptyList()
        }

    /**
     * Añade `Authorization: Bearer` a cada petición, si hay sesión.
     *
     * No se pone en cada llamada del repositorio porque olvidarlo en una sola
     * sería un fallo silencioso: esa petición devolvería 401 y parecería un
     * problema de sesión.
     */
    private class InterceptorAuth(private val sesion: SesionStore) : Interceptor {
        override fun intercept(cadena: Interceptor.Chain): Response {
            val original = cadena.request()

            // El registro y el login todavía no tienen token, y /estado y el
            // menú son públicos. Mandar una cabecera vacía en esos casos no
            // rompe nada, pero tampoco aporta.
            val token = sesion.tokenAhora()
                ?: return cadena.proceed(original)

            return cadena.proceed(
                original.newBuilder()
                    .header("Authorization", "Bearer $token")
                    .build()
            )
        }
    }

    /**
     * Detecta la sesión muerta en un solo sitio.
     *
     * Un 401 significa que el servidor ya no reconoce el token: caducó, el
     * cliente cambió su contraseña (lo que cierra todas las sesiones) o borró
     * su cuenta. Guardarlo no sirve de nada y hace que la app reintente con él
     * indefinidamente, así que se borra aquí y la interfaz reacciona sola al
     * quedarse sin token.
     *
     * El 401 de `/auth/login` se deja pasar: ahí significa "contraseña
     * incorrecta", no "sesión caducada", y borrar la sesión sería absurdo
     * porque todavía no hay ninguna.
     */
    private class InterceptorSesionMuerta(private val sesion: SesionStore) : Interceptor {
        override fun intercept(cadena: Interceptor.Chain): Response {
            val respuesta = cadena.proceed(cadena.request())
            val ruta = cadena.request().url.encodedPath

            val esAutenticacion = ruta.endsWith("/auth/login") || ruta.endsWith("/registro")
            if (respuesta.code == 401 && !esAutenticacion) {
                kotlinx.coroutines.runBlocking { sesion.limpiar() }
            }
            return respuesta
        }
    }

    /**
     * Reescribe el destino de cada petición con el servidor en uso.
     *
     * Retrofit exige una `baseUrl` fija al construirse, así que no se puede
     * cambiar después. Este interceptor reemplaza el esquema, el host y el
     * puerto de la URL ya construida, que es el patrón habitual para tener una
     * dirección variable sin recrear Retrofit en cada llamada.
     */
    private class InterceptorServidor : Interceptor {
        override fun intercept(cadena: Interceptor.Chain): Response {
            val peticion = cadena.request()
            val destino = servidor.toHttpUrlOrNull()
                ?: return cadena.proceed(peticion)

            val nueva = peticion.url.newBuilder()
                .scheme(destino.scheme)
                .host(destino.host)
                .port(destino.port)
                .build()

            return cadena.proceed(peticion.newBuilder().url(nueva).build())
        }
    }

    /**
     * Cliente aparte, solo para sondear direcciones.
     *
     * Es uno solo y compartido a propósito: el escaneo de la red local abre
     * cientos de sondeos y crear un OkHttpClient por cada uno significaría
     * cientos de pools de conexiones y de hilos. Sin interceptores —no interesa
     * el token ni el registro— y con márgenes muy cortos, porque aquí lo normal
     * es que la dirección NO responda.
     */
    private val sonda: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(1500, TimeUnit.MILLISECONDS)
            .readTimeout(1500, TimeUnit.MILLISECONDS)
            // Sin reintentos: si una dirección no contesta a la primera, es que
            // no hay nada ahí. Reintentar multiplica por dos el escaneo entero.
            .retryOnConnectionFailure(false)
            .build()
    }

    /**
     * ¿Hay un servidor de SIGR escuchando en esta dirección?
     *
     * Pregunta por `/app/estado`, que es el único endpoint que responde incluso
     * con la aplicación apagada por el administrador. Así se distingue "aquí hay
     * un SIGR" de "aquí hay algún servidor cualquiera en el puerto 3000".
     */
    suspend fun responde(url: String): Boolean = withContext(Dispatchers.IO) {
        val base = (if (url.endsWith('/')) url else "$url/").toHttpUrlOrNull()
            ?: return@withContext false

        val peticion = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/v1/app/estado").build())
            .build()

        try {
            sonda.newCall(peticion).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    // NOTA PARA QUIEN VENGA A "MEJORAR" ESTO
    // Se probó a escanear la red local (deducir 192.168.x.* de la IP del propio
    // teléfono y sondear las 254 direcciones) para que el móvil por WiFi
    // encontrara el PC sin escribir nada. Se descartó: son unos segundos de
    // sondeos en cada arranque fallido, y no hacía falta — con el cable y
    // `adb reverse tcp:3000 tcp:3000` la dirección `localhost` de arriba ya
    // funciona, y eso es todo lo que se necesita para desarrollar. En producción
    // el problema no existe: la dirección es un dominio fijado al compilar.

    fun crear(contexto: Context, sesion: SesionStore): ApiSigr {
        val registro = HttpLoggingInterceptor().apply {
            // El cuerpo completo solo en debug: en release incluiría
            // contraseñas y tokens en el logcat del dispositivo.
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
            else HttpLoggingInterceptor.Level.NONE
        }

        val http = OkHttpClient.Builder()
            // Primero se decide A DONDE va la peticion, y luego el resto.
            .addInterceptor(InterceptorServidor())
            .addInterceptor(InterceptorAuth(sesion))
            .addInterceptor(InterceptorSesionMuerta(sesion))
            .addInterceptor(registro)
            // Márgenes cortos: en un móvil, una pantalla congelada 30 s se
            // percibe como que la app está rota. Mejor fallar y reintentar.
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()

        return Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(http)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiSigr::class.java)
    }

    /**
     * URL absoluta de una imagen servida por el backend (`/uploads/...`).
     * Lee el servidor EN USO, no el de la compilacion: si el usuario cambio la
     * direccion, las fotos de los platos tienen que seguirla.
     */
    fun urlAbsoluta(ruta: String?): String? {
        if (ruta.isNullOrBlank()) return null
        if (ruta.startsWith("http")) return ruta
        return servidor.trimEnd('/') + ruta
    }

    /** Plantilla de teselas del mapa: el proxy del propio servidor. */
    fun plantillaTeselas(): String =
        servidor.trimEnd('/') + "/api/v1/mapa/teselas/"

    private val gson = Gson()

    /**
     * Traduce el cuerpo de error del servidor a algo que la interfaz pueda
     * mostrar. El backend responde siempre en español y pensando en el usuario
     * final (`server/middleware/errores.js`), así que el mensaje se muestra tal
     * cual en lugar de inventar uno propio.
     */
    fun leerError(respuesta: Response?, cuerpo: String?): ErrorApi {
        val porDefecto = ErrorApi(
            error = "desconocido",
            mensaje = "No se pudo completar la operación. Intente de nuevo.",
        )
        if (cuerpo.isNullOrBlank()) return porDefecto
        return try {
            gson.fromJson(cuerpo, ErrorApi::class.java) ?: porDefecto
        } catch (e: Exception) {
            porDefecto
        }
    }
}
