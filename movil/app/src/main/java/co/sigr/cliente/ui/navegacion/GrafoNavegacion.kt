package co.sigr.cliente.ui.navegacion

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import co.sigr.cliente.datos.repo.RepoSigr
import co.sigr.cliente.ui.Arranque
import co.sigr.cliente.ui.EstadoAppVm
import co.sigr.cliente.ui.componentes.Cargando
import co.sigr.cliente.ui.pantallas.*

/** Rutas de la aplicación. Constantes para que un error de tecleo no compile. */
object Rutas {
    const val LOGIN = "login"
    const val REGISTRO = "registro"
    const val INICIO = "inicio"
    const val MENU = "menu"
    const val PLATO = "plato/{id}"
    const val CARRITO = "carrito"
    const val CHECKOUT = "checkout"
    const val RESERVAS = "reservas"
    const val PEDIDOS = "pedidos"
    const val PERFIL = "perfil"
    const val DIRECCIONES = "direcciones"
    const val NOTIFICACIONES = "notificaciones"

    fun plato(id: Int) = "plato/$id"
}

private data class Pestana(
    val ruta: String,
    val etiqueta: String,
    val icono: ImageVector,
)

/**
 * Barra inferior: las cuatro cosas que el cliente hace de verdad.
 *
 * Perfil y notificaciones NO están aquí: se llega a ellos desde la cabecera de
 * Inicio. Cinco pestañas en un móvil dejan etiquetas ilegibles, y son
 * pantallas que se visitan de vez en cuando, no a diario.
 */
private val PESTANAS = listOf(
    Pestana(Rutas.INICIO, "Inicio", Icons.Default.Home),
    Pestana(Rutas.MENU, "Carta", Icons.Default.RestaurantMenu),
    Pestana(Rutas.RESERVAS, "Reservas", Icons.Default.EventSeat),
    Pestana(Rutas.PEDIDOS, "Pedidos", Icons.Default.Receipt),
)

@Composable
fun AppSigr(repo: RepoSigr, vm: EstadoAppVm) {
    val arranque by vm.arranque.collectAsState()

    when (arranque) {
        Arranque.COMPROBANDO -> Surface(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Cargando(texto = "Conectando con el restaurante…")
            }
        }

        // La aplicación está apagada por el administrador, o no hay red. Se
        // muestra el mensaje real, no un error genérico: es lo que permite el
        // endpoint /app/estado, que responde siempre.
        Arranque.MANTENIMIENTO -> PantallaMantenimiento(
            mensaje = vm.mensajeMantenimiento.collectAsState().value.orEmpty(),
            servidorEnUso = vm.servidorEnUso.collectAsState().value,
            alReintentar = { vm.comprobarArranque() },
            alFijarServidor = { vm.fijarServidor(it) },
        )

        Arranque.SIN_SESION -> AutenticacionNav(repo, vm)

        Arranque.LISTO -> PrincipalNav(repo, vm)
    }
}

/** Login y registro, sin barra inferior. */
@Composable
private fun AutenticacionNav(repo: RepoSigr, vm: EstadoAppVm) {
    val nav = rememberNavController()

    NavHost(navController = nav, startDestination = Rutas.LOGIN) {
        composable(Rutas.LOGIN) {
            PantallaLogin(
                repo = repo,
                alEntrar = { vm.alIniciarSesion(it) },
                alIrARegistro = { nav.navigate(Rutas.REGISTRO) },
            )
        }
        composable(Rutas.REGISTRO) {
            PantallaRegistro(
                repo = repo,
                alEntrar = { vm.alIniciarSesion(it) },
                alVolver = { nav.popBackStack() },
            )
        }
    }
}

