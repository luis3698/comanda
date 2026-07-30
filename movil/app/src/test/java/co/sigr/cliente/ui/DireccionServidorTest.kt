package co.sigr.cliente.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pruebas de `normalizarDireccion`.
 *
 * Se prueba esto y no otra cosa porque es donde de verdad se pierde una tarde:
 * si la dirección sale con un carácter de más o de menos, la app dice "no hay
 * conexión con el restaurante" y no hay ninguna pista de que el problema sea una
 * cadena mal formada y no la red.
 */
class DireccionServidorTest {

    @Test
    fun `la IP sola se completa con esquema, puerto y barra`() {
        assertEquals("http://192.168.40.41:3000/", normalizarDireccion("192.168.40.41"))
    }

    @Test
    fun `respeta el puerto que se escriba`() {
        assertEquals("http://192.168.40.41:8080/", normalizarDireccion("192.168.40.41:8080"))
    }

    @Test
    fun `acepta la URL completa sin duplicar nada`() {
        assertEquals("http://192.168.40.41:3000/", normalizarDireccion("http://192.168.40.41:3000/"))
    }

    @Test
    fun `no degrada https a http ni le pone puerto de desarrollo`() {
        // Un dominio por HTTPS va al 443: añadirle el 3000 convertiría una
        // dirección buena en una que no responde.
        assertEquals("https://pedidos.ejemplo.com/", normalizarDireccion("https://pedidos.ejemplo.com"))
    }

    @Test
    fun `ignora espacios sobrantes al pegar`() {
        assertEquals("http://10.0.2.2:3000/", normalizarDireccion("  10.0.2.2  "))
    }

    @Test
    fun `el nombre de equipo tambien vale`() {
        assertEquals("http://mi-pc:3000/", normalizarDireccion("mi-pc"))
    }

    @Test
    fun `una entrada vacia no es una direccion`() {
        assertNull(normalizarDireccion(""))
        assertNull(normalizarDireccion("   "))
    }
}
