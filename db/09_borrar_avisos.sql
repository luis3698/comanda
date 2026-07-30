-- =====================================================================
-- 09 · Permitir que el cliente borre sus propios avisos
-- =====================================================================
--
-- El gesto de deslizar en la bandeja de la aplicación necesita un DELETE sobre
-- `notificacion_cliente`, y `sigr_app` no lo tenía: 05_movil.sql le concedió
-- SELECT, INSERT y UPDATE, que era todo lo que hacía falta cuando un aviso solo
-- se podía marcar como leído.
--
-- POR QUÉ ESTE PRIVILEGIO SÍ, Y OTROS NO
-- El principio del FSD 6.5 no es «no borrar nunca», es que el motor impida
-- borrar lo que NO DEBE poder borrarse aunque el código se equivoque: una
-- factura emitida, un registro de auditoría. Por eso `sigr_app` sigue sin
-- DELETE sobre `factura` ni sobre `log_auditoria`, y eso no cambia aquí.
--
-- Una notificación es otra cosa: es una COPIA de un aviso cuyo original vive en
-- la reserva o el pedido al que se refiere. Borrar «su pedido va en camino» no
-- toca el pedido, ni su factura, ni su rastro en la auditoría. Y conservar para
-- siempre avisos que el cliente ya descartó sería acumular datos personales sin
-- ninguna razón, justo lo contrario de lo que pide el propio criterio de la
-- baja de cuenta (que anonimiza en lugar de guardar).
--
-- El alcance sigue siendo mínimo: DELETE sobre ESTA tabla y ninguna más. La
-- autorización de que solo se borre lo propio la pone la consulta, que filtra
-- por `id_cliente` en el WHERE (ver `borrarNotificacion` en servicios/push.js).
--
-- ESTE ARCHIVO ES REAPLICABLE: un GRANT repetido no da error.

GRANT DELETE ON sigr.notificacion_cliente TO 'sigr_app'@'%';

FLUSH PRIVILEGES;
