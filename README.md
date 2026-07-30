<div align="center">

# 🍽️ SIGR

### Sistema Integral de Gestión para Restaurantes

*Del plano del salón a la caja cuadrada, más la app del comensal.*

[![Node](https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com)
[![Kotlin](https://img.shields.io/badge/Kotlin-Compose-7F52FF?style=flat-square&logo=kotlin&logoColor=white)](https://kotlinlang.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Sin build](https://img.shields.io/badge/build_step-ninguno-brightgreen?style=flat-square)](#-estructura-del-proyecto)

</div>

---

## 📑 Índice

| | Sección | Para qué |
|:--:|---|---|
| ⚡ | [Arranque rápido](#-arranque-rápido) | **Comando por comando, para copiar y pegar** |
| 🧭 | [Qué es SIGR](#-qué-es-sigr) | Panorama y módulos |
| ✅ | [Requisitos](#-requisitos) | Qué instalar antes de empezar |
| 🔑 | [Primer acceso](#-primer-acceso) | Credenciales y primeros pasos |
| 📱 | [La app del comensal](#-la-app-del-comensal) | Compilar, instalar y conectar |
| 🔔 | [Notificaciones push](#-notificaciones-push) | Firebase, opcional |
| ▶️ | [Comandos](#-comandos) | Ejecutar, probar y limpiar |
| ⚙️ | [Variables de entorno](#-variables-de-entorno) | Configuración del `.env` |
| 🗂️ | [Estructura del proyecto](#-estructura-del-proyecto) | Dónde vive cada cosa |
| 🧠 | [Decisiones de diseño](#-decisiones-de-diseño) | Leer **antes** de tocar el código |
| ♿ | [Accesibilidad](#-accesibilidad) | Cómo se cumple el FSD 6.4 |
| 🆘 | [Problemas frecuentes](#-problemas-frecuentes) | Síntoma → causa → solución |

---

## ⚡ Arranque rápido

### Un solo comando

```bash
npm run arrancar
```

Hace la secuencia entera y **se para en el paso que falla**, diciendo qué hacer: crea el
`.env`, levanta los contenedores, espera a que la base responda de verdad, aplica los
`db/*.sql` que falten y termina enseñando por dónde entrar.

```
▶ Comprobando el entorno
  ✓ docker   ✓ node 24.16.0   ✓ .env
▶ Levantando los contenedores
  ✓ contenedores en marcha
▶ Esperando a que el servidor responda
  ✓ http://localhost:3000/api/v1/salud → {"estado":"ok","bd":"conectada"}
▶ Poniendo la base al día
  ✓ 05_movil.sql — canal digital: clientes, reservas, domicilios y cobertura
  ✓ 06_pagos.sql — métodos de pago de la app y verificación de comprobantes
  ✓ 07_rendimiento.sql — índices de las consultas calientes

Todo listo.
  Entrar          http://localhost:3000
```

Funciona igual en **PowerShell, cmd y Git Bash**: es Node, no bash.

| Añada | Y además |
|---|---|
| `npm run arrancar -- --rapido` | No reconstruye la imagen. Para cuando solo tocó `public/` |
| `npm run arrancar -- --limpio` | Empieza de cero. ⚠️ **borra la base** |
| `npm run arrancar -- --movil` | Compila e instala la app Android. Vale por **cable, wifi o emulador**; si no hay nada conectado, arranca un emulador |
| `npm run arrancar -- --pruebas` | Al terminar pasa las 99 pruebas |
| `npm run arrancar -- --local` | Base en Docker, servidor con `node --watch` para depurar |
| `npm run parar` | Baja los contenedores. La base se conserva |

Se combinan: `npm run arrancar -- --limpio --pruebas`.

<details>
<summary><b>La misma secuencia a mano</b></summary>

<br>

```bash
cp .env.example .env
docker compose up -d --build
curl -s http://localhost:3000/api/v1/salud
```

Debe decir `{"estado":"ok","bd":"conectada"}`.

La primera vez tarda: construye la imagen y MySQL ejecuta los `db/*.sql` en orden. Si
`curl` no responde, lo más común es que Docker Desktop no esté abierto.

**Y hay un paso que a mano se olvida:** el entrypoint de MySQL ejecuta `db/*.sql` solo la
**primera** vez que se crea el volumen. Sobre una base que ya existe hay que aplicar a mano
los archivos nuevos, y el síntoma de no hacerlo aparece días después —«no hay posiciones de
domicilio configuradas» cuando un cajero acepta su primer pedido—. Los tres son
reaplicables:

```bash
docker exec -i sigr_db mysql -uroot -proot_sigr_dev sigr < db/05_movil.sql
docker exec -i sigr_db mysql -uroot -proot_sigr_dev sigr < db/06_pagos.sql
docker exec -i sigr_db mysql -uroot -proot_sigr_dev sigr < db/07_rendimiento.sql
```

`npm run arrancar` los pasa siempre, y por eso no hay nada que recordar.

</details>

### La app móvil, con un solo comando

```bash
npm run arrancar -- --movil
```

o, si prefiere solo la parte Android: `cd movil && ./arrancar.sh`

Hace la secuencia entera —servidor, puente al móvil, compilar, instalar, abrir— y **se
para en el paso que falla**, diciendo qué hacer:

```
▶ Comprobando herramientas
  ✓ adb   ✓ docker   ✓ JDK
▶ Levantando el servidor
  ✓ ya estaba arriba
  ✓ canal digital activo
▶ Preparando el móvil
  ✓ 2412DPC0AG por wifi (adb-U8AEV8PFPBDEDIPN-…._adb-tls-connect._tcp)
  ✓ puente abierto: el localhost:3000 del móvil apunta a este PC
▶ Compilando e instalando la app
  ✓ instalada
▶ Abriendo la app
  ✓ SIGR arrancando en el móvil
```

**Sirve para las tres formas de tener un Android delante:**

| Cómo esté conectado | Qué hace |
|---|---|
| **Cable** | Lo usa tal cual |
| **Wifi** (depuración inalámbrica) | Lo usa tal cual. `adb reverse` funciona igual que por USB |
| **Cable y wifi a la vez** | Cierra la inalámbrica: con dos entradas del mismo móvil, `adb reverse` falla con *«more than one device»* |
| **Emulador ya abierto** | Lo usa tal cual |
| **Nada conectado** | **Arranca un emulador** con el primer AVD que encuentre, y espera a que termine de arrancar |

> Con `--sin-emulador` no arranca ninguno y se limita a avisar de que no hay dispositivo.

Para reabrir el puente sin recompilar, que es lo típico tras desenchufar el cable:

```bash
cd movil && ./arrancar.sh --sin-compilar
```

<details>
<summary><b>La misma secuencia a mano</b>, si prefiere entender cada pieza</summary>

<br>

**Git Bash:**

```bash
cd "/f/claude code/comanda"
export PATH="$PATH:$HOME/AppData/Local/Android/Sdk/platform-tools"
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
docker compose up -d --build
adb disconnect
adb reverse tcp:3000 tcp:3000
adb reverse --list
cd movil && ./gradlew installDebug
adb shell am start -n co.sigr.cliente/.MainActivity
```

**PowerShell** (la terminal por defecto de VS Code en Windows):

```powershell
cd "F:\claude code\comanda"
$env:Path += ";$env:LOCALAPPDATA\Android\Sdk\platform-tools"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
docker compose up -d --build
adb disconnect
adb reverse tcp:3000 tcp:3000
adb reverse --list
cd movil
.\gradlew.bat installDebug
adb shell am start -n co.sigr.cliente/.MainActivity
```

Cuatro trampas que cuestan una tarde si no se conocen:

- **`adb` no está en el PATH.** De ahí las líneas de `export PATH` / `$env:Path`.
- **En Git Bash no sirve `$LOCALAPPDATA`.** Vale `C:\Users\…` con barras invertidas y el
  PATH de Bash necesita `/c/Users/…`. Use `$HOME`, que sí llega en formato POSIX.
- **`adb disconnect` no es relleno.** Si el móvil está a la vez por cable y por
  depuración inalámbrica, `adb reverse` falla con *«more than one device»*, el error se
  pierde entre la salida de Docker y la de Gradle, y la app acaba sin puente.
- **En PowerShell es `.\gradlew.bat`**, con extensión. `./gradlew` es el guion de Linux.

</details>

---

## 🧭 Qué es SIGR

Cubre el ciclo completo de servicio de un restaurante: diseño del salón, toma de comandas,
pantallas de cocina y barra, cobro, arqueo de caja, inventario por recetas, reportes y —
desde el canal digital— reservas y domicilios pedidos por el propio comensal.

| Módulo | Ruta | Quién lo usa |
|---|---|---|
| 🎛️ **Administración** | `public/admin/` | Salón, menú, recetas, inventario, reportes, canal digital |
| 📱 **Comandero** (PWA) | `public/comandero/` | Mesero: plano, toma de comanda y seguimiento |
| 👨‍🍳 **KDS** | `public/kds/` | Pantallas de cocina y barra |
| 💳 **Caja** | `public/caja/` | Cobro, división de cuenta, arqueo, reservas y domicilios |
| 🤳 **App del cliente** | `movil/` | Android: carta, reservas y pedidos a domicilio |

**Stack:** Node 20+, Express, MySQL 8, JavaScript sin framework en el navegador (módulos ES
nativos) y Kotlin + Jetpack Compose en Android.

> [!NOTE]
> **No hay paso de compilación en la web.** Lo que está en `public/` es exactamente lo que
> corre el navegador. Edita un archivo, recargas la página, y ya.

---

## ✅ Requisitos

| Herramienta | Versión | ¿Obligatorio? |
|---|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Con `docker compose` | ✔️ Ruta recomendada |
| [Node.js](https://nodejs.org) | `>= 20` | ✔️ Pruebas y scripts de base de datos |
| [Android Studio](https://developer.android.com/studio) | Cualquiera reciente | ➖ Solo para la app móvil |
| MySQL 8 local | 8.0 | ➖ Solo si **no** usa Docker |

```bash
node --version && docker compose version
```

<details>
<summary>Ruta alternativa: Node en local, sin contenedor de API</summary>

<br>

Útil para depurar el servidor con sus herramientas de siempre.

```bash
docker compose up -d db      # solo la base de datos
npm install
npm run dev                  # servidor con recarga automática
```

El `.env` ya apunta al **3307**, así que el servidor local encuentra la base sin tocar nada.
La base escucha ahí y no en el 3306 para no chocar con un MySQL ya instalado en la máquina.

</details>

---

## 🔑 Primer acceso

Credenciales sembradas por `db/03_seed.sql`:

| Rol | Correo | Contraseña | Documento | PIN |
|---|---|---|:--:|:--:|
| 🛡️ Administrador | `admin@sigr.local` | `Admin123!` | CC1001 | 1111 |
| 💰 Cajero | `cajero@sigr.local` | `Cajero123!` | CC1002 | 2222 |
| 👨‍🍳 Cocinero | `cocinero@sigr.local` | `Cocina123!` | CC1003 | 3333 |
| 🧾 Mesero | `mesero@sigr.local` | `Mesero123!` | CC1004 | 4444 |

- 🖥️ **Escritorio** → correo y contraseña
- 📱 **Tablet y móvil** → documento y PIN

> [!CAUTION]
> `db/03_seed.sql` **no debe cargarse en producción**: son credenciales públicas.

### El salón arranca vacío, y es a propósito

El plano de un restaurante no se parece al de ningún otro, así que se dibuja desde cero:

> **Administración → Salón** → crear una zona → arrastrar las mesas al lienzo →
> **Guardar distribución**

En el lienzo se puede **arrastrar sobre una zona vacía para seleccionar varias mesas** y
quitarlas de un clic. Sin ratón se llega a lo mismo con `Ctrl`/`Shift` + clic, `Ctrl+A`,
`Ctrl+Espacio`, `Esc` y `Supr`.

### Para que funcionen los domicilios

Antes de aceptar el primer pedido hay que configurar la cobertura:

> **Administración → Canal digital → Zonas de entrega** → clic para el centro, arrastre
> para el radio, y precio y pedido mínimo por zona.

El mapa **abre encuadrado sobre la cobertura que ya existe**, y una zona nueva nace en el
centro de esa vista. Solo cuando todavía no hay ninguna zona mira a la ficha del
restaurante, y en último término a unas coordenadas de fábrica.

Y las formas de pago, si quiere cobrar por transferencia:

> **Administración → Canal digital → Aplicación móvil → Métodos de pago**

---

## 📱 La app del comensal

Vive en **`movil/`**, una carpeta autónoma con su propio Gradle: se puede copiar o sacar del
repositorio y sigue compilando. Paquete `co.sigr.cliente`, `minSdk 26`, `compileSdk 36`.

```bash
cd movil && ./gradlew assembleDebug
```

El APK queda en `movil/app/build/outputs/apk/debug/app-debug.apk`.

### Cómo encuentra el servidor

**En desarrollo no hay nada que configurar.** Al arrancar, la app prueba en orden:

1. La dirección que le funcionó la última vez (queda guardada).
2. `http://10.0.2.2:3000/` — así ve el **emulador** el `localhost` del PC.
3. `http://localhost:3000/` — el **móvil por cable**, con `adb reverse tcp:3000 tcp:3000`.

Se queda con la primera que responda a `/api/v1/app/estado`. El **mismo APK** sirve para el
emulador y para el móvil, sin recompilar al cambiar de uno a otro.

Si aún así no lo encuentra —móvil por WiFi, otra subred—, la pantalla «No disponible ahora
mismo» de las compilaciones **de depuración** trae un enlace plegado para escribir la IP del
PC sin recompilar. Recuerde abrir el puerto 3000 en el cortafuegos de Windows.

### En producción no se configura nada

| | Depuración | Release |
|---|---|---|
| Búsqueda de servidor | Sí | **No** |
| Campo para escribir la IP | Sí, plegado | **No existe** |
| Tráfico sin cifrar | Permitido (`src/debug/res/xml/`) | **Prohibido**, HTTPS obligatorio |
| Dirección | La que encuentre | `API_BASE_URL_RELEASE` |

Al publicar se pone **un dominio**, no una IP:

```properties
API_BASE_URL_RELEASE=https://pedidos.turestaurante.com/
```

Un dominio permite que el hosting cambie de máquina, de proveedor o de IP sin volver a
publicar la app: lo resuelve el DNS. El comensal abre la app y se conecta, sin ver jamás una
dirección.

> **Por qué el campo de dirección no puede existir en release:** además de incomprensible
> para un comensal, sería una vía para apuntar la app a un servidor ajeno que le capturara la
> contraseña, la cédula y el comprobante de pago.

<details>
<summary><b>Compilar para publicar</b></summary>

<br>

Genere una clave de firma:

```bash
keytool -genkeypair -v -keystore sigr.jks -keyalg RSA -keysize 2048 -validity 10000 -alias sigr
```

Guarde ese `.jks` **fuera del repositorio** y no lo pierda: sin él no podrá publicar
actualizaciones de la misma app, nunca.

Apunte `API_BASE_URL_RELEASE` a su dominio con HTTPS, declare la firma en
`movil/app/build.gradle.kts` y compile:

```bash
cd movil && ./gradlew assembleRelease
```

</details>

### La bandeja de avisos

Se organiza sola en cuanto crece: filtros por tipo (pedidos, reservas, ofertas) con su
recuento, y separadores de **Hoy / Ayer / Anteriores** dentro de la lista. Los filtros solo
aparecen a partir de cuatro avisos, y ninguno que dejaría la lista vacía se ofrece.

**Se elimina deslizando**, hacia cualquiera de los dos lados —cuál es «el natural» depende de
la mano con la que se sujete el teléfono—. La tarjeta desaparece al instante y el borrado
real se manda solo si el **Deshacer** del mensaje inferior expira sin que nadie lo pulse:
deslizar es fácil de hacer sin querer, y sin vuelta atrás se perdería el aviso con el código
de la reserva.

> Quien no pueda hacer el gesto tiene el botón de la barra, que vacía los leídos de una vez
> y **conserva lo no leído**. Es la misma regla que ya cumplen el diseñador de salón y las
> zonas de entrega: todo arrastre tiene salida por otro camino.

El borrado es real, y aquí sí corresponde: una notificación es una **copia** de un aviso
cuyo original vive en la reserva o el pedido. Tirarla no toca el pedido, ni su factura, ni la
auditoría. Por eso `db/09_borrar_avisos.sql` concede `DELETE` sobre esa tabla **y solo sobre
esa**: `factura` y `log_auditoria` siguen siendo intocables para el usuario de la aplicación.

### La foto de perfil

En **Perfil**, tocar el avatar abre el selector de fotos del sistema.

> Se usa `PickVisualMedia` y **no** el permiso de galería. Es la diferencia entre pedir
> acceso a *todas* las fotos del cliente —un diálogo que mucha gente rechaza, con razón— y
> que elija una y solo esa llegue a la aplicación. No hace falta declarar
> `READ_MEDIA_IMAGES`.

Sin foto se muestra la inicial del nombre, no un hueco gris. El tamaño se comprueba en el
móvil antes de subir (2 MB, el mismo tope del servidor) para no gastar la subida entera de
una foto de 8 MB antes de que la rechacen al otro lado, y la copia temporal se borra pase lo
que pase.

### Lo que la app añade al lado web

| Dónde | Qué |
|---|---|
| **Admin → Canal digital → Zonas de entrega** | Cobertura como círculos sobre un mapa, con radio, precio y pedido mínimo |
| **Admin → Canal digital → Aplicación móvil** | Encender y apagar la app, ficha del restaurante, métodos de pago, promociones push |
| **Caja → Reservas** | Llegan **en vivo**, con aviso, campana y globo; se confirman asignando mesa |
| **Caja → Domicilios** | Aceptar un pedido abre una comanda real que entra en el KDS y se cobra como cualquier mesa |
| **API `/api/v1/app`** | Superficie del cliente: token Bearer, límite por IP, interruptor de mantenimiento |

### Tres cosas que conviene saber

**Un domicilio aceptado se convierte en una `orden` real.** No hay circuito paralelo: entra
por el mismo KDS, descuenta inventario por receta y se cobra en caja. Para lograrlo sin
hacer `orden.id_mesa` nullable —lo que rompería decenas de consultas— existe una zona
virtual **`Domicilios`** con 30 posiciones `D1..D30` que sirven de ancla. En el KDS un
domicilio aparece como «D7» y se distingue de un vistazo del servicio en sala.

> [!WARNING]
> Esas posiciones **no se tocan**. El servidor las oculta del diseñador de salón y rechaza
> borrarlas, moverlas o renombrar su zona. Sin ellas, Caja no puede aceptar ni un pedido.
> `npm run bd:vaciar` las repone automáticamente.

**El mapa no usa Google Maps.** Las teselas se sirven por
`/api/v1/mapa/teselas/:z/:x/:y.png`, un proxy con caché en disco, así que el CSP estricto no
se tocó y no hace falta ninguna clave de API.

**La dirección se escribe sola.** En **Perfil → Mis direcciones**, señalar un punto en el
mapa rellena la casilla «Dirección completa» con la dirección real de ese portal —«Calle 62
#11-04, Chapinero, Bogotá»—. Se puede corregir a mano después; lo que se evita es teclear
eso entero en un móvil, que es lento y se presta a erratas que acaba pagando el repartidor.

La traducción la hace el servidor en `/api/v1/mapa/direccion`, no el móvil, por las mismas
razones que las teselas: sin clave de API, sin que el teléfono del comensal hable con
terceros, y con una caché compartida —diez vecinos del mismo edificio son una consulta, no
diez—. El `Geocoder` de Android se descartó porque depende de los servicios de Google Play y
en un móvil sin ellos devuelve una lista vacía sin decir por qué.

> Nominatim admite **una petición por segundo** en total. El servidor lo respeta con una
> cola serializada, caché de 24 h y un límite por IP. Si el servicio no contesta, la casilla
> no se autocompleta y ya está: la dirección se escribe a mano, como antes.

**El pago se verifica antes de cocinar.** Con Nequi, Bancolombia o DaviPlata el cliente sube
el comprobante y **el pedido no avanza hasta que Caja lo confirma**. Contra entrega no
requiere verificación.

---

## 🔔 Notificaciones push

**Son opcionales.** Sin Firebase configurado el sistema funciona igual: los avisos se
guardan en la bandeja de la app y el cliente los ve al abrirla; solo no suena el aviso en el
móvil.

Por eso **Canal digital → Aplicación móvil** lo dice como una nota informativa y **se puede
cerrar** para siempre. Antes era un ⚠ permanente, y eso estaba mal planteado: marcar como
avería algo que es un modo de funcionamiento previsto enseña a ignorar los avisos, y el día
que salga uno de verdad tampoco se leerá. La nota trae además el comando exacto, en vez de
mandar a editar el `.env` a mano:

```bash
npm run firebase -- ruta/al/archivo.json
```

Si algún día se configura el push, la nota deja de salir sola aunque se hubiera cerrado.

### Firebase son DOS mitades, y hacen falta las dos

Es la confusión más fácil de tener aquí, porque cada mitad falla de forma distinta y una de
ellas engaña:

| Mitad | Qué archivo | Para qué | Si falta |
|---|---|---|---|
| **Cliente** | `movil/app/google-services.json` | Que el móvil obtenga su token y lo registre | El servidor no tiene a quién enviar |
| **Servidor** | `FCM_*` en el `.env` | Que el servidor pueda **enviar** a Google | Nada sale del servidor |

Se puede tener la primera y no la segunda —dispositivos registrados en la base y cero
notificaciones entregadas—, que es el caso por defecto de este repositorio.

> [!WARNING]
> **Ver un aviso dentro de la app NO demuestra que el push funcione.** Todo aviso se escribe
> primero en la bandeja de la aplicación y solo después se intenta enviar al móvil; la
> bandeja se llena igual aunque Firebase no esté configurado. Al abrir la app se ve el aviso
> y parece que funcionó.
>
> **La prueba de verdad:** cierre la aplicación por completo y envíe la promoción. Si no
> aparece nada en la barra de notificaciones del teléfono, el push está apagado.
>
> Y aun con Firebase bien configurado, en Android 13 o superior no se muestra nada hasta que
> el usuario concede el permiso de notificaciones que la app pide al arrancar.

### Si Firebase está bien y aun así no suena: el fabricante

Comprobado en un Xiaomi con HyperOS: con las dos mitades puestas, Google acepta el mensaje y
devuelve su identificador —así que el servidor hizo su trabajo— y el teléfono **no muestra
nada**. No es un fallo del sistema.

Xiaomi, Huawei, Oppo y Vivo bloquean por defecto que una app se despierte en segundo plano, y
FCM necesita justo eso. En el teléfono hay que permitirlo a mano:

> **Ajustes → Aplicaciones → SIGR → Ahorro de batería → Sin restricciones**
> y **Inicio automático** (o «Autostart») activado.

Dos cosas más que confunden al probar:

- **`adb shell am force-stop` invalida la prueba.** Deja la app en estado *stopped* de
  Android, donde el sistema NO le entrega mensajes FCM hasta que alguien la abra a mano.
  Para probar en segundo plano, use el botón de inicio, no `force-stop`.
- **Un 200 de FCM no es una entrega.** Significa que Google se hizo cargo del mensaje. Si el
  móvil está sin red o el fabricante lo bloquea, se queda en cola o se descarta, y el
  servidor no tiene forma de enterarse. Por eso la ficha de la promoción dice «aceptados por
  Firebase» y no «entregados».

### Lado de la app — ya configurado

`movil/app/google-services.json` enlaza la app con el proyecto `comanda-app-894d4` y el
paquete `co.sigr.cliente`. Ese archivo **no es secreto** (viaja dentro del APK), pero está
en `.gitignore` porque es de su proyecto de Firebase, no del repositorio.

Si falta, la app compila igual: el plugin `google-services` solo se aplica si el archivo
existe, y sin él Firebase no se autoinicializa.

### Lado del servidor — paso a paso

Para **enviar** notificaciones hacen falta las credenciales de una cuenta de servicio, que
son un archivo distinto del `google-services.json`.

#### 1 · Descargar la clave

1. Abra <https://console.firebase.google.com> y entre en su proyecto.
2. Pulse el **engranaje ⚙** de arriba a la izquierda → **Configuración del proyecto**.
3. Vaya a la pestaña **Cuentas de servicio**.
4. Abajo, botón **Generar nueva clave privada** → **Generar clave**.
5. El navegador descarga un `.json` con un nombre largo, algo como
   `comanda-app-894d4-firebase-adminsdk-a1b2c.json`.

Ese archivo empieza por `{ "type": "service_account", …`. Si el suyo empieza por
`{ "project_info": …` se ha descargado el de la app, que no sirve aquí.

#### 2 · Conectarlo

```bash
npm run firebase -- "C:/Users/usted/Downloads/comanda-app-894d4-firebase-adminsdk-a1b2c.json"
```

El guion lee el archivo, **comprueba contra Google que las credenciales funcionan** y solo
entonces escribe las tres variables en su `.env`. La clave privada no se imprime en ningún
momento.

```
Conectando Firebase

  ✓ proyecto comanda-app-894d4
  ✓ cuenta   firebase-adminsdk-a1b2c@comanda-app-894d4.iam.gserviceaccount.com
    clave privada leída (1704 caracteres, no se muestra)

Comprobando contra Google…
  ✓ Google las acepta
  ✓ .env actualizado
```

**Se hace con un guion y no a mano** porque la clave privada tiene saltos de línea reales y
en un `.env` deben ir escapados como `\n`, en una sola línea y entre comillas. Copiarla a
mano falla casi siempre por ahí, y el error que devuelve Google no menciona el formato.

#### 3 · Reiniciar y comprobar

```bash
docker compose up -d --build api
```

```bash
npm run firebase -- --probar
```

Lo segundo pide un token de acceso a Google exactamente igual que hace `push.js` en cada
envío: si pasa, el push funciona.

#### 4 · Guardar la clave, o rotarla

> [!CAUTION]
> Ese `.json` contiene una **clave privada** que permite enviar notificaciones en nombre de
> su restaurante. Guárdelo fuera del repositorio y no lo comparta por chat, ticket ni
> captura. El `.env` donde acaba está en `.gitignore`.

**Si la clave se expuso** —quedó en un chat, en una captura, en un repositorio— hay que
rotarla. No basta con borrar el mensaje: quien la haya visto la conserva.

1. Consola de Firebase → **Configuración del proyecto** → **Cuentas de servicio** →
   **Administrar los permisos de la cuenta de servicio** (le lleva a Google Cloud).
2. Entre en la cuenta `firebase-adminsdk-…` → pestaña **Claves**.
3. **Genere una clave nueva** primero, y solo después **elimine la vieja**: al revés, el
   push queda muerto entre un paso y otro.
4. Conecte la nueva y borre el `.json` descargado:

```bash
npm run firebase -- "ruta/al/nuevo.json" && docker compose up -d --build api
```

Rotar es barato —dos minutos— y no afecta a la app instalada: el `google-services.json` del
cliente es otro archivo y no cambia.

**No confunda con el «certificado push web» (VAPID)** que aparece en la misma pantalla de
Firebase: es una cadena que empieza por `B…` y sirve para notificaciones en un navegador, no
para una app Android.

Sin dependencias nuevas: el JWT RS256 que exige FCM HTTP v1 se firma con `node:crypto` en
`server/servicios/push.js`, en lugar de arrastrar `firebase-admin` y sus transitivas.

---

## 🏃 Comandos

### Ejecutar

| Comando | Qué hace |
|---|---|
| `npm run arrancar` | **Lo levanta todo.** Es lo que hay que ejecutar tras cambiar código del servidor |
| `npm run parar` | Baja los contenedores. La base se conserva |
| `npm run registros` | Sigue los registros de los dos contenedores en vivo |
| `npm run estado` | Qué contenedores hay en pie |
| `npm start` | Servidor en modo normal. Es lo que ejecuta el contenedor `sigr_api` |
| `npm run dev` | Igual, con `node --watch`: reinicia solo al guardar |
| `docker compose up -d --build api` | Lo que `npm run arrancar` hace por dentro. `restart` NO basta: la imagen lleva `server/` copiado dentro |
| `cd movil && ./gradlew installDebug` | Tras cambiar código de la app |

### Probar

| Comando | Qué verifica | ¿Servidor? | ¿MySQL? |
|---|---|:--:|:--:|
| `npm run arrancar -- --pruebas` | **Levanta el sistema y pasa las tres baterías (99)** | — | — |
| `npm test` | Unitarias + aceptación (64) | ➖ | ✔️ |
| `npm run test:e2e` | Los 5 casos de uso del FSD cap. 7 (8) | ✔️ | ✔️ |
| `npm run test:seguridad` | Superficie de ataque (27) | ➖ | ✔️ |
| `npm run test:carga` | 50 dispositivos concurrentes | ✔️ | ✔️ |
| `node tests/integracion/tiempo-real.mjs` | CA-01 y CA-02 cronometrados sobre WebSocket real | ✔️ | ✔️ |
| `cd movil && ./gradlew testDebugUnitTest` | Unitarias de la app (7) | ➖ | ➖ |

### Limpiar la base de datos

Tres niveles de agresividad, todos sobre `scripts/vaciar.js`:

| Comando | Qué hace |
|---|---|
| `npm run bd:ver` | **Mira sin tocar.** Cuenta filas y muestra qué se borraría |
| `npm run bd:vaciar` | Borra la operación del día a día |
| `npm run bd:reiniciar` | Deja la base como recién instalada |

`bd:vaciar` en detalle:

| ❌ Se borra | ✅ Se conserva |
|---|---|
| Salón y mesas | Catálogo y precios |
| Comandas y su detalle | Insumos y recetas |
| Facturas, pagos y turnos | Proveedores |
| Clientes de la app, reservas y domicilios | Usuarios, roles y permisos |
| | Configuración y zonas de entrega |
| | Auditoría |

Dos cosas que hace y no se ven:

- **Repone las 30 posiciones de domicilio.** Viven en `zona` y `mesa`, así que el vaciado se
  las llevaba por delante y el fallo no aparecía hasta que un cajero intentaba aceptar un
  pedido, días después.
- **Los `AUTO_INCREMENT` no vuelven a 1**, sino al último id que la auditoría menciona para
  cada tabla. Si volvieran a 1, las facturas nuevas reestrenarían números que registros de
  auditoría viejos ya reclaman.

> [!IMPORTANT]
> Un vaciado no se deshace. Antes de uno grande, una copia cuesta un segundo:
> ```bash
> docker exec sigr_db mysqldump -uroot -proot_sigr_dev --single-transaction sigr > respaldos/copia.sql
> ```

### Borrón y cuenta nueva

```bash
docker compose down -v && docker compose up -d --build
```

⚠️ Destruye el volumen: la base se recrea desde `db/*.sql`.

### Utilidades

| Comando | Qué hace |
|---|---|
| `npm run hash -- MiClave123!` | Genera un hash bcrypt para sembrar usuarios |
| `npm run firebase -- ruta.json` | Conecta las notificaciones push desde la clave de cuenta de servicio |
| `npm run firebase -- --probar` | Comprueba contra Google que las credenciales de push valen |
| `node scripts/contraste.mjs` | Reverifica los contrastes de la paleta (WCAG) |

---

## 🔧 Variables de entorno

Se copian de `.env.example`. Los valores por defecto funcionan en local sin tocar nada.

<details>
<summary><b>Ver todas las variables</b></summary>

<br>

**General**

| Variable | Por defecto | Para qué |
|---|---|---|
| `NODE_ENV` | `development` | En `production` los scripts de limpieza se bloquean |
| `PORT` | `3000` | Puerto de la API |
| `TZ` | `America/Bogota` | Zona horaria de la aplicación y de la base |

**Base de datos**

| Variable | Por defecto | Para qué |
|---|---|---|
| `DB_HOST` | `localhost` | Anfitrión de MySQL |
| `DB_PORT` | `3307` | Puerto de MySQL visto desde la aplicación |
| `DB_NAME` | `sigr` | Nombre de la base |
| `DB_USER` | `sigr_app` | Usuario de la aplicación (privilegios mínimos) |
| `DB_PASSWORD` | `sigr_app_dev` | Su contraseña |
| `DB_ROOT_PASSWORD` | `root_sigr_dev` | Root — solo lo usan los scripts de limpieza |
| `DB_PORT_HOST` | `3307` | Puerto que expone el contenedor MySQL |
| `PORT_HOST` | `3000` | Puerto que expone el contenedor de la API |

**Seguridad**

| Variable | Por defecto | Para qué |
|---|---|---|
| `BCRYPT_COSTO` | `12` | Coste de bcrypt. El FSD 6.1 exige `>= 12` |
| `SESION_HORAS` | `12` | Duración de la sesión del personal |
| `SESION_INACTIVIDAD_MIN` | `10` | Minutos tras los que se re-pide el PIN |
| `SESION_CLIENTE_DIAS` | `30` | Duración del token de un cliente de la app |
| `COOKIE_SEGURA` | `false` | En producción tras HTTPS debe ser `true` |

**Canal digital**

| Variable | Por defecto | Para qué |
|---|---|---|
| `FCM_PROJECT_ID` | — | Id del proyecto de Firebase |
| `FCM_CLIENT_EMAIL` | — | Cuenta de servicio que envía las notificaciones |
| `FCM_PRIVATE_KEY` | — | Su clave privada. **Nunca sale del `.env`** |
| `MAPA_TESELAS_URL` | OpenStreetMap | Origen de las teselas del mapa |
| `MAPA_CACHE_DIR` | `.cache/teselas` | Fuera de `public/`: no se sirven como estáticos |
| `MAPA_USER_AGENT` | `SIGR/0.1 …` | La política de OSM exige identificarse |
| `MAPA_GEOCODIFICACION_URL` | Nominatim | De un punto del mapa a una dirección escrita |
| `MAPA_IDIOMA` | `es` | Para que diga «Calle» y no «Street» |
| `APP_VERSION_MINIMA` | `1` | Por debajo, la app pide actualizarse |

</details>

> [!CAUTION]
> El `.env` **nunca** se sube al repositorio.

---

## 📁 Estructura del proyecto

```
📁 server/                    Backend
   index.js                   arranque, middleware y montaje de rutas
   db.js                      pool, consultas parametrizadas y transacciones con reintento
   realtime.js                canal WebSocket y catálogo de eventos
   middleware/                auth del personal, auth de clientes, permisos, errores,
                              compresión, interruptor de la app y límite por IP
   rutas/                     un archivo por área: salon, ordenes, kds, caja, catalogo,
                              app, reservas, domicilios, configuracion, mapa
   servicios/                 precios, dinero, inventario, auditoría, clientes, entregas,
                              reservas, domicilios, pagos, push, teselas, parámetros,
                              caché de la matriz de permisos

📁 public/                    Frontend — sin compilar, tal cual lo sirve el navegador
   comun/                     cliente HTTP, componentes de interfaz y cliente WebSocket
   admin/                     back office: salón, menú, recetas, inventario, canal digital
   comandero/                 PWA del mesero: plano, toma de comanda y seguimiento
   kds/                       pantallas de cocina y barra
   caja/                      cobro, división de cuenta, arqueo, reservas y domicilios
   vendor/                    Leaflet servido en local (ver «Sin CDN» más abajo)

📁 movil/                     📱 App Android — CARPETA AUTÓNOMA
   arrancar.sh                levanta todo y verifica cada paso
   gradlew, settings.gradle   build propio: se puede sacar del repositorio y sigue compilando
   app/src/main/java/…        Kotlin + Jetpack Compose
   app/src/debug/res/xml/     política de red permisiva, SOLO para depuración

📁 db/                        Se ejecutan en orden al crear el volumen
   01_schema.sql              tablas y restricciones
   02_permisos.sql            catálogo de permisos y su asignación a roles
   03_seed.sql                usuarios y catálogo de demostración
   04_privilegios.sql         privilegios mínimos de los usuarios de base de datos
   05_movil.sql               canal digital: clientes, reservas, domicilios, cobertura
   06_pagos.sql               métodos de pago de la app y verificación de comprobantes
   07_rendimiento.sql         índices de las consultas calientes (reaplicable)
   08_promocion_push.sql      separa «guardada en la bandeja» de «sonó en el móvil»
   09_borrar_avisos.sql       DELETE sobre notificacion_cliente para sigr_app

📁 tests/                     unit · aceptacion · e2e · seguridad · carga · integracion
📁 scripts/                   arrancar.mjs · vaciar.js · hash.js · contraste.mjs
📁 respaldos/                 copias de la base (ignorado por git)
```

> **`npm run arrancar` aplica del 05 al 07 en cada arranque**, y con eso basta: los tres
> están escritos para poder reaplicarse (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`, y
> los `ALTER` envueltos en un procedimiento que comprueba antes).
>
> Hace falta porque el entrypoint de MySQL ejecuta `db/*.sql` solo la **primera** vez que se
> crea el volumen: sobre una base que ya existe, un archivo nuevo no se aplicaría nunca.

---

## 🧠 Decisiones de diseño

> Léalo antes de tocar el código. Cada punto responde a un error real que ya se cometió.

**🔒 Las consultas van siempre parametrizadas.**
`server/db.js` solo expone helpers que reciben `(sql, parametros)` y usan sentencias
preparadas. Nunca se concatena SQL con entrada del usuario.

**💵 El dinero no se calcula en coma flotante.**
Los `DECIMAL` llegan como cadena y se operan con `servicios/dinero.js`. Convertirlos a
`Number` descuadra el arqueo. En Kotlin, `BigDecimal`.

**🧾 Las facturas no se borran, nunca.**
El usuario de base de datos de la aplicación no tiene `DELETE` sobre `factura`, y es el
motor quien lo impone (`db/04_privilegios.sql`). Una venta emitida solo se corrige con una
anulación auditada. Por eso una zona que conserve facturas no se elimina: **se da de baja**.

**⛓️ La auditoría es de solo inserción y encadena hashes.**
Alterar o borrar una fila suelta rompe la cadena de todas las siguientes y queda en
evidencia. Por eso `bd:vaciar` no la toca.

**🪑 Las mesas con historial no se eliminan, se retiran.**
Desaparecen del plano pero conservan su fila, porque sus comandas y sus reservas la
referencian. Si luego se crea una mesa con el mismo número en la misma zona, se **reactiva
la original** con su historial en lugar de duplicarla.

**👥 El comensal no es un `usuario`.**
`usuario` está atado a la matriz de permisos del backoffice; meter ahí a los clientes los
pondría en la pantalla de permisos y en el selector de login del personal. Viven en su
propio carril: tabla `cliente`, `sesion_cliente` con **token Bearer** (no cookie, porque el
cliente es OkHttp y no un navegador), namespace `/api/v1/app` y autorización por pertenencia
en vez de por permiso.

**🗑️ Dar de baja una cuenta anonimiza, no borra.**
Se sobrescribe el dato personal y se conserva la trazabilidad contable de sus pedidos. Y
libera la cédula para un re-registro.

**🌐 Sin CDN, y por eso Leaflet está vendorizado.**
El CSP es estricto a propósito (`script-src 'self'`, `img-src 'self' data:`,
`connect-src 'self' ws:`). Un `<script src="https://unpkg.com/…">` quedaría bloqueado por el
navegador antes de descargarse. Copiar Leaflet a `public/vendor/` y proxear las teselas es
lo que permite tener un mapa **sin tocar un carácter del CSP**.
Leaflet se distribuye bajo licencia BSD-2-Clause; su aviso de copyright viaja en los propios
archivos de `public/vendor/leaflet/`. Los datos de los mapas son © colaboradores de
OpenStreetMap, bajo ODbL.

**📡 Todo cambio se publica en tiempo real.**
Mesas, comandas, reservas y domicilios viajan por WebSocket a quien tenga permiso para
verlos, con reconexión automática y respaldo de sondeo cada 10 s.

> Las dos excepciones son deliberadas: **la terminal de cobro y la división de cuenta**
> avisan del cambio en vez de repintarse, para no borrar lo que el cajero está tecleando con
> el cliente delante.

**⚡ La matriz de permisos se relee en cada petición, pero no desde la base.**
El FSD 5.1 exige que revocar un permiso surta efecto en la petición siguiente, y eso se
cumple. Lo que cambió es de dónde sale el dato: `servicios/permisosRol.js` lo tiene en
memoria y se invalida en el momento exacto en que alguien guarda la matriz —dos o tres
veces en la vida del sistema, frente a un `JOIN` por petición—. Lo que **sí** se relee
siempre de la base es el rol del usuario y si sigue activo: dar de baja a alguien tiene que
cortar en seco.

Esa invalidación también reajusta los WebSocket ya abiertos. Antes no: un KDS resolvía sus
permisos en el handshake y se quedaba con ellos las doce horas del turno, así que revocar un
permiso cortaba el acceso por HTTP pero no el chorro de eventos en vivo —la misma
información por otra puerta—.

**🚫 Los archivos estáticos no tocan la base.**
`cargarSesion` estaba montado sobre *toda* petición, así que cada hoja de estilos y cada
módulo JS pagaba dos `SELECT` y un `UPDATE`: abrir una pantalla del backoffice costaba unas
sesenta operaciones **antes** de pedir el primer dato. Ahora solo lo hacen las rutas
`/api/`, que son las únicas que consultan `req.usuario`. Medido con `SHOW GLOBAL STATUS`:
20 peticiones a un estático pasaron de 60 consultas a 0.

Por lo mismo, `ultima_actividad` se reescribe como mucho una vez por minuto en vez de en
cada petición. La regla que lo usa es la de los 10 minutos de inactividad del FSD 5.1: una
resolución de un minuto la respeta de sobra.

**📦 Todo viaja comprimido, sin dependencias nuevas.**
`middleware/compresion.js` son ochenta líneas de `node:zlib`, por la misma razón por la que
las cabeceras de seguridad no usan helmet. Leaflet baja de 147 KB a 41 KB (−72 %) y una cola
del KDS de 51 KB a 1 KB (−98 %). La calidad de brotli está medida, no elegida a ojo: la
tabla con los números está en la cabecera del archivo.

> La trampa que costó encontrar: `express.static` sirve con `pipe`, que ante contrapresión
> pausa el origen y espera un `drain` **de `res`** —pero quien se llena es el compresor. Sin
> reenviar ese evento, los archivos grandes entregaban los diez bytes de la cabecera gzip y
> la petición no terminaba nunca. Los JSON no lo notaban: caben en el buffer y nunca
> devuelven `false`.

**🛡️ La UI oculta, la API revalida.**
Doble capa siempre. Que una pantalla no muestre un botón no es una garantía: la ruta
correspondiente vuelve a comprobar el permiso. Lo mismo con la zona `Domicilios`: se esconde
del diseñador **y** las rutas de escritura la rechazan.

---

## ♿ Accesibilidad

Cumple **WCAG 2.1 nivel AA**, que es lo que exige el FSD 6.4.

| Criterio | Estado |
|---|---|
| Contraste ≥ 4.5:1 (≥ 7:1 en KDS) | ✅ 21/21 combinaciones |
| Navegación por teclado | ✅ |
| `:focus-visible` consistente | ✅ |
| ARIA en componentes dinámicos | ✅ 18/18 modales etiquetados |
| Alternativas al *drag & drop* | ✅ En las 3 pantallas que lo usan |
| Información nunca solo por color | ✅ Icono + texto siempre |
| `prefers-reduced-motion` | ✅ En las 4 hojas con animación |
| Objetivo táctil ≥ 48 px | ✅ Token `--target-tactil` |

Los contrastes son reverificables:

```bash
node scripts/contraste.mjs
```

**Todo arrastre tiene alternativa por teclado.** El diseñador de salón, las zonas de entrega
y el reordenado de categorías se manejan enteros sin ratón, con campos numéricos y atajos.

**Pendiente antes de producción.** Esta auditoría es estática: verifica paleta, marcado y
patrones. Convendría complementarla con lectores de pantalla reales (NVDA, VoiceOver),
axe-core o Lighthouse en el pipeline, y pruebas con el personal real por rol (FSD §10.2).

---

## 🆘 Problemas frecuentes

### La web

| Síntoma | Causa | Solución |
|---|---|---|
| `docker compose` falla nada más empezar, hablando de `GetFileAttributesEx` | Falta el `.env` | `npm run arrancar` lo crea solo |
| `curl` a `/api/v1/salud` no responde | Docker Desktop cerrado | Ábralo y `npm run arrancar` |
| Cambié código del servidor y no pasa nada | `restart` no recarga la imagen | `npm run arrancar` |
| Entro y el salón está en blanco | Es el diseño: el plano se dibuja desde cero | Administración → Salón. `npm run arrancar` lo avisa cuando pasa |
| «La operación afecta a registros relacionados» | Clave foránea | El mensaje detallado dice qué mesa y por qué; suele ser una reserva viva |

### La app

| Síntoma | Causa | Solución |
|---|---|---|
| «No disponible ahora mismo», móvil por cable | El puente se cayó | `npm run arrancar -- --movil --sin-compilar`, que lo reabre |
| Lo mismo, y `adb reverse` falla | Móvil conectado por cable **y** por wifi | `adb disconnect` primero. El guion ya lo hace, pero **solo** en ese caso |
| «No hay ningún dispositivo» con el móvil por wifi | Versiones anteriores hacían `adb disconnect` a secas y lo tiraban | Ya corregido: la inalámbrica solo se cierra si hay también cable |
| «Error type 3 · Activity class does not exist» | La app no está instalada en ese dispositivo | Ejecútelo sin `--sin-compilar`. El guion ahora lo detecta y lo dice así |
| Lo mismo, pero la red va bien | El canal digital está **apagado** en Admin | Admin → Canal digital → App móvil |
| Conectaba y de pronto dejó de hacerlo | Guardó una dirección que ya no vale | `adb shell pm clear co.sigr.cliente` |
| `ERROR: JAVA_HOME is not set` | Gradle no encuentra el JDK | `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"` |
| `adb: command not found` | No está en el PATH | Ver [arranque rápido](#-arranque-rápido) |
| `INSTALL_FAILED_USER_RESTRICTED` | MIUI bloquea instalar por wifi | Instale **por cable** una vez; luego ya vale inalámbrico |
| `CLEARTEXT communication not permitted` | Está probando el APK de **release** contra `http://` | Use el de depuración. En release solo HTTPS, a propósito |
| «Default FirebaseApp failed to initialize» | No hay `google-services.json` | Normal. No rompe nada: los avisos van a la bandeja |
| El mapa sale gris | El proxy de teselas no responde | `curl http://localhost:3000/api/v1/mapa/teselas/13/2410/3991.png` |

### Los domicilios

| Síntoma | Causa | Solución |
|---|---|---|
| «No hay posiciones de domicilio configuradas» | Se perdió la zona virtual | `docker exec -i sigr_db mysql -uroot -proot_sigr_dev sigr < db/05_movil.sql` |
| «No hacemos entregas en esa dirección» siempre | No hay cobertura definida | Admin → Canal digital → Zonas de entrega |
| El pedido no avanza tras pagar | Es el diseño | Caja tiene que verificar el comprobante primero |

---

<div align="center">
<br>
<sub>SIGR · Implementación del FSD v1.1</sub>
</div>
