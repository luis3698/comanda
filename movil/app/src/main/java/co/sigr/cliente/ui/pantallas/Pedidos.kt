package co.sigr.cliente.ui.pantallas

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.Pedido
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Historial de pedidos a domicilio.
 *
 * Mientras haya un pedido en curso, la pantalla se refresca sola cada 20
 * segundos. Es un sondeo sencillo y no un WebSocket a propósito: el canal de
 * tiempo real del servidor está pensado para el personal —filtra por permisos
 * de empleado— y abrirlo a los clientes obligaría a repensar ese filtrado por
 * un beneficio pequeño. Con el push como aviso inmediato y el sondeo mientras
 * la pantalla está abierta, el cliente ve el cambio igual de rápido.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaPedidos(repo: RepoSigr) {
    var pedidos by remember { mutableStateOf<List<Pedido>>(emptyList()) }
    var cargando by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var subiendo by remember { mutableStateOf(false) }
    var errorSubida by remember { mutableStateOf<String?>(null) }
    val alcance = rememberCoroutineScope()

    suspend fun traer() {
        when (val r = repo.pedidos()) {
            is Resultado.Exito -> { pedidos = r.datos; error = null }
            is Resultado.Fallo -> error = r.mensaje
            is Resultado.SinConexion -> error = r.mensaje
        }
        cargando = false
    }

    LaunchedEffect(Unit) { traer() }

    // Solo se sondea si hay algo vivo: con todos los pedidos entregados, seguir
    // preguntando sería gastar batería y datos para nada.
    val hayEnCurso = pedidos.any { it.estado in ESTADOS_EN_CURSO }
    LaunchedEffect(hayEnCurso) {
        while (hayEnCurso) {
            delay(20_000)
            traer()
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("Mis pedidos") }) }) { relleno ->
        Box(Modifier.fillMaxSize().padding(relleno)) {
            when {
                cargando -> Cargando()
                error != null -> ErrorConReintento(error!!, alReintentar = {
                    cargando = true
                    alcance.launch { traer() }
                })
                pedidos.isEmpty() -> EstadoVacio(
                    icono = "🛵",
                    titulo = "Todavía no ha pedido nada",
                    mensaje = "Sus pedidos a domicilio aparecerán aquí con su estado en tiempo real.",
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(pedidos) { p ->
                        TarjetaPedido(
                            pedido = p,
                            alCancelar = { alcance.launch { repo.cancelarPedido(p.id); traer() } },
                            alSubirComprobante = { archivo ->
                                alcance.launch {
                                    subiendo = true
                                    when (val r = repo.subirComprobante(p.id, archivo)) {
                                        is Resultado.Exito -> { errorSubida = null; traer() }
                                        is Resultado.Fallo -> errorSubida = r.mensaje
                                        is Resultado.SinConexion -> errorSubida = r.mensaje
                                    }
                                    subiendo = false
                                }
                            },
                            subiendo = subiendo,
                            errorSubida = errorSubida,
                        )
                    }
                }
            }
        }
    }
}

private val ESTADOS_EN_CURSO = listOf("pendiente", "aceptado", "en_preparacion", "en_camino")

/** Los pasos que ve el cliente. El pedido avanza por ellos en orden. */
private val PASOS = listOf(
    "pendiente" to "Enviado",
    "aceptado" to "Aceptado",
    "en_preparacion" to "Cocinando",
    "en_camino" to "En camino",
    "entregado" to "Entregado",
)

private data class EstiloPedido(val icono: String, val texto: String, val fondo: Color, val tinta: Color)

/**
 * Estado del PAGO, que es un eje distinto del estado del pedido.
 *
 * Es lo primero que mira el cliente cuando su pedido no avanza: si dice
 * «esperando su comprobante», ya sabe que la pelota está en su tejado.
 */
private fun estiloPago(estado: String): EstiloPedido = when (estado) {
    "pendiente" -> EstiloPedido("⏳", "Falta su comprobante", AlertaFondo, Alerta)
    "por_verificar" -> EstiloPedido("🧾", "Comprobante en revisión", InfoFondo, Info)
    "verificado" -> EstiloPedido("✓", "Pago confirmado", ExitoFondo, Exito)
    "rechazado" -> EstiloPedido("✕", "Comprobante rechazado", ErrorFondo, ErrorRojo)
    else -> EstiloPedido("💵", "Paga al recibir", InfoFondo, Info)
}

