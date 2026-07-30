package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import co.sigr.cliente.datos.red.*
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.Formato
import co.sigr.cliente.ui.LineaCarrito
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TargetTactil
import co.sigr.cliente.ui.tema.TextoTenue
import kotlinx.coroutines.launch

/**
 * La carta.
 *
 * El servidor ya filtra lo que no se puede pedir: solo llegan productos
 * `activo` y `disponible`. Si el cocinero marca un plato como agotado desde el
 * KDS, desaparece de aquí igual que desaparece del comandero (CA-02). La app no
 * tiene que saber nada de eso.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaMenu(repo: RepoSigr, alAbrirPlato: (Int) -> Unit) {
    var menu by remember { mutableStateOf<RespuestaMenu?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var categoriaSel by remember { mutableStateOf<Int?>(null) }
    var cargando by remember { mutableStateOf(true) }
    val alcance = rememberCoroutineScope()

    fun cargar() {
        cargando = true
        error = null
        alcance.launch {
            when (val r = repo.menu()) {
                is Resultado.Exito -> menu = r.datos
                is Resultado.Fallo -> error = r.mensaje
                is Resultado.SinConexion -> error = r.mensaje
            }
            cargando = false
        }
    }

    LaunchedEffect(Unit) { cargar() }

    Scaffold(topBar = { TopAppBar(title = { Text("Nuestra carta") }) }) { relleno ->
        Box(Modifier.fillMaxSize().padding(relleno)) {
            when {
                cargando -> Cargando()
                error != null -> ErrorConReintento(error!!, alReintentar = ::cargar)
                menu == null || menu!!.productos.isEmpty() -> EstadoVacio(
                    icono = "🍽",
                    titulo = "La carta está vacía",
                    mensaje = "No hay platos disponibles en este momento. Vuelva a intentarlo más tarde.",
                )
                else -> {
                    val visibles = menu!!.productos.filter {
                        categoriaSel == null || it.idCategoria == categoriaSel
                    }

                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 96.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        item {
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                item {
                                    FilterChip(
                                        selected = categoriaSel == null,
                                        onClick = { categoriaSel = null },
                                        label = { Text("Todo") },
                                    )
                                }
                                items(menu!!.categorias) { c ->
                                    FilterChip(
                                        selected = categoriaSel == c.id,
                                        onClick = { categoriaSel = c.id },
                                        label = { Text(c.nombre) },
                                    )
                                }
                            }
                        }

                        items(visibles) { p ->
                            TarjetaPlato(p) { alAbrirPlato(p.id) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TarjetaPlato(producto: Producto, alPulsar: () -> Unit) {
    Card(
        onClick = alPulsar,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            AsyncImage(
                model = co.sigr.cliente.datos.red.ClienteHttp.urlAbsoluta(producto.urlImagen),
                // El nombre del plato ya está escrito al lado; repetirlo en la
                // descripción haría que el lector de pantalla lo diga dos veces.
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(84.dp).clip(RoundedCornerShape(10.dp)),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(producto.nombre, style = MaterialTheme.typography.titleMedium)
                producto.descripcion?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = TextoTenue,
                        maxLines = 2,
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    Formato.dinero(producto.precio),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

/**
 * Detalle de un plato: elegir extras, cantidad y notas.
 *
 * Los grupos de modificadores traen `min` y `max` del servidor, y aquí se
 * respetan al pintar (radio si solo cabe uno, casilla si caben varios). La
 * validación real está en el backend: `validarModificadores` en
 * `servicios/ordenes.js` rechaza una combinación inválida aunque el cliente la
 * mande a mano.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaPlato(
    repo: RepoSigr,
    vm: EstadoAppVm,
    idProducto: Int,
    alVolver: () -> Unit,
) {
    var plato by remember { mutableStateOf<ProductoDetalle?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var cantidad by remember { mutableIntStateOf(1) }
    var notas by remember { mutableStateOf("") }
    val elegidos = remember { mutableStateMapOf<Int, OpcionModificador>() }
    val alcance = rememberCoroutineScope()

    LaunchedEffect(idProducto) {
        when (val r = repo.plato(idProducto)) {
            is Resultado.Exito -> plato = r.datos
            is Resultado.Fallo -> error = r.mensaje
            is Resultado.SinConexion -> error = r.mensaje
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(plato?.nombre ?: "Plato") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
            )
        },
        bottomBar = {
            plato?.let { p ->
                Surface(shadowElevation = 8.dp) {
                    Row(
                        Modifier.fillMaxWidth().padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        SelectorCantidad(cantidad, { cantidad = it })
                        Spacer(Modifier.width(12.dp))
                        Button(
                            onClick = {
                                vm.agregarAlCarrito(
                                    LineaCarrito(
                                        idProducto = p.id,
                                        nombre = p.nombre,
                                        urlImagen = p.urlImagen,
                                        precioUnitario = p.precio,
                                        cantidad = cantidad,
                                        notas = notas.trim().ifBlank { null },
                                        modificadores = elegidos.values.toList(),
                                    )
                                )
                                alVolver()
                            },
                            modifier = Modifier.weight(1f).heightIn(min = TargetTactil),
                        ) { Text("Añadir · ${Formato.dinero(p.precio)}") }
                    }
                }
            }
        },
    ) { relleno ->
        when {
            error != null -> ErrorConReintento(error!!, Modifier.padding(relleno))
            plato == null -> Box(Modifier.fillMaxSize().padding(relleno)) { Cargando() }
            else -> {
                val p = plato!!
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(relleno)
                        .verticalScroll(rememberScrollState()),
                ) {
                    AsyncImage(
                        model = co.sigr.cliente.datos.red.ClienteHttp.urlAbsoluta(p.urlImagen),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().height(220.dp),
                    )

                    Column(Modifier.padding(20.dp)) {
                        Text(p.nombre, style = MaterialTheme.typography.headlineSmall)
                        p.descripcion?.let {
                            Spacer(Modifier.height(8.dp))
                            Text(it, style = MaterialTheme.typography.bodyLarge, color = TextoTenue)
                        }

                        p.grupos.forEach { grupo ->
                            Spacer(Modifier.height(24.dp))
                            Text(grupo.nombre, style = MaterialTheme.typography.titleMedium)
                            Text(
                                // Se dice explícitamente si hay que elegir algo:
                                // un grupo obligatorio sin avisar acaba en un
                                // error del servidor que sorprende al cliente.
                                if (grupo.min > 0) "Elija al menos ${grupo.min}"
                                else "Opcional · hasta ${grupo.max}",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextoTenue,
                            )
                            Spacer(Modifier.height(4.dp))

                            grupo.opciones.forEach { opcion ->
                                val marcada = elegidos[opcion.id] != null
                                val unaSola = grupo.max <= 1

                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = TargetTactil)
                                        .then(
                                            if (unaSola) Modifier.selectable(
                                                selected = marcada,
                                                role = Role.RadioButton,
                                                onClick = {
                                                    grupo.opciones.forEach { elegidos.remove(it.id) }
                                                    elegidos[opcion.id] = opcion
                                                },
                                            )
                                            else Modifier.toggleable(
                                                value = marcada,
                                                role = Role.Checkbox,
                                                onValueChange = { activar ->
                                                    if (activar) {
                                                        val yaMarcados = grupo.opciones.count { elegidos[it.id] != null }
                                                        if (yaMarcados < grupo.max) elegidos[opcion.id] = opcion
                                                    } else elegidos.remove(opcion.id)
                                                },
                                            )
                                        ),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    if (unaSola) RadioButton(selected = marcada, onClick = null)
                                    else Checkbox(checked = marcada, onCheckedChange = null)

                                    Spacer(Modifier.width(8.dp))
                                    Text(opcion.nombre, Modifier.weight(1f))
                                    if (Formato.aDecimal(opcion.precioExtra).signum() > 0) {
                                        Text(
                                            "+${Formato.dinero(opcion.precioExtra)}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                            }
                        }

                        Spacer(Modifier.height(24.dp))
                        CampoTexto(
                            valor = notas,
                            alCambiar = { notas = it },
                            etiqueta = "Notas para la cocina",
                            ayuda = "Alergias, punto de cocción, sin cebolla…",
                            lineas = 2,
                        )
                        Spacer(Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}
