-- =====================================================================
-- SIGR - Pago de los domicilios con comprobante verificado
--
-- AMPLIACION DEL CANAL DIGITAL (ver el README).
--
-- Hasta ahora un domicilio se pagaba en la puerta y punto. Este archivo
-- anade el pago por adelantado con las billeteras que se usan en Colombia
-- -- Nequi, Bancolombia y DaviPlata -- mas la opcion de contra entrega.
--
-- COMO FUNCIONA, Y POR QUE ASI
-- No hay pasarela de pago ni integracion bancaria: el cliente transfiere
-- por su cuenta a la llave que publica el restaurante, fotografia el
-- comprobante y lo sube. Caja lo mira y lo verifica a mano.
--
-- Es deliberadamente manual. Integrarse con una pasarela exige contrato
-- mercantil, certificacion y comisiones por transaccion; el flujo de
-- "transfiera y mande el pantallazo" es como funciona de hecho el comercio
-- pequeno en Colombia, y no cuesta nada montarlo. Si algun dia se contrata
-- una pasarela, `estado_pago` ya modela los estados que hace falta.
--
-- LA REGLA QUE MANDA
-- Un pedido con pago pendiente NO se puede aceptar. Caja lo ve en su lista
-- desde el primer momento -- para poder llamar al cliente si tarda -- pero
-- el boton de aceptar esta bloqueado hasta que el pago quede verificado.
-- Contra entrega no verifica nada: no hay pago por adelantado que mirar.
--
-- ESTE ARCHIVO ES REAPLICABLE, igual que 05_movil.sql.
--
-- Los GRANT van al final. Ver la nota de db/04_privilegios.sql.
-- =====================================================================

USE sigr;

SET NAMES utf8mb4;


-- =====================================================================
-- METODOS DE PAGO DE LA APLICACION
-- =====================================================================

