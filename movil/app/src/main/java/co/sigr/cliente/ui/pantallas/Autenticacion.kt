package co.sigr.cliente.ui.pantallas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import co.sigr.cliente.datos.red.Cliente
import co.sigr.cliente.datos.red.ClienteHttp
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.datos.repo.Resultado
import co.sigr.cliente.ui.componentes.*
import co.sigr.cliente.ui.tema.TextoTenue
import kotlinx.coroutines.launch

/**
 * Pantalla de mantenimiento.
 *
 * Se muestra cuando el administrador apagó la aplicación desde el panel, o
 * cuando no hay red. El texto es el que escribió el administrador, no uno
 * inventado: por eso `GET /app/estado` es el único endpoint que responde
 * aunque todo lo demás devuelva 503.
 */
@Composable
fun PantallaMantenimiento(
    mensaje: String,
    servidorEnUso: String,
    alReintentar: () -> Unit,
    alFijarServidor: suspend (String) -> String?,
) {
    var configurando by remember { mutableStateOf(false) }
    var direccion by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var probando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("🔧", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(16.dp))
            Text(
                "No disponible ahora mismo",
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                mensaje,
                style = MaterialTheme.typography.bodyLarge,
                color = TextoTenue,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(28.dp))
            BotonPrincipal(
                "Reintentar",
                alReintentar,
                Modifier.widthIn(max = 280.dp),
                habilitado = !probando,
            )

            Spacer(Modifier.height(20.dp))

            // ---------------------------------------------------------------
            // Configurar la dirección DENTRO de la aplicación.
            //
            // SOLO EN COMPILACIONES DE DEPURACIÓN (`ClienteHttp.configurable`).
            // En la app publicada este bloque NO EXISTE: el comensal no tiene
            // que saber dónde está el servidor del restaurante ni pedirle la IP
            // a nadie — abre la app y ya. Enseñarle un campo de dirección sería
            // incomprensible y, peor, una vía para apuntar la app a un servidor
            // ajeno que le capturara la contraseña y el comprobante de pago.
            //
            // Aquí sirve para que desarrollar contra un PC de la red local no
            // exija recompilar cada vez que el router cambia la IP. Va plegado:
            // con el emulador o con el cable no hace falta ni abrirlo, porque la
            // app encuentra el servidor sola.
            // ---------------------------------------------------------------
            if (ClienteHttp.configurable) {
                TextButton(onClick = { configurando = !configurando }) {
                    Text(if (configurando) "Ocultar la configuración" else "Configurar la dirección del servidor")
                }
            }

            if (configurando) {
                Column(Modifier.widthIn(max = 380.dp)) {
                    Text(
                        "Escriba la dirección IP del computador donde corre SIGR. " +
                            "En Windows se ve con «ipconfig», en la línea «Dirección IPv4».",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextoTenue,
                    )
                    Spacer(Modifier.height(12.dp))

                    error?.let {
                        Aviso(it, TipoAviso.ERROR)
                        Spacer(Modifier.height(12.dp))
                    }

                    CampoTexto(
                        valor = direccion,
                        alCambiar = { direccion = it },
                        etiqueta = "Dirección del servidor",
                        // Se acepta la IP sola: pedir "http://" y la barra final
                        // es una forma segura de que el usuario se equivoque.
                        ayuda = "Por ejemplo 192.168.1.42 — el puerto 3000 se asume",
                        tipoTeclado = KeyboardType.Uri,
                        accionTeclado = ImeAction.Done,
                        habilitado = !probando,
                    )

                    Spacer(Modifier.height(8.dp))
                    BotonPrincipal(
                        texto = "Probar y guardar",
                        cargando = probando,
                        alPulsar = {
                            error = null
                            probando = true
                            alcance.launch {
                                // Se comprueba ANTES de guardar: una dirección
                                // muerta guardada dejaría la app inservible.
                                error = alFijarServidor(direccion)
                                probando = false
                            }
                        },
                    )

                    Spacer(Modifier.height(16.dp))
                    Text(
                        "Está intentando conectarse a:",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextoTenue,
                    )
                    Text(
                        servidorEnUso,
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

/**
 * Inicio de sesión.
 *
 * Un solo campo para correo O cédula: el servidor distingue por la forma del
 * valor. En un móvil, obligar a elegir de antemano cuál se va a escribir es
 * una fricción sin ninguna contrapartida.
 */
@Composable
fun PantallaLogin(
    repo: RepoSigr,
    alEntrar: (Cliente) -> Unit,
    alIrARegistro: () -> Unit,
) {
    var identificador by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var cargando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    fun entrar() {
        error = null
        if (identificador.isBlank() || password.isBlank()) {
            error = "Escriba su correo o cédula y su contraseña."
            return
        }
        cargando = true
        alcance.launch {
            when (val r = repo.iniciarSesion(identificador.trim(), password)) {
                is Resultado.Exito -> alEntrar(r.datos)
                is Resultado.Fallo -> error = r.mensaje
                is Resultado.SinConexion -> error = r.mensaje
            }
            cargando = false
        }
    }

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("🍽", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(8.dp))
            Text("SIGR", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "Reserve su mesa o pida a domicilio.",
                style = MaterialTheme.typography.bodyLarge,
                color = TextoTenue,
            )
            Spacer(Modifier.height(32.dp))

            error?.let {
                Aviso(it, TipoAviso.ERROR)
                Spacer(Modifier.height(16.dp))
            }

            CampoTexto(
                valor = identificador,
                alCambiar = { identificador = it },
                etiqueta = "Correo o cédula",
                tipoTeclado = KeyboardType.Email,
                habilitado = !cargando,
            )
            CampoTexto(
                valor = password,
                alCambiar = { password = it },
                etiqueta = "Contraseña",
                esPassword = true,
                accionTeclado = ImeAction.Done,
                habilitado = !cargando,
            )

            Spacer(Modifier.height(20.dp))
            BotonPrincipal("Entrar", ::entrar, cargando = cargando)

            Spacer(Modifier.height(16.dp))
            TextButton(
                onClick = alIrARegistro,
                enabled = !cargando,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("¿Primera vez? Crear una cuenta") }
        }
    }
}

/**
 * Registro.
 *
 * Los errores por campo llegan del servidor y se pintan bajo su casilla. La
 * validación de aquí solo evita el viaje de ida y vuelta obvio: **la que manda
 * es la del servidor** (FSD 6.1), porque el cliente se puede manipular.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantallaRegistro(
    repo: RepoSigr,
    alEntrar: (Cliente) -> Unit,
    alVolver: () -> Unit,
) {
    var nombre by remember { mutableStateOf("") }
    var documento by remember { mutableStateOf("") }
    var correo by remember { mutableStateOf("") }
    var telefono by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    var campos by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var error by remember { mutableStateOf<String?>(null) }
    var cargando by remember { mutableStateOf(false) }
    val alcance = rememberCoroutineScope()

    fun registrar() {
        error = null
        campos = emptyMap()
        cargando = true
        alcance.launch {
            val r = repo.registrar(
                nombreCompleto = nombre.trim(),
                correo = correo.trim(),
                telefono = telefono.trim(),
                documento = documento.trim(),
                password = password,
            )
            when (r) {
                is Resultado.Exito -> alEntrar(r.datos)
                is Resultado.Fallo -> {
                    campos = r.campos
                    // Si el servidor detalló los campos, el mensaje general
                    // sobra: se vería dos veces lo mismo.
                    error = if (r.campos.isEmpty()) r.mensaje else null
                }
                is Resultado.SinConexion -> error = r.mensaje
            }
            cargando = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Crear cuenta") },
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
                .padding(24.dp),
        ) {
            error?.let {
                Aviso(it, TipoAviso.ERROR)
                Spacer(Modifier.height(16.dp))
            }

            CampoTexto(
                valor = nombre, alCambiar = { nombre = it },
                etiqueta = "Nombre completo",
                error = campos["nombreCompleto"],
                habilitado = !cargando,
            )
            CampoTexto(
                valor = documento, alCambiar = { documento = it },
                etiqueta = "Cédula",
                error = campos["documento"],
                ayuda = "Solo números. Puede escribirla con puntos.",
                tipoTeclado = KeyboardType.Number,
                habilitado = !cargando,
            )
            CampoTexto(
                valor = correo, alCambiar = { correo = it },
                etiqueta = "Correo electrónico",
                error = campos["correo"],
                tipoTeclado = KeyboardType.Email,
                habilitado = !cargando,
            )
            CampoTexto(
                valor = telefono, alCambiar = { telefono = it },
                etiqueta = "Teléfono",
                error = campos["telefono"],
                ayuda = "Lo usará el repartidor para encontrarle.",
                tipoTeclado = KeyboardType.Phone,
                habilitado = !cargando,
            )
            CampoTexto(
                valor = password, alCambiar = { password = it },
                etiqueta = "Contraseña",
                error = campos["password"],
                ayuda = "Mínimo 8 caracteres.",
                esPassword = true,
                accionTeclado = ImeAction.Done,
                habilitado = !cargando,
            )

            Spacer(Modifier.height(24.dp))
            BotonPrincipal("Crear mi cuenta", ::registrar, cargando = cargando)
            Spacer(Modifier.height(24.dp))
        }
    }
}
