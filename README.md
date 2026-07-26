# SIGR — Sistema Integral de Gestión para Restaurantes

Implementación del FSD v1.1. Cubre el ciclo completo de servicio: diseño del salón,
toma de comandas, pantallas de cocina y barra, cobro y arqueo de caja, inventario por
recetas y reportes.

Node 20+, Express, MySQL 8 y JavaScript sin framework en el navegador (módulos ES
nativos). Sin paso de compilación: lo que hay en `public/` es lo que corre el navegador.

---

## Puesta en marcha

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Abrir <http://localhost:3000>.

La base de datos se crea sola la primera vez que se levanta el volumen: esquema,
permisos, roles, usuarios y un catálogo de demostración con 12 platos y sus recetas.

**El salón arranca vacío a propósito.** El plano de un restaurante no se parece al de
ningún otro, así que se dibuja desde cero en **Administración → Salón**: se crea una
zona, se arrastran las mesas al lienzo y se pulsa "Guardar distribución".

### Credenciales de demostración

Solo las siembra `db/03_seed.sql`, que **no debe cargarse en producción**.

| Rol | Correo | Contraseña | Documento | PIN |
|---|---|---|---|---|
| Administrador | `admin@sigr.local` | `Admin123!` | CC1001 | 1111 |
| Cajero | `cajero@sigr.local` | `Cajero123!` | CC1002 | 2222 |
| Cocinero | `cocinero@sigr.local` | `Cocina123!` | CC1003 | 3333 |
| Mesero | `mesero@sigr.local` | `Mesero123!` | CC1004 | 4444 |

En tablet y móvil se entra con documento y PIN; en escritorio, con correo y contraseña.

---

## Comandos

### Aplicación

```bash
npm start
```

```bash
npm run dev
```

`dev` levanta el servidor con `--watch`: recarga solo al guardar un archivo del
servidor. Los archivos de `public/` no necesitan reinicio, basta recargar el navegador.

Con Docker, la base escucha en el **3307** del anfitrión para no chocar con un MySQL ya
instalado en la máquina. Si se ejecuta `npm start` fuera de Docker, el `.env` ya apunta
ahí.

### Pruebas

```bash
npm test
```

Unitarias y de aceptación. Las de aceptación necesitan el contenedor de MySQL en pie
(`docker compose up -d db`), porque la concurrencia y las transacciones solo se pueden
verificar contra una base real.

```bash
npm run test:e2e
```

Los cinco casos de uso del capítulo 7 del FSD, de extremo a extremo por HTTP.
**Requiere el servidor corriendo.**

```bash
npm run test:seguridad
```

Escalada de privilegios, inyección SQL, CSRF, manipulación de importes e inmutabilidad
de la auditoría.

```bash
npm run test:carga
```

50 dispositivos concurrentes enviando comandas. **Requiere el servidor corriendo.**

```bash
npm run test:todo
```

Encadena unitarias, aceptación, e2e y seguridad.

Las pruebas crean su propia zona y sus propias mesas (`tests/comun/salon.mjs`) y limpian
lo que crean, así que se pueden repetir sin dejar rastro.

### Base de datos

```bash
npm run bd:ver
```

Cuenta lo que hay y enseña qué se borraría. **No borra nada.** Es el modo por defecto:
un vaciado no se deshace, así que conviene mirar antes.

```bash
npm run bd:vaciar
```

Vacía la **operación**: salón, mesas, comandas, facturas, pagos y turnos de caja.
Conserva catálogo, insumos, recetas, proveedores, usuarios y auditoría. Es el comando
del día a día cuando las pruebas manuales han dejado la base sucia.

```bash
npm run bd:reiniciar
```

Vacía **todo** —incluidos catálogo, inventario, compras y auditoría— y vuelve a sembrar
el catálogo de demostración desde `db/03_seed.sql`. Deja la base como recién instalada.
Solo se conservan roles, permisos y usuarios: sin ellos no se podría ni entrar.

Los tres se conectan con la credencial root de la base, porque la aplicación **no puede**
borrar facturas ni auditoría y eso es deliberado (ver más abajo). Se niegan a ejecutarse
con `NODE_ENV=production`.

