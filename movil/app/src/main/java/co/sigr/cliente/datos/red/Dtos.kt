package co.sigr.cliente.datos.red

/**
 * Objetos de transporte de la API.
 *
 * LOS NOMBRES SON LOS DEL SERVIDOR, EN ESPAÑOL. Todo SIGR está en español
 * —tablas, columnas, campos JSON— y traducir aquí obligaría a mantener un
 * diccionario mental entre las dos mitades del sistema. Con los nombres
 * iguales, buscar `costoEnvio` encuentra a la vez el DTO, el servicio Node y
 * la columna de MySQL.
 *
 * LOS IMPORTES SON `String`, NO `Double`. mysql2 devuelve los DECIMAL como
 * texto a propósito, para no perder precisión, y el servidor los reenvía tal
 * cual. Convertirlos a coma flotante aquí reintroduciría justo el error que el
 * backend evita: 0.1 + 0.2 = 0.30000000000000004. La app los muestra tal como
 * llegan y NUNCA calcula un total: eso es del servidor (FSD 5.7).
 */

// --- Estado del servicio ---

data class EstadoApp(
    val activa: Boolean = true,
    val mensaje: String? = null,
    val reservas: Boolean = true,
    val domicilios: Boolean = true,
    val versionMinima: Int = 1,
)

// --- Cuenta ---

data class Cliente(
    val id: Int,
    val documento: String,
    val nombre: String,
    val correo: String,
    val telefono: String,
    val urlFoto: String? = null,
    val aceptaPromociones: Boolean = true,
)

data class RespuestaSesion(
    val cliente: Cliente,
    val token: String,
    val expiraEn: String,
)

data class PeticionRegistro(
    val nombreCompleto: String,
    val correo: String,
    val telefono: String,
    val documento: String,
    val password: String,
)

data class PeticionLogin(
    val identificador: String,
    val password: String,
)

data class PeticionPerfil(
    val nombreCompleto: String? = null,
    val telefono: String? = null,
    val aceptaPromociones: Boolean? = null,
)

data class PeticionCorreo(val correo: String, val password: String)

data class PeticionPassword(val passwordActual: String, val passwordNueva: String)

data class PeticionBaja(val password: String)

data class RespuestaCliente(val cliente: Cliente)

// --- Restaurante y carta ---

data class Restaurante(
    val nombre: String? = null,
    val descripcion: String? = null,
    val direccion: String? = null,
    val telefono: String? = null,
    val horario: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
)

data class RespuestaRestaurante(val restaurante: Restaurante)

data class Categoria(val id: Int, val nombre: String)

data class Producto(
    val id: Int,
    val idCategoria: Int,
    val nombre: String,
    val descripcion: String? = null,
    val urlImagen: String? = null,
    val precio: String,
    val tasaImpuesto: String,
)

data class RespuestaMenu(
    val categorias: List<Categoria> = emptyList(),
    val productos: List<Producto> = emptyList(),
)

data class OpcionModificador(
    val id: Int,
    val nombre: String,
    val precioExtra: String,
)

data class GrupoModificador(
    val id: Int,
    val nombre: String,
    val min: Int,
    val max: Int,
    val opciones: List<OpcionModificador> = emptyList(),
)

data class ProductoDetalle(
    val id: Int,
    val nombre: String,
    val descripcion: String? = null,
    val urlImagen: String? = null,
    val categoria: String? = null,
    val precio: String,
    val tasaImpuesto: String,
    val grupos: List<GrupoModificador> = emptyList(),
)

data class RespuestaProducto(val producto: ProductoDetalle)

// --- Direcciones ---

data class Direccion(
    val id: Int,
    val etiqueta: String,
    val direccion: String,
    val referencia: String? = null,
    val lat: Double,
    val lng: Double,
    val predeterminada: Boolean = false,
)

data class RespuestaDirecciones(val direcciones: List<Direccion> = emptyList())

data class PeticionDireccion(
    val etiqueta: String,
    val direccion: String,
    val referencia: String? = null,
    val lat: Double,
    val lng: Double,
    val predeterminada: Boolean = false,
)

// --- Cobertura ---

data class ZonaEntrega(
    val id: Int,
    val nombre: String,
    val centroLat: Double,
    val centroLng: Double,
    val radioM: Int,
    val costoEnvio: String,
    val pedidoMinimo: String,
    val tiempoEstimadoMin: Int,
    val color: String,
    val distanciaM: Int? = null,
)

data class RespuestaZonas(val zonas: List<ZonaEntrega> = emptyList())

data class PeticionCotizar(val lat: Double, val lng: Double, val subtotal: String)

/**
 * El servidor responde 200 también cuando NO hay cobertura, para que la app
 * distinga "no llegamos hasta ahí" (mover el pin) de "te falta pedido mínimo"
 * (añadir platos). Son dos pantallas distintas y dos acciones distintas.
 */
data class Cotizacion(
    val cubierto: Boolean,
    val motivo: String? = null,
    val zona: ZonaEntrega? = null,
    val costoEnvio: String = "0.00",
    val pedidoMinimo: String = "0.00",
    val faltaParaMinimo: String = "0.00",
    val tiempoEstimadoMin: Int? = null,
)

