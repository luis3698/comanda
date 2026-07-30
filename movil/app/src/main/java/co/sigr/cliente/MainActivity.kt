package co.sigr.cliente

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.navegacion.AppSigr
import co.sigr.cliente.ui.tema.TemaSigr

class MainActivity : ComponentActivity() {

    /**
     * Permiso de notificaciones (Android 13+).
     *
     * Se pide DESPUÉS de arrancar y sin bloquear nada: si el cliente lo
     * rechaza, la aplicación funciona igual. Los avisos siguen guardándose en
     * la bandeja del servidor y se ven al abrir la app — el push solo añade
     * que suene el móvil.
     */
    private val pedirPermisoAvisos =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* concedido o no, da igual */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val app = application as SigrApp

        setContent {
            TemaSigr {
                val vm: EstadoAppVm = viewModel(factory = object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>): T =
                        EstadoAppVm(app.repo) as T
                })
                AppSigr(repo = app.repo, vm = vm)
            }
        }

        solicitarPermisoAvisos()
    }

    private fun solicitarPermisoAvisos() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val concedido = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!concedido) pedirPermisoAvisos.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
