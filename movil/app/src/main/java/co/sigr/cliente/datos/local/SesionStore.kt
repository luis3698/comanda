package co.sigr.cliente.datos.local

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.almacen by preferencesDataStore(name = "sesion_sigr")

/**
 * Guarda el token de sesión entre arranques de la app.
 *
 * POR QUÉ AQUÍ Y NO EN MEMORIA
 * La sesión del cliente dura 30 días a propósito (ver MOVIL.md): un móvil es
 * un dispositivo personal, no compartido como el comandero o el POS. Pedir la
 * contraseña cada vez que se abre la app solo conseguiría que la gente
 * eligiera contraseñas más cortas.
 *
 * QUÉ SE GUARDA Y QUÉ NO
 * Se guarda el token —un valor opaco de 32 bytes que el servidor puede
 * invalidar en cualquier momento— y el nombre del cliente, para poder saludar
 * antes de que responda la primera petición. **La contraseña no se guarda
 * nunca**, ni cifrada: no hace falta para nada, y lo que no se almacena no se
 * puede filtrar.
 *
 * Sobre el cifrado del almacén: DataStore vive en el directorio privado de la
 * app, que en Android es inaccesible para otras aplicaciones. Añadir
 * `EncryptedSharedPreferences` protegería solo frente a alguien con el
 * dispositivo rooteado y desbloqueado en la mano — que a esas alturas también
 * puede leer la clave de cifrado del Keystore. El token, además, caduca y se
 * revoca desde el servidor.
 */
class SesionStore(private val contexto: Context) {

    private companion object {
        val TOKEN = stringPreferencesKey("token")
        val NOMBRE = stringPreferencesKey("nombre")
        val CORREO = stringPreferencesKey("correo")
        val EXPIRA = stringPreferencesKey("expira_en")

        /**
         * Direccion del servidor, elegida por el usuario o detectada sola.
         *
         * Se guarda aparte de la sesion y NO se borra al cerrarla: la direccion
         * del servidor no tiene nada que ver con quien esta dentro, y perderla
         * al salir obligaria a volver a configurarla en cada login.
         */
        val SERVIDOR = stringPreferencesKey("servidor")
    }

    /** Direccion guardada del servidor, o null si nunca se fijó. */
    val servidor: Flow<String?> = contexto.almacen.data.map { it[SERVIDOR] }

    suspend fun guardarServidor(url: String) {
        contexto.almacen.edit { it[SERVIDOR] = url }
    }

    /** Lectura sincrona, para el interceptor de OkHttp. */
    fun servidorAhora(): String? = kotlinx.coroutines.runBlocking {
        contexto.almacen.data.first()[SERVIDOR]
    }

    /** Emite el token actual, o null si no hay sesión. */
    val token: Flow<String?> = contexto.almacen.data.map { it[TOKEN] }

    /** Nombre del cliente, para saludarlo antes de la primera petición. */
    val nombre: Flow<String?> = contexto.almacen.data.map { it[NOMBRE] }

    /**
     * Lectura síncrona del token.
     *
     * La usa el interceptor de OkHttp, que corre en un hilo de red y necesita
     * el valor AHORA para poner la cabecera. `runBlocking` sobre DataStore es
     * seguro aquí: el dato ya está en la caché en memoria del almacén después
     * de la primera lectura, así que no toca disco en el camino caliente.
     */
    fun tokenAhora(): String? = kotlinx.coroutines.runBlocking {
        contexto.almacen.data.first()[TOKEN]
    }

    suspend fun guardar(token: String, nombre: String, correo: String, expiraEn: String) {
        contexto.almacen.edit {
            it[TOKEN] = token
            it[NOMBRE] = nombre
            it[CORREO] = correo
            it[EXPIRA] = expiraEn
        }
    }

    /** Actualiza los datos visibles sin tocar el token. */
    suspend fun actualizarDatos(nombre: String, correo: String) {
        contexto.almacen.edit {
            it[NOMBRE] = nombre
            it[CORREO] = correo
        }
    }

    /**
     * Borra la sesión. Se llama al cerrar sesión y también cuando el servidor
     * responde 401: un token que el servidor ya no reconoce no sirve de nada
     * guardado, y dejarlo haría que la app reintentara con él una y otra vez.
     */
    suspend fun limpiar() {
        contexto.almacen.edit { it.clear() }
    }
}
