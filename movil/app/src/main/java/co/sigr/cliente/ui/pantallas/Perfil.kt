package co.sigr.cliente.ui.pantallas

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import co.sigr.cliente.datos.red.ClienteHttp
import co.sigr.cliente.datos.red.Direccion
import co.sigr.cliente.datos.red.PeticionDireccion
import co.sigr.cliente.datos.red.ZonaEntrega
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.datos.repo.datosONull
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TargetTactil
import co.sigr.cliente.ui.tema.TextoTenue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Tope de tamaño de la foto, en bytes. Es el mismo que impone el servidor
 * (`servicios/imagenes.js`); aquí se repite para no gastar la subida entera
 * antes de que la rechacen al otro lado.
 */
private const val MAX_FOTO_BYTES = 2L * 1024 * 1024

/**
 * Copia el contenido de un `content://` a un archivo temporal.
 *
 * Hace falta porque Retrofit sube un File y lo que entrega el selector es una
 * URI con un permiso de lectura prestado, que además caduca. La extensión da
 * igual: el servidor identifica el formato real por los primeros bytes del
 * archivo y no se fía del nombre.
 *
 * Devuelve null si la URI no se puede leer, en vez de lanzar: elegir una foto
 * de una nube que ya no responde no debe cerrar la aplicación.
 */
private fun copiarACache(contexto: Context, uri: Uri): File? = try {
    contexto.contentResolver.openInputStream(uri)?.use { entrada ->
        val destino = File.createTempFile("foto_", ".img", contexto.cacheDir)
        destino.outputStream().use { entrada.copyTo(it) }
        destino
    }
} catch (e: Exception) {
    null
}

