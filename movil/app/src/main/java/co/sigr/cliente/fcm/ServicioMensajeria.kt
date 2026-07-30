package co.sigr.cliente.fcm

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import co.sigr.cliente.MainActivity
import co.sigr.cliente.R
import co.sigr.cliente.SigrApp
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Recepción de notificaciones push.
 *
 * CUÁNDO SE EJECUTA ESTO
 * Solo si la aplicación se compiló con `google-services.json`. Sin ese archivo
 * el plugin de Google Services no se aplica, Firebase no se autoinicializa y
 * Android nunca invoca a este servicio. **No pasa nada**: el servidor guarda
 * cada aviso en `notificacion_cliente` antes de intentar el envío, así que el
 * cliente los ve igualmente al abrir la pantalla de avisos. El push solo añade
 * que suene el móvil con la aplicación cerrada.
 *
 * POR QUÉ SE CONSTRUYE LA NOTIFICACIÓN A MANO
 * Firebase muestra solo el bloque `notification` cuando la app está en segundo
 * plano, y en primer plano no muestra nada. Construyéndola aquí, el
 * comportamiento es el mismo en los dos casos y se puede llevar al cliente a
 * la pantalla correcta al tocarla.
 */
class ServicioMensajeria : FirebaseMessagingService() {

    private val alcance = CoroutineScope(Dispatchers.IO)

    /**
     * Token nuevo. Ocurre al instalar, al reinstalar y cuando Google lo rota
     * por su cuenta.
     *
     * Se manda al servidor solo si hay sesión: sin cliente al que asociarlo, el
     * token no serviría para nada. Cuando el cliente entre, `MainActivity` lo
     * registra desde `RegistroPush`.
     */
    override fun onNewToken(token: String) {
        val app = application as? SigrApp ?: return
        alcance.launch {
            if (app.sesion.tokenAhora() != null) {
                app.repo.registrarDispositivo(token, Build.MODEL)
            }
        }
    }

    override fun onMessageReceived(mensaje: RemoteMessage) {
        val titulo = mensaje.notification?.title
            ?: mensaje.data["titulo"]
            ?: getString(R.string.app_nombre)
        val cuerpo = mensaje.notification?.body
            ?: mensaje.data["cuerpo"]
            ?: return

        mostrar(titulo, cuerpo)
    }

    private fun mostrar(titulo: String, cuerpo: String) {
        // Desde Android 13 el permiso puede estar denegado. Publicar sin él
        // lanzaría una excepción y cerraría el proceso en segundo plano.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val intencion = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendiente = PendingIntent.getActivity(
            this, 0, intencion,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val aviso = NotificationCompat.Builder(this, getString(R.string.canal_avisos_id))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(titulo)
            .setContentText(cuerpo)
            // Sin esto, un texto largo se corta con puntos suspensivos y el
            // cliente no puede leer el motivo de un rechazo.
            .setStyle(NotificationCompat.BigTextStyle().bigText(cuerpo))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pendiente)
            .build()

        NotificationManagerCompat.from(this)
            .notify(System.currentTimeMillis().toInt(), aviso)
    }
}
