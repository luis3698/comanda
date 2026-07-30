-- =====================================================================
-- 07 · Índices de rendimiento
-- =====================================================================
--
-- Índices que NO son necesarios para la corrección del sistema —sin ellos
-- todo funciona igual— sino para que las consultas calientes sigan siendo
-- rápidas cuando la base deje de estar recién instalada.
--
-- POR QUÉ EN UN ARCHIVO APARTE Y NO EN 01_schema.sql
-- 01_schema.sql describe el MODELO: tablas, claves y restricciones. Esto es
-- afinado, que es otra cosa: se deduce de las consultas que acabaron
-- escribiéndose, cambia cuando cambian ellas, y conviene poder leerlo junto
-- con el motivo de cada uno. Separarlo además permite reaplicarlo sobre una
-- base que ya existe, que es el caso normal: el entrypoint de MySQL solo
-- ejecuta db/*.sql la PRIMERA vez que se crea el volumen.
--
-- ESTE ARCHIVO ES REAPLICABLE. Cada índice se crea solo si falta, así que
-- ejecutarlo dos veces no da error. Lo aplica solo `npm run arrancar`.
--
-- QUÉ ESTÁ MEDIDO Y QUÉ ESTÁ RAZONADO
-- Sobre la base de demostración estos índices no cambian nada visible: con
-- cinco filas el optimizador recorre la tabla entera y acierta al hacerlo.
-- Lo que sí está comprobado con EXPLAIN es la FORMA del plan —la cola del KDS
-- resuelve su ORDER BY con "Using temporary; Using filesort", es decir
-- materializando y ordenando a mano—, y esa forma no depende del volumen:
-- depende de que no haya un índice que sirva para filtrar y ordenar a la vez.
-- Con el servicio de una noche en la tabla, eso es exactamente lo que se paga.

-- ---------------------------------------------------------------------
-- Ayuda: añadir un índice solo si no está.
--
-- MySQL 8 no tiene "CREATE INDEX IF NOT EXISTS", así que se consulta
-- information_schema y se construye el ALTER con una sentencia preparada.
-- Es el mismo recurso que ya usa 06_pagos.sql para las columnas.
--
-- Se usa DATABASE() en lugar del nombre literal 'sigr' para que el archivo
-- siga valiendo si la base se llama de otra forma (DB_NAME del .env).
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sigr_indice_si_falta;
DELIMITER //
CREATE PROCEDURE sigr_indice_si_falta(
  IN p_tabla   VARCHAR(64),
  IN p_indice  VARCHAR(64),
  IN p_columnas VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_tabla
       AND index_name = p_indice
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_tabla, '` ADD INDEX `', p_indice, '` (', p_columnas, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Y la simétrica, para retirar un índice que dejó de aportar.
DROP PROCEDURE IF EXISTS sigr_indice_fuera;
DELIMITER //
CREATE PROCEDURE sigr_indice_fuera(IN p_tabla VARCHAR(64), IN p_indice VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_tabla
       AND index_name = p_indice
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_tabla, '` DROP INDEX `', p_indice, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------
-- La cola del KDS.  RF-14 · CA-01
--
--   WHERE od.enviado_en IS NOT NULL
--     AND od.estado_preparacion IN ('en_cola','preparando')
--   ORDER BY od.enviado_en
--
-- El índice que había, idx_ordendet_estado, es solo (estado_preparacion): sirve
-- para filtrar y deja la ordenación al filesort. Añadiendo enviado_en como
-- segunda columna, las filas ya salen del índice en el orden que pide la vista
-- 15 ("la más antigua a la izquierda") y desaparece la ordenación en memoria.
--
-- La ganancia crece con el histórico, no con la cola: orden_detalle acumula
-- TODAS las líneas servidas desde que se instaló el sistema, y de ellas la
-- cocina solo quiere las diez o veinte que están vivas ahora mismo.
CALL sigr_indice_si_falta('orden_detalle', 'idx_ordendet_cola', '`estado_preparacion`, `enviado_en`');

-- Y con el compuesto puesto, el viejo sobra. Un índice (a, b) sirve para todo
-- aquello para lo que servía uno (a): el optimizador usa cualquier prefijo por
-- la izquierda. Mantener los dos no acelera ninguna lectura y sí encarece cada
-- escritura, porque hay un árbol más que actualizar en cada línea de comanda
-- que se crea o cambia de estado —que en hora punta son muchas—.
--
-- Se deja aquí y no se borra de 01_schema.sql a propósito: 01 describe el
-- modelo tal como se diseñó, y este archivo es el registro de lo que el uso
-- real acabó pidiendo. En un volumen nuevo se crea en 01 y se retira aquí
-- unos milisegundos después, sobre una tabla vacía.
CALL sigr_indice_fuera('orden_detalle', 'idx_ordendet_estado');

-- ---------------------------------------------------------------------
-- Monitor consolidado y menú de la estación.  RF-15 · RF-16
--
-- GET /kds/menu trae cada plato de la estación con sus unidades en cola, y lo
-- resuelve con una subconsulta correlacionada: una ejecución POR PLATO,
-- filtrando por id_producto y estado_preparacion. Existe un índice sobre
-- id_producto (lo crea InnoDB para la clave foránea), pero el estado se acaba
-- comprobando fila a fila. Con la carta completa de un restaurante son decenas
-- de subconsultas en cada refresco de una pantalla que se refresca sola.
CALL sigr_indice_si_falta('orden_detalle', 'idx_ordendet_producto_estado', '`id_producto`, `estado_preparacion`');

-- Las sesiones NO necesitan nada aquí, y conviene dejarlo escrito para que
-- nadie lo "arregle" más adelante: `sesion` y `sesion_cliente` se buscan por
-- su token, que es la clave primaria, y se purgan por expira_en, que ya tiene
-- índice. `dispositivo_cliente.token_fcm` es UNIQUE, y una restricción UNIQUE
-- ya ES un índice: añadirle otro solo costaría escrituras.

-- ---------------------------------------------------------------------
-- Auditoría: la vista por defecto.
--
-- La pantalla de auditoría abre siempre por lo más reciente y casi siempre
-- acotada a un módulo. idx_log_fecha ordena, idx_log_accion filtra, pero el
-- optimizador solo puede usar uno de los dos por consulta. El compuesto cubre
-- el caso de uso real de la pantalla.
CALL sigr_indice_si_falta('log_auditoria', 'idx_log_accion_fecha', '`accion`, `fecha`');

-- Los ayudantes no se quedan en la base: son andamio de este archivo.
DROP PROCEDURE IF EXISTS sigr_indice_si_falta;
DROP PROCEDURE IF EXISTS sigr_indice_fuera;
