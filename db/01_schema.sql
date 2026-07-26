-- =====================================================================
-- SIGR - Esquema relacional
-- Implementa el diccionario de datos del FSD v1.1, seccion 2.4.
--
-- Convenciones del FSD 2.4:
--   - Toda tabla lleva creado_en NN DEFAULT CURRENT_TIMESTAMP y actualizado_en.
--   - PK = llave primaria, FK = llave foranea, NN = NOT NULL, UQ = UNIQUE.
--   - Modelo normalizado 3FN con integridad referencial e ACID (InnoDB).
--
-- Los importes usan DECIMAL, nunca coma flotante: un redondeo binario en
-- dinero descuadra el arqueo de caja.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS sigr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE sigr;

SET NAMES utf8mb4;


-- =====================================================================
-- 2.4.1 SEGURIDAD
-- =====================================================================

CREATE TABLE rol (
  id_rol        INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(50)  NOT NULL UNIQUE,
  descripcion   VARCHAR(255),
  -- Los 4 roles preestablecidos (FSD 3.1) no se pueden eliminar.
  es_sistema    BOOLEAN      NOT NULL DEFAULT FALSE,
  creado_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE permiso (
  id_permiso    INT AUTO_INCREMENT PRIMARY KEY,
  -- Ej.: ordenes.anular_enviada, descuentos.aplicar_menor_10, caja.abrir_cajon.
  codigo        VARCHAR(60)  NOT NULL UNIQUE,
  modulo        VARCHAR(40)  NOT NULL,
  descripcion   VARCHAR(255) NOT NULL,
  creado_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_permiso_modulo (modulo)
) ENGINE=InnoDB;

CREATE TABLE rol_permiso (
  id_rol        INT NOT NULL,
  id_permiso    INT NOT NULL,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_rol, id_permiso),
  CONSTRAINT fk_rolperm_rol     FOREIGN KEY (id_rol)     REFERENCES rol(id_rol)         ON DELETE CASCADE,
  CONSTRAINT fk_rolperm_permiso FOREIGN KEY (id_permiso) REFERENCES permiso(id_permiso) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE usuario (
  id_usuario       INT AUTO_INCREMENT PRIMARY KEY,
  id_rol           INT          NOT NULL,
  nombre_completo  VARCHAR(120) NOT NULL,
  documento        VARCHAR(30)  UNIQUE,
  correo           VARCHAR(120) NOT NULL UNIQUE,
  -- FSD 6.1: hash bcrypt costo >= 12. Jamas texto plano.
  hash_password    VARCHAR(255) NOT NULL,
  -- PIN de 4 digitos para acceso rapido en dispositivos operativos.
  hash_pin         VARCHAR(255) NOT NULL,
  uid_rfid         VARCHAR(64)  UNIQUE NULL,
  -- FSD 2.4.1: baja logica; nunca se elimina fisicamente por trazabilidad.
  activo           BOOLEAN      NOT NULL DEFAULT TRUE,
  intentos_fallidos TINYINT     NOT NULL DEFAULT 0,
  -- ADICION AL FSD: el diccionario define intentos_fallidos pero no donde
  -- guardar el fin del bloqueo que exige 5.1 ("bloquean la cuenta 15 minutos").
  -- Sin este campo la regla no es implementable.
  bloqueado_hasta  DATETIME     NULL,
  ultimo_acceso    DATETIME     NULL,
  creado_en        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en   DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_usuario_rol FOREIGN KEY (id_rol) REFERENCES rol(id_rol),
  INDEX idx_usuario_activo (activo)
) ENGINE=InnoDB;

-- ADICION AL FSD (declarada en el plan): el diccionario 2.4 no contempla
-- sesiones, pero 5.1 exige expiracion de 12 h, re-autenticacion por PIN tras
-- 10 min de inactividad y revalidacion de permisos por request. Guardar la
-- sesion en tabla permite recargar rol y permisos frescos en cada peticion:
-- un cambio de permisos surte efecto de inmediato, como pide el FSD.
CREATE TABLE sesion (
  id_sesion        CHAR(64)  PRIMARY KEY,          -- token aleatorio de 32 bytes en hex
  id_usuario       INT       NOT NULL,
  -- 5.1 distingue dos formas de entrar: correo+contrasena en el backoffice y
  -- PIN/RFID en los dispositivos operativos. La re-autenticacion por PIN tras
  -- 10 min de inactividad aplica solo a los segundos, por eso hay que saber
  -- de que tipo es cada sesion.
  tipo_acceso      ENUM('backoffice','operativo') NOT NULL DEFAULT 'backoffice',
  -- 6.1: "Token anti-CSRF en formularios y verificacion de origen en la API".
  -- Se entrega al cliente y este lo reenvia en la cabecera X-CSRF-Token.
  token_csrf       CHAR(64)  NOT NULL,
  ip_origen        VARCHAR(45),
  user_agent       VARCHAR(255),
  creado_en        DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_en        DATETIME  NOT NULL,
  ultima_actividad DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sesion_usuario FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario) ON DELETE CASCADE,
  INDEX idx_sesion_expira (expira_en)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.2 SALON
-- =====================================================================

CREATE TABLE zona (
  id_zona       INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(60) NOT NULL UNIQUE,
  orden_visual  SMALLINT    NOT NULL DEFAULT 0,
  activa        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE mesa (
  id_mesa       INT AUTO_INCREMENT PRIMARY KEY,
  id_zona       INT         NOT NULL,
  numero        VARCHAR(10) NOT NULL,
  forma         ENUM('redonda','cuadrada','rectangular','barra') NOT NULL,
  capacidad     TINYINT     NOT NULL,
  -- Coordenadas y dimensiones en el lienzo, en % (FSD 2.4.2).
  pos_x         DECIMAL(6,2) NOT NULL,
  pos_y         DECIMAL(6,2) NOT NULL,
  ancho         DECIMAL(6,2) NOT NULL,
  alto          DECIMAL(6,2) NOT NULL,
  estado        ENUM('libre','ocupada','precuenta','bloqueada') NOT NULL DEFAULT 'libre',
  activa        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mesa_zona FOREIGN KEY (id_zona) REFERENCES zona(id_zona),
  -- FSD 5.2: numero unico dentro de su zona, no globalmente.
  CONSTRAINT uq_mesa_zona_numero UNIQUE (id_zona, numero),
  CONSTRAINT ck_mesa_capacidad   CHECK (capacidad BETWEEN 1 AND 30),
  INDEX idx_mesa_estado (estado)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.3 CATALOGO Y RECETARIO
-- =====================================================================

CREATE TABLE categoria (
  id_categoria  INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(60) NOT NULL UNIQUE,
  -- Enruta cada linea al KDS correspondiente (FSD 5.5, 5.6).
  destino_preparacion ENUM('cocina','barra','ninguno') NOT NULL DEFAULT 'cocina',
  orden_visual  SMALLINT    NOT NULL DEFAULT 0,
  activa        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE producto (
  id_producto   INT AUTO_INCREMENT PRIMARY KEY,
  id_categoria  INT          NOT NULL,
  nombre        VARCHAR(100) NOT NULL,
  descripcion   TEXT,
  url_imagen    VARCHAR(255),
  precio_base   DECIMAL(12,2) NOT NULL,
  tasa_impuesto DECIMAL(5,2)  NOT NULL DEFAULT 0,
  -- Interruptor "Agotado" del KDS (vista 17). No afecta la configuracion.
  disponible    BOOLEAN      NOT NULL DEFAULT TRUE,
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_producto_categoria FOREIGN KEY (id_categoria) REFERENCES categoria(id_categoria),
  CONSTRAINT ck_producto_precio    CHECK (precio_base >= 0),
  CONSTRAINT ck_producto_impuesto  CHECK (tasa_impuesto >= 0),
  INDEX idx_producto_disponible (disponible, activo)
) ENGINE=InnoDB;

-- Variantes de precio por horario/temporada (FSD 2.4.3).
-- La no superposicion de ventanas se valida en servidor (5.3): no es
-- expresable como CHECK porque compara filas entre si.
CREATE TABLE producto_precio (
  id_precio     INT AUTO_INCREMENT PRIMARY KEY,
  id_producto   INT         NOT NULL,
  nombre        VARCHAR(60) NOT NULL,          -- "Happy hour", "Temporada alta"
  precio        DECIMAL(12,2) NOT NULL,
  hora_inicio   TIME NULL,
  hora_fin      TIME NULL,
  fecha_inicio  DATE NULL,
  fecha_fin     DATE NULL,
  dias_semana   VARCHAR(20) NULL,              -- Ej.: "L,M,X,J,V"
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_precio_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto) ON DELETE CASCADE,
  CONSTRAINT ck_precio_valor    CHECK (precio >= 0),
  INDEX idx_precio_producto_activo (id_producto, activo)
) ENGINE=InnoDB;

CREATE TABLE grupo_modificador (
  id_grupo_mod  INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80) NOT NULL,          -- "Termino de coccion", "Adicionales"
  obligatorio   BOOLEAN     NOT NULL DEFAULT FALSE,
  seleccion_min TINYINT     NOT NULL DEFAULT 0,
  seleccion_max TINYINT     NOT NULL DEFAULT 1,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ck_grupo_seleccion CHECK (seleccion_max >= seleccion_min)
) ENGINE=InnoDB;

CREATE TABLE modificador (
  id_modificador INT AUTO_INCREMENT PRIMARY KEY,
  id_grupo_mod   INT         NOT NULL,
  nombre         VARCHAR(80) NOT NULL,
  precio_extra   DECIMAL(12,2) NOT NULL DEFAULT 0,
  activo         BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_modificador_grupo FOREIGN KEY (id_grupo_mod) REFERENCES grupo_modificador(id_grupo_mod) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE producto_grupo_modificador (
  id_producto   INT NOT NULL,
  id_grupo_mod  INT NOT NULL,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_producto, id_grupo_mod),
  CONSTRAINT fk_pgm_producto FOREIGN KEY (id_producto)  REFERENCES producto(id_producto) ON DELETE CASCADE,
  CONSTRAINT fk_pgm_grupo    FOREIGN KEY (id_grupo_mod) REFERENCES grupo_modificador(id_grupo_mod) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE insumo (
  id_insumo     INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(100) NOT NULL UNIQUE,
  unidad_medida ENUM('g','kg','ml','l','unidad') NOT NULL,
  -- FSD 5.4: el stock PUEDE quedar negativo. La venta nunca se detiene por
  -- un dato de inventario desactualizado; se marca en rojo para conciliar.
  -- Por eso stock_actual no lleva CHECK >= 0.
  stock_actual  DECIMAL(12,3) NOT NULL DEFAULT 0,
  stock_minimo  DECIMAL(12,3) NOT NULL DEFAULT 0,
  costo_promedio DECIMAL(12,4) NOT NULL DEFAULT 0,
  creado_en     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME   NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Ficha tecnica producto-insumo. La PK compuesta evita duplicados (FSD 5.3).
CREATE TABLE receta (
  id_producto   INT NOT NULL,
  id_insumo     INT NOT NULL,
  cantidad      DECIMAL(12,3) NOT NULL,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_producto, id_insumo),
  CONSTRAINT fk_receta_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto) ON DELETE CASCADE,
  CONSTRAINT fk_receta_insumo   FOREIGN KEY (id_insumo)   REFERENCES insumo(id_insumo),
  CONSTRAINT ck_receta_cantidad CHECK (cantidad > 0)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.4 INVENTARIO Y COMPRAS
-- =====================================================================

CREATE TABLE proveedor (
  id_proveedor   INT AUTO_INCREMENT PRIMARY KEY,
  razon_social   VARCHAR(120) NOT NULL,
  nit            VARCHAR(30)  UNIQUE,
  contacto_nombre VARCHAR(100),
  telefono       VARCHAR(30),
  correo         VARCHAR(120),
  activo         BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE compra (
  id_compra      INT AUTO_INCREMENT PRIMARY KEY,
  id_proveedor   INT         NOT NULL,
  id_usuario     INT         NOT NULL,
  numero_factura_prov VARCHAR(40),
  fecha          DATETIME    NOT NULL,
  total          DECIMAL(14,2) NOT NULL,
  -- Al pasar a "recibida" se actualiza stock dentro de una transaccion (5.4).
  estado         ENUM('borrador','recibida','anulada') NOT NULL DEFAULT 'borrador',
  creado_en      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_compra_proveedor FOREIGN KEY (id_proveedor) REFERENCES proveedor(id_proveedor),
  CONSTRAINT fk_compra_usuario   FOREIGN KEY (id_usuario)   REFERENCES usuario(id_usuario),
  CONSTRAINT ck_compra_total     CHECK (total >= 0),
  INDEX idx_compra_fecha  (fecha),
  INDEX idx_compra_estado (estado)
) ENGINE=InnoDB;

CREATE TABLE compra_detalle (
  id_compra_detalle INT AUTO_INCREMENT PRIMARY KEY,
  id_compra      INT NOT NULL,
  id_insumo      INT NOT NULL,
  cantidad       DECIMAL(12,3) NOT NULL,
  costo_unitario DECIMAL(12,4) NOT NULL,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_compradet_compra FOREIGN KEY (id_compra) REFERENCES compra(id_compra) ON DELETE CASCADE,
  CONSTRAINT fk_compradet_insumo FOREIGN KEY (id_insumo) REFERENCES insumo(id_insumo),
  CONSTRAINT ck_compradet_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_compradet_costo    CHECK (costo_unitario >= 0)
) ENGINE=InnoDB;

-- Kardex. FSD 5.4: nunca se borra; anular una compra recibida genera
-- contra-asientos, no un DELETE.
CREATE TABLE movimiento_inventario (
  id_movimiento  BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_insumo      INT NOT NULL,
  tipo           ENUM('compra','venta','ajuste','merma') NOT NULL,
  -- Positiva = entrada, negativa = salida.
  cantidad       DECIMAL(12,3) NOT NULL,
  -- id_compra o id_orden_detalle segun tipo. Polimorfico: sin FK.
  id_referencia  BIGINT NULL,
  id_usuario     INT NOT NULL,
  motivo         VARCHAR(255) NULL,            -- obligatorio en ajustes (5.4)
  fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_movinv_insumo  FOREIGN KEY (id_insumo)  REFERENCES insumo(id_insumo),
  CONSTRAINT fk_movinv_usuario FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario),
  INDEX idx_movinv_insumo_fecha (id_insumo, fecha),
  INDEX idx_movinv_tipo_ref     (tipo, id_referencia)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.5 SERVICIO (COMANDAS)
-- =====================================================================

CREATE TABLE orden (
  id_orden       BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_mesa        INT     NOT NULL,
  id_mesero      INT     NOT NULL,
  num_comensales TINYINT NOT NULL,
  estado         ENUM('abierta','enviada','precuenta','cerrada','anulada') NOT NULL DEFAULT 'abierta',
  abierta_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cerrada_en     DATETIME NULL,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orden_mesa   FOREIGN KEY (id_mesa)   REFERENCES mesa(id_mesa),
  CONSTRAINT fk_orden_mesero FOREIGN KEY (id_mesero) REFERENCES usuario(id_usuario),
  CONSTRAINT ck_orden_comensales CHECK (num_comensales > 0),
  -- FSD 6.2: indice sobre orden.estado (filtro frecuente).
  INDEX idx_orden_estado (estado),
  INDEX idx_orden_mesa_estado (id_mesa, estado)
) ENGINE=InnoDB;

CREATE TABLE orden_detalle (
  id_orden_detalle BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_orden       BIGINT   NOT NULL,
  id_producto    INT      NOT NULL,
  cantidad       SMALLINT NOT NULL,
  -- Precio e impuesto CONGELADOS al momento de la venta (CA-04): editar el
  -- catalogo despues no debe alterar lo ya comandado.
  precio_unitario DECIMAL(12,2) NOT NULL,
  tasa_impuesto  DECIMAL(5,2)  NOT NULL,
  tiempo_salida  TINYINT  NOT NULL DEFAULT 1,   -- 1=entradas, 2=fuertes, 3=postres
  notas          VARCHAR(255),                  -- "Alergia al gluten"
  estado_preparacion ENUM('en_cola','preparando','listo','servido','anulado') NOT NULL DEFAULT 'en_cola',
  enviado_en     DATETIME NULL,
  listo_en       DATETIME NULL,
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ordendet_orden    FOREIGN KEY (id_orden)    REFERENCES orden(id_orden) ON DELETE CASCADE,
  CONSTRAINT fk_ordendet_producto FOREIGN KEY (id_producto) REFERENCES producto(id_producto),
  CONSTRAINT ck_ordendet_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_ordendet_precio   CHECK (precio_unitario >= 0),
  CONSTRAINT ck_ordendet_tiempo   CHECK (tiempo_salida > 0),
  -- FSD 6.2: indice sobre estado_preparacion (cola del KDS).
  INDEX idx_ordendet_estado (estado_preparacion),
  INDEX idx_ordendet_orden  (id_orden)
) ENGINE=InnoDB;

CREATE TABLE orden_detalle_modificador (
  id_orden_detalle BIGINT NOT NULL,
  id_modificador   INT    NOT NULL,
  -- Precio extra congelado, igual que el precio de la linea.
  precio_extra     DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id_orden_detalle, id_modificador),
  CONSTRAINT fk_odm_detalle     FOREIGN KEY (id_orden_detalle) REFERENCES orden_detalle(id_orden_detalle) ON DELETE CASCADE,
  CONSTRAINT fk_odm_modificador FOREIGN KEY (id_modificador)   REFERENCES modificador(id_modificador)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.6 CAJA Y FACTURACION
-- =====================================================================

-- ADICION AL FSD: secuencia para el consecutivo fiscal de las facturas.
-- El AUTO_INCREMENT de factura no sirve: deja huecos cuando una transaccion
-- hace rollback, y una numeracion fiscal debe ser correlativa y sin saltos.
-- El patron es el estandar de secuencia sin huecos en MySQL: el UPDATE bloquea
-- la fila y serializa a las transacciones concurrentes, de modo que dos cierres
-- simultaneos nunca obtienen el mismo numero.
CREATE TABLE secuencia (
  nombre VARCHAR(40) PRIMARY KEY,
  valor  BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

INSERT INTO secuencia (nombre, valor) VALUES ('factura_fiscal', 0);

CREATE TABLE turno_caja (
  id_turno       BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_cajero      INT      NOT NULL,
  fondo_inicial  DECIMAL(14,2) NOT NULL,
  abierto_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cerrado_en     DATETIME NULL,
  -- CA-07 (arqueo ciego): total_sistema se calcula y persiste SOLO cuando el
  -- cajero ya confirmo el conteo fisico. Antes del cierre estas 3 columnas
  -- son NULL y la API nunca las expone.
  total_contado  DECIMAL(14,2) NULL,
  total_sistema  DECIMAL(14,2) NULL,
  diferencia     DECIMAL(14,2) NULL,
  comentario_cierre TEXT NULL,                 -- obligatorio si hay descuadre (CU-05)
  estado         ENUM('abierto','cerrado') NOT NULL DEFAULT 'abierto',
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_turno_cajero FOREIGN KEY (id_cajero) REFERENCES usuario(id_usuario),
  CONSTRAINT ck_turno_fondo  CHECK (fondo_inicial >= 0),
  INDEX idx_turno_estado (estado, id_cajero)
) ENGINE=InnoDB;

CREATE TABLE movimiento_caja (
  id_mov_caja    BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_turno       BIGINT       NOT NULL,
  tipo           ENUM('ingreso','salida') NOT NULL,
  monto          DECIMAL(14,2) NOT NULL,
  motivo         VARCHAR(255) NOT NULL,        -- justificacion obligatoria (5.7)
  id_usuario     INT          NOT NULL,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_movcaja_turno   FOREIGN KEY (id_turno)   REFERENCES turno_caja(id_turno),
  CONSTRAINT fk_movcaja_usuario FOREIGN KEY (id_usuario) REFERENCES usuario(id_usuario),
  CONSTRAINT ck_movcaja_monto   CHECK (monto > 0)
) ENGINE=InnoDB;

CREATE TABLE motivo_descuento (
  id_motivo      INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(80) NOT NULL UNIQUE,  -- "Cliente frecuente", "Cortesia gerencia"
  porcentaje_max DECIMAL(5,2) NOT NULL DEFAULT 100,
  activo         BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME    NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ck_motivo_pct CHECK (porcentaje_max BETWEEN 0 AND 100)
) ENGINE=InnoDB;

CREATE TABLE factura (
  id_factura     BIGINT AUTO_INCREMENT PRIMARY KEY,
  consecutivo_fiscal VARCHAR(30) NOT NULL UNIQUE,
  -- Varias facturas por orden cuando se divide la cuenta (FSD 2.4.6).
  id_orden       BIGINT       NOT NULL,
  id_turno       BIGINT       NOT NULL,
  subtotal       DECIMAL(14,2) NOT NULL,
  descuento      DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- Motivo obligatorio si descuento > 0: se valida en servidor porque un
  -- CHECK no puede referenciar la regla completa (5.7).
  id_motivo_descuento INT NULL,
  impuestos      DECIMAL(14,2) NOT NULL DEFAULT 0,
  propina        DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL,
  estado         ENUM('emitida','anulada') NOT NULL DEFAULT 'emitida',
  emitida_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_factura_orden  FOREIGN KEY (id_orden) REFERENCES orden(id_orden),
  CONSTRAINT fk_factura_turno  FOREIGN KEY (id_turno) REFERENCES turno_caja(id_turno),
  CONSTRAINT fk_factura_motivo FOREIGN KEY (id_motivo_descuento) REFERENCES motivo_descuento(id_motivo),
  CONSTRAINT ck_factura_montos CHECK (subtotal >= 0 AND descuento >= 0 AND impuestos >= 0 AND propina >= 0 AND total >= 0),
  -- FSD 6.2: indice sobre factura.emitida_en (reportes por rango de fechas).
  INDEX idx_factura_emitida (emitida_en),
  INDEX idx_factura_orden   (id_orden),
  INDEX idx_factura_turno   (id_turno)
) ENGINE=InnoDB;

-- Replica de las lineas asignadas a cada factura. Soporta la division de
-- cuentas (FSD 2.4.6): la suma de asignaciones debe igualar la orden (CA-06).
CREATE TABLE factura_detalle (
  id_factura        BIGINT NOT NULL,
  id_orden_detalle  BIGINT NOT NULL,
  cantidad_asignada SMALLINT NOT NULL,
  PRIMARY KEY (id_factura, id_orden_detalle),
  CONSTRAINT fk_factdet_factura FOREIGN KEY (id_factura)       REFERENCES factura(id_factura) ON DELETE CASCADE,
  CONSTRAINT fk_factdet_detalle FOREIGN KEY (id_orden_detalle) REFERENCES orden_detalle(id_orden_detalle),
  CONSTRAINT ck_factdet_cantidad CHECK (cantidad_asignada > 0)
) ENGINE=InnoDB;

CREATE TABLE pago (
  id_pago        BIGINT AUTO_INCREMENT PRIMARY KEY,
  -- Multiples pagos sobre una factura = pago mixto (CA-05).
  id_factura     BIGINT NOT NULL,
  metodo         ENUM('efectivo','tarjeta_credito','tarjeta_debito','transferencia','otro') NOT NULL,
  monto          DECIMAL(14,2) NOT NULL,
  recibido       DECIMAL(14,2) NULL,           -- efectivo entregado, para el cambio
  referencia     VARCHAR(60) NULL,             -- voucher / referencia de transferencia
  creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pago_factura FOREIGN KEY (id_factura) REFERENCES factura(id_factura) ON DELETE CASCADE,
  CONSTRAINT ck_pago_monto   CHECK (monto > 0),
  INDEX idx_pago_factura (id_factura),
  INDEX idx_pago_metodo  (metodo)
) ENGINE=InnoDB;


-- =====================================================================
-- 2.4.7 AUDITORIA
-- =====================================================================

-- FSD 2.4.7 y 6.1: tabla de SOLO INSERCION. El usuario de aplicacion de la BD
-- se crea sin privilegios UPDATE/DELETE sobre ella (ver 04_privilegios.sql):
-- la inmutabilidad se garantiza en el motor, no por convencion del codigo.
-- Cada registro encadena el hash del anterior para evidenciar manipulacion
-- (5.8): alterar una fila rompe la cadena de todas las siguientes.
CREATE TABLE log_auditoria (
  id_log         BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_usuario     INT         NOT NULL,
  id_autorizador INT         NULL,             -- supervisor que autorizo (CA-08)
  accion         VARCHAR(60) NOT NULL,         -- cajon.apertura_manual, orden.anulacion...
  entidad        VARCHAR(40) NOT NULL,
  id_entidad     BIGINT      NULL,
  detalle        TEXT        NOT NULL,
  ip_origen      VARCHAR(45) NULL,
  hash_anterior  CHAR(64)    NULL,             -- SHA-256 del registro previo
  hash_actual    CHAR(64)    NOT NULL,
  fecha          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_log_usuario     FOREIGN KEY (id_usuario)     REFERENCES usuario(id_usuario),
  CONSTRAINT fk_log_autorizador FOREIGN KEY (id_autorizador) REFERENCES usuario(id_usuario),
  -- FSD 6.2: indice sobre log_auditoria.fecha (filtro de la vista 9).
  INDEX idx_log_fecha   (fecha),
  INDEX idx_log_usuario (id_usuario),
  INDEX idx_log_accion  (accion),
  INDEX idx_log_entidad (entidad, id_entidad)
) ENGINE=InnoDB;