private fun estiloPedido(estado: String): EstiloPedido = when (estado) {
    "pendiente" -> EstiloPedido("⏳", "Esperando confirmación", AlertaFondo, Alerta)
    "aceptado" -> EstiloPedido("✓", "Aceptado", InfoFondo, Info)
    "en_preparacion" -> EstiloPedido("🍳", "En preparación", InfoFondo, Info)
    "en_camino" -> EstiloPedido("🛵", "En camino", InfoFondo, Info)
    "entregado" -> EstiloPedido("★", "Entregado", ExitoFondo, Exito)
    "rechazado" -> EstiloPedido("✕", "Rechazado", ErrorFondo, ErrorRojo)
    "cancelado" -> EstiloPedido("⊘", "Cancelado", InfoFondo, Info)
    else -> EstiloPedido("?", estado, InfoFondo, Info)
}

@Composable
private fun TarjetaPedido(
    pedido: Pedido,
    alCancelar: () -> Unit,
    alSubirComprobante: (java.io.File) -> Unit,
    subiendo: Boolean,
    errorSubida: String?,
) {
    var confirmando by remember { mutableStateOf(false) }
    val estilo = estiloPedido(pedido.estado)
    val estiloPg = estiloPago(pedido.estadoPago)

    // Solo se puede cancelar mientras nadie lo ha aceptado: después la cocina
    // ya empezó y el inventario ya se descontó. A partir de ahí hay que llamar
    // al restaurante, y así se dice.
    val sePuedeCancelar = pedido.estado == "pendiente"

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(pedido.codigo, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.weight(1f))
                Insignia(estilo.texto, estilo.icono, estilo.fondo, estilo.tinta)
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Insignia(estiloPg.texto, estiloPg.icono, estiloPg.fondo, estiloPg.tinta)
                Spacer(Modifier.width(8.dp))
                Text(
                    pedido.metodoNombre ?: pedido.metodoPago,
                    style = MaterialTheme.typography.bodySmall,
                    color = TextoTenue,
                )
            }

            Text(
                Formato.fechaCorta(pedido.creadoEn),
                style = MaterialTheme.typography.bodySmall,
                color = TextoTenue,
            )

            if (pedido.estado in ESTADOS_EN_CURSO || pedido.estado == "entregado") {
                Spacer(Modifier.height(14.dp))
                LineaProgreso(pedido.estado)
            }

            Spacer(Modifier.height(14.dp))
            pedido.lineas.forEach { l ->
                Row(Modifier.padding(vertical = 2.dp)) {
                    Text(
                        "${l.cantidad}×",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(l.producto.orEmpty(), style = MaterialTheme.typography.bodyMedium)
                        if (l.modificadores.isNotEmpty()) {
                            Text(
                                "» " + l.modificadores.joinToString(", ") { it.nombre },
                                style = MaterialTheme.typography.bodySmall,
                                color = TextoTenue,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))

            FilaImporte("Subtotal", Formato.dinero(pedido.subtotal))
            FilaImporte("Impuestos", Formato.dinero(pedido.impuestos))
            FilaImporte("Envío", Formato.dinero(pedido.costoEnvio))
            Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                Text("Total", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                Text(
                    Formato.dinero(pedido.total),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            Spacer(Modifier.height(10.dp))
            Text("📍 ${pedido.direccion}", style = MaterialTheme.typography.bodySmall, color = TextoTenue)

            pedido.motivoGestion?.takeIf { pedido.estado == "rechazado" }?.let {
                Spacer(Modifier.height(10.dp))
                Aviso(it, TipoAviso.ERROR)
            }

            // El bloque del comprobante: lo que el cliente tiene que hacer
            // ahora mismo si su pedido está frenado por el pago.
            if (pedido.requiereComprobante &&
                pedido.estadoPago in listOf("pendiente", "por_verificar", "rechazado")
            ) {
                Spacer(Modifier.height(12.dp))
                BloqueComprobante(pedido, alSubirComprobante, subiendo, errorSubida)
            }

            if (sePuedeCancelar) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { confirmando = true },
                    modifier = Modifier.heightIn(min = TargetTactil),
                ) { Text("Cancelar pedido") }
            }
        }
    }

    if (confirmando) {
        AlertDialog(
            onDismissRequest = { confirmando = false },
            title = { Text("Cancelar el pedido") },
            text = {
                Text(
                    "Se cancelará el pedido ${pedido.codigo}. " +
                        "Solo se puede mientras el restaurante no lo haya aceptado."
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmando = false; alCancelar() }) { Text("Sí, cancelar") }
            },
            dismissButton = { TextButton(onClick = { confirmando = false }) { Text("No") } },
        )
    }
}