/**
 * Perfil del cliente.
 *
 * QUÉ SE PUEDE CAMBIAR Y QUÉ NO
 * Nombre, teléfono, foto, correo, contraseña y direcciones: sí. **La cédula
 * no**, y no es un olvido: identifica a la persona en las facturas ya
 * emitidas, así que cambiarla dejaría el histórico apuntando a otra persona.
 * Se muestra deshabilitada con esa explicación, en vez de esconderla y dejar
 * que el cliente la busque.
 *
 * Cambiar el correo o la contraseña exige confirmar la contraseña actual: el
 * correo es la vía de recuperación de la cuenta, así que quien pudiera
 * cambiarlo sin más se quedaría con ella si encuentra un móvil desbloqueado.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaPerfil(
    repo: RepoSigr,
    vm: EstadoAppVm,
    alVolver: () -> Unit,
    alIrADirecciones: () -> Unit,
) {
    val cliente by vm.cliente.collectAsState()

    var nombre by remember(cliente) { mutableStateOf(cliente?.nombre.orEmpty()) }
    var telefono by remember(cliente) { mutableStateOf(cliente?.telefono.orEmpty()) }
    var promociones by remember(cliente) { mutableStateOf(cliente?.aceptaPromociones ?: true) }

    var mensaje by remember { mutableStateOf<String?>(null) }
    var tipoMensaje by remember { mutableStateOf(TipoAviso.EXITO) }
    var guardando by remember { mutableStateOf(false) }

    var dialogoCorreo by remember { mutableStateOf(false) }
    var dialogoPassword by remember { mutableStateOf(false) }
    var dialogoBaja by remember { mutableStateOf(false) }

    val alcance = rememberCoroutineScope()

    // ---- Foto de perfil ----
    //
    // SE USA EL SELECTOR DEL SISTEMA (PickVisualMedia) Y NO EL PERMISO DE
    // GALERÍA. Es la diferencia entre pedirle al cliente acceso a TODAS sus
    // fotos —un diálogo que mucha gente rechaza, y con razón— y que elija una y
    // solo esa llegue a la aplicación. Desde Android 13 lo trae el sistema, y en
    // versiones anteriores la biblioteca lo suple con el selector clásico; en
    // ninguno de los dos casos hace falta declarar READ_MEDIA_IMAGES.
    val contexto = LocalContext.current
    var subiendoFoto by remember { mutableStateOf(false) }

    val selectorFoto = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult   // canceló

        subiendoFoto = true
        mensaje = null
        alcance.launch {
            // La copia a un archivo temporal es obligatoria: Retrofit necesita
            // un File y el content:// del selector es un permiso prestado que
            // se revoca en cuanto la pantalla se va.
            val archivo = withContext(Dispatchers.IO) { copiarACache(contexto, uri) }

            if (archivo == null) {
                tipoMensaje = TipoAviso.ERROR
                mensaje = "No se pudo leer esa imagen. Pruebe con otra."
            } else if (archivo.length() > MAX_FOTO_BYTES) {
                // Se comprueba aquí además de en el servidor para no gastar la
                // subida entera de una foto de 8 MB por la red del cliente
                // antes de que la rechacen.
                archivo.delete()
                tipoMensaje = TipoAviso.ERROR
                mensaje = "La imagen pesa más de 2 MB. Elija una más pequeña."
            } else {
                when (val r = repo.subirFoto(archivo)) {
                    is Resultado.Exito -> {
                        vm.actualizarCliente(r.datos)
                        tipoMensaje = TipoAviso.EXITO
                        mensaje = "Foto actualizada."
                    }
                    is Resultado.Fallo -> {
                        tipoMensaje = TipoAviso.ERROR
                        mensaje = r.campos.values.firstOrNull() ?: r.mensaje
                    }
                    is Resultado.SinConexion -> {
                        tipoMensaje = TipoAviso.ERROR
                        mensaje = r.mensaje
                    }
                }
                // El temporal se borra pase lo que pase: es una copia de una
                // foto personal y no tiene por qué quedarse en el disco.
                withContext(Dispatchers.IO) { archivo.delete() }
            }
            subiendoFoto = false
        }
    }

    val elegirFoto = {
        selectorFoto.launch(
            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Mi perfil") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
            )
        },
    ) { relleno ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(relleno)
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box {
                    // Toda la foto es el botón. Un icono de lápiz al lado sería
                    // un objetivo diminuto; así el área que se pulsa son los
                    // 72 dp del avatar, muy por encima del mínimo táctil.
                    Box(
                        Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .clickable(enabled = !subiendoFoto, onClick = elegirFoto)
                            .semantics {
                                // Sin esto, un lector de pantalla solo anuncia
                                // «imagen»: no habría forma de saber que se
                                // puede tocar para cambiarla.
                                contentDescription = if (cliente?.urlFoto == null)
                                    "Añadir una foto de perfil"
                                else "Cambiar su foto de perfil"
                                role = Role.Button
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (cliente?.urlFoto != null) {
                            AsyncImage(
                                model = ClienteHttp.urlAbsoluta(cliente?.urlFoto),
                                contentDescription = null,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                            )
                        } else {
                            // Sin foto se muestra la inicial, no un hueco gris:
                            // un avatar vacío no invita a nada, y una letra ya
                            // parece «algo tuyo» que se puede personalizar.
                            Text(
                                cliente?.nombre?.trim()?.firstOrNull()?.uppercase() ?: "?",
                                style = MaterialTheme.typography.headlineMedium,
                                color = TextoTenue,
                            )
                        }

                        if (subiendoFoto) {
                            Box(
                                Modifier
                                    .fillMaxSize()
                                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.45f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(28.dp),
                                    strokeWidth = 3.dp,
                                    color = MaterialTheme.colorScheme.onPrimary,
                                )
                            }
                        }
                    }

                    // La insignia de la cámara es SOLO decorativa: anuncia que
                    // la foto se puede tocar. No captura pulsaciones para no
                    // robarle el toque al avatar, que es el objetivo grande.
                    if (!subiendoFoto) {
                        Box(
                            Modifier
                                .align(Alignment.BottomEnd)
                                .size(26.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("📷", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }

                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        cliente?.nombre.orEmpty(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(cliente?.correo.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = TextoTenue)
                    Spacer(Modifier.height(4.dp))
                    // La instrucción por escrito, porque el icono de cámara solo
                    // se entiende si ya se sabe lo que significa.
                    TextButton(
                        onClick = elegirFoto,
                        enabled = !subiendoFoto,
                        contentPadding = PaddingValues(0.dp),
                    ) {
                        Text(
                            if (cliente?.urlFoto == null) "Añadir foto" else "Cambiar foto",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            mensaje?.let {
                Aviso(it, tipoMensaje)
                Spacer(Modifier.height(16.dp))
            }

            Text("Datos personales", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))

            CampoTexto(nombre, { nombre = it }, "Nombre completo", habilitado = !guardando)
            CampoTexto(
                telefono, { telefono = it }, "Teléfono",
                tipoTeclado = KeyboardType.Phone, habilitado = !guardando,
            )
            CampoTexto(
                valor = cliente?.documento.orEmpty(),
                alCambiar = { },
                etiqueta = "Cédula",
                habilitado = false,
                ayuda = "No se puede cambiar: identifica sus facturas.",
            )

            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth().heightIn(min = TargetTactil),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Recibir promociones", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Avisos de ofertas y novedades del restaurante.",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextoTenue,
                    )
                }
                Switch(checked = promociones, onCheckedChange = { promociones = it })
            }

            Spacer(Modifier.height(16.dp))
            BotonPrincipal(
                texto = "Guardar cambios",
                cargando = guardando,
                alPulsar = {
                    guardando = true
                    mensaje = null
                    alcance.launch {
                        val r = repo.actualizarPerfil(nombre.trim(), telefono.trim(), promociones)
                        when (r) {
                            is Resultado.Exito -> {
                                vm.actualizarCliente(r.datos)
                                tipoMensaje = TipoAviso.EXITO
                                mensaje = "Datos actualizados."
                            }
                            is Resultado.Fallo -> {
                                tipoMensaje = TipoAviso.ERROR
                                mensaje = r.campos.values.firstOrNull() ?: r.mensaje
                            }
                            is Resultado.SinConexion -> {
                                tipoMensaje = TipoAviso.ERROR
                                mensaje = r.mensaje
                            }
                        }
                        guardando = false
                    }
                },
            )

            Spacer(Modifier.height(28.dp))
            Text("Cuenta", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))

            FilaAccion("📍", "Mis direcciones", "Dónde entregamos sus pedidos", alIrADirecciones)
            FilaAccion("✉", "Cambiar correo", cliente?.correo.orEmpty()) { dialogoCorreo = true }
            FilaAccion("🔒", "Cambiar contraseña", "Cerrará la sesión en todos sus dispositivos") { dialogoPassword = true }

            Spacer(Modifier.height(24.dp))
            OutlinedButton(
                onClick = { vm.cerrarSesion() },
                modifier = Modifier.fillMaxWidth().heightIn(min = TargetTactil),
            ) { Text("Cerrar sesión") }

            Spacer(Modifier.height(12.dp))
            TextButton(
                onClick = { dialogoBaja = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = TargetTactil),
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text("Eliminar mi cuenta") }

            Spacer(Modifier.height(32.dp))
        }
    }

    if (dialogoCorreo) {
        DialogoConPassword(
            titulo = "Cambiar correo",
            etiquetaCampo = "Nuevo correo",
            tipoTeclado = KeyboardType.Email,
            alCerrar = { dialogoCorreo = false },
            alConfirmar = { valor, password ->
                when (val r = repo.cambiarCorreo(valor.trim(), password)) {
                    is Resultado.Exito -> { vm.actualizarCliente(r.datos); null }
                    is Resultado.Fallo -> r.campos.values.firstOrNull() ?: r.mensaje
                    is Resultado.SinConexion -> r.mensaje
                }
            },
        )
    }

    if (dialogoPassword) {
        DialogoConPassword(
            titulo = "Cambiar contraseña",
            etiquetaCampo = "Nueva contraseña",
            campoEsPassword = true,
            // Se avisa ANTES de hacerlo: cerrar la sesión sin avisar parecería
            // un fallo de la aplicación.
            explicacion = "Al cambiarla se cerrará su sesión en todos los dispositivos, " +
                "incluido este. Tendrá que volver a entrar.",
            alCerrar = { dialogoPassword = false },
            alConfirmar = { nueva, actual ->
                when (val r = repo.cambiarPassword(actual, nueva)) {
                    is Resultado.Exito -> { vm.cerrarSesion(); null }
                    is Resultado.Fallo -> r.campos.values.firstOrNull() ?: r.mensaje
                    is Resultado.SinConexion -> r.mensaje
                }
            },
        )
    }

    if (dialogoBaja) {
        DialogoBaja(
            alCerrar = { dialogoBaja = false },
            alConfirmar = { password ->
                when (val r = repo.eliminarCuenta(password)) {
                    is Resultado.Exito -> { vm.cerrarSesion(); null }
                    is Resultado.Fallo -> r.campos.values.firstOrNull() ?: r.mensaje
                    is Resultado.SinConexion -> r.mensaje
                }
            },
        )
    }
}

@Composable
private fun FilaAccion(icono: String, titulo: String, subtitulo: String, alPulsar: () -> Unit) {
    Surface(
        onClick = alPulsar,
        modifier = Modifier.fillMaxWidth().heightIn(min = TargetTactil + 8.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(icono)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(titulo, style = MaterialTheme.typography.bodyLarge)
                Text(
                    subtitulo,
                    style = MaterialTheme.typography.bodySmall,
                    color = TextoTenue,
                    maxLines = 1,
                )
            }
            Text("›", style = MaterialTheme.typography.titleLarge, color = TextoTenue)
        }
    }
}

/** Diálogo de "cambiar X confirmando la contraseña actual". */
@Composable
private fun DialogoConPassword(
    titulo: String,
    etiquetaCampo: String,
    alCerrar: () -> Unit,
    alConfirmar: suspend (valor: String, password: String) -> String?,
    tipoTeclado: KeyboardType = KeyboardType.Text,
    campoEsPassword: Boolean = false,
    explicacion: String? = null,
) {
    var valor by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var enviando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text(titulo) },
        text = {
            Column {
                explicacion?.let {
                    Aviso(it, TipoAviso.ALERTA)
                    Spacer(Modifier.height(12.dp))
                }
                error?.let {
                    Aviso(it, TipoAviso.ERROR)
                    Spacer(Modifier.height(12.dp))
                }
                CampoTexto(
                    valor, { valor = it }, etiquetaCampo,
                    tipoTeclado = tipoTeclado, esPassword = campoEsPassword,
                    habilitado = !enviando,
                )
                CampoTexto(
                    password, { password = it }, "Su contraseña actual",
                    esPassword = true, habilitado = !enviando,
                    ayuda = "La pedimos para confirmar que es usted.",
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !enviando,
                onClick = {
                    enviando = true
                    error = null
                    alcance.launch {
                        val fallo = alConfirmar(valor, password)
                        if (fallo == null) alCerrar() else error = fallo
                        enviando = false
                    }
                },
            ) { Text(if (enviando) "Guardando…" else "Confirmar") }
        },
        dismissButton = { TextButton(onClick = alCerrar) { Text("Cancelar") } },
    )
}

