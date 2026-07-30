package co.sigr.cliente.ui.tema

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/*
 * Paleta.
 *
 * Son EXACTAMENTE los mismos valores que `:root` en public/css/base.css. Se
 * copian como constantes en vez de compartir un archivo porque la carpeta
 * `movil/` tiene que poder salir del repositorio y seguir compilando (ver
 * MOVIL.md): un import hacia `../public/css` la ataría al proyecto web.
 *
 * Si alguien cambia la marca, hay que tocar los dos sitios. Es el precio de la
 * independencia, y está anotado aquí para que no sorprenda.
 */
val VerdePrimario = Color(0xFF0F766E)      // --c-primario
val VerdeFuerte = Color(0xFF115E59)        // --c-primario-fuerte
val VerdeSuave = Color(0xFFCCFBF1)         // --c-primario-suave
val Fondo = Color(0xFFF1F5F9)              // --c-fondo
val Superficie = Color(0xFFFFFFFF)         // --c-superficie
val Borde = Color(0xFFCBD5E1)              // --c-borde
val Texto = Color(0xFF0F172A)              // --c-texto
val TextoSuave = Color(0xFF475569)         // --c-texto-suave
val TextoTenue = Color(0xFF5D6D84)         // --c-texto-tenue

val Exito = Color(0xFF15803D)
val ExitoFondo = Color(0xFFDCFCE7)
val Alerta = Color(0xFFB45309)
val AlertaFondo = Color(0xFFFEF3C7)
val ErrorRojo = Color(0xFFB91C1C)
val ErrorFondo = Color(0xFFFEE2E2)
val Info = Color(0xFF1D4ED8)
val InfoFondo = Color(0xFFDBEAFE)

/** Altura mínima de cualquier elemento que se toca. FSD 6.3: 48 dp. */
val TargetTactil = 48.dp

private val EsquemaClaro = lightColorScheme(
    primary = VerdePrimario,
    onPrimary = Color.White,
    primaryContainer = VerdeSuave,
    onPrimaryContainer = VerdeFuerte,
    secondary = VerdeFuerte,
    onSecondary = Color.White,
    background = Fondo,
    onBackground = Texto,
    surface = Superficie,
    onSurface = Texto,
    surfaceVariant = Fondo,
    onSurfaceVariant = TextoSuave,
    outline = Borde,
    error = ErrorRojo,
    onError = Color.White,
    errorContainer = ErrorFondo,
    onErrorContainer = ErrorRojo,
)

/*
 * Modo oscuro.
 *
 * Se define porque Android lo aplica solo si el usuario lo tiene activado, y
 * sin un esquema propio Material inventaría uno con colores que no son los de
 * la marca. Se conserva el verde como primario, subiendo su luminosidad para
 * que mantenga contraste sobre fondo oscuro.
 */
private val EsquemaOscuro = darkColorScheme(
    primary = Color(0xFF5EEAD4),
    onPrimary = Color(0xFF00201C),
    primaryContainer = VerdeFuerte,
    onPrimaryContainer = VerdeSuave,
    secondary = Color(0xFF99F6E4),
    onSecondary = Color(0xFF00201C),
    background = Color(0xFF0F172A),
    onBackground = Color(0xFFE2E8F0),
    surface = Color(0xFF1E293B),
    onSurface = Color(0xFFE2E8F0),
    surfaceVariant = Color(0xFF334155),
    onSurfaceVariant = Color(0xFFCBD5E1),
    outline = Color(0xFF475569),
    error = Color(0xFFFCA5A5),
    onError = Color(0xFF450A0A),
)

/**
 * Tipografía del sistema, sin fuentes descargadas.
 *
 * Igual que en la web (`--fuente: system-ui…`): usar la del dispositivo evita
 * pesar el APK, evita el parpadeo de texto mientras carga una fuente y respeta
 * los ajustes de accesibilidad del usuario.
 */
private val TipografiaSigr = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold, lineHeight = 32.sp),
    headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, lineHeight = 28.sp),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 26.sp),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun TemaSigr(
    oscuro: Boolean = isSystemInDarkTheme(),
    contenido: @Composable () -> Unit,
) {
    val esquema = if (oscuro) EsquemaOscuro else EsquemaClaro
    val vista = LocalView.current

    if (!vista.isInEditMode) {
        SideEffect {
            val ventana = (vista.context as Activity).window
            ventana.statusBarColor = if (oscuro) esquema.surface.toArgb() else VerdePrimario.toArgb()
            // Iconos claros sobre la barra verde, oscuros si el fondo es claro.
            WindowCompat.getInsetsController(ventana, vista).isAppearanceLightStatusBars = oscuro
        }
    }

    MaterialTheme(
        colorScheme = esquema,
        typography = TipografiaSigr,
        content = contenido,
    )
}