/** La aplicación con sesión iniciada. */
@Composable
private fun PrincipalNav(repo: RepoSigr, vm: EstadoAppVm) {
    val nav = rememberNavController()
    val carrito by vm.carrito.collectAsState()

    // El token de push se asocia a la cuenta en cuanto hay sesión. Si Firebase
    // no está configurado, esto no hace nada y no molesta a nadie.
    LaunchedEffect(Unit) { co.sigr.cliente.fcm.RegistroPush.registrar(repo) }

    // Ruta actual: la necesitan la barra inferior y el botón flotante.
    val entradaActual by nav.currentBackStackEntryAsState()
    val rutaActual = entradaActual?.destination?.route

    Scaffold(
        bottomBar = { BarraInferior(nav) },
        floatingActionButton = {
            // El botón del carrito solo existe cuando hay algo dentro —un
            // carrito vacío no es un destino al que ir— y SOLO en las pantallas
            // donde llevar al carrito significa algo.
            //
            // En Carrito ya se está ahí; en Checkout se está confirmando ese
            // mismo pedido, y ahí el botón flotante además TAPABA el botón
            // "Confirmar" de la barra inferior; y en el detalle de un plato hay
            // un "Añadir" abajo que quedaba igual de estorbado.
            val estorba = rutaActual in listOf(Rutas.CARRITO, Rutas.CHECKOUT, Rutas.PLATO)

            if (carrito.isNotEmpty() && !estorba) {
                ExtendedFloatingActionButton(
                    onClick = { nav.navigate(Rutas.CARRITO) },
                    icon = { Icon(Icons.Default.ShoppingCart, contentDescription = null) },
                    text = { Text("Ver pedido · ${vm.unidadesCarrito}") },
                )
            }
        },
    ) { relleno ->
        NavHost(
            navController = nav,
            startDestination = Rutas.INICIO,
            modifier = Modifier.padding(relleno),
        ) {
            composable(Rutas.INICIO) {
                PantallaInicio(
                    repo = repo, vm = vm,
                    alIrAMenu = { nav.navigate(Rutas.MENU) },
                    alIrAReservas = { nav.navigate(Rutas.RESERVAS) },
                    alIrAPerfil = { nav.navigate(Rutas.PERFIL) },
                    alIrANotificaciones = { nav.navigate(Rutas.NOTIFICACIONES) },
                )
            }
            composable(Rutas.MENU) {
                PantallaMenu(repo = repo, alAbrirPlato = { nav.navigate(Rutas.plato(it)) })
            }
            composable(Rutas.PLATO) { entrada ->
                val id = entrada.arguments?.getString("id")?.toIntOrNull() ?: 0
                PantallaPlato(
                    repo = repo, vm = vm, idProducto = id,
                    alVolver = { nav.popBackStack() },
                )
            }
            composable(Rutas.CARRITO) {
                PantallaCarrito(
                    vm = vm,
                    alVolver = { nav.popBackStack() },
                    alPagar = { nav.navigate(Rutas.CHECKOUT) },
                )
            }
            composable(Rutas.CHECKOUT) {
                PantallaCheckout(
                    repo = repo, vm = vm,
                    alVolver = { nav.popBackStack() },
                    alTerminar = {
                        vm.vaciarCarrito()
                        nav.navigate(Rutas.PEDIDOS) {
                            popUpTo(Rutas.INICIO)
                        }
                    },
                )
            }
            composable(Rutas.RESERVAS) { PantallaReservas(repo = repo, vm = vm) }
            composable(Rutas.PEDIDOS) { PantallaPedidos(repo = repo) }
            composable(Rutas.PERFIL) {
                PantallaPerfil(
                    repo = repo, vm = vm,
                    alVolver = { nav.popBackStack() },
                    alIrADirecciones = { nav.navigate(Rutas.DIRECCIONES) },
                )
            }
            composable(Rutas.DIRECCIONES) {
                PantallaDirecciones(repo = repo, alVolver = { nav.popBackStack() })
            }
            composable(Rutas.NOTIFICACIONES) {
                PantallaNotificaciones(
                    repo = repo, vm = vm,
                    alVolver = { nav.popBackStack() },
                )
            }
        }
    }
}

@Composable
private fun BarraInferior(nav: NavHostController) {
    val entrada by nav.currentBackStackEntryAsState()
    val destino = entrada?.destination

    // La barra se esconde en las pantallas de flujo: dentro del carrito o del
    // checkout, cambiar de pestaña sería perder lo que se estaba haciendo.
    val rutaActual = destino?.route
    if (rutaActual in listOf(Rutas.CARRITO, Rutas.CHECKOUT, Rutas.PLATO, Rutas.PERFIL,
            Rutas.DIRECCIONES, Rutas.NOTIFICACIONES)) return

    NavigationBar {
        PESTANAS.forEach { pestana ->
            val activa = destino?.hierarchy?.any { it.route == pestana.ruta } == true
            NavigationBarItem(
                selected = activa,
                onClick = {
                    nav.navigate(pestana.ruta) {
                        // Sin esto, ir y volver entre pestañas apila pantallas
                        // y el botón atrás recorre todo el historial.
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = { Icon(pestana.icono, contentDescription = null) },
                // La etiqueta va siempre visible: un icono suelto se
                // interpreta mal, y aquí hay sitio de sobra para cuatro.
                label = { Text(pestana.etiqueta) },
                alwaysShowLabel = true,
            )
        }
    }
}
