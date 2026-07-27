<div align="center">

# 🍽️ SIGR

### Sistema Integral de Gestión para Restaurantes

*Del plano del salón a la caja cuadrada, sin salir del navegador.*

[![Node](https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Sin build](https://img.shields.io/badge/build_step-ninguno-brightgreen?style=flat-square)](#-estructura-del-proyecto)
[![FSD](https://img.shields.io/badge/FSD-v1.1-blueviolet?style=flat-square)](FSD_SIGR_Sistema_Gestion_Restaurantes_v1.1.docx)

</div>

---

## 📑 Índice

| | Sección | Para qué |
|:--:|---|---|
| 🧭 | [Qué es SIGR](#-qué-es-sigr) | Panorama y módulos |
| ✅ | [Requisitos previos](#-requisitos-previos) | Qué instalar antes de empezar |
| 🚀 | [Puesta en marcha](#-puesta-en-marcha) | Levantar el proyecto paso a paso |
| 🔑 | [Primer acceso](#-primer-acceso) | Credenciales y dibujo del salón |
| ▶️ | [Comandos · Ejecutar el proyecto](#️-comandos--ejecutar-el-proyecto) | `start`, `dev` |
| 🧪 | [Comandos · Pruebas](#-comandos--pruebas) | Unitarias, e2e, seguridad, carga |
| 🧹 | [Comandos · Limpiar la base de datos](#-comandos--limpiar-la-base-de-datos) | `bd:ver`, `bd:vaciar`, `bd:reiniciar` |
| 🛠️ | [Comandos · Utilidades](#️-comandos--utilidades) | `hash` |
| ⚙️ | [Variables de entorno](#️-variables-de-entorno) | Configuración del `.env` |
| 🗂️ | [Estructura del proyecto](#️-estructura-del-proyecto) | Dónde vive cada cosa |
| 🧠 | [Decisiones de diseño](#-decisiones-de-diseño) | Leer **antes** de tocar el código |
| 📚 | [Documentación adicional](#-documentación-adicional) | FSD, manual, accesibilidad |

---

## 🧭 Qué es SIGR

Implementación del **FSD v1.1**. Cubre el ciclo completo de servicio de un restaurante:
diseño del salón, toma de comandas, pantallas de cocina y barra, cobro, arqueo de caja,
inventario por recetas y reportes.

| Módulo | Ruta | Quién lo usa |
|---|---|---|
| 🎛️ **Administración** | `public/admin/` | Salón, menú, recetas, inventario, reportes |
| 📱 **Comandero** (PWA) | `public/comandero/` | Mesero: plano, toma de comanda y seguimiento |
| 👨‍🍳 **KDS** | `public/kds/` | Pantallas de cocina y barra |
| 💳 **Caja** | `public/caja/` | Cobro, división de cuenta y arqueo |

**Stack:** Node 20+, Express, MySQL 8 y JavaScript sin framework en el navegador
(módulos ES nativos).

> [!NOTE]
> **No hay paso de compilación.** Lo que está en `public/` es exactamente lo que corre el
> navegador. Editas un archivo, recargas la página, y ya.

---

## ✅ Requisitos previos

| Herramienta | Versión | ¿Obligatorio? |
|---|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Cualquiera con `docker compose` | ✔️ Ruta recomendada |
| [Node.js](https://nodejs.org) | `>= 20` | ✔️ Para pruebas y scripts de base de datos |
| MySQL 8 local | 8.0 | ➖ Solo si **no** usas Docker |

Comprueba que todo está en su sitio:

```bash
node --version && docker compose version
```

---

## 🚀 Puesta en marcha

### Ruta recomendada — Docker

Levanta la API y MySQL juntos, con la base ya inicializada.

#### Paso 1 · Copiar la configuración

```bash
cp .env.example .env
```

Los valores por defecto ya funcionan en local. Ver [variables de entorno](#️-variables-de-entorno).

#### Paso 2 · Levantar los contenedores

```bash
docker compose up -d --build
```

Arranca dos servicios:

| Contenedor | Servicio | Puerto anfitrión |
|---|---|:--:|
| `sigr_api` | Aplicación Express | **3000** |
| `sigr_db` | MySQL 8 | **3307** |

> [!TIP]
> La base escucha en el **3307** —y no en el 3306— para no chocar con un MySQL que ya
> tengas instalado en la máquina.

#### Paso 3 · Abrir la aplicación

<http://localhost:3000>

La primera vez que se crea el volumen, los scripts de `db/` se ejecutan en orden y dejan
listo el esquema, los permisos, los roles, los usuarios y un catálogo de demostración con
12 platos y sus recetas. No hay que hacer nada más.

<br>

### Ruta alternativa — Node en local

Útil cuando quieres depurar el servidor con tus herramientas de siempre.

```bash
# 1 · Solo la base de datos en Docker
docker compose up -d db

# 2 · Dependencias
npm install

# 3 · Servidor con recarga automática
npm run dev
```

El `.env` ya apunta al **3307**, así que el servidor local encuentra la base sin tocar nada.

---

## 🔑 Primer acceso

### Credenciales de demostración

Las siembra `db/03_seed.sql`.

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

---

## ▶️ Comandos · Ejecutar el proyecto

### `npm start`

```bash
npm start
```

Arranca el servidor en modo normal (`node server/index.js`). Es lo que ejecuta el
contenedor `sigr_api`. **Úsalo para** correr la aplicación tal cual, sin recargas.

### `npm run dev`

```bash
npm run dev
```

Igual que `start`, pero con `node --watch`: **reinicia solo** al guardar un archivo del
servidor. **Úsalo para** desarrollar.

> [!NOTE]
> Los archivos de `public/` **no** necesitan reinicio: son estáticos. Basta con recargar
> el navegador.

---

## 🧪 Comandos · Pruebas

| Comando | Qué verifica | ¿Necesita servidor? | ¿Necesita MySQL? |
|---|---|:--:|:--:|
| `npm test` | Unitarias + aceptación | ➖ | ✔️ |
| `npm run test:e2e` | Los 5 casos de uso del FSD cap. 7 | ✔️ | ✔️ |
| `npm run test:seguridad` | Superficie de ataque | ➖ | ✔️ |
| `npm run test:carga` | 50 dispositivos concurrentes | ✔️ | ✔️ |
| `npm run test:todo` | Las cuatro anteriores encadenadas | ✔️ | ✔️ |

<br>

### `npm test` — unitarias y de aceptación

```bash
npm test
```

Las de aceptación necesitan el contenedor de MySQL en pie (`docker compose up -d db`),
porque la concurrencia y las transacciones solo se pueden verificar **contra una base
real**.

### `npm run test:e2e` — de extremo a extremo

```bash
npm run test:e2e
```

Los cinco casos de uso del capítulo 7 del FSD, recorridos por HTTP como los haría un
usuario. **Requiere el servidor corriendo.**

### `npm run test:seguridad` — superficie de ataque

```bash
npm run test:seguridad
```

Escalada de privilegios, inyección SQL, CSRF, manipulación de importes e inmutabilidad de
la auditoría.

### `npm run test:carga` — concurrencia

```bash
npm run test:carga
```

50 dispositivos concurrentes enviando comandas a la vez. **Requiere el servidor corriendo.**

### `npm run test:todo` — la batería completa

```bash
npm run test:todo
```

Encadena unitarias, aceptación, e2e y seguridad. Se detiene en el primer fallo.

> [!TIP]
> Las pruebas crean su propia zona y sus propias mesas (`tests/comun/salon.mjs`) y limpian
> lo que crean. Se pueden repetir sin dejar rastro ni ensuciar tu salón.

---

## 🧹 Comandos · Limpiar la base de datos

Tres comandos, tres niveles de agresividad. Todos apuntan al mismo script:
`scripts/vaciar.js`.

### ¿Cuál necesito?

| Situación | Comando |
|---|---|
| Quiero saber qué hay antes de tocar nada | `npm run bd:ver` |
| Las pruebas manuales dejaron comandas y mesas sucias | `npm run bd:vaciar` |
| Quiero la base como recién instalada | `npm run bd:reiniciar` |
| Quiero destruirlo **todo**, incluido el volumen de Docker | [ver abajo](#borrón-y-cuenta-nueva) |

<br>

### 🔍 `npm run bd:ver` — mirar sin tocar

```bash
npm run bd:ver
```

Cuenta las filas y muestra **qué se borraría**. Es el modo por defecto del script.

> [!IMPORTANT]
> **No borra nada.** Un vaciado no se deshace, así que conviene mirar antes de disparar.

### 🧽 `npm run bd:vaciar` — limpiar la operación del día a día

```bash
npm run bd:vaciar
```

| ❌ Se borra | ✅ Se conserva |
|---|---|
| Salón y mesas | Catálogo y precios |
| Comandas y su detalle | Insumos y recetas |
| Facturas y pagos | Proveedores |
| Turnos y movimientos de caja | Usuarios, roles y permisos |
| | Auditoría |

Es **el comando del día a día**: cuando las pruebas manuales han dejado la base sucia pero
no quieres perder el menú que acabas de cargar.

### 💣 `npm run bd:reiniciar` — dejarla como recién instalada

```bash
npm run bd:reiniciar
```

Vacía **todo** —incluidos catálogo, inventario, compras y auditoría— y vuelve a sembrar el
catálogo de demostración desde `db/03_seed.sql`.

Solo sobreviven **roles, permisos y usuarios**: sin ellos no se podría ni entrar.

> [!WARNING]
> Esto se lleva por delante tu menú, tus recetas y tu historial de auditoría. Corre
> `npm run bd:ver` antes si tienes dudas.

<br>

### Detalles que conviene conocer

**Modo simulación del reinicio completo.** Para ver qué se llevaría `bd:reiniciar` sin
ejecutarlo (el script solo borra con `--si`):

```bash
node scripts/vaciar.js --todo
```

**Los tres se conectan como `root`.** No es descuido: el usuario de la aplicación **no
puede** borrar facturas ni auditoría, y eso es deliberado
([ver decisiones de diseño](#-decisiones-de-diseño)). El script es una herramienta de
mantenimiento, no parte de la aplicación.

**Se niegan a ejecutarse con `NODE_ENV=production`.** Los tres abortan antes de tocar nada.

**La auditoría solo se vacía entera.** `log_auditoria` encadena el hash de cada registro
con el anterior; borrar *algunas* filas rompería la cadena y la aplicación reportaría
manipulación sobre registros que nadie tocó. Por eso `bd:vaciar` no la toca y
`bd:reiniciar` la vacía completa: sin filas, la cadena vuelve a empezar limpia.

<br>

### Borrón y cuenta nueva

Cuando quieres destruir el volumen de MySQL entero y que los scripts de `db/` se vuelvan a
ejecutar desde cero:

```bash
docker compose down -v && docker compose up -d --build
```

> [!CAUTION]
> `-v` elimina **los dos volúmenes**: `sigr_datos` (la base) y `sigr_imagenes` (las fotos
> de los platos). **No hay vuelta atrás.** Si solo quieres reiniciar la base y conservar
> las imágenes, usa [`npm run bd:reiniciar`](#-npm-run-bdreiniciar--dejarla-como-recién-instalada).

### Dónde se guardan los datos

Nada que quieras conservar vive dentro de los contenedores:

| Volumen | Contiene | Se borra con |
|---|---|---|
| `sigr_datos` | Base de datos MySQL | `docker compose down -v` |
| `sigr_imagenes` | Imágenes de los platos (`public/uploads`) | `docker compose down -v` |

Por eso `docker compose up -d --build` se puede repetir sin miedo: recrea los contenedores,
pero los volúmenes siguen en su sitio.

---

## 🛠️ Comandos · Utilidades

### `npm run hash`

```bash
npm run hash
```

Genera hashes **bcrypt de coste 12** para sembrar contraseñas o PINs a mano en los
archivos de `db/`.

---

## ⚙️ Variables de entorno

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
| `SESION_HORAS` | `12` | Duración de la sesión. FSD 5.1 |
| `SESION_INACTIVIDAD_MIN` | `10` | Minutos de inactividad tras los que se re-pide el PIN |
| `COOKIE_SEGURA` | `false` | En producción tras HTTPS debe ser `true`. FSD 6.1 |

</details>

> [!CAUTION]
> El `.env` **nunca** se sube al repositorio.

---

## 🗂️ Estructura del proyecto

```
📁 server/                    Backend
   index.js                   arranque, middleware y montaje de rutas
   db.js                      pool, consultas parametrizadas y transacciones con reintento
   realtime.js                canal WebSocket y catálogo de eventos
   middleware/                autenticación, permisos y manejo central de errores
   rutas/                     un archivo por área: salon, ordenes, kds, caja, catalogo…
   servicios/                 lógica de negocio: precios, dinero, inventario, auditoría…

📁 public/                    Frontend — sin compilar, tal cual lo sirve el navegador
   comun/                     cliente HTTP, componentes de interfaz y cliente WebSocket
   admin/                     back office: salón, menú, recetas, inventario, reportes…
   comandero/                 PWA del mesero: plano, toma de comanda y seguimiento
   kds/                       pantallas de cocina y barra
   caja/                      terminal de cobro, división de cuenta y arqueo

📁 db/                        Se ejecutan en orden al crear el volumen
   01_schema.sql              tablas y restricciones
   02_permisos.sql            catálogo de permisos y su asignación a roles
   03_seed.sql                usuarios y catálogo de demostración
   04_privilegios.sql         privilegios mínimos de los usuarios de base de datos

📁 tests/
   unit/  aceptacion/  e2e/  seguridad/  carga/  integracion/  comun/

📁 scripts/
   vaciar.js                  vaciado y reinicio de la base
   hash.js                    generador de hashes bcrypt
```

---

## 🧠 Decisiones de diseño

> Léelo antes de tocar el código. Cada punto responde a un error real que ya se cometió.

<br>

**🔒 Las consultas van siempre parametrizadas.**
`server/db.js` solo expone helpers que reciben `(sql, parametros)` y usan sentencias
preparadas. Nunca se concatena SQL con entrada del usuario.

**💵 El dinero no se calcula en coma flotante.**
Los `DECIMAL` llegan como cadena y se operan con `servicios/dinero.js`. Convertirlos a
`Number` descuadra el arqueo.

**🧾 Las facturas no se borran, nunca.**
El usuario de base de datos de la aplicación no tiene `DELETE` sobre `factura`, y es el
motor quien lo impone (`db/04_privilegios.sql`). Una venta emitida solo se corrige con una
anulación auditada. Por eso una zona que conserve facturas no se puede eliminar: **se da
de baja**.

**⛓️ La auditoría es de solo inserción y encadena hashes.**
Alterar o borrar una fila suelta rompe la cadena de todas las siguientes y queda en
evidencia. Por eso `bd:vaciar` no la toca y `bd:reiniciar` la vacía entera, que es la única
forma consistente de reiniciarla.

**📦 El kárdex de inventario tampoco se borra.**
Anular algo genera un **contra-asiento**, no un `DELETE`.

**🪑 Las mesas con historial de ventas no se eliminan, se retiran.**
Desaparecen del plano pero conservan su fila, porque sus comandas la referencian. Si más
adelante se vuelve a crear una mesa con el mismo número en la misma zona, se **reactiva la
original** con su historial en lugar de duplicarla.

**📡 Todo cambio se publica en tiempo real.**
Mesas, salas, comandas y disponibilidad de platos viajan por WebSocket a quien tenga
permiso para verlos, con reconexión automática, resincronización al volver a primer plano
y respaldo de sondeo cada 10 s. Ninguna pantalla necesita recargarse a mano.

> Las dos excepciones son deliberadas: **la terminal de cobro y la división de cuenta**
> avisan del cambio en vez de repintarse, para no borrar lo que el cajero está tecleando
> con el cliente delante.

---

## 📚 Documentación adicional

| Documento | Contenido |
|---|---|
| [`ACCESIBILIDAD.md`](ACCESIBILIDAD.md) | Cómo se cumple el capítulo 6.4 del FSD |
| [`FSD_SIGR_Sistema_Gestion_Restaurantes_v1.1.docx`](FSD_SIGR_Sistema_Gestion_Restaurantes_v1.1.docx) | Especificación funcional completa |
| [`Manual_Funcionalidad_SIGR.pdf`](Manual_Funcionalidad_SIGR.pdf) | Manual de uso con capturas |

<div align="center">
<br>
<sub>SIGR · Implementación del FSD v1.1</sub>
</div>