// --- Reservas ---

data class Reserva(
    val id: Int,
    val codigo: String,
    val fechaHora: String,
    val numPersonas: Int,
    val notas: String? = null,
    val estado: String,
    val mesa: String? = null,
    val zona: String? = null,
    val motivoGestion: String? = null,
    val creadoEn: String? = null,
)

data class RespuestaReservas(val reservas: List<Reserva> = emptyList())
data class RespuestaReserva(val reserva: Reserva)

/**
 * `fechaHora` viaja como "YYYY-MM-DD HH:mm" SIN zona horaria, y el servidor la
 * interpreta como hora local del restaurante. Es la hora de pared que tiene en
 * la cabeza el comensal: si reserva "a las 8", quiere decir las 8 en el
 * restaurante. Mandar un instante en UTC desplazaría la reserva 5 horas.
 */
data class PeticionReserva(
    val fechaHora: String,
    val numPersonas: Int,
    val notas: String? = null,
)

// --- Domicilios ---

data class LineaPedido(
    val id: Int? = null,
    val idProducto: Int,
    val producto: String? = null,
    val urlImagen: String? = null,
    val cantidad: Int,
    val precioUnitario: String? = null,
    val notas: String? = null,
    val modificadores: List<ModificadorLinea> = emptyList(),
)

data class ModificadorLinea(val nombre: String, val precioExtra: String)

data class Pedido(
    val id: Int,
    val codigo: String,
    val estado: String,
    val direccion: String,
    val referencia: String? = null,
    val telefono: String? = null,
    val subtotal: String,
    val impuestos: String,
    val costoEnvio: String,
    val total: String,
    val metodoPago: String,
    val metodoNombre: String? = null,
    val requiereComprobante: Boolean = false,
    /** no_requerido · pendiente · por_verificar · verificado · rechazado */
    val estadoPago: String = "no_requerido",
    val urlComprobante: String? = null,
    val comprobanteEn: String? = null,
    val verificadoEn: String? = null,
    val motivoPago: String? = null,
    val pagaCon: String? = null,
    val zonaEntrega: String? = null,
    val tiempoEstimadoMin: Int? = null,
    val notas: String? = null,
    val motivoGestion: String? = null,
    val creadoEn: String? = null,
    val lineas: List<LineaPedido> = emptyList(),
)

data class RespuestaPedidos(val pedidos: List<Pedido> = emptyList())
data class RespuestaPedido(val pedido: Pedido)

data class LineaNueva(
    val idProducto: Int,
    val cantidad: Int,
    val notas: String? = null,
    val modificadores: List<Int> = emptyList(),
)

data class PeticionPedido(
    val lineas: List<LineaNueva>,
    val direccion: String,
    val referencia: String? = null,
    val lat: Double,
    val lng: Double,
    val telefonoContacto: String,
    val metodoPago: String = "efectivo",
    val pagaCon: String? = null,
    val notas: String? = null,
)

// --- Metodos de pago ---

/**
 * Forma de pago que el restaurante tiene publicada.
 *
 * `llave` es a donde transfiere el cliente: el celular en Nequi y DaviPlata,
 * el numero de cuenta en Bancolombia. Viene nula en contra entrega, que no
 * tiene cuenta ninguna.
 */
data class MetodoPago(
    val codigo: String,
    val nombre: String,
    val requiereComprobante: Boolean,
    val llave: String? = null,
    val titular: String? = null,
    val tipoCuenta: String? = null,
    val banco: String? = null,
)

data class RespuestaMetodos(val metodos: List<MetodoPago> = emptyList())

data class RespuestaComprobante(
    val codigo: String? = null,
    val estadoPago: String? = null,
    val urlComprobante: String? = null,
)

// --- Notificaciones ---

data class Notificacion(
    val id: Long,
    val tipo: String,
    val titulo: String,
    val cuerpo: String,
    val referencia: String? = null,
    val leida: Boolean = false,
    val creadoEn: String? = null,
)

data class RespuestaNotificaciones(
    val notificaciones: List<Notificacion> = emptyList(),
    val noLeidas: Int = 0,
)

data class Promocion(
    val id: Int,
    val titulo: String,
    val cuerpo: String,
    val urlImagen: String? = null,
    val vigenteHasta: String? = null,
)

data class RespuestaPromociones(val promociones: List<Promocion> = emptyList())

data class PeticionDispositivo(
    val token: String,
    val plataforma: String = "android",
    val modelo: String? = null,
)

// --- Errores ---

/**
 * Forma exacta del error del servidor (`server/middleware/errores.js`).
 * `datos.campos` trae el mensaje por campo, para pintarlo bajo su casilla en
 * lugar de un aviso genérico que obligue a adivinar qué está mal.
 */
data class ErrorApi(
    val error: String? = null,
    val mensaje: String? = null,
    val datos: DatosError? = null,
)

data class DatosError(
    val campos: Map<String, String>? = null,
    val motivo: String? = null,
)
