package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.Reserva
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.*
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/**
 * Reservas del cliente.
 *
 * Al crear una, el servidor la publica por WebSocket a las pantallas de Caja
 * —esa es la "notificación automática al rol de caja" del enunciado— y queda
 * en estado `pendiente` hasta que un cajero la confirme asignando mesa. Aquí
 * se ve ese estado y, cuando se resuelve, llega además una notificación push.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaReservas(repo: RepoSigr, vm: EstadoAppVm) {
    var reservas by remember { mutableStateOf<List<Reserva>>(emptyList()) }
    var cargando by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var mostrarFormulario by remember { mutableStateOf(false) }

    val servicio by vm.servicio.collectAsState()
    val alcance = rememberCoroutineScope()

    fun cargar() {
        alcance.launch {
            cargando = true
            when (val r = repo.reservas()) {
                is Resultado.Exito -> { reservas = r.datos; error = null }
                is Resultado.Fallo -> error = r.mensaje
                is Resultado.SinConexion -> error = r.mensaje
            }
            cargando = false
        }
    }

    LaunchedEffect(Unit) { cargar() }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Mis reservas") }) },
        floatingActionButton = {
            if (servicio.reservas) {
                ExtendedFloatingActionButton(
                    onClick = { mostrarFormulario = true },
                    icon = { Icon(Icons.Default.Add, contentDescription = null) },
                    text = { Text("Reservar") },
                )
            }
        },
    ) { relleno ->
        Box(Modifier.fillMaxSize().padding(relleno)) {
            when {
                cargando -> Cargando()
                error != null -> ErrorConReintento(error!!, alReintentar = ::cargar)
                reservas.isEmpty() -> EstadoVacio(
                    icono = "📅",
                    titulo = "Sin reservas",
                    mensaje = if (servicio.reservas)
                        "Reserve su mesa y le confirmaremos en unos minutos."
                    else
                        "Las reservas por la aplicación están cerradas ahora mismo. Llame al restaurante.",
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(reservas) { r ->
                        TarjetaReserva(r) {
                            alcance.launch {
                                repo.cancelarReserva(r.id)
                                cargar()
                            }
                        }
                    }
                }
            }
        }
    }

    if (mostrarFormulario) {
        DialogoNuevaReserva(
            repo = repo,
            alCerrar = { mostrarFormulario = false },
            alCrear = { mostrarFormulario = false; cargar() },
        )
    }
}

/** Icono, texto y colores de cada estado. Nunca solo color. */
private data class EstiloEstado(val icono: String, val texto: String, val fondo: androidx.compose.ui.graphics.Color, val tinta: androidx.compose.ui.graphics.Color)

private fun estiloDe(estado: String): EstiloEstado = when (estado) {
    "pendiente" -> EstiloEstado("⏳", "Esperando confirmación", AlertaFondo, Alerta)
    "confirmada" -> EstiloEstado("✓", "Confirmada", ExitoFondo, Exito)
    "rechazada" -> EstiloEstado("✕", "No disponible", ErrorFondo, ErrorRojo)
    "cancelada" -> EstiloEstado("⊘", "Cancelada", InfoFondo, Info)
    "cumplida" -> EstiloEstado("★", "Cumplida", ExitoFondo, Exito)
    "no_asistio" -> EstiloEstado("—", "No asistió", InfoFondo, Info)
    else -> EstiloEstado("?", estado, InfoFondo, Info)
}

@Composable
private fun TarjetaReserva(reserva: Reserva, alCancelar: () -> Unit) {
    var confirmando by remember { mutableStateOf(false) }
    val estilo = estiloDe(reserva.estado)
    val sePuedeCancelar = reserva.estado in listOf("pendiente", "confirmada")

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(reserva.codigo, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.weight(1f))
                Insignia(estilo.texto, estilo.icono, estilo.fondo, estilo.tinta)
            }

            Spacer(Modifier.height(10.dp))
            Text(Formato.fechaLarga(reserva.fechaHora), style = MaterialTheme.typography.bodyLarge)
            Text(
                "${reserva.numPersonas} " + if (reserva.numPersonas == 1) "persona" else "personas",
                style = MaterialTheme.typography.bodyMedium,
                color = TextoTenue,
            )

            reserva.mesa?.let {
                Spacer(Modifier.height(6.dp))
                Text("Mesa $it${reserva.zona?.let { z -> " · $z" } ?: ""}",
                    style = MaterialTheme.typography.bodyMedium)
            }
            reserva.notas?.let {
                Spacer(Modifier.height(8.dp))
                Text("💬 $it", style = MaterialTheme.typography.bodySmall, color = TextoTenue)
            }
            // El motivo del rechazo lo escribió el cajero pensando en el
            // cliente: se muestra tal cual.
            reserva.motivoGestion?.takeIf { reserva.estado == "rechazada" }?.let {
                Spacer(Modifier.height(10.dp))
                Aviso(it, TipoAviso.ERROR)
            }

            if (sePuedeCancelar) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { confirmando = true },
                    modifier = Modifier.heightIn(min = TargetTactil),
                ) { Text("Cancelar reserva") }
            }
        }
    }

    if (confirmando) {
        AlertDialog(
            onDismissRequest = { confirmando = false },
            title = { Text("Cancelar la reserva") },
            text = { Text("Se cancelará la reserva ${reserva.codigo}. No se puede deshacer.") },
            confirmButton = {
                TextButton(onClick = { confirmando = false; alCancelar() }) {
                    Text("Sí, cancelar")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmando = false }) { Text("No") }
            },
        )
    }
}