/**
 * Baja de la cuenta.
 *
 * Se explica exactamente qué pasa: el servidor ANONIMIZA en vez de borrar
 * —conserva la trazabilidad de lo ya facturado— y eso deja libres la cédula y
 * el correo para volver a registrarse. Decir "se eliminará todo" sería mentira.
 */
@Composable
private fun DialogoBaja(alCerrar: () -> Unit, alConfirmar: suspend (String) -> String?) {
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var enviando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text("Eliminar mi cuenta") },
        text = {
            Column {
                Aviso(
                    "Se borrarán su nombre, teléfono, foto y direcciones, y no podrá volver a entrar " +
                        "con esta cuenta. Sus facturas anteriores se conservan por obligación contable, " +
                        "pero ya no estarán asociadas a usted. Podrá registrarse de nuevo con la misma " +
                        "cédula cuando quiera.",
                    TipoAviso.ALERTA,
                )
                Spacer(Modifier.height(12.dp))
                error?.let {
                    Aviso(it, TipoAviso.ERROR)
                    Spacer(Modifier.height(12.dp))
                }
                CampoTexto(
                    password, { password = it }, "Su contraseña",
                    esPassword = true, habilitado = !enviando,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = !enviando,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                onClick = {
                    enviando = true
                    error = null
                    alcance.launch {
                        val fallo = alConfirmar(password)
                        if (fallo == null) alCerrar() else error = fallo
                        enviando = false
                    }
                },
            ) { Text(if (enviando) "Eliminando…" else "Eliminar mi cuenta") }
        },
        dismissButton = { TextButton(onClick = alCerrar) { Text("Conservarla") } },
    )
}

