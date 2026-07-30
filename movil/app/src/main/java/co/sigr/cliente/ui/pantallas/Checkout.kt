package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.*
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.datos.repo.datosONull
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TargetTactil
import co.sigr.cliente.ui.tema.TextoTenue
import kotlinx.coroutines.launch

/**
 * Confirmación del pedido a domicilio: dónde se entrega y cómo se paga.
 *
 * LA COTIZACIÓN LA HACE EL SERVIDOR, en cuanto se mueve el pin. Es la misma
 * función que usa el administrador al previsualizar una coordenada en el panel
 * web (`servicios/entregas.js`), así que lo que ve el cliente aquí y lo que ve
 * el administrador allí no pueden discrepar.
 *
 * El servidor responde 200 aunque NO haya cobertura, con un motivo. Eso permite
 * distinguir dos situaciones que se resuelven de forma distinta:
 *   fuera_de_cobertura → mover el pin
 *   pedido_minimo      → volver al carrito y añadir platos
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaCheckout(
    repo: RepoSigr,
    vm: EstadoAppVm,
    alVolver: () -> Unit,
    alTerminar: () -> Unit,
) {
    val cliente by vm.cliente.collectAsState()
    val carrito by vm.carrito.collectAsState()

    var zonas by remember { mutableStateOf<List<ZonaEntrega>>(emptyList()) }
    var direcciones by remember { mutableStateOf<List<Direccion>>(emptyList()) }
    var metodos by remember { mutableStateOf<List<MetodoPago>>(emptyList()) }

    var lat by remember { mutableDoubleStateOf(0.0) }
    var lng by remember { mutableDoubleStateOf(0.0) }
    var direccion by remember { mutableStateOf("") }
    var referencia by remember { mutableStateOf("") }
    var telefono by remember { mutableStateOf(cliente?.telefono.orEmpty()) }
    var metodoPago by remember { mutableStateOf("contra_entrega") }
    var pagaCon by remember { mutableStateOf("") }
    var notas by remember { mutableStateOf("") }

    var cotizacion by remember { mutableStateOf<Cotizacion?>(null) }
    var cotizando by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var campos by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var enviando by remember { mutableStateOf(false) }

    val alcance = rememberCoroutineScope()
    val subtotal = vm.subtotalCarrito

    // Punto de partida: la dirección predeterminada del cliente si tiene, y si
    // no, el centro de la primera zona de cobertura. Abrir el mapa en medio del
    // océano obligaría a buscar la ciudad a mano.
    LaunchedEffect(Unit) {
        zonas = repo.zonasEntrega().datosONull() ?: emptyList()
        direcciones = repo.direcciones().datosONull() ?: emptyList()
        // Los metodos los publica el administrador: aqui no hay ninguna lista
        // escrita a mano que se quede desfasada cuando active o desactive uno.
        metodos = repo.metodosPago().datosONull() ?: emptyList()
        metodos.firstOrNull()?.let { metodoPago = it.codigo }

        val predeterminada = direcciones.firstOrNull { it.predeterminada } ?: direcciones.firstOrNull()
        if (predeterminada != null) {
            lat = predeterminada.lat
            lng = predeterminada.lng
            direccion = predeterminada.direccion
            referencia = predeterminada.referencia.orEmpty()
        } else {
            zonas.firstOrNull()?.let { lat = it.centroLat; lng = it.centroLng }
        }
    }

    // Recotiza al mover el pin o al cambiar el carrito.
    LaunchedEffect(lat, lng, subtotal) {
        if (lat == 0.0 && lng == 0.0) return@LaunchedEffect
        cotizando = true
        cotizacion = repo.cotizar(lat, lng, Formato.aTextoApi(subtotal)).datosONull()
        cotizando = false
    }

    fun enviar() {
        error = null
        campos = emptyMap()

        if (direccion.isBlank()) {
            campos = mapOf("direccion" to "Escriba la dirección de entrega.")
            return
        }
        if (telefono.isBlank()) {
            campos = mapOf("telefonoContacto" to "Indique un teléfono de contacto.")
            return
        }

        enviando = true
        alcance.launch {
            val peticion = PeticionPedido(
                lineas = carrito.map {
                    LineaNueva(
                        idProducto = it.idProducto,
                        cantidad = it.cantidad,
                        notas = it.notas,
                        modificadores = it.modificadores.map { m -> m.id },
                    )
                },
                direccion = direccion.trim(),
                referencia = referencia.trim().ifBlank { null },
                lat = lat, lng = lng,
                telefonoContacto = telefono.trim(),
                metodoPago = metodoPago,
                pagaCon = pagaCon.trim().ifBlank { null },
                notas = notas.trim().ifBlank { null },
            )
            when (val r = repo.crearPedido(peticion)) {
                is Resultado.Exito -> alTerminar()
                is Resultado.Fallo -> { error = r.mensaje; campos = r.campos }
                is Resultado.SinConexion -> error = r.mensaje
            }
            enviando = false
        }
    }

    val puedePedir = cotizacion?.cubierto == true && carrito.isNotEmpty()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Entrega y pago") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
            )
        },
        bottomBar = {
            Surface(shadowElevation = 8.dp) {
                Column(Modifier.padding(16.dp)) {
                    ResumenImportes(subtotal, cotizacion)
                    Spacer(Modifier.height(12.dp))
                    BotonPrincipal(
                        texto = if (puedePedir) "Confirmar pedido" else "Revise la entrega",
                        alPulsar = ::enviar,
                        habilitado = puedePedir,
                        cargando = enviando,
                    )
                }
            }
        },
    ) { relleno ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(relleno)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            error?.let {
                Aviso(it, TipoAviso.ERROR)
                Spacer(Modifier.height(12.dp))
            }

            Text("¿Dónde se lo llevamos?", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                "Toque el mapa o arrastre el pin. Las áreas coloreadas son las zonas a las que llegamos.",
                style = MaterialTheme.typography.bodySmall,
                color = TextoTenue,
            )
            Spacer(Modifier.height(12.dp))

            MapaEntrega(
                latitud = lat,
                longitud = lng,
                zonas = zonas,
                alMoverPin = { nuevaLat, nuevaLng -> lat = nuevaLat; lng = nuevaLng },
                modifier = Modifier.fillMaxWidth().height(280.dp),
            )

            Spacer(Modifier.height(12.dp))
            EstadoCobertura(cotizacion, cotizando)

            // Las direcciones guardadas: elegir una es más rápido y menos
            // propenso a error que volver a buscarla en el mapa.
            if (direcciones.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Text("Mis direcciones", style = MaterialTheme.typography.titleMedium)
                direcciones.forEach { d ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = TargetTactil)
                            .selectable(
                                selected = direccion == d.direccion,
                                role = Role.RadioButton,
                                onClick = {
                                    lat = d.lat; lng = d.lng
                                    direccion = d.direccion
                                    referencia = d.referencia.orEmpty()
                                },
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = direccion == d.direccion, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(d.etiqueta, style = MaterialTheme.typography.bodyMedium)
                            Text(d.direccion, style = MaterialTheme.typography.bodySmall, color = TextoTenue)
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            CampoTexto(
                valor = direccion, alCambiar = { direccion = it },
                etiqueta = "Dirección",
                error = campos["direccion"],
                ayuda = "Calle, número, apartamento.",
            )
            CampoTexto(
                valor = referencia, alCambiar = { referencia = it },
                etiqueta = "Referencia (opcional)",
                ayuda = "Portón verde, junto a la farmacia…",
            )
            CampoTexto(
                valor = telefono, alCambiar = { telefono = it },
                etiqueta = "Teléfono de contacto",
                error = campos["telefonoContacto"],
                tipoTeclado = KeyboardType.Phone,
            )

            Spacer(Modifier.height(16.dp))
            Text("¿Cómo paga?", style = MaterialTheme.typography.titleMedium)

            if (metodos.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Aviso("Cargando las formas de pago…", TipoAviso.INFO)
            }

            metodos.forEach { m ->
                val elegido = metodoPago == m.codigo
                Column(
                    Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = elegido,
                            role = Role.RadioButton,
                            onClick = { metodoPago = m.codigo },
                        )
                ) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = TargetTactil),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = elegido, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(iconoMetodo(m.codigo) + "  " + m.nombre)
                            Text(
                                if (m.requiereComprobante) "Transfiere y envía el comprobante"
                                else "Paga al recibir el pedido",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextoTenue,
                            )
                        }
                    }

                    // Los datos de la cuenta se enseñan SOLO del método
                    // elegido: mostrarlos todos a la vez invita a transferir
                    // a la cuenta equivocada.
                    if (elegido && m.requiereComprobante) {
                        DatosCuenta(m)
                    }
                }
            }

            // Solo tiene sentido en contra entrega: es lo que decide cuánto
            // cambio tiene que llevar el repartidor. En los métodos digitales
            // el cliente transfiere el importe exacto.
            if (metodoPago == "contra_entrega") {
                CampoTexto(
                    valor = pagaCon, alCambiar = { pagaCon = it },
                    etiqueta = "¿Con cuánto paga? (opcional)",
                    error = campos["pagaCon"],
                    ayuda = "Así el repartidor lleva el cambio exacto.",
                    tipoTeclado = KeyboardType.Number,
                )
            }

            CampoTexto(
                valor = notas, alCambiar = { notas = it },
                etiqueta = "Notas para la entrega (opcional)",
                lineas = 2,
            )

            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * Dice si llegamos, con el motivo exacto cuando no.
 *
 * Los tres casos llevan icono y texto, nunca solo color: "sí llegamos",
 * "llegamos pero falta pedido mínimo" y "no llegamos" son tres respuestas
 * distintas con tres acciones distintas.
 */
