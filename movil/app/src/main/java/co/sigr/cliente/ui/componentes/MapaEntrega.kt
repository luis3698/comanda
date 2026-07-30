package co.sigr.cliente.ui.componentes

import android.graphics.Color as ColorAndroid
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import co.sigr.cliente.datos.red.ClienteHttp
import co.sigr.cliente.datos.red.ZonaEntrega
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.tileprovider.tilesource.XYTileSource
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polygon

/**
 * Mapa para elegir la ubicación de entrega.
 *
 * LAS TESELAS VIENEN DEL PROPIO SERVIDOR DE SIGR, no de Google ni directamente
 * de OpenStreetMap: `/api/v1/mapa/teselas/{z}/{x}/{y}.png`. Eso da tres cosas
 * a la vez —ninguna clave de API, ninguna cuenta con facturación, y el mismo
 * proxy con caché que ya usa el mapa del panel de administración— y es la razón
 * de que se use osmdroid en lugar de Google Maps.
 *
 * Los círculos de cobertura se dibujan encima para que el cliente vea si su
 * dirección entra ANTES de llenar el carrito, en vez de descubrirlo al pagar.
 */
@Composable
fun MapaEntrega(
    latitud: Double,
    longitud: Double,
    zonas: List<ZonaEntrega>,
    alMoverPin: (Double, Double) -> Unit,
    modifier: Modifier = Modifier,
) {
    // La fuente de teselas apunta al proxy. El sufijo ".png" completa la ruta
    // que construye osmdroid, que por defecto no añade extensión.
    val fuente = remember {
        XYTileSource(
            "sigr", 3, 19, 256, ".png",
            arrayOf(ClienteHttp.plantillaTeselas()),
            "© OpenStreetMap",
        )
    }

    AndroidView(
        // EL RECORTE ES OBLIGATORIO, no decoración.
        //
        // En Compose, un modificador de tamaño (`height(280.dp)`) limita el
        // espacio que OCUPA la vista, pero no recorta lo que PINTA. osmdroid
        // dibuja los círculos de cobertura en su lienzo y, como son mucho más
        // grandes que la ventana del mapa, sus trazos se derramaban por toda la
        // pantalla: cruzaban la cabecera, la lista de direcciones y la barra de
        // totales.
        //
        // Va aquí dentro y no en cada llamada para que ninguna pantalla pueda
        // olvidarlo. El `clip` recorta y de paso redondea las esquinas.
        modifier = modifier.clip(RoundedCornerShape(12.dp)),
        factory = { contexto ->
            MapView(contexto).apply {
                setTileSource(fuente)
                setMultiTouchControls(true)
                // El zoom por botones se deja fuera: estorba en una pantalla
                // pequeña y el gesto de pellizcar ya está activado.
                setBuiltInZoomControls(false)
                controller.setZoom(16.0)
                controller.setCenter(GeoPoint(latitud, longitud))
            }
        },
        update = { mapa ->
            mapa.overlays.clear()

            // 1. Zonas de cobertura, debajo de todo.
            zonas.forEach { zona ->
                val circulo = Polygon(mapa).apply {
                    points = Polygon.pointsAsCircle(
                        GeoPoint(zona.centroLat, zona.centroLng),
                        zona.radioM.toDouble(),
                    )
                    val color = try {
                        ColorAndroid.parseColor(zona.color)
                    } catch (e: IllegalArgumentException) {
                        ColorAndroid.parseColor("#0f766e")
                    }
                    fillPaint.color = ColorAndroid.argb(38, ColorAndroid.red(color), ColorAndroid.green(color), ColorAndroid.blue(color))
                    outlinePaint.color = color
                    outlinePaint.strokeWidth = 3f
                    title = "${zona.nombre} · envío ${zona.costoEnvio}"
                }
                mapa.overlays.add(circulo)
            }

            // 2. Un toque en el mapa mueve el pin. Es el gesto natural, y la
            //    alternativa sin gestos es el campo de dirección del checkout.
            mapa.overlays.add(
                MapEventsOverlay(object : MapEventsReceiver {
                    override fun singleTapConfirmedHelper(p: GeoPoint?): Boolean {
                        p ?: return false
                        alMoverPin(p.latitude, p.longitude)
                        return true
                    }
                    override fun longPressHelper(p: GeoPoint?): Boolean = false
                })
            )

            // 3. El pin, siempre encima.
            mapa.overlays.add(
                Marker(mapa).apply {
                    position = GeoPoint(latitud, longitud)
                    setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                    title = "Entregar aquí"
                    // Se puede arrastrar además de tocar: es más preciso para
                    // ajustar unos metros.
                    isDraggable = true
                    setOnMarkerDragListener(object : Marker.OnMarkerDragListener {
                        override fun onMarkerDrag(marker: Marker?) {}
                        override fun onMarkerDragEnd(marker: Marker?) {
                            marker?.position?.let { alMoverPin(it.latitude, it.longitude) }
                        }
                        override fun onMarkerDragStart(marker: Marker?) {}
                    })
                }
            )

            mapa.controller.setCenter(GeoPoint(latitud, longitud))
            mapa.invalidate()
        },
        onRelease = { it.onDetach() },
    )
}