-- Tabla y no parametros clave-valor: cada metodo tiene varios campos que
-- van juntos (llave, titular, tipo de cuenta, banco) y se activan o
-- desactivan como una unidad. Con parametros sueltos habria que inventar
-- claves tipo 'pago.nequi.llave' y nada garantizaria que existan todas.
CREATE TABLE IF NOT EXISTS metodo_pago_app (
  -- Codigo estable: es lo que se guarda en el pedido y lo que compara el
  -- codigo. El nombre visible puede cambiar sin romper el historico.
  codigo         VARCHAR(30)  PRIMARY KEY,
  nombre         VARCHAR(60)  NOT NULL,

  -- FALSE solo para contra entrega. Es lo que decide si el pedido necesita
  -- comprobante o puede aceptarse directamente.
  requiere_comprobante BOOLEAN NOT NULL DEFAULT TRUE,

  -- A donde transfiere el cliente. Nulos en contra entrega.
  llave          VARCHAR(60)  NULL,   -- celular en Nequi/DaviPlata, cuenta en Bancolombia
  titular        VARCHAR(120) NULL,   -- a nombre de quien esta
  tipo_cuenta    VARCHAR(30)  NULL,   -- "Ahorros", "Corriente"
  banco          VARCHAR(60)  NULL,

  activo         BOOLEAN      NOT NULL DEFAULT FALSE,
  orden_visual   SMALLINT     NOT NULL DEFAULT 0,
  creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Los tres digitales arrancan DESACTIVADOS y sin llave: un metodo de pago
-- publicado sin numero de cuenta manda al cliente a transferir al vacio.
-- El administrador los activa cuando pone sus datos, y la API impide
-- activar uno sin llave.
--
-- Contra entrega arranca activo: es el comportamiento que ya existia.
INSERT IGNORE INTO metodo_pago_app
  (codigo, nombre, requiere_comprobante, activo, orden_visual) VALUES
  ('contra_entrega', 'Contra entrega', FALSE, TRUE,  1),
  ('nequi',          'Nequi',          TRUE,  FALSE, 2),
  ('bancolombia',    'Bancolombia',    TRUE,  FALSE, 3),
  ('daviplata',      'DaviPlata',      TRUE,  FALSE, 4);


-- =====================================================================
-- EL PEDIDO: ESTADO DEL PAGO Y COMPROBANTE
-- =====================================================================

-- El estado del pago va en su PROPIA columna, no mezclado en `estado`.
-- Son dos ejes independientes: un pedido puede estar "en camino" con el
-- pago verificado, o "pendiente" con el pago rechazado. Meterlo todo en un
-- solo ENUM habria multiplicado los estados y hecho imposible saber, de un
-- vistazo, por que un pedido no avanza.
--
--   no_requerido  contra entrega: no hay nada que verificar
--   pendiente     esperando a que el cliente suba el comprobante
--   por_verificar el cliente lo subio; Caja tiene que mirarlo
--   verificado    Caja dio el pago por bueno -> ya se puede aceptar
--   rechazado     el comprobante no servia; el cliente puede subir otro
--
-- El bloque de ALTER va envuelto en un procedimiento porque MySQL no tiene
-- "ADD COLUMN IF NOT EXISTS": sin esto, reaplicar el archivo fallaria.
DROP PROCEDURE IF EXISTS sigr_anadir_columnas_pago;
DELIMITER //
CREATE PROCEDURE sigr_anadir_columnas_pago()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'sigr' AND table_name = 'pedido_domicilio'
                    AND column_name = 'estado_pago') THEN
    ALTER TABLE pedido_domicilio
      ADD COLUMN estado_pago ENUM('no_requerido','pendiente','por_verificar','verificado','rechazado')
                 NOT NULL DEFAULT 'no_requerido' AFTER metodo_pago,
      ADD COLUMN url_comprobante VARCHAR(255) NULL AFTER estado_pago,
      ADD COLUMN comprobante_en DATETIME NULL AFTER url_comprobante,
      -- Quien verifico el pago y cuando. Es distinto de id_usuario_gestion:
      -- puede verificarlo un cajero y aceptarlo otro en el cambio de turno.
      ADD COLUMN id_usuario_pago INT NULL AFTER comprobante_en,
      ADD COLUMN verificado_en DATETIME NULL AFTER id_usuario_pago,
      ADD COLUMN motivo_pago VARCHAR(255) NULL AFTER verificado_en,
      ADD CONSTRAINT fk_pedido_usuario_pago FOREIGN KEY (id_usuario_pago)
          REFERENCES usuario(id_usuario),
      ADD INDEX idx_pedido_estado_pago (estado_pago);
  END IF;

  -- `metodo_pago` era un ENUM cerrado ('efectivo','tarjeta','transferencia').
  -- Pasa a VARCHAR para poder referenciar los codigos de metodo_pago_app,
  -- que el administrador activa y desactiva sin tocar el esquema.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'sigr' AND table_name = 'pedido_domicilio'
                AND column_name = 'metodo_pago' AND data_type = 'enum') THEN
    ALTER TABLE pedido_domicilio
      MODIFY COLUMN metodo_pago VARCHAR(30) NOT NULL DEFAULT 'contra_entrega';

    -- Los pedidos que ya existian se pagaban en la puerta.
    UPDATE pedido_domicilio
       SET metodo_pago = 'contra_entrega'
     WHERE metodo_pago IN ('efectivo', 'tarjeta', 'transferencia');
  END IF;
END //
DELIMITER ;

CALL sigr_anadir_columnas_pago();
DROP PROCEDURE sigr_anadir_columnas_pago;


-- =====================================================================
-- PERMISOS
-- =====================================================================
INSERT IGNORE INTO permiso (codigo, modulo, descripcion) VALUES
  ('config.pagos.gestionar', 'canal_digital',
   'Configurar los metodos de pago de la aplicacion y sus llaves.'),
  ('domicilios.verificar_pago', 'domicilios',
   'Verificar o rechazar el comprobante de pago de un pedido a domicilio.');

-- Administrador: ambos.
INSERT IGNORE INTO rol_permiso (id_rol, id_permiso)
SELECT 1, id_permiso FROM permiso
 WHERE codigo IN ('config.pagos.gestionar', 'domicilios.verificar_pago');

-- Cajero: verifica pagos, pero NO configura las llaves. Publicar a que
-- cuenta transfiere el cliente es una decision del dueno del negocio.
INSERT IGNORE INTO rol_permiso (id_rol, id_permiso)
SELECT 2, id_permiso FROM permiso WHERE codigo = 'domicilios.verificar_pago';


-- =====================================================================
-- PRIVILEGIOS
-- =====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.metodo_pago_app TO 'sigr_app'@'%';

FLUSH PRIVILEGES;
