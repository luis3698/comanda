-- =====================================================================
-- SIGR - Privilegios minimos del usuario de aplicacion
--
-- FSD 6.1 (Inyeccion SQL):
--   "Usuario de BD de la aplicacion con privilegios minimos (sin DDL; sin
--    UPDATE/DELETE sobre log_auditoria)."
-- FSD 5.8 (Auditoria):
--   "log_auditoria es de solo insercion: el usuario de aplicacion de la BD
--    carece de privilegios UPDATE/DELETE sobre esa tabla."
--   "las conexiones de reporting usan un usuario de BD de solo SELECT."
--
-- POR QUE SE CONCEDE TABLA POR TABLA
-- El modelo de privilegios de MySQL es aditivo: un GRANT a nivel de base de
-- datos (sigr.*) no se puede recortar despues con un REVOKE sobre una tabla
-- concreta. Si se concediera UPDATE sobre sigr.*, el usuario tendria UPDATE
-- sobre log_auditoria y la inmutabilidad seria una mentira. La unica forma de
-- que el motor la garantice es enumerar los privilegios por tabla.
--
-- Con esto, un atacante que logre inyeccion SQL o que comprometa las
-- credenciales de la aplicacion TAMPOCO puede borrar sus huellas: el motor
-- rechaza el UPDATE/DELETE sobre la auditoria.
-- =====================================================================

USE sigr;

-- El contenedor crea el usuario con todos los privilegios sobre sigr.*.
-- Se parte de cero para no heredar ese permiso amplio.
REVOKE ALL PRIVILEGES ON sigr.* FROM 'sigr_app'@'%';


-- ---------------------------------------------------------------------
-- Tablas de operacion normal: lectura y escritura completa.
-- Sin CREATE/ALTER/DROP/INDEX: la aplicacion nunca modifica el esquema.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.rol                        TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.permiso                    TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.rol_permiso                TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.usuario                    TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.sesion                     TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.zona                       TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.mesa                       TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.categoria                  TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.producto                   TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.producto_precio            TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.grupo_modificador          TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.modificador                TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.producto_grupo_modificador TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.insumo                     TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.receta                     TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.proveedor                  TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.compra                     TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.compra_detalle             TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.orden                      TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.orden_detalle              TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.orden_detalle_modificador  TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.turno_caja                 TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.movimiento_caja            TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.motivo_descuento           TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE         ON sigr.secuencia                  TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.factura_detalle            TO 'sigr_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON sigr.pago                       TO 'sigr_app'@'%';

-- factura necesita UPDATE unicamente para pasar estado a 'anulada'.
-- FSD 6.5: las facturas emitidas son inmutables y solo se corrigen con
-- documentos de anulacion auditados; no se les permite DELETE.
GRANT SELECT, INSERT, UPDATE ON sigr.factura TO 'sigr_app'@'%';


-- ---------------------------------------------------------------------
-- Tablas de SOLO INSERCION.
-- ---------------------------------------------------------------------

-- log_auditoria: registro inalterable (FSD 2.4.7, 5.8, 6.1).
GRANT SELECT, INSERT ON sigr.log_auditoria TO 'sigr_app'@'%';

-- movimiento_inventario: el kardex tampoco se altera ni se borra.
-- FSD 5.4: "Anular una compra recibida revierte los movimientos con
-- contra-asientos (nunca se borra el kardex)."
GRANT SELECT, INSERT ON sigr.movimiento_inventario TO 'sigr_app'@'%';


-- ---------------------------------------------------------------------
-- Usuario de reporting: solo SELECT (FSD 5.8).
-- Las consultas del dashboard y los reportes no necesitan escribir nada.
--
-- Se recrea en lugar de revocar: MySQL aborta con "no such grant defined"
-- si se intenta revocar un privilegio que el usuario nunca tuvo, y el
-- entrypoint corta el resto del archivo al primer error.
-- ---------------------------------------------------------------------
DROP USER IF EXISTS 'sigr_reportes'@'%';
CREATE USER 'sigr_reportes'@'%' IDENTIFIED BY 'sigr_reportes_dev';
GRANT SELECT ON sigr.* TO 'sigr_reportes'@'%';

FLUSH PRIVILEGES;