Para ver qué se borraría en el modo completo sin ejecutarlo:

```bash
node scripts/vaciar.js --todo
```

Para empezar de cero del todo, destruyendo el volumen de MySQL y dejando que los scripts
de `db/` se vuelvan a ejecutar:

```bash
docker compose down -v && docker compose up -d --build
```

### Utilidades

```bash
npm run hash
```

Genera hashes bcrypt de coste 12 para sembrar contraseñas o PINs a mano.

---

## Estructura

```
server/
  index.js         arranque, middleware y montaje de rutas
  db.js            pool, consultas parametrizadas y transacciones con reintento
  realtime.js      canal WebSocket y catálogo de eventos
  middleware/      autenticación, permisos y manejo central de errores
  rutas/           un archivo por área: salon, ordenes, kds, caja, catalogo…
  servicios/       lógica de negocio: precios, dinero, inventario, auditoría…
public/
  comun/           cliente HTTP, componentes de interfaz y cliente WebSocket
  admin/           back office: salón, menú, recetas, inventario, reportes…
  comandero/       PWA del mesero: plano, toma de comanda y seguimiento
  kds/             pantallas de cocina y barra
  caja/            terminal de cobro, división de cuenta y arqueo
db/                se ejecutan en orden al crear el volumen
  01_schema.sql    tablas y restricciones
  02_permisos.sql  catálogo de permisos y su asignación a roles
  03_seed.sql      usuarios y catálogo de demostración
  04_privilegios.sql  privilegios mínimos de los usuarios de base de datos
tests/
  unit/  aceptacion/  e2e/  seguridad/  carga/  integracion/  comun/
scripts/
  vaciar.js        vaciado y reinicio de la base
  hash.js          generador de hashes bcrypt
```

---

## Decisiones que conviene conocer antes de tocar el código

**Las consultas van siempre parametrizadas.** `server/db.js` solo expone helpers que
reciben `(sql, parametros)` y usan sentencias preparadas. Nunca se concatena SQL con
entrada del usuario.

**El dinero no se calcula en coma flotante.** Los `DECIMAL` llegan como cadena y se
operan con `servicios/dinero.js`. Convertirlos a `Number` descuadra el arqueo.

**Las facturas no se borran, nunca.** El usuario de base de datos de la aplicación no
tiene `DELETE` sobre `factura`, y es el motor quien lo impone (`db/04_privilegios.sql`).
Una venta emitida solo se corrige con una anulación auditada. Por eso una zona que
conserve facturas no se puede eliminar: se da de baja.

**La auditoría es de solo inserción y encadena hashes.** Alterar o borrar una fila suelta
rompe la cadena de todas las siguientes y queda en evidencia. Por eso `bd:vaciar` no la
toca y `bd:reiniciar` la vacía entera, que es la única forma consistente de reiniciarla.

**El kárdex de inventario tampoco se borra.** Anular algo genera un contra-asiento, no un
`DELETE`.

**Las mesas con historial de ventas no se eliminan, se retiran.** Desaparecen del plano
pero conservan su fila, porque sus comandas la referencian. Si más adelante se vuelve a
crear una mesa con el mismo número en la misma zona, se reactiva la original con su
historial en lugar de duplicarla.

**Todo cambio se publica en tiempo real.** Mesas, salas, comandas y disponibilidad de
platos viajan por WebSocket a quien tenga permiso para verlos, con reconexión automática,
resincronización al volver a primer plano y respaldo de sondeo cada 10 s. Ninguna
pantalla necesita recargarse a mano. Las dos excepciones son deliberadas: la terminal de
cobro y la división de cuenta avisan del cambio en vez de repintarse, para no borrar lo
que el cajero está tecleando con el cliente delante.

---

## Documentación adicional

- `ACCESIBILIDAD.md` — cómo se cumple el capítulo 6.4 del FSD.
- `FSD_SIGR_Sistema_Gestion_Restaurantes_v1.1.docx` — especificación funcional.
- `Manual_Funcionalidad_SIGR.pdf` — manual de uso con capturas.