@Composable
private fun EstadoCobertura(cotizacion: Cotizacion?, cotizando: Boolean) {
    when {
        cotizando -> Aviso("Comprobando si llegamos a esa dirección…", TipoAviso.INFO)

        cotizacion == null -> Aviso("Mueva el pin a la dirección de entrega.", TipoAviso.INFO)

        cotizacion.cubierto -> Aviso(
            "Sí llegamos. Zona ${cotizacion.zona?.nombre}, " +
                "envío ${Formato.dinero(cotizacion.costoEnvio)}, " +
                "entrega en unos ${cotizacion.tiempoEstimadoMin} minutos.",
            TipoAviso.EXITO,
        )

        cotizacion.motivo == "pedido_minimo" -> Aviso(
            "Llegamos a esa dirección, pero el pedido mínimo de la zona es " +
                "${Formato.dinero(cotizacion.pedidoMinimo)}. " +
                "Le faltan ${Formato.dinero(cotizacion.faltaParaMinimo)} — añada algo más a su pedido.",
            TipoAviso.ALERTA,
        )

        else -> Aviso(
            "No hacemos entregas en esa dirección. Pruebe con otra ubicación dentro de las áreas coloreadas.",
            TipoAviso.ERROR,
        )
    }
}

/** Desglose de importes. El total sale del servidor en cuanto hay cobertura. */
@Composable
private fun ResumenImportes(subtotal: java.math.BigDecimal, cotizacion: Cotizacion?) {
    Column {
        Fila("Subtotal", Formato.dinero(subtotal))
        if (cotizacion?.cubierto == true) {
            Fila("Envío", Formato.dinero(cotizacion.costoEnvio))
            Spacer(Modifier.height(4.dp))
            Text(
                // No se suma aquí un "total": los impuestos los calcula el
                // servidor y mostrar una cifra que luego cambie sería peor que
                // no mostrar ninguna.
                "Los impuestos se calculan al confirmar.",
                style = MaterialTheme.typography.bodySmall,
                color = TextoTenue,
            )
        }
    }
}

