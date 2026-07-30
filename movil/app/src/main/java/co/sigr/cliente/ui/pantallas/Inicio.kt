package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.Promocion
import co.sigr.cliente.datos.red.Restaurante
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.datosONull
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TextoTenue

/**
 * Pantalla de inicio: la ficha del restaurante, las promociones vigentes y los
 * accesos a lo que el cliente viene a hacer.
 *
 * Todo lo que se ve aquí —nombre, horario, dirección, teléfono— sale de la
 * tabla `parametro` y lo edita el administrador desde el panel web. No hay ni
 * un texto de restaurante escrito en el código.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaInicio(
    repo: RepoSigr,
    vm: EstadoAppVm,
    alIrAMenu: () -> Unit,
    alIrAReservas: () -> Unit,
    alIrAPerfil: () -> Unit,
    alIrANotificaciones: () -> Unit,
) {
    var restaurante by remember { mutableStateOf<Restaurante?>(null) }
    var promociones by remember { mutableStateOf<List<Promocion>>(emptyList()) }
    var cargando by remember { mutableStateOf(true) }

    val cliente by vm.cliente.collectAsState()
    val servicio by vm.servicio.collectAsState()
    val noLeidas by vm.noLeidas.collectAsState()

    LaunchedEffect(Unit) {
        restaurante = repo.restaurante().datosONull()
        promociones = repo.promociones().datosONull() ?: emptyList()
        vm.refrescarNoLeidas()
        cargando = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(restaurante?.nombre ?: "SIGR", style = MaterialTheme.typography.titleLarge)
                        cliente?.let {
                            Text(
                                "Hola, ${it.nombre.substringBefore(' ')}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = alIrANotificaciones) {
                        // El globo va sobre el icono, con el número dentro:
                        // un punto sin cifra no dice cuántos avisos hay.
                        BadgedBox(badge = {
                            if (noLeidas > 0) Badge { Text(noLeidas.toString()) }
                        }) {
                            Icon(Icons.Default.Notifications, contentDescription = "Notificaciones")
                        }
                    }
                    IconButton(onClick = alIrAPerfil) {
                        Icon(Icons.Default.Person, contentDescription = "Mi perfil")
                    }
                },
            )
        },
    ) { relleno ->
        if (cargando) {
            Box(Modifier.fillMaxSize().padding(relleno), contentAlignment = Alignment.Center) {
                Cargando()
            }
            return@Scaffold
        }

        LazyColumn(
            Modifier.fillMaxSize().padding(relleno),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // --- Ficha del restaurante ---
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        restaurante?.descripcion?.let {
                            Text(it, style = MaterialTheme.typography.bodyLarge)
                            Spacer(Modifier.height(12.dp))
                        }
                        restaurante?.horario?.let { DatoRestaurante("🕐", "Horario", it) }
                        restaurante?.direccion?.let { DatoRestaurante("📍", "Dirección", it) }
                        restaurante?.telefono?.let { DatoRestaurante("📞", "Teléfono", it) }
                    }
                }
            }

            // --- Accesos ---
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AccesoGrande(
                        icono = "🍽",
                        titulo = "Ver la carta",
                        subtitulo = if (servicio.domicilios) "Pedir a domicilio" else "Domicilios cerrados",
                        habilitado = true,
                        alPulsar = alIrAMenu,
                        modifier = Modifier.weight(1f),
                    )
                    AccesoGrande(
                        icono = "📅",
                        titulo = "Reservar",
                        subtitulo = if (servicio.reservas) "Aparta tu mesa" else "Cerrado ahora",
                        // Si el administrador cerró las reservas, el acceso se
                        // desactiva y lo dice. Es solo claridad: la API lo
                        // rechazaría igualmente con un 503.
                        habilitado = servicio.reservas,
                        alPulsar = alIrAReservas,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            if (!servicio.domicilios) {
                item {
                    Aviso(
                        "Los pedidos a domicilio están cerrados en este momento. " +
                            "Puede ver la carta y reservar mesa.",
                        TipoAviso.ALERTA,
                    )
                }
            }

            // --- Promociones ---
            if (promociones.isNotEmpty()) {
                item {
                    Text(
                        "Promociones",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }
                item {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(promociones) { promo ->
                            Card(
                                Modifier.width(260.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                                ),
                            ) {
                                Column(Modifier.padding(16.dp)) {
                                    Text(
                                        promo.titulo,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    Spacer(Modifier.height(6.dp))
                                    Text(promo.cuerpo, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DatoRestaurante(icono: String, etiqueta: String, valor: String) {
    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        Text(icono)
        Spacer(Modifier.width(10.dp))
        Column {
            Text(etiqueta, style = MaterialTheme.typography.bodySmall, color = TextoTenue)
            Text(valor, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun AccesoGrande(
    icono: String,
    titulo: String,
    subtitulo: String,
    habilitado: Boolean,
    alPulsar: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = alPulsar,
        enabled = habilitado,
        modifier = modifier.heightIn(min = 120.dp),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.Center) {
            Text(icono, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text(titulo, style = MaterialTheme.typography.titleMedium)
            Text(subtitulo, style = MaterialTheme.typography.bodySmall, color = TextoTenue)
        }
    }
}
