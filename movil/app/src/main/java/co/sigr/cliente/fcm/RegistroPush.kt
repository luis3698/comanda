package co.sigr.cliente.fcm

import android.os.Build
import android.util.Log
import co.sigr.cliente.BuildConfig
import co.sigr.cliente.datos.repo.RepoSigr
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Registro del token de notificaciones al iniciar sesión.
 *
 * FALLA EN SILENCIO A PROPÓSITO. Si no hay `google-services.json`, si Firebase
 * no arrancó o si Google no responde, esto no debe molestar al cliente ni
 * bloquear la pantalla: los avisos siguen llegando a la bandeja de la
 * aplicación, que es la vía fiable. Lo único que se pierde es que suene el
 * móvil con la app cerrada.
 */
object RegistroPush {

    private const val ETIQUETA = "SigrPush"

    /** Pide el token a Firebase y lo asocia a la sesión actual. */
    suspend fun registrar(repo: RepoSigr) {
        if (!BuildConfig.TIENE_FIREBASE) {
            Log.i(
                ETIQUETA,
                "Compilado sin google-services.json: no hay notificaciones push. " +
                    "Los avisos se ven igualmente en la pantalla de Avisos de la aplicación.",
            )
            return
        }

        val token = obtenerToken() ?: return
        repo.registrarDispositivo(token, Build.MODEL)
    }

    /** Token actual de FCM, o null si no se puede obtener. */
    suspend fun obtenerToken(): String? = try {
        suspendCancellableCoroutine { continuacion ->
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { continuacion.resume(it) }
                .addOnFailureListener {
                    Log.w(ETIQUETA, "No se pudo obtener el token de FCM: ${it.message}")
                    continuacion.resume(null)
                }
        }
    } catch (e: Exception) {
        // Firebase sin inicializar lanza IllegalStateException. No es un error
        // del que haya que enterar al usuario.
        Log.w(ETIQUETA, "Firebase no está disponible: ${e.message}")
        null
    }
}
