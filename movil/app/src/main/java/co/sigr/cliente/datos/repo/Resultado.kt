package co.sigr.cliente.datos.repo

import co.sigr.cliente.datos.red.ClienteHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import retrofit2.Response
import java.io.IOException

/**
 * Resultado de una llamada a la API.
 *
 * POR QUÉ NO SE LANZAN EXCEPCIONES
 * Un fallo de red no es un error de programación: es el estado normal de un
 * móvil que entra en un ascensor. Modelarlo como excepción invita a envolver
 * cada llamada en un try/catch y, en cuanto uno se olvida, la app se cierra
 * sola delante del cliente. Con un tipo de resultado, el compilador obliga a
 * mirar el caso de error.
 *
 * Los tres casos están separados porque la pantalla reacciona distinto a cada
 * uno:
 *   Exito         → pintar los datos.
 *   Fallo         → mostrar el mensaje del servidor, que ya viene en español
 *                   y pensado para el usuario final.
 *   SinConexion   → "no hay internet" + botón de reintentar. Es lo único que
 *                   el cliente puede resolver por su cuenta.
 */
sealed interface Resultado<out T> {

    data class Exito<T>(val datos: T) : Resultado<T>

    /**
     * El servidor respondió, pero con un error.
     *
     * @param codigo   Código estable de `errores.js` ('regla_negocio',
     *                 'app_desactivada', 'cliente_no_autenticado'…). Es lo que
     *                 se compara en el código, nunca el texto.
     * @param mensaje  Texto en español, ya listo para mostrar.
     * @param campos   Errores por campo, para pintarlos bajo su casilla.
     * @param http     Código HTTP, para los casos que dependen de él.
     */
    data class Fallo(
        val codigo: String,
        val mensaje: String,
        val campos: Map<String, String> = emptyMap(),
        val http: Int = 0,
    ) : Resultado<Nothing>

    data class SinConexion(val mensaje: String = MENSAJE_SIN_RED) : Resultado<Nothing>

    companion object {
        const val MENSAJE_SIN_RED =
            "No hay conexión con el restaurante. Revise su internet e intente de nuevo."
    }
}

/** Los datos si fue bien, o null. Para los casos en que el error no importa. */
fun <T> Resultado<T>.datosONull(): T? = (this as? Resultado.Exito)?.datos

/** ¿Es el error de "la aplicación está apagada"? */
fun Resultado<*>.esAppDesactivada(): Boolean =
    this is Resultado.Fallo && codigo == "app_desactivada"

/** ¿Es el error de "hay que iniciar sesión"? */
fun Resultado<*>.esSesionCaducada(): Boolean =
    this is Resultado.Fallo &&
        (codigo == "cliente_no_autenticado" || codigo == "sesion_expirada" || http == 401)

/**
 * Ejecuta una llamada a la API y la convierte en `Resultado`.
 *
 * Centraliza tres cosas que, repetidas en cada método del repositorio, alguien
 * acabaría olvidando: salir del hilo principal, traducir el cuerpo de error y
 * distinguir "sin red" de "el servidor dijo que no".
 */
suspend fun <T> llamar(bloque: suspend () -> Response<T>): Resultado<T> =
    withContext(Dispatchers.IO) {
        try {
            val respuesta = bloque()

            if (respuesta.isSuccessful) {
                val cuerpo = respuesta.body()
                // 204 No Content es un éxito legítimo sin cuerpo. Se representa
                // como Unit para que quien llame no tenga que distinguirlo.
                @Suppress("UNCHECKED_CAST")
                return@withContext Resultado.Exito((cuerpo ?: Unit) as T)
            }

            val error = ClienteHttp.leerError(null, respuesta.errorBody()?.string())
            Resultado.Fallo(
                codigo = error.error ?: "desconocido",
                mensaje = error.mensaje ?: "No se pudo completar la operación.",
                campos = error.datos?.campos ?: emptyMap(),
                http = respuesta.code(),
            )
        } catch (e: IOException) {
            // Sin red, DNS caído, servidor apagado, timeout.
            Resultado.SinConexion()
        } catch (e: Exception) {
            // Cualquier otra cosa (JSON malformado, por ejemplo). No se deja
            // escapar: una excepción aquí cerraría la aplicación.
            Resultado.Fallo(
                codigo = "error_cliente",
                mensaje = "Ocurrió un problema inesperado. Intente de nuevo.",
            )
        }
    }