/**
 * Formulario de reserva.
 *
 * La fecha se manda como "yyyy-MM-dd HH:mm" SIN zona horaria: el servidor la
 * interpreta como hora local del restaurante, que es la hora de pared que
 * tiene en la cabeza el comensal. Mandar un instante en UTC la desplazaría
 * varias horas.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DialogoNuevaReserva(
    repo: RepoSigr,
    alCerrar: () -> Unit,
    alCrear: () -> Unit,
) {
    // Por defecto, mañana a las 20:00: la antelación mínima que suele pedir el
    // restaurante son 2 horas, así que "hoy dentro de un rato" sería rechazado.
    var fecha by remember { mutableStateOf(LocalDate.now().plusDays(1)) }
    var hora by remember { mutableStateOf(LocalTime.of(20, 0)) }
    var personas by remember { mutableIntStateOf(2) }
    var notas by remember { mutableStateOf("") }

    var error by remember { mutableStateOf<String?>(null) }
    var campos by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var enviando by remember { mutableStateOf(false) }

    var eligiendoFecha by remember { mutableStateOf(false) }
    var eligiendoHora by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text("Nueva reserva") },
        text = {
            Column {
                error?.let {
                    Aviso(it, TipoAviso.ERROR)
                    Spacer(Modifier.height(12.dp))
                }

                OutlinedButton(
                    onClick = { eligiendoFecha = true },
                    modifier = Modifier.fillMaxWidth().heightIn(min = TargetTactil),
                ) { Text("📅  ${fecha}") }

                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { eligiendoHora = true },
                    modifier = Modifier.fillMaxWidth().heightIn(min = TargetTactil),
                ) { Text("🕐  ${hora}") }

                campos["fechaHora"]?.let {
                    Text(it, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(16.dp))
                Text("¿Cuántas personas?", style = MaterialTheme.typography.bodyMedium)
                SelectorCantidad(personas, { personas = it }, maximo = 20)
                campos["numPersonas"]?.let {
                    Text(it, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(12.dp))
                CampoTexto(
                    valor = notas, alCambiar = { notas = it },
                    etiqueta = "Notas (opcional)",
                    ayuda = "Aniversario, silla para bebé, mesa tranquila…",
                    lineas = 2,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !enviando,
                onClick = {
                    error = null
                    campos = emptyMap()
                    enviando = true
                    alcance.launch {
                        val cuando = LocalDateTime.of(fecha, hora)
                        val r = repo.crearReserva(
                            Formato.paraApi(cuando),
                            personas,
                            notas.trim().ifBlank { null },
                        )
                        when (r) {
                            is Resultado.Exito -> alCrear()
                            is Resultado.Fallo -> {
                                campos = r.campos
                                error = r.mensaje
                            }
                            is Resultado.SinConexion -> error = r.mensaje
                        }
                        enviando = false
                    }
                },
            ) { Text(if (enviando) "Enviando…" else "Reservar") }
        },
        dismissButton = { TextButton(onClick = alCerrar) { Text("Cancelar") } },
    )

    if (eligiendoFecha) {
        val estado = rememberDatePickerState(
            initialSelectedDateMillis = fecha.toEpochDay() * 86_400_000L,
        )
        DatePickerDialog(
            onDismissRequest = { eligiendoFecha = false },
            confirmButton = {
                TextButton(onClick = {
                    estado.selectedDateMillis?.let {
                        fecha = LocalDate.ofEpochDay(it / 86_400_000L)
                    }
                    eligiendoFecha = false
                }) { Text("Aceptar") }
            },
        ) { DatePicker(state = estado) }
    }

    if (eligiendoHora) {
        val estado = rememberTimePickerState(hora.hour, hora.minute, true)
        AlertDialog(
            onDismissRequest = { eligiendoHora = false },
            title = { Text("Hora de la reserva") },
            text = { TimePicker(state = estado) },
            confirmButton = {
                TextButton(onClick = {
                    hora = LocalTime.of(estado.hour, estado.minute)
                    eligiendoHora = false
                }) { Text("Aceptar") }
            },
        )
    }
}