/**
 * Barra de progreso del reparto.
 *
 * Cada paso lleva su etiqueta debajo: una fila de puntos de colores sin texto
 * obligaría a adivinar en qué punto está el pedido.
 */
@Composable
private fun LineaProgreso(estadoActual: String) {
    val indiceActual = PASOS.indexOfFirst { it.first == estadoActual }

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        PASOS.forEachIndexed { i, (_, etiqueta) ->
            val alcanzado = i <= indiceActual
            Column(
                Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    if (alcanzado) "●" else "○",
                    color = if (alcanzado) MaterialTheme.colorScheme.primary else Borde,
                )
                Text(
                    etiqueta,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (alcanzado) Texto else TextoTenue,
                    fontWeight = if (i == indiceActual) FontWeight.Bold else FontWeight.Normal,
                )
            }
        }
    }
}

@Composable
private fun FilaImporte(etiqueta: String, valor: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
        Text(etiqueta, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = TextoTenue)
        Text(valor, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Adjuntar el comprobante de pago.
 *
 * SE ELIGE DE LA GALERÍA, no se abre la cámara. El cliente acaba de hacer la
 * transferencia en otra aplicación y lo que tiene es una captura de pantalla;
 * pedirle que fotografíe algo sería absurdo. `PickVisualMedia` además no exige
 * permiso de almacenamiento: el sistema devuelve solo la imagen que el usuario
 * elija, sin dar acceso al resto.
 *
 * El archivo se copia a la caché de la app antes de subirlo. El `content://`
 * que devuelve el selector no es una ruta de archivo y OkHttp no puede leerlo
 * directamente.
 */
@Composable
private fun BloqueComprobante(
    pedido: Pedido,
    alSubir: (java.io.File) -> Unit,
    subiendo: Boolean,
    errorSubida: String?,
) {
    val contexto = LocalContext.current

    val elegir = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val destino = java.io.File(contexto.cacheDir, "comprobante_${pedido.codigo}.jpg")
        runCatching {
            contexto.contentResolver.openInputStream(uri)?.use { entrada ->
                destino.outputStream().use { salida -> entrada.copyTo(salida) }
            }
            alSubir(destino)
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (pedido.estadoPago == "por_verificar") InfoFondo else AlertaFondo,
                RoundedCornerShape(10.dp),
            )
            .padding(12.dp),
    ) {
        val tinta = if (pedido.estadoPago == "por_verificar") Info else Alerta

        Text(
            when (pedido.estadoPago) {
                "por_verificar" -> "Su comprobante está en revisión"
                "rechazado" -> "Hubo un problema con su comprobante"
                else -> "Falta enviar el comprobante de pago"
            },
            style = MaterialTheme.typography.titleMedium,
            color = tinta,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            when (pedido.estadoPago) {
                "por_verificar" ->
                    "El restaurante lo está revisando. En cuanto lo confirme empezamos a preparar su pedido."
                else ->
                    "Transfiera ${Formato.dinero(pedido.total)} por ${pedido.metodoNombre} y " +
                        "adjunte aquí la captura. Su pedido no empieza a prepararse hasta que lo confirmemos."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = tinta,
        )

        // El motivo del rechazo lo escribió el cajero pensando en el cliente:
        // se muestra tal cual para que sepa qué corregir.
        pedido.motivoPago?.takeIf { pedido.estadoPago != "verificado" }?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = tinta)
        }

        errorSubida?.let {
            Spacer(Modifier.height(8.dp))
            Aviso(it, TipoAviso.ERROR)
        }

        if (pedido.estadoPago != "por_verificar") {
            Spacer(Modifier.height(12.dp))
            BotonPrincipal(
                texto = if (pedido.estadoPago == "rechazado") "Adjuntar otro comprobante"
                        else "Adjuntar comprobante",
                cargando = subiendo,
                alPulsar = {
                    elegir.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    )
                },
            )
        }
    }
}
