-- =====================================================================
-- SIGR - Canal digital: clientes, reservas, domicilios y app movil
--
-- AMPLIACION AL FSD v1.1. El documento cubre la operacion interna del
-- restaurante (salon, comanda, cocina, caja, inventario) pero no contempla
-- ningun canal hacia el comensal. Este archivo anade esa capa:
--   - identidad del cliente final, separada de la del personal
--   - reservas de mesa, que se avisan al rol de Caja
--   - pedidos a domicilio con cobertura por radio sobre un mapa
--   - almacen de configuracion, que sostiene el interruptor de la app
--
-- Las decisiones de modelado que no se deducen leyendo el SQL estan
-- explicadas en el README (raiz del repositorio). Lo esencial:
--
--   1. El cliente NO es un usuario. usuario esta atado a id_rol ->
--      rol_permiso, y esa matriz alimenta el backoffice y el login del
--      personal. Los comensales viven en su propio carril: tabla cliente,
--      tabla sesion_cliente y token Bearer en vez de cookie.
--
--   2. Un domicilio aceptado se convierte en una orden real, para que
--      llegue al KDS y se cobre en caja sin duplicar el pipeline. Como
--      orden.id_mesa es NOT NULL, se siembra una zona virtual
--      'Domicilios' (activa = FALSE) con mesas D1..D30 que sirven de
--      ancla. listarSalon filtra por zona.activa, asi que esas mesas no
--      aparecen ni en el plano ni en el comandero.
--
--   3. Dar de baja una cuenta anonimiza, no borra: conserva la
--      trazabilidad contable y libera la cedula para un re-registro.
--
-- ESTE ARCHIVO ES REAPLICABLE. Usa CREATE TABLE IF NOT EXISTS e
-- INSERT IGNORE, de modo que puede ejecutarse sobre una base ya creada
-- sin perder datos:
--   docker exec -i sigr_db mysql -uroot -p<clave> sigr < db/05_movil.sql
--
-- LOS GRANT VAN AL FINAL DE ESTE MISMO ARCHIVO. 04_privilegios.sql
-- concede privilegios tabla por tabla (es lo que hace que log_auditoria
-- sea de verdad inmutable) y ya se ejecuto antes que este archivo. Una
-- tabla nueva sin GRANT no falla al arrancar: falla en produccion, en la
-- primera consulta. Si anades una tabla aqui, anade su GRANT abajo.
-- =====================================================================

USE sigr;

SET NAMES utf8mb4;


-- =====================================================================
-- CONFIGURACION DEL SISTEMA
-- =====================================================================

