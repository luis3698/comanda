package co.sigr.cliente.ui.pantallas

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
 *
 * ORGANIZACIÓN
 * Una bandeja crece sin parar: en un mes son decenas de avisos de pedidos
 * mezclados con promociones. Se ordena de dos formas a la vez —filtro por tipo
 * arriba, y separadores de «Hoy / Ayer / Anteriores» dentro— para que encontrar
 * «¿a qué hora dijeron que salía mi pedido?» no sea desplazarse a ciegas.
 */

/** Filtros de la barra superior. `tipo` a null significa «todos». */
private enum class Filtro(val etiqueta: String, val tipo: String?) {
    TODOS("Todos", null),
    PEDIDOS("Pedidos", "pedido"),
    RESERVAS("Reservas", "reserva"),
    PROMOS("Ofertas", "promocion"),
}

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
    var filtro by remember { mutableStateOf(Filtro.TODOS) }
    var confirmarLimpiar by remember { mutableStateOf(false) }

    val alcance = rememberCoroutineScope()
    val anfitrionMensajes = remember { SnackbarHostState() }

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

    /**
     * Borrado con deshacer.
     *
     * La tarjeta desaparece ANTES de hablar con el servidor. Es lo que hace que
     * el gesto se sienta instantáneo, y es seguro porque el peor caso —que la
     * petición falle— se resuelve devolviéndola a su sitio y diciéndolo.
     *
     * El «Deshacer» no es un adorno: deslizar es un gesto fácil de hacer sin
     * querer mientras se recorre una lista, y sin vuelta atrás el cliente
     * perdería el aviso con el código de su reserva y sin forma de recuperarlo.
     * Solo se manda el borrado al servidor si el plazo del mensaje se agota sin
     * que nadie lo deshaga.
     */
    fun borrarConDeshacer(aviso: Notificacion) {
        val listaPrevia = avisos
        avisos = avisos.filterNot { it.id == aviso.id }
        if (!aviso.leida) noLeidas = (noLeidas - 1).coerceAtLeast(0)

        alcance.launch {
            val resultado = anfitrionMensajes.showSnackbar(
                message = "Aviso eliminado",
                actionLabel = "Deshacer",
                duration = SnackbarDuration.Short,
                withDismissAction = true,
            )

            if (resultado == SnackbarResult.ActionPerformed) {
                // Nunca llegó a salir del móvil: basta con restaurar la lista.
                avisos = listaPrevia
                if (!aviso.leida) noLeidas += 1
                return@launch
            }

            if (!repo.borrarNotificacion(aviso.id)) {
                avisos = listaPrevia
                if (!aviso.leida) noLeidas += 1
                anfitrionMensajes.showSnackbar("No se pudo eliminar. Revise su conexión.")
            }
            vm.refrescarNoLeidas()
        }
    }

    val visibles = remember(avisos, filtro) {
        if (filtro.tipo == null) avisos else avisos.filter { it.tipo == filtro.tipo }
    }
    val leidas = remember(avisos) { avisos.count { it.leida } }

    Scaffold(
        snackbarHost = { SnackbarHost(anfitrionMensajes) },
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Text("Avisos")
                            // El recuento en el propio título ahorra contar
                            // puntos azules a ojo.
                            if (noLeidas > 0) {
                                Text(
                                    "$noLeidas sin leer",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextoTenue,
                                )
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = alVolver) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                        }
                    },
                    actions = {
                        // Cada acción aparece solo si tiene algo que hacer: un
                        // botón que no hace nada es peor que ningún botón.
                        if (noLeidas > 0) {
                            TextButton(onClick = {
                                alcance.launch { repo.marcarTodasLeidas(); cargar() }
                            }) { Text("Marcar todo") }
                        }
                        if (leidas > 0) {
                            IconButton(onClick = { confirmarLimpiar = true }) {
                                Icon(Icons.Filled.Delete, contentDescription = "Vaciar los avisos leídos")
                            }
                        }
                    },
                )

                // Los filtros solo estorban cuando hay poco que filtrar.
                if (avisos.size >= 4) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Filtro.entries.forEach { f ->
                            val cuantos = if (f.tipo == null) avisos.size
                                          else avisos.count { it.tipo == f.tipo }
                            // Un filtro que dejaría la lista vacía no se ofrece.
                            if (cuantos > 0) {
                                FilterChip(
                                    selected = filtro == f,
                                    onClick = { filtro = f },
                                    label = { Text("${f.etiqueta} ($cuantos)") },
                                )
                            }
                        }
                    }
                }
            }
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
                visibles.isEmpty() -> EstadoVacio(
                    icono = "🔎",
                    titulo = "Nada en «${filtro.etiqueta}»",
                    mensaje = "Pruebe con otro filtro para ver el resto de sus avisos.",
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // `key` es OBLIGATORIO aquí, no una optimización: sin él
                    // Compose identifica las filas por su posición, y al borrar
                    // una el estado del deslizamiento se queda pegado a la
                    // posición —no a la tarjeta—, así que la de abajo aparece ya
                    // deslizada y se borra sola.
                    items(visibles, key = { it.id }) { n ->
                        val previa = visibles.getOrNull(visibles.indexOf(n) - 1)
                        val grupo = grupoDe(n.creadoEn)

                        if (previa == null || grupoDe(previa.creadoEn) != grupo) {
                            Text(
                                grupo,
                                style = MaterialTheme.typography.labelLarge,
                                color = TextoTenue,
                                modifier = Modifier.padding(top = if (previa == null) 0.dp else 8.dp),
                            )
                        }

                        AvisoDeslizable(
                            aviso = n,
                            alBorrar = { borrarConDeshacer(n) },
                            alPulsar = {
                                if (!n.leida) {
                                    // Se marca en la lista al momento y se avisa
                                    // al servidor después: recargar la pantalla
                                    // entera por un punto azul hace saltar la
                                    // lista bajo el dedo.
                                    avisos = avisos.map {
                                        if (it.id == n.id) it.copy(leida = true) else it
                                    }
                                    noLeidas = (noLeidas - 1).coerceAtLeast(0)
                                    alcance.launch { repo.marcarLeida(n.id); vm.refrescarNoLeidas() }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    if (confirmarLimpiar) {
        AlertDialog(
            onDismissRequest = { confirmarLimpiar = false },
            title = { Text("¿Vaciar los avisos leídos?") },
            text = {
                Text(
                    "Se eliminarán los $leidas aviso(s) que ya leyó. " +
                        if (noLeidas > 0) "Los $noLeidas sin leer se conservan." else ""
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmarLimpiar = false
                    alcance.launch { repo.borrarNotificacionesLeidas(); cargar() }
                }) { Text("Vaciar") }
            },
            dismissButton = {
                TextButton(onClick = { confirmarLimpiar = false }) { Text("Cancelar") }
            },
        )
    }
}

/**
 * Agrupa por cercanía en el tiempo.
 *
 * Se compara sobre la cadena 'YYYY-MM-DD HH:mm:ss' que manda el servidor, sin
 * convertirla a fecha: el servidor ya la escribe en la zona horaria del
 * restaurante (`dateStrings` en server/db.js), y pasarla por el reloj del móvil
 * la movería si el cliente tiene otra zona configurada.
 */
private fun grupoDe(creadoEn: String?): String {
    // Sin fecha cae en «Anteriores»: es el grupo que no promete nada. Ponerlo
    // en «Hoy» sería afirmar algo que no se sabe.
    val dia = creadoEn?.take(10) ?: return "Anteriores"
    val hoy = java.time.LocalDate.now().toString()
    val ayer = java.time.LocalDate.now().minusDays(1).toString()
    return when (dia) {
        hoy -> "Hoy"
        ayer -> "Ayer"
        else -> "Anteriores"
    }
}

private fun iconoDe(tipo: String): String = when (tipo) {
    "reserva" -> "📅"
    "pedido" -> "🛵"
    "promocion" -> "🎉"
    else -> "ℹ"
}

/**
 * Tarjeta que se puede deslizar a cualquiera de los dos lados para eliminarla.
 *
 * SE ACEPTAN LOS DOS SENTIDOS a propósito. Cuál es «el natural» depende de la
 * mano con la que se sujete el teléfono y de a qué esté acostumbrado cada uno,
 * y no hay ninguna razón para que uno de los dos no haga nada.
 *
 * NO ES EL ÚNICO CAMINO. El botón de la barra vacía los leídos de una vez, así
 * que quien no pueda hacer el gesto —temblor, una sola mano ocupada, un lector
 * de pantalla— tiene una alternativa. Es la misma regla que ya cumplen el
 * diseñador de salón y las zonas de entrega en la web: todo arrastre tiene
 * salida por teclado o por botón.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AvisoDeslizable(
    aviso: Notificacion,
    alBorrar: () -> Unit,
    alPulsar: () -> Unit,
) {
    val estado = rememberSwipeToDismissBoxState(
        // Hay que recorrer más de la mitad del ancho. El umbral por defecto es
        // bastante menos, y con tarjetas apiladas se dispara sin querer al
        // desplazar la lista en diagonal.
        positionalThreshold = { ancho -> ancho * 0.55f },
    )

    // El fondo rojo entra progresivamente en vez de aparecer de golpe: así el
    // gesto avisa de lo que va a pasar y se puede abortar a tiempo.
    val avance by animateFloatAsState(
        targetValue = if (estado.targetValue == SwipeToDismissBoxValue.Settled) 0f else 1f,
        label = "avanceBorrado",
    )

    LaunchedEffect(estado.currentValue) {
        if (estado.currentValue != SwipeToDismissBoxValue.Settled) alBorrar()
    }

    SwipeToDismissBox(
        state = estado,
        backgroundContent = {
            Box(
                Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.errorContainer.copy(alpha = avance))
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                // El icono se pinta a los dos lados porque el gesto vale en los
                // dos sentidos y el fondo debe leerse venga de donde venga.
                Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                    IconoBorrar()
                    Spacer(Modifier.weight(1f))
                    IconoBorrar()
                }
            }
        },
        content = { TarjetaAviso(aviso, alPulsar) },
    )
}

@Composable
private fun IconoBorrar() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Filled.Delete,
            // Texto además del icono y del color: 6.4 prohíbe comunicar solo
            // con color, y aquí el rojo por sí solo no dice qué va a ocurrir.
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onErrorContainer,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            "Eliminar",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
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