/* =====================================================================
   Direcciones
   ===================================================================== */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaDirecciones(repo: RepoSigr, alVolver: () -> Unit) {
    var direcciones by remember { mutableStateOf<List<Direccion>>(emptyList()) }
    var zonas by remember { mutableStateOf<List<ZonaEntrega>>(emptyList()) }
    var cargando by remember { mutableStateOf(true) }
    var editando by remember { mutableStateOf<Direccion?>(null) }
    var creando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    fun cargar() {
        alcance.launch {
            direcciones = repo.direcciones().datosONull() ?: emptyList()
            zonas = repo.zonasEntrega().datosONull() ?: emptyList()
            cargando = false
        }
    }

    LaunchedEffect(Unit) { cargar() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Mis direcciones") },
                navigationIcon = {
                    IconButton(onClick = alVolver) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { creando = true },
                icon = { Icon(Icons.Default.Add, contentDescription = null) },
                text = { Text("Añadir") },
            )
        },
    ) { relleno ->
        Box(Modifier.fillMaxSize().padding(relleno)) {
            when {
                cargando -> Cargando()
                direcciones.isEmpty() -> EstadoVacio(
                    icono = "📍",
                    titulo = "Sin direcciones guardadas",
                    mensaje = "Guarde una dirección y sus pedidos irán más rápido.",
                    textoAccion = "Añadir dirección",
                    alPulsarAccion = { creando = true },
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(direcciones) { d ->
                        Card(onClick = { editando = d }, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(d.etiqueta, style = MaterialTheme.typography.titleMedium)
                                        if (d.predeterminada) {
                                            Spacer(Modifier.width(8.dp))
                                            Insignia(
                                                "Predeterminada", "★",
                                                MaterialTheme.colorScheme.primaryContainer,
                                                MaterialTheme.colorScheme.onPrimaryContainer,
                                            )
                                        }
                                    }
                                    Text(d.direccion, style = MaterialTheme.typography.bodyMedium)
                                    d.referencia?.let {
                                        Text(it, style = MaterialTheme.typography.bodySmall, color = TextoTenue)
                                    }
                                }
                                IconButton(onClick = {
                                    alcance.launch { repo.borrarDireccion(d.id); cargar() }
                                }) {
                                    Icon(Icons.Default.Delete, contentDescription = "Borrar ${d.etiqueta}")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (creando || editando != null) {
        DialogoDireccion(
            inicial = editando,
            zonas = zonas,
            repo = repo,
            alCerrar = { creando = false; editando = null },
            alGuardar = { peticion ->
                val r = if (editando != null) repo.actualizarDireccion(editando!!.id, peticion)
                else repo.crearDireccion(peticion)
                when (r) {
                    is Resultado.Exito -> { creando = false; editando = null; cargar(); null }
                    is Resultado.Fallo -> r.campos.values.firstOrNull() ?: r.mensaje
                    is Resultado.SinConexion -> r.mensaje
                }
            },
        )
    }
}

/** Alta y edición de una dirección, con el mapa para situar el punto exacto. */
@Composable
private fun DialogoDireccion(
    inicial: Direccion?,
    zonas: List<ZonaEntrega>,
    repo: RepoSigr,
    alCerrar: () -> Unit,
    alGuardar: suspend (PeticionDireccion) -> String?,
) {
    var etiqueta by remember { mutableStateOf(inicial?.etiqueta ?: "Casa") }
    var texto by remember { mutableStateOf(inicial?.direccion.orEmpty()) }
    var referencia by remember { mutableStateOf(inicial?.referencia.orEmpty()) }
    var lat by remember { mutableDoubleStateOf(inicial?.lat ?: zonas.firstOrNull()?.centroLat ?: 0.0) }
    var lng by remember { mutableDoubleStateOf(inicial?.lng ?: zonas.firstOrNull()?.centroLng ?: 0.0) }
    var predeterminada by remember { mutableStateOf(inicial?.predeterminada ?: false) }

    var error by remember { mutableStateOf<String?>(null) }
    var enviando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    // ---- Relleno automático de la dirección al mover el pin ----
    //
    // Escribir "Calle 62 #11-04, Chapinero" a mano en el teclado de un móvil es
    // lento y se presta a erratas que luego el repartidor paga. El punto del
    // mapa ya lleva esa información dentro; solo hay que traducirla.
    var buscandoDireccion by remember { mutableStateOf(false) }

    /**
     * Coordenadas cuya dirección se pidió por última vez. Sirve para no volver
     * a preguntar por el mismo punto cuando Compose recompone por cualquier
     * otro motivo —teclear en "Referencia" recompone el diálogo entero—.
     */
    var ultimoPunto by remember { mutableStateOf<Pair<Double, Double>?>(null) }

    /**
     * Al ABRIR el diálogo no se busca nada.
     *
     * Editando una dirección ya guardada, el cliente pudo haberla afinado a
     * mano ("apto 302, torre B"); pisársela nada más abrir sería destruir su
     * trabajo sin que él haya tocado el mapa. Y en una dirección nueva el pin
     * arranca en el centro de la zona de cobertura, que no es la casa de nadie.
     * Solo se traduce lo que el cliente señala a propósito.
     */
    LaunchedEffect(lat, lng) {
        val punto = lat to lng
        if (ultimoPunto == null) { ultimoPunto = punto; return@LaunchedEffect }
        if (ultimoPunto == punto) return@LaunchedEffect
        ultimoPunto = punto

        // Espera a que deje de mover. Arrastrar el pin dispara este efecto
        // muchas veces seguidas, y sin la pausa cada micro-movimiento sería una
        // consulta al servicio de mapas, que solo admite una por segundo.
        // LaunchedEffect cancela el intento anterior al cambiar las claves, así
        // que solo sobrevive la última posición: justo la que interesa.
        kotlinx.coroutines.delay(600)

        buscandoDireccion = true
        val encontrada = repo.direccionDePunto(punto.first, punto.second)
        buscandoDireccion = false

        // Si no se encontró nada, se deja lo que hubiera escrito. Un campo que
        // se vacía solo es peor que uno que no se rellena.
        if (encontrada != null) texto = encontrada
    }

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text(if (inicial == null) "Nueva dirección" else "Editar dirección") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                error?.let {
                    Aviso(it, TipoAviso.ERROR)
                    Spacer(Modifier.height(12.dp))
                }
                CampoTexto(etiqueta, { etiqueta = it }, "Nombre", ayuda = "Casa, Oficina…")
                CampoTexto(
                    texto, { texto = it }, "Dirección completa",
                    // La ayuda cambia mientras se resuelve: sin esto, el campo
                    // se reescribe solo un segundo después de tocar el mapa y
                    // parece que la app hace cosas por su cuenta.
                    ayuda = if (buscandoDireccion) "Buscando la dirección de ese punto…"
                            else "Se rellena sola al señalar en el mapa. Puede corregirla.",
                )
                CampoTexto(referencia, { referencia = it }, "Referencia (opcional)")

                Spacer(Modifier.height(12.dp))
                Text("Ubicación exacta", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Toque el mapa para ajustar el punto: la dirección de arriba se completa sola.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextoTenue,
                )
                Spacer(Modifier.height(8.dp))
                MapaEntrega(
                    latitud = lat, longitud = lng, zonas = zonas,
                    alMoverPin = { a, b -> lat = a; lng = b },
                    modifier = Modifier.fillMaxWidth().height(200.dp),
                )

                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = predeterminada, onCheckedChange = { predeterminada = it })
                    Text("Usar como predeterminada")
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !enviando,
                onClick = {
                    enviando = true
                    error = null
                    alcance.launch {
                        error = alGuardar(
                            PeticionDireccion(
                                etiqueta = etiqueta.trim(),
                                direccion = texto.trim(),
                                referencia = referencia.trim().ifBlank { null },
                                lat = lat, lng = lng,
                                predeterminada = predeterminada,
                            )
                        )
                        enviando = false
                    }
                },
            ) { Text(if (enviando) "Guardando…" else "Guardar") }
        },
        dismissButton = { TextButton(onClick = alCerrar) { Text("Cancelar") } },
    )
}
