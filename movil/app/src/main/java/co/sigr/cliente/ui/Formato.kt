package co.sigr.cliente.ui

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Formato de dinero y fechas.
 *
 * EL DINERO SE MANEJA CON `BigDecimal`, NUNCA CON `Double`.
 * El servidor envía los importes como texto ("53840.00") a propósito: mysql2
 * devuelve los DECIMAL sin convertir para no perder precisión. Pasarlos por
 * coma flotante aquí reintroduciría el error que el backend evita — 0.1 + 0.2
 * da 0.30000000000000004 — y en un carrito de diez platos eso se convierte en
 * un total que no cuadra con el que cobra la caja.
 *
 * La app suma en `BigDecimal` solo para MOSTRAR un subtotal orientativo
 * mientras el cliente llena el carrito. **El total que se cobra lo calcula
 * siempre el servidor** (FSD 5.7): lo que se ve aquí es informativo.
 */
object Formato {

    private val MONEDA: NumberFormat = NumberFormat.getCurrencyInstance(Locale("es", "CO")).apply {
        maximumFractionDigits = 0
    }

    /** Formatea un importe que llega como texto desde la API. */
    fun dinero(valor: String?): String {
        if (valor.isNullOrBlank()) return "—"
        return try {
            MONEDA.format(BigDecimal(valor))
        } catch (e: NumberFormatException) {
            valor
        }
    }

    fun dinero(valor: BigDecimal): String = MONEDA.format(valor)

    /** Convierte texto de la API a BigDecimal; 0 si viene mal. */
    fun aDecimal(valor: String?): BigDecimal = try {
        if (valor.isNullOrBlank()) BigDecimal.ZERO else BigDecimal(valor)
    } catch (e: NumberFormatException) {
        BigDecimal.ZERO
    }

    /** Texto plano "53840.00" para mandar al servidor. */
    fun aTextoApi(valor: BigDecimal): String =
        valor.setScale(2, RoundingMode.HALF_UP).toPlainString()

    // --- Fechas ---

    private val ENTRADA = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
    private val ENTRADA_CORTA = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    private val SALIDA_LARGA = DateTimeFormatter.ofPattern("d 'de' MMMM 'a las' HH:mm", Locale("es", "CO"))
    private val SALIDA_CORTA = DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale("es", "CO"))

    private fun parsear(valor: String?): LocalDateTime? {
        if (valor.isNullOrBlank()) return null
        val limpio = valor.replace('T', ' ').removeSuffix("Z").take(19)
        return try {
            LocalDateTime.parse(limpio, if (limpio.length > 16) ENTRADA else ENTRADA_CORTA)
        } catch (e: Exception) {
            null
        }
    }

    fun fechaLarga(valor: String?): String = parsear(valor)?.format(SALIDA_LARGA) ?: "—"
    fun fechaCorta(valor: String?): String = parsear(valor)?.format(SALIDA_CORTA) ?: "—"

    /**
     * Formatea una fecha para MANDARLA al servidor: "yyyy-MM-dd HH:mm", sin
     * zona horaria.
     *
     * Es deliberado. El servidor la interpreta como hora local del restaurante,
     * que es la hora de pared que tiene en la cabeza el comensal: si reserva "a
     * las 8", quiere decir las 8 allí. Mandar un instante en UTC desplazaría la
     * reserva varias horas.
     */
    fun paraApi(fecha: LocalDateTime): String = fecha.format(ENTRADA_CORTA)
}