-- El sistema no tenia ningun almacen de configuracion: todo era constante
-- en codigo o variable de entorno. El interruptor de la app movil, la
-- ficha publica del restaurante y las reglas de reserva tienen que poder
-- cambiarse desde el modulo Administrador sin reiniciar el proceso, asi
-- que necesitan vivir en la base.
--
-- Clave-valor y no una columna por parametro: el conjunto va a crecer, y
-- una tabla ancha obligaria a un ALTER (y por tanto a un despliegue) cada
-- vez que el negocio quiera un ajuste mas.
CREATE TABLE IF NOT EXISTS parametro (
  clave          VARCHAR(60)  PRIMARY KEY,
  -- Siempre texto. El tipo real lo declara la columna `tipo` y lo
  -- interpreta servicios/parametros.js, que es el unico que lee esta
  -- tabla. Guardar JSON tipado aqui complicaria la edicion desde la UI.
  valor          VARCHAR(500) NOT NULL,
  tipo           ENUM('texto','numero','booleano') NOT NULL DEFAULT 'texto',
  descripcion    VARCHAR(255) NOT NULL,
  -- FALSE para los parametros que solo toca el sistema; la UI los muestra
  -- pero no deja editarlos.
  editable       BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- =====================================================================
-- IDENTIDAD DEL CLIENTE
-- =====================================================================

CREATE TABLE IF NOT EXISTS cliente (
  id_cliente        INT AUTO_INCREMENT PRIMARY KEY,
  -- Cedula. UNIQUE porque identifica a la persona en la factura.
  documento         VARCHAR(30)  NOT NULL UNIQUE,
  nombre_completo   VARCHAR(120) NOT NULL,
  correo            VARCHAR(120) NOT NULL UNIQUE,
  telefono          VARCHAR(20)  NOT NULL,
  -- Mismo estandar que el personal: bcrypt costo >= 12 (FSD 6.1).
  hash_password     VARCHAR(255) NOT NULL,
  url_foto          VARCHAR(255) NULL,
  acepta_promociones BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Baja logica. Al eliminar la cuenta se pone en FALSE y se anonimiza el
  -- dato personal (ver el README): las facturas emitidas siguen apuntando a
  -- esta fila, pero ya no contiene informacion identificable, y la cedula
  -- real queda libre para un re-registro.
  activo            BOOLEAN      NOT NULL DEFAULT TRUE,
  eliminado_en      DATETIME     NULL,
  -- Mismo mecanismo antifuerza bruta que usuario (FSD 5.1: 5 intentos,
  -- bloqueo de 15 min). Aqui importa mas: este endpoint da a internet.
  intentos_fallidos TINYINT      NOT NULL DEFAULT 0,
  bloqueado_hasta   DATETIME     NULL,
  ultimo_acceso     DATETIME     NULL,
  creado_en         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_cliente_activo (activo)
) ENGINE=InnoDB;

-- Sesiones del cliente. Mismo patron que `sesion` (token opaco de 32 bytes
-- como PK, permisos releidos en cada peticion), con dos diferencias:
--   - No hay token_csrf: la app nativa no usa cookies, asi que no existe
--     superficie CSRF que proteger.
--   - La duracion es de dias, no de horas. Un movil es un dispositivo
--     personal, no compartido: la regla de 12 h del FSD 5.1 aplica a
--     comandero, KDS y POS, que pasan de mano en mano.
CREATE TABLE IF NOT EXISTS sesion_cliente (
  id_sesion        CHAR(64) PRIMARY KEY,
  id_cliente       INT      NOT NULL,
  dispositivo      VARCHAR(120) NULL,
  ip_origen        VARCHAR(45)  NULL,
  creado_en        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_en        DATETIME NOT NULL,
  ultima_actividad DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sesioncli_cliente FOREIGN KEY (id_cliente)
    REFERENCES cliente(id_cliente) ON DELETE CASCADE,
  INDEX idx_sesioncli_expira (expira_en)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS direccion_cliente (
  id_direccion   INT AUTO_INCREMENT PRIMARY KEY,
  id_cliente     INT          NOT NULL,
  etiqueta       VARCHAR(40)  NOT NULL,          -- "Casa", "Oficina"
  direccion      VARCHAR(200) NOT NULL,
  referencia     VARCHAR(200) NULL,              -- "Porton verde, tercer piso"
  -- DECIMAL(10,7) da ~1 cm de resolucion, de sobra para una entrega, y no
  -- arrastra el error de redondeo binario de un DOUBLE.
  lat            DECIMAL(10,7) NOT NULL,
  lng            DECIMAL(10,7) NOT NULL,
  predeterminada BOOLEAN      NOT NULL DEFAULT FALSE,
  activa         BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_direccion_cliente FOREIGN KEY (id_cliente)
    REFERENCES cliente(id_cliente) ON DELETE CASCADE,
  CONSTRAINT ck_direccion_lat CHECK (lat BETWEEN -90  AND 90),
  CONSTRAINT ck_direccion_lng CHECK (lng BETWEEN -180 AND 180),
  INDEX idx_direccion_cliente_activa (id_cliente, activa)
) ENGINE=InnoDB;

-- Tokens de notificacion push (FCM). Un cliente puede tener varios
-- dispositivos; el token es UNIQUE porque Google lo reasigna entre
-- instalaciones: si reaparece asociado a otra cuenta, hay que moverlo, no
-- duplicarlo.
CREATE TABLE IF NOT EXISTS dispositivo_cliente (
  id_dispositivo INT AUTO_INCREMENT PRIMARY KEY,
  id_cliente     INT          NOT NULL,
  token_fcm      VARCHAR(255) NOT NULL UNIQUE,
  plataforma     ENUM('android','ios','web') NOT NULL DEFAULT 'android',
  modelo         VARCHAR(80)  NULL,
  activo         BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultimo_uso     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dispositivo_cliente FOREIGN KEY (id_cliente)
    REFERENCES cliente(id_cliente) ON DELETE CASCADE,
  INDEX idx_dispositivo_cliente (id_cliente, activo)
) ENGINE=InnoDB;


-- =====================================================================
-- COBERTURA DE DOMICILIOS
-- =====================================================================

-- Cada zona es un circulo: centro, radio en metros y precio. Es el modelo
-- que pide la herramienta de radar del modulo Administrador.
--
-- Circulos y no poligonos: un poligono describe mejor un barrio real, pero
-- exige un editor de vertices y consultas espaciales (ST_Contains). El
-- circulo se dibuja con dos gestos, se explica solo al administrador
-- ("hasta X km cuesta Y") y se resuelve con Haversine sin extensiones.
CREATE TABLE IF NOT EXISTS zona_entrega (
  id_zona_entrega INT AUTO_INCREMENT PRIMARY KEY,
  nombre          VARCHAR(60)  NOT NULL UNIQUE,
  centro_lat      DECIMAL(10,7) NOT NULL,
  centro_lng      DECIMAL(10,7) NOT NULL,
  radio_m         INT           NOT NULL,
  costo_envio     DECIMAL(12,2) NOT NULL DEFAULT 0,
  pedido_minimo   DECIMAL(12,2) NOT NULL DEFAULT 0,
  tiempo_estimado_min SMALLINT  NOT NULL DEFAULT 30,
  -- Solo para pintarla en el mapa. El estado nunca se comunica unicamente
  -- con color (README «Accesibilidad»): la etiqueta lleva nombre, radio y precio.
  color           CHAR(7)       NOT NULL DEFAULT '#0f766e',
  -- Desempate cuando un punto cae en varios circulos: gana la prioridad
  -- MENOR y, a igualdad, el radio menor (la zona mas especifica). La regla
  -- se implementa una sola vez, en servicios/entregas.js, para que la
  -- previsualizacion del Admin y la cotizacion de la app no discrepen.
  prioridad       SMALLINT      NOT NULL DEFAULT 0,
  activa          BOOLEAN       NOT NULL DEFAULT TRUE,
  creado_en       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en  DATETIME      NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ck_zonaent_radio   CHECK (radio_m BETWEEN 100 AND 50000),
  CONSTRAINT ck_zonaent_costo   CHECK (costo_envio >= 0),
  CONSTRAINT ck_zonaent_minimo  CHECK (pedido_minimo >= 0),
  CONSTRAINT ck_zonaent_tiempo  CHECK (tiempo_estimado_min > 0),
  CONSTRAINT ck_zonaent_lat     CHECK (centro_lat BETWEEN -90  AND 90),
  CONSTRAINT ck_zonaent_lng     CHECK (centro_lng BETWEEN -180 AND 180),
  INDEX idx_zonaent_activa (activa, prioridad)
) ENGINE=InnoDB;


-- =====================================================================
-- RESERVAS DE MESA
-- =====================================================================

CREATE TABLE IF NOT EXISTS reserva (
  id_reserva     BIGINT AUTO_INCREMENT PRIMARY KEY,
  -- Codigo legible que el cliente enseña al llegar ("R-000042"). Sale de
  -- la tabla `secuencia`, no del AUTO_INCREMENT: un rollback deja huecos y
  -- el numero que el cliente ya vio en pantalla no puede reutilizarse.
  codigo         VARCHAR(12) NOT NULL UNIQUE,
  id_cliente     INT         NOT NULL,
  -- La asigna Caja al confirmar, no el cliente al reservar: quien conoce
  -- el estado real del salon es el cajero.
  id_mesa        INT         NULL,
  fecha_hora     DATETIME    NOT NULL,
  num_personas   TINYINT     NOT NULL,
  notas          VARCHAR(255) NULL,
  estado         ENUM('pendiente','confirmada','rechazada','cancelada','cumplida','no_asistio')
                 NOT NULL DEFAULT 'pendiente',
  -- Quien la gestiono desde Caja y por que. 'cancelada' es la unica
  -- transicion que puede pedir el propio cliente.
  id_usuario_gestion INT     NULL,
  gestionada_en  DATETIME    NULL,
  motivo_gestion VARCHAR(255) NULL,
  creado_en      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reserva_cliente FOREIGN KEY (id_cliente) REFERENCES cliente(id_cliente),
  CONSTRAINT fk_reserva_mesa    FOREIGN KEY (id_mesa)    REFERENCES mesa(id_mesa),
  CONSTRAINT fk_reserva_usuario FOREIGN KEY (id_usuario_gestion) REFERENCES usuario(id_usuario),
  CONSTRAINT ck_reserva_personas CHECK (num_personas BETWEEN 1 AND 50),
  INDEX idx_reserva_estado  (estado),
  INDEX idx_reserva_fecha   (fecha_hora),
  INDEX idx_reserva_cliente (id_cliente, estado)
) ENGINE=InnoDB;


-- =====================================================================
-- PEDIDOS A DOMICILIO
-- =====================================================================

-- Un pedido a domicilio vive aqui MIENTRAS ESPERA ACEPTACION. En cuanto
-- Caja lo acepta se crea una `orden` de verdad y se guarda su id en
-- id_orden: a partir de ese momento la cocina, los tiempos de salida y el
-- cobro son exactamente los del servicio en sala.
--
-- Por que dos tablas y no meter el pedido directo en `orden`: una orden
-- ocupa una mesa y entra en el flujo de servicio en el instante en que se
-- crea. Un pedido pendiente de aceptar todavia puede rechazarse, y no debe
-- aparecer en caja ni bloquear una mesa hasta que alguien lo apruebe.
CREATE TABLE IF NOT EXISTS pedido_domicilio (
  id_pedido      BIGINT AUTO_INCREMENT PRIMARY KEY,
  codigo         VARCHAR(12) NOT NULL UNIQUE,
  id_cliente     INT         NOT NULL,
  -- NULL mientras esta pendiente; apunta a la comanda una vez aceptado.
  id_orden       BIGINT      NULL,
  id_zona_entrega INT        NULL,
  -- Direccion CONGELADA, igual que el precio en orden_detalle (CA-04): si
  -- el cliente edita luego su direccion guardada, el pedido ya despachado
  -- tiene que seguir diciendo a donde se llevo.
  direccion_entrega  VARCHAR(200) NOT NULL,
  referencia_entrega VARCHAR(200) NULL,
  lat            DECIMAL(10,7) NOT NULL,
  lng            DECIMAL(10,7) NOT NULL,
  telefono_contacto VARCHAR(20) NOT NULL,
  subtotal       DECIMAL(12,2) NOT NULL,
  impuestos      DECIMAL(12,2) NOT NULL DEFAULT 0,
  costo_envio    DECIMAL(12,2) NOT NULL DEFAULT 0,
  total          DECIMAL(12,2) NOT NULL,
  metodo_pago    ENUM('efectivo','tarjeta','transferencia') NOT NULL DEFAULT 'efectivo',
  -- Con cuanto paga en efectivo, para que el domiciliario lleve el cambio.
  paga_con       DECIMAL(12,2) NULL,
  estado         ENUM('pendiente','aceptado','en_preparacion','en_camino','entregado','rechazado','cancelado')
                 NOT NULL DEFAULT 'pendiente',
  notas          VARCHAR(255) NULL,
  id_usuario_gestion INT      NULL,
  gestionada_en  DATETIME     NULL,
  motivo_gestion VARCHAR(255) NULL,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pedido_cliente FOREIGN KEY (id_cliente) REFERENCES cliente(id_cliente),
  CONSTRAINT fk_pedido_orden   FOREIGN KEY (id_orden)   REFERENCES orden(id_orden),
  CONSTRAINT fk_pedido_zonaent FOREIGN KEY (id_zona_entrega) REFERENCES zona_entrega(id_zona_entrega),
  CONSTRAINT fk_pedido_usuario FOREIGN KEY (id_usuario_gestion) REFERENCES usuario(id_usuario),
  CONSTRAINT ck_pedido_totales CHECK (subtotal >= 0 AND impuestos >= 0 AND costo_envio >= 0 AND total >= 0),
  INDEX idx_pedido_estado  (estado),
  INDEX idx_pedido_cliente (id_cliente, estado),
  INDEX idx_pedido_creado  (creado_en)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pedido_domicilio_detalle (
  id_detalle     BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pedido      BIGINT   NOT NULL,
  id_producto    INT      NOT NULL,
  cantidad       SMALLINT NOT NULL,
  -- Congelados en el momento de pedir, igual que en orden_detalle: el
  -- cliente paga el precio que vio, aunque el menu cambie mientras el
  -- pedido espera aceptacion.
  precio_unitario DECIMAL(12,2) NOT NULL,
  tasa_impuesto  DECIMAL(5,2)  NOT NULL DEFAULT 0,
  notas          VARCHAR(255) NULL,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pedidodet_pedido   FOREIGN KEY (id_pedido)   REFERENCES pedido_domicilio(id_pedido) ON DELETE CASCADE,
  CONSTRAINT fk_pedidodet_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto),
  CONSTRAINT ck_pedidodet_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_pedidodet_precio   CHECK (precio_unitario >= 0),
  INDEX idx_pedidodet_pedido (id_pedido)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pedido_domicilio_detalle_modificador (
  id_detalle     BIGINT NOT NULL,
  id_modificador INT    NOT NULL,
  precio_extra   DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id_detalle, id_modificador),
  CONSTRAINT fk_pdm_detalle     FOREIGN KEY (id_detalle)     REFERENCES pedido_domicilio_detalle(id_detalle) ON DELETE CASCADE,
  CONSTRAINT fk_pdm_modificador FOREIGN KEY (id_modificador) REFERENCES modificador(id_modificador)
) ENGINE=InnoDB;


-- =====================================================================
-- PROMOCIONES Y NOTIFICACIONES
-- =====================================================================

CREATE TABLE IF NOT EXISTS promocion (
  id_promocion   INT AUTO_INCREMENT PRIMARY KEY,
  titulo         VARCHAR(120) NOT NULL,
  cuerpo         VARCHAR(255) NOT NULL,
  url_imagen     VARCHAR(255) NULL,
  vigente_desde  DATE NULL,
  vigente_hasta  DATE NULL,
  activa         BOOLEAN  NOT NULL DEFAULT TRUE,
  -- Una promocion se envia UNA vez. enviada_en no vuelve a NULL: es lo que
  -- impide que un doble clic bombardee a todos los clientes dos veces.
  enviada_en     DATETIME NULL,
  total_enviados INT      NOT NULL DEFAULT 0,
  id_usuario_creo INT     NULL,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_promocion_usuario FOREIGN KEY (id_usuario_creo) REFERENCES usuario(id_usuario),
  INDEX idx_promocion_activa (activa, vigente_hasta)
) ENGINE=InnoDB;

-- Bandeja de notificaciones dentro de la app. Es tambien la RED DE
-- SEGURIDAD del push: si FCM no esta configurado, o el envio falla, o el
-- movil tenia los avisos silenciados, el mensaje sigue estando aqui y el
-- cliente lo ve al abrir la aplicacion. Por eso se escribe siempre, antes
-- de intentar el envio.
CREATE TABLE IF NOT EXISTS notificacion_cliente (
  id_notificacion BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_cliente     INT NOT NULL,
  tipo           ENUM('reserva','pedido','promocion','sistema') NOT NULL DEFAULT 'sistema',
  titulo         VARCHAR(120) NOT NULL,
  cuerpo         VARCHAR(255) NOT NULL,
  -- Codigo de la reserva o del pedido al que se refiere, para que la app
  -- pueda navegar al detalle desde la notificacion.
  referencia     VARCHAR(40) NULL,
  leida          BOOLEAN  NOT NULL DEFAULT FALSE,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifcli_cliente FOREIGN KEY (id_cliente)
    REFERENCES cliente(id_cliente) ON DELETE CASCADE,
  INDEX idx_notifcli_cliente (id_cliente, leida, creado_en)
) ENGINE=InnoDB;


-- =====================================================================
-- SECUENCIAS
-- =====================================================================
-- Mismo patron sin huecos que factura_fiscal: el UPDATE bloquea la fila y
-- serializa a las transacciones concurrentes, asi que dos reservas
-- simultaneas nunca obtienen el mismo codigo.
INSERT IGNORE INTO secuencia (nombre, valor) VALUES
  ('reserva',          0),
  ('pedido_domicilio', 0);


-- =====================================================================
-- ZONA VIRTUAL PARA LOS DOMICILIOS
-- =====================================================================
-- Ancla de las ordenes generadas por un domicilio aceptado (ver el README).
-- activa = FALSE mantiene la zona fuera del plano del salon y del
-- comandero: listarSalon filtra WHERE zona.activa = TRUE
-- (server/rutas/salon.js). Las mesas SI van activas, porque una mesa
-- inactiva es una mesa retirada y no admitiria una orden.
--
-- El KDS muestra el numero de mesa, asi que una comanda de domicilio
-- aparece en cocina como "D7": se distingue de un vistazo del servicio en
-- sala sin tocar ni una linea del KDS.
--
-- 30 posiciones = 30 domicilios simultaneos sin cerrar. Si se agotan, la
-- API responde 422 en vez de crear una orden invalida. Para ampliarlo,
-- suba el 30 de abajo y vuelva a ejecutar este archivo.
INSERT IGNORE INTO zona (nombre, orden_visual, activa)
  VALUES ('Domicilios', 99, FALSE);

-- La serie va escrita a mano en vez de con un CTE recursivo: este archivo
-- lo ejecuta el entrypoint de MySQL, que aborta el resto del script al
-- primer error, y una lista de enteros no puede fallar en ninguna version.
INSERT IGNORE INTO mesa (id_zona, numero, forma, capacidad, pos_x, pos_y, ancho, alto, estado, activa)
SELECT z.id_zona, CONCAT('D', s.i), 'cuadrada', 1, 0, 0, 5, 5, 'libre', TRUE
  FROM zona z
  CROSS JOIN (
    SELECT  1 AS i UNION ALL SELECT  2 UNION ALL SELECT  3 UNION ALL SELECT  4 UNION ALL SELECT  5 UNION ALL
    SELECT  6        UNION ALL SELECT  7 UNION ALL SELECT  8 UNION ALL SELECT  9 UNION ALL SELECT 10 UNION ALL
    SELECT 11        UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL
    SELECT 16        UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20 UNION ALL
    SELECT 21        UNION ALL SELECT 22 UNION ALL SELECT 23 UNION ALL SELECT 24 UNION ALL SELECT 25 UNION ALL
    SELECT 26        UNION ALL SELECT 27 UNION ALL SELECT 28 UNION ALL SELECT 29 UNION ALL SELECT 30
  ) s
 WHERE z.nombre = 'Domicilios';


-- =====================================================================
-- PARAMETROS INICIALES
-- =====================================================================
INSERT IGNORE INTO parametro (clave, valor, tipo, descripcion, editable) VALUES
  -- Interruptores de la aplicacion movil (panel de control del Admin).
  ('app.movil.activa',             'true',  'booleano',
   'Interruptor general de la aplicacion movil. En falso, toda la API /app responde 503.', TRUE),
  ('app.movil.reservas_activas',   'true',  'booleano',
   'Permite crear reservas de mesa desde la aplicacion.', TRUE),
  ('app.movil.domicilios_activos', 'true',  'booleano',
   'Permite crear pedidos a domicilio desde la aplicacion.', TRUE),
  ('app.movil.mensaje_inactiva',
   'Estamos en mantenimiento. Vuelva a intentarlo en unos minutos.', 'texto',
   'Mensaje que ve el cliente cuando la aplicacion esta desactivada.', TRUE),
  ('app.movil.version_minima',     '1',     'numero',
   'Version minima de la app aceptada. Por debajo, se pide actualizar.', TRUE),

  -- Ficha publica del restaurante (pantalla de inicio de la app).
  ('restaurante.nombre',      'Restaurante SIGR', 'texto', 'Nombre comercial.', TRUE),
  ('restaurante.descripcion',
   'Cocina de autor con producto local. Reserve su mesa o pida a domicilio.', 'texto',
   'Descripcion breve que abre la aplicacion.', TRUE),
  ('restaurante.direccion',   'Calle 10 # 5-25, Bogota', 'texto', 'Direccion fisica.', TRUE),
  ('restaurante.telefono',    '+57 300 000 0000', 'texto', 'Telefono de contacto.', TRUE),
  ('restaurante.horario',     'Lunes a domingo, 12:00 - 22:00', 'texto', 'Horario de atencion.', TRUE),
  -- Centro por defecto del mapa, tanto en el Admin como en la app.
  ('restaurante.lat',         '4.5981', 'numero', 'Latitud del local.',  TRUE),
  ('restaurante.lng',        '-74.0758','numero', 'Longitud del local.', TRUE),

  -- Reglas de reserva.
  ('reservas.anticipacion_min_horas', '2',  'numero',
   'Horas minimas de antelacion para reservar.', TRUE),
  ('reservas.dias_max',               '30', 'numero',
   'Cuantos dias hacia adelante se puede reservar.', TRUE),
  ('reservas.personas_max',           '12', 'numero',
   'Maximo de comensales por reserva desde la aplicacion.', TRUE),

  -- Reglas de domicilio.
  ('domicilios.pedido_minimo_global', '0',  'numero',
   'Pedido minimo cuando la zona de entrega no define uno propio.', TRUE);


-- =====================================================================
-- PERMISOS NUEVOS
-- =====================================================================
-- Mismo patron modulo.accion del catalogo existente. La vista de permisos
-- (public/admin/permisos.html) agrupa dinamicamente por `modulo`, asi que
-- estos aparecen solos en la matriz sin tocar el cliente.
INSERT IGNORE INTO permiso (codigo, modulo, descripcion) VALUES
  ('config.app.ver',           'canal_digital', 'Consultar la configuracion de la aplicacion movil.'),
  ('config.app.gestionar',     'canal_digital', 'Activar o desactivar la aplicacion movil y editar la ficha del restaurante.'),
  ('config.entregas.ver',      'canal_digital', 'Consultar las zonas de cobertura de domicilio.'),
  ('config.entregas.gestionar','canal_digital', 'Crear y editar zonas de cobertura, radios y precios de envio.'),
  ('promociones.gestionar',    'canal_digital', 'Crear promociones y enviarlas por notificacion push.'),
  ('clientes.ver',             'canal_digital', 'Consultar el registro de clientes de la aplicacion.'),
  ('reservas.ver',             'reservas',      'Consultar las reservas de mesa.'),
  ('reservas.gestionar',       'reservas',      'Confirmar, rechazar y cerrar reservas de mesa.'),
  ('domicilios.ver',           'domicilios',    'Consultar los pedidos a domicilio.'),
  ('domicilios.gestionar',     'domicilios',    'Aceptar, rechazar y avanzar el estado de los pedidos a domicilio.');


-- ---------------------------------------------------------------------
-- Administrador: todo el canal digital.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO rol_permiso (id_rol, id_permiso)
SELECT 1, id_permiso FROM permiso WHERE modulo IN ('canal_digital', 'reservas', 'domicilios');

-- ---------------------------------------------------------------------
-- Cajero: opera reservas y domicilios, pero no los configura.
--
-- El FSD 3.1 pone al cajero al frente del mostrador: es quien conoce el
-- estado real del salon y quien atiende al cliente que llega o llama. Por
-- eso recibe la reserva en su pantalla y es quien la confirma asignando
-- mesa. NO recibe config.*: parametrizar cobertura y precios de envio es
-- decision del Administrador.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO rol_permiso (id_rol, id_permiso)
SELECT 2, id_permiso FROM permiso WHERE codigo IN (
  'reservas.ver',
  'reservas.gestionar',
  'domicilios.ver',
  'domicilios.gestionar',
  'clientes.ver'
);


-- =====================================================================
-- PRIVILEGIOS DE LAS TABLAS NUEVAS
-- =====================================================================
-- 04_privilegios.sql concede tabla por tabla y ya se ejecuto. Sin estos
-- GRANT, sigr_app recibe "access denied" en la primera consulta.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.parametro                            TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.cliente                              TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.sesion_cliente                       TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.direccion_cliente                    TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.dispositivo_cliente                  TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.zona_entrega                         TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.reserva                              TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.pedido_domicilio                     TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.pedido_domicilio_detalle             TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.pedido_domicilio_detalle_modificador TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.promocion                            TO 'sigr_app'@'%';

-- notificacion_cliente NO recibe DELETE: es el registro de lo que se le
-- comunico al cliente. Solo se marca como leida (UPDATE). Si algun dia hay
-- que purgarla por volumen, sera una tarea administrativa deliberada, no
-- algo que pueda hacer la aplicacion desde un endpoint.
GRANT SELECT, INSERT, UPDATE ON sigr.notificacion_cliente TO 'sigr_app'@'%';

FLUSH PRIVILEGES;
