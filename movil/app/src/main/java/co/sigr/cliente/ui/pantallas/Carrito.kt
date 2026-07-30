package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TextoTenue

/**
 * El carrito antes de pagar.
 *
 * El total que se ve aquí es SOLO EL SUBTOTAL, y así se dice: falta el envío,
 * que depende de dónde se entregue, y los impuestos. Enseñar un número grande
 * llamado "Total" que luego cambia en el checkout es la forma más rápida de
 * que el cliente desconfíe. El importe definitivo lo calcula el servidor
 * (FSD 5.7).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaCarrito(
    vm: EstadoAppVm,
    alVolver: () -> Unit,
    alPagar: () -> Unit,
) {
    val carrito by vm.carrito.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Mi pedido") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
                actions = {
                    if (carrito.isNotEmpty()) {
                        TextButton(onClick = { vm.vaciarCarrito() }) { Text("Vaciar") }
                    }
                },
            )
        },
        bottomBar = {
            if (carrito.isNotEmpty()) {
                Surface(shadowElevation = 8.dp) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth()) {
                            Text("Subtotal", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                            Text(
                                Formato.dinero(vm.subtotalCarrito),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        Text(
                            "El envío y los impuestos se calculan al elegir la dirección.",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextoTenue,
                        )
                        Spacer(Modifier.height(12.dp))
                        BotonPrincipal("Continuar con la entrega", alPagar)
                    }
                }
            }
        },
    ) { relleno ->
        if (carrito.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(relleno), contentAlignment = Alignment.Center) {
                EstadoVacio(
                    icono = "🛒",
                    titulo = "Su pedido está vacío",
                    mensaje = "Añada platos desde la carta y aparecerán aquí.",
                    textoAccion = "Ver la carta",
                    alPulsarAccion = alVolver,
                )
            }
            return@Scaffold
        }

        LazyColumn(
            Modifier.fillMaxSize().padding(relleno),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(carrito, key = { it.clave }) { linea ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.Top) {
                            Column(Modifier.weight(1f)) {
                                Text(linea.nombre, style = MaterialTheme.typography.titleMedium)

                                if (linea.modificadores.isNotEmpty()) {
                                    Text(
                                        "» " + linea.modificadores.joinToString(", ") { it.nombre },
                                        style = MaterialTheme.typography.bodySmall,
                                        color = TextoTenue,
                                    )
                                }
                                // La nota se destaca: es lo que la cocina tiene
                                // que leer sí o sí, y suele ser una alergia.
                                linea.notas?.let { nota ->
                                    Spacer(Modifier.height(6.dp))
                                    Aviso(nota, TipoAviso.ALERTA)
                                }
                            }
                            IconButton(onClick = { vm.quitarDelCarrito(linea.clave) }) {
                                Icon(
                                    Icons.Default.Delete,
                                    contentDescription = "Quitar ${linea.nombre} del pedido",
                                )
                            }
                        }

                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            SelectorCantidad(
                                cantidad = linea.cantidad,
                                alCambiar = { vm.cambiarCantidad(linea.clave, it) },
                                minimo = 0,
                            )
                            Spacer(Modifier.weight(1f))
                            Text(
                                Formato.dinero(linea.subtotalLinea),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
        }
    }
}
