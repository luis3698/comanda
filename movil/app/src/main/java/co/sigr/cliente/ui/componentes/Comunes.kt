package co.sigr.cliente.ui.componentes

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import co.sigr.cliente.ui.tema.*

/**
 * Piezas de interfaz que se repiten en varias pantallas.
 *
 * Todas siguen la misma regla que el sistema web: **el estado nunca se
 * comunica solo con color**. Cada insignia y cada aviso llevan icono y texto,
 * porque un cliente daltónico no distingue "confirmada" de "rechazada" si lo
 * único que cambia es el verde por el rojo (ACCESIBILIDAD.md).
 */

/** Campo de texto con etiqueta, error y altura táctil suficiente. */
@Composable
fun CampoTexto(
    valor: String,
    alCambiar: (String) -> Unit,
    etiqueta: String,
    modifier: Modifier = Modifier,
    error: String? = null,
    ayuda: String? = null,
    tipoTeclado: KeyboardType = KeyboardType.Text,
    accionTeclado: ImeAction = ImeAction.Next,
    esPassword: Boolean = false,
    lineas: Int = 1,
    habilitado: Boolean = true,
) {
    var visible by remember { mutableStateOf(false) }

    Column(modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        OutlinedTextField(
            value = valor,
            onValueChange = alCambiar,
            label = { Text(etiqueta) },
            isError = error != null,
            enabled = habilitado,
            singleLine = lineas == 1,
            minLines = lineas,
            visualTransformation = when {
                !esPassword || visible -> VisualTransformation.None
                else -> PasswordVisualTransformation()
            },
            keyboardOptions = KeyboardOptions(
                keyboardType = if (esPassword) KeyboardType.Password else tipoTeclado,
                imeAction = accionTeclado,
            ),
            trailingIcon = if (esPassword) {
                {
                    IconButton(onClick = { visible = !visible }) {
                        Icon(
                            imageVector = if (visible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            // Sin esta descripción, un lector de pantalla anuncia
                            // "botón" y nada más.
                            contentDescription = if (visible) "Ocultar la contraseña" else "Mostrar la contraseña",
                        )
                    }
                }
            } else null,
            modifier = Modifier.fillMaxWidth(),
        )

        // El error tiene prioridad sobre la ayuda: si algo está mal, es lo
        // único que interesa leer en ese momento.
        when {
            error != null -> Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = 16.dp, top = 4.dp),
            )
            ayuda != null -> Text(
                text = ayuda,
                color = TextoTenue,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = 16.dp, top = 4.dp),
            )
        }
    }
}

/** Botón principal, a lo ancho y con altura táctil. */
@Composable
fun BotonPrincipal(
    texto: String,
    alPulsar: () -> Unit,
    modifier: Modifier = Modifier,
    habilitado: Boolean = true,
    cargando: Boolean = false,
) {
    Button(
        onClick = alPulsar,
        // Mientras carga se deshabilita: evita el doble envío, que en un pedido
        // significaría cobrarlo dos veces.
        enabled = habilitado && !cargando,
        modifier = modifier.fillMaxWidth().heightIn(min = TargetTactil),
        shape = RoundedCornerShape(10.dp),
    ) {
        if (cargando) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onPrimary,
            )
            Spacer(Modifier.width(10.dp))
        }
        Text(texto, style = MaterialTheme.typography.labelLarge)
    }
}

/** Tipo de mensaje. Cada uno tiene su icono, no solo su color. */
enum class TipoAviso(val icono: String, val fondo: Color, val tinta: Color) {
    INFO("ℹ", InfoFondo, Info),
    EXITO("✓", ExitoFondo, Exito),
    ALERTA("⚠", AlertaFondo, Alerta),
    ERROR("✕", ErrorFondo, ErrorRojo),
}

/** Mensaje en línea dentro de un formulario o una pantalla. */
@Composable
fun Aviso(
    texto: String,
    tipo: TipoAviso = TipoAviso.INFO,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .background(tipo.fondo, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = tipo.icono,
            color = tipo.tinta,
            fontWeight = FontWeight.Bold,
            // El icono es decorativo: el texto de al lado ya dice todo lo que
            // hay que saber, y leerlo dos veces molesta.
            modifier = Modifier.clearAndSetSemantics { },
        )
        Spacer(Modifier.width(8.dp))
        Text(texto, color = tipo.tinta, style = MaterialTheme.typography.bodyMedium)
    }
}

/** Etiqueta compacta de estado: icono + palabra, nunca solo color. */
@Composable
fun Insignia(
    texto: String,
    icono: String,
    fondo: Color,
    tinta: Color,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .background(fondo, RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icono, color = tinta, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.width(4.dp))
        Text(
            texto,
            color = tinta,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * Pantalla vacía.
 *
 * Nunca se queda en "no hay nada": siempre explica POR QUÉ está vacío y, si
 * el usuario puede hacer algo, se lo ofrece. Una lista vacía sin explicación
 * se confunde con un error de carga.
 */
@Composable
fun EstadoVacio(
    icono: String,
    titulo: String,
    mensaje: String,
    modifier: Modifier = Modifier,
    textoAccion: String? = null,
    alPulsarAccion: (() -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(icono, style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(12.dp))
        Text(titulo, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(
            mensaje,
            style = MaterialTheme.typography.bodyMedium,
            color = TextoTenue,
            textAlign = TextAlign.Center,
        )
        if (textoAccion != null && alPulsarAccion != null) {
            Spacer(Modifier.height(20.dp))
            Button(onClick = alPulsarAccion, modifier = Modifier.heightIn(min = TargetTactil)) {
                Text(textoAccion)
            }
        }
    }
}

/** Indicador de carga centrado. */
@Composable
fun Cargando(modifier: Modifier = Modifier, texto: String = "Cargando…") {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(12.dp))
        Text(texto, color = TextoTenue, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Error con opción de reintentar.
 *
 * El botón solo aparece cuando reintentar tiene sentido: si el fallo es "te
 * falta pedido mínimo", volver a pulsar dará el mismo resultado y el botón
 * sería una promesa falsa.
 */
@Composable
fun ErrorConReintento(
    mensaje: String,
    modifier: Modifier = Modifier,
    alReintentar: (() -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Aviso(mensaje, TipoAviso.ERROR)
        if (alReintentar != null) {
            Spacer(Modifier.height(16.dp))
            OutlinedButton(onClick = alReintentar, modifier = Modifier.heightIn(min = TargetTactil)) {
                Text("Reintentar")
            }
        }
    }
}

/** Selector de cantidad. Botones grandes: se usa con el pulgar. */
@Composable
fun SelectorCantidad(
    cantidad: Int,
    alCambiar: (Int) -> Unit,
    modifier: Modifier = Modifier,
    minimo: Int = 1,
    maximo: Int = 99,
) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
        FilledTonalIconButton(
            onClick = { if (cantidad > minimo) alCambiar(cantidad - 1) },
            enabled = cantidad > minimo,
            modifier = Modifier.size(TargetTactil),
        ) { Text("−", style = MaterialTheme.typography.titleLarge) }

        Text(
            text = cantidad.toString(),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(min = 48.dp).padding(horizontal = 4.dp),
        )

        FilledTonalIconButton(
            onClick = { if (cantidad < maximo) alCambiar(cantidad + 1) },
            enabled = cantidad < maximo,
            modifier = Modifier.size(TargetTactil),
        ) { Text("+", style = MaterialTheme.typography.titleLarge) }
    }
}
