package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.Notificacion
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TextoTenue
import kotlinx.coroutines.launch

/**
 * Bandeja de avisos.
 *
 * ESTA PANTALLA ES LA RED DE SEGURIDAD DEL PUSH, y por eso existe aunque
 * Firebase esté configurado. El servidor escribe aquí la notificación ANTES de
 * intentar enviarla al móvil (`servicios/push.js`): si no hay credenciales de
 * Firebase, si el token caducó, si el cliente tenía los avisos silenciados o
 * si estaba sin datos, el mensaje sigue estando y lo ve al abrir la aplicación.
 *
 * Es lo que permite que todo el sistema funcione y se pueda demostrar sin
 * ninguna cuenta de Firebase.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaNotificaciones(
    repo: RepoSigr,
    vm: EstadoAppVm,
    alVolver: () -> Unit,
) {
    var avisos by remember { mutableStateOf<List<Notificacion>>(emptyList()) }
    var noLeidas by remember { mutableIntStateOf(0) }
    var cargando by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val alcance = rememberCoroutineScope()

    fun cargar() {
        alcance.launch {
            when (val r = repo.notificaciones()) {
                is Resultado.Exito -> {
                    avisos = r.datos.notificaciones
                    noLeidas = r.datos.noLeidas
                    error = null
                }
                is Resultado.Fallo -> error = r.mensaje
                is Resultado.SinConexion -> error = r.mensaje
            }
            cargando = false
            vm.refrescarNoLeidas()
        }
    }

    LaunchedEffect(Unit) { cargar() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Avisos") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
                actions = {
                    // Solo aparece si hay algo que marcar: un botón que no hace
                    // nada es peor que ningún botón.
                    if (noLeidas > 0) {
                        TextButton(onClick = {
                            alcance.launch { repo.marcarTodasLeidas(); cargar() }
                        }) { Text("Marcar todo") }
                    }
                },
            )
        },
    ) { relleno ->
        Box(Modifier.fillMaxSize().padding(relleno)) {
            when {
                cargando -> Cargando()
                error != null -> ErrorConReintento(error!!, alReintentar = ::cargar)
                avisos.isEmpty() -> EstadoVacio(
                    icono = "🔔",
                    titulo = "Sin avisos",
                    mensaje = "Aquí verá la confirmación de sus reservas, el estado de sus pedidos " +
                        "y las promociones del restaurante.",
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(avisos) { n ->
                        TarjetaAviso(n) {
                            if (!n.leida) {
                                alcance.launch { repo.marcarLeida(n.id); cargar() }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun iconoDe(tipo: String): String = when (tipo) {
    "reserva" -> "📅"
    "pedido" -> "🛵"
    "promocion" -> "🎉"
    else -> "ℹ"
}

@Composable
private fun TarjetaAviso(aviso: Notificacion, alPulsar: () -> Unit) {
    Card(
        onClick = alPulsar,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            // Lo no leído resalta con el color de marca, pero además lleva un
            // punto y el título en negrita: el color solo no basta.
            containerColor = if (aviso.leida) MaterialTheme.colorScheme.surface
            else MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Text(iconoDe(aviso.tipo), style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (!aviso.leida) {
                        Text("●", color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        aviso.titulo,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = if (aviso.leida) FontWeight.Normal else FontWeight.Bold,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(aviso.cuerpo, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(6.dp))
                Row {
                    Text(
                        Formato.fechaCorta(aviso.creadoEn),
                        style = MaterialTheme.typography.bodySmall,
                        color = TextoTenue,
                    )
                    aviso.referencia?.let {
                        Spacer(Modifier.width(8.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall, color = TextoTenue)
                    }
                }
            }
        }
    }
}