@Composable
private fun Fila(etiqueta: String, valor: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(etiqueta, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(valor, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}

/** Un icono por método, para reconocerlo de un vistazo. */
fun iconoMetodo(codigo: String): String = when (codigo) {
    "contra_entrega" -> "💵"
    "nequi" -> "💜"
    "bancolombia" -> "🏦"
    "daviplata" -> "❤️"
    else -> "💳"
}

/**
 * Datos de la cuenta a la que transferir.
 *
 * Se enseñan SOLO del método elegido: mostrarlos todos a la vez es la forma
 * más rápida de que alguien transfiera a la cuenta equivocada.
 *
 * El botón de copiar existe porque teclear a mano un número de cuenta desde
 * otra pantalla es justo donde se cometen los errores caros.
 */
@Composable
private fun DatosCuenta(metodo: MetodoPago) {
    val portapapeles = LocalClipboardManager.current
    var copiado by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 40.dp, bottom = 8.dp)
            .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Text(
            "Transfiera a esta cuenta y luego adjunte el comprobante:",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
        Spacer(Modifier.height(8.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                metodo.llave.orEmpty(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = {
                portapapeles.setText(AnnotatedString(metodo.llave.orEmpty()))
                copiado = true
            }) { Text(if (copiado) "✓ Copiado" else "Copiar") }
        }

        metodo.titular?.let {
            Text("A nombre de: $it", style = MaterialTheme.typography.bodyMedium)
        }
        listOfNotNull(metodo.tipoCuenta, metodo.banco)
            .takeIf { it.isNotEmpty() }
            ?.let {
                Text(
                    it.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextoTenue,
                )
            }

        Spacer(Modifier.height(8.dp))
        Text(
            // Se avisa ANTES de confirmar, no después: el cliente tiene que
            // saber que su pedido no empieza a cocinarse hasta que alguien
            // mire su comprobante.
            "Al confirmar le pediremos la foto del comprobante. El restaurante lo revisa " +
                "y solo entonces empieza a preparar su pedido.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}
