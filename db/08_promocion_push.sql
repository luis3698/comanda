-- =====================================================================
-- 08 · Promociones: separar «guardada en la bandeja» de «sonó en el móvil»
-- =====================================================================
--
-- EL PROBLEMA QUE ARREGLA
-- `promocion.total_enviados` guardaba el número de clientes a los que se
-- escribió la promoción en su BANDEJA, pero la columna se llama «enviados» y la
-- pantalla lo mostraba como «✓ Enviada … a N cliente(s)», en verde.
--
-- Esas dos cosas coinciden solo cuando Firebase está configurado. Sin
-- credenciales de servidor, la promoción se guarda en la bandeja de los N
-- clientes y se entregan CERO notificaciones al móvil — y la ficha seguía
-- diciendo «✓ Enviada a N» para siempre.
--
-- El aviso del momento sí lo decía («Firebase no está configurado: quedó en la
-- bandeja…»), pero era un mensaje que se desvanece a los nueve segundos,
-- mientras que el registro permanente afirmaba lo contrario. Quien volvía al
-- día siguiente leía el registro, no el aviso, y concluía que el push
-- funcionaba. Es exactamente la confusión que motivó este archivo.
--
-- Ahora son dos números distintos porque son dos hechos distintos:
--   · total_enviados  clientes que la tienen en su bandeja
--   · total_push      notificaciones que Firebase aceptó entregar
--
-- ESTE ARCHIVO ES REAPLICABLE. `npm run arrancar` lo pasa en cada arranque.

DROP PROCEDURE IF EXISTS sigr_promocion_push;
DELIMITER //
CREATE PROCEDURE sigr_promocion_push()
BEGIN
  -- MySQL no tiene "ADD COLUMN IF NOT EXISTS": se comprueba antes, igual que
  -- hace 06_pagos.sql.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = DATABASE() AND table_name = 'promocion'
                    AND column_name = 'total_push') THEN
    ALTER TABLE promocion
      ADD COLUMN total_push INT NOT NULL DEFAULT 0 AFTER total_enviados;

    -- Las promociones ya enviadas se quedan en 0, que es el valor honesto: no
    -- se guardó cuántas llegaron de verdad, así que no se puede inventar. Y en
    -- la práctica, si esta columna no existía, tampoco había forma de saberlo.
  END IF;
END //
DELIMITER ;

CALL sigr_promocion_push();

DROP PROCEDURE IF EXISTS sigr_promocion_push;
