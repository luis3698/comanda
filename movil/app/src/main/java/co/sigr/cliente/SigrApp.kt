package co.sigr.cliente

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import co.sigr.cliente.datos.local.SesionStore
import co.sigr.cliente.datos.red.ClienteHttp
import co.sigr.cliente.datos.repo.RepoSigr
import org.osmdroid.config.Configuration

/**
 * Arranque de la aplicación.
 *
 * Monta a mano las tres piezas que necesita todo lo demás —almacén de sesión,
 * cliente HTTP y repositorio— en vez de traer un framework de inyección de
 * dependencias. Son tres objetos sin ciclo de vida complicado: Hilt aquí sería
 * más ceremonia que ayuda, y una dependencia más que auditar. Es la misma
 * postura que el servidor, que escribe sus cabeceras de seguridad a mano en
 * lugar de usar helmet.
 */
class SigrApp : Application() {

    lateinit var repo: RepoSigr
        private set

    lateinit var sesion: SesionStore
        private set

    override fun onCreate() {
        super.onCreate()

        sesion = SesionStore(this)

        // La direccion guardada se restaura ANTES de crear el cliente HTTP: si
        // no, la primera peticion saldria hacia la de la compilacion y fallaria
        // aunque el usuario ya hubiera configurado la correcta.
        sesion.servidorAhora()?.let { ClienteHttp.servidor = it }

        repo = RepoSigr(ClienteHttp.crear(this, sesion), sesion)

        configurarMapa()
        crearCanalAvisos()
    }

    /**
     * osmdroid necesita saber dónde guardar su caché y con qué User-Agent
     * identificarse.
     *
     * El User-Agent es obligatorio: sin uno propio, osmdroid manda el suyo por
     * defecto y muchos servidores de teselas lo bloquean. Aquí da igual quién
     * sirva las teselas —van por el proxy del propio SIGR—, pero identificarse
     * correctamente sigue siendo lo correcto.
     */
    private fun configurarMapa() {
        // Se le pasa un SharedPreferences propio en lugar del "por defecto":
        // asi no hace falta la dependencia androidx.preference solo para esto.
        val prefs = getSharedPreferences("osmdroid", Context.MODE_PRIVATE)

        Configuration.getInstance().apply {
            load(this@SigrApp, prefs)
            userAgentValue = packageName
            osmdroidBasePath = cacheDir
            osmdroidTileCache = cacheDir.resolve("teselas")
        }
    }

    /**
     * Canal de notificaciones.
     *
     * Android 8+ descarta en silencio cualquier aviso que no pertenezca a un
     * canal existente: si no se crea aquí, las notificaciones simplemente no
     * aparecen y no hay ningún error que lo explique.
     *
     * Se crea SIEMPRE, aunque no haya Firebase configurado, porque también lo
     * usan los avisos locales.
     */
    private fun crearCanalAvisos() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val canal = NotificationChannel(
            getString(R.string.canal_avisos_id),
            getString(R.string.canal_avisos_nombre),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = getString(R.string.canal_avisos_descripcion)
            enableVibration(true)
        }

        getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
    }
}
