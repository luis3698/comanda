-- =====================================================================
-- SIGR - Catalogo de permisos y roles preestablecidos
--
-- ORIGEN DE ESTOS DATOS
-- La matriz de accesos del FSD (seccion 3.2) esta TRUNCADA en el documento
-- v1.1: define 4 filas y se corta a mitad de la palabra "precios", dejando
-- indefinidas las celdas de Cajero/Cocinero/Mesero para casi todo el sistema.
-- El catalogo de abajo se reconstruye cruzando tres fuentes que si estan
-- completas en el documento:
--   1. Seccion 3.1  - descripcion de responsabilidades de cada rol.
--   2. Seccion 4    - lo que cada vista permite hacer y a quien.
--   3. Seccion 8    - columna "Permiso" del catalogo de API, que nombra
--                     codigos concretos.
--
-- Los codigos citados LITERALMENTE por el FSD se marcan con [FSD]. El resto
-- se deriva por el mismo patron de nomenclatura (modulo.accion).
-- Esta reconstruccion requiere validacion del negocio (ver TRAZABILIDAD.md).
-- =====================================================================

USE sigr;


-- ---------------------------------------------------------------------
-- Roles preestablecidos (FSD 3.1). es_sistema = TRUE: no se pueden eliminar.
-- El FSD aclara que el Administrador puede crear roles adicionales
-- personalizados sin tocar codigo; la configuracion estandar es de 4.
-- ---------------------------------------------------------------------
INSERT INTO rol (id_rol, nombre, descripcion, es_sistema) VALUES
  (1, 'Administrador', 'Control total: parametriza salon, catalogo, recetas, seguridad y usuarios; gestiona proveedores, compras e inventario; consulta auditoria, dashboard y reportes. Autoriza operaciones sensibles con su PIN.', TRUE),
  (2, 'Cajero',        'Responsable del dinero: abre y cierra turnos, cobra y factura, divide cuentas, aplica descuentos dentro de su tope, registra salidas de efectivo y realiza el arqueo ciego.', TRUE),
  (3, 'Cocinero',      'Responsable de la preparacion: gestiona comandas en el KDS, avanza estados de los platos, usa el monitor consolidado y marca platos agotados.', TRUE),
  (4, 'Mesero',        'Responsable del servicio en sala: abre mesas, toma pedidos con modificadores, agrupa por tiempos de salida, envia a cocina y solicita la pre-cuenta.', TRUE);


-- ---------------------------------------------------------------------
-- Catalogo de permisos
-- ---------------------------------------------------------------------
INSERT INTO permiso (codigo, modulo, descripcion) VALUES
  -- Seguridad (vistas 3 y 4)
  ('seguridad.usuarios.ver',       'seguridad', 'Consultar el registro de usuarios.'),
  ('seguridad.usuarios.gestionar', 'seguridad', 'Crear, editar y dar de baja usuarios.'),
  ('seguridad.roles.ver',          'seguridad', 'Consultar roles y su matriz de permisos.'),
  ('seguridad.roles.gestionar',    'seguridad', 'Crear roles y modificar permisos concedidos.'),

  -- Salon (vistas 2, 11, 18)
  ('salon.ver',                    'salon',     'Ver el plano del salon y el estado de las mesas.'),
  ('salon.gestionar',              'salon',     'Disenar la distribucion: zonas y mesas.'),

  -- Catalogo (vistas 5, 6)
  ('catalogo.ver',                 'catalogo',  'Consultar el menu, precios y modificadores.'),
  ('catalogo.gestionar',           'catalogo',  'Crear y editar categorias, platos, precios y modificadores.'),
  ('catalogo.recetas.gestionar',   'catalogo',  'Editar fichas tecnicas (receta producto-insumo).'),

  -- Inventario (vista 7)
  ('inventario.ver',               'inventario','Consultar existencias y kardex.'),
  ('inventario.gestionar_compras', 'inventario','Registrar proveedores y compras.'),           -- [FSD seccion 8]
  ('inventario.ajustar',           'inventario','Ajuste manual de inventario con motivo.'),

  -- Ordenes / comandero (vistas 11-14)
  ('ordenes.abrir',                'ordenes',   'Abrir una comanda en una mesa libre.'),
  ('ordenes.tomar',                'ordenes',   'Agregar y editar lineas no enviadas.'),
  ('ordenes.enviar',               'ordenes',   'Enviar la comanda a cocina y barra.'),
  ('ordenes.precuenta',            'ordenes',   'Solicitar la pre-cuenta de una mesa.'),
  ('ordenes.anular_enviada',       'ordenes',   'Anular una linea ya enviada a cocina.'),      -- [FSD secciones 5.5 y 8]
  ('ordenes.ver_todas',            'ordenes',   'Ver y operar mesas atendidas por otros meseros.'),

  -- KDS (vistas 15-17)
  ('kds.ver',                      'kds',       'Ver el monitor de ordenes de la estacion.'),
  ('kds.avanzar_estado',           'kds',       'Avanzar el estado de preparacion de los platos.'),
  ('kds.marcar_agotado',           'kds',       'Marcar un plato como agotado o disponible.'),  -- [FSD secciones 4.3, 5.6 y 8]

  -- Caja (vistas 18-21)
  ('caja.turno.abrir',             'caja',      'Abrir turno de caja con fondo inicial.'),
  ('caja.turno.cerrar',            'caja',      'Cerrar turno con arqueo ciego.'),
  ('caja.cobrar',                  'caja',      'Cobrar cuentas y emitir facturas.'),
  ('caja.dividir',                 'caja',      'Dividir una cuenta en sub-cuentas.'),
  ('caja.registrar_salida',        'caja',      'Registrar ingresos y salidas de efectivo.'),  -- [FSD seccion 8]
  ('caja.abrir_cajon',             'caja',      'Abrir el cajon manualmente sin una venta.'),  -- [FSD secciones 2.4.1 y 5.7]

  -- Descuentos (vista 19)
  ('descuentos.aplicar_menor_10',  'descuentos','Aplicar descuentos de hasta 10 %.'),          -- [FSD seccion 2.4.1]
  ('descuentos.aplicar_mayor_10',  'descuentos','Aplicar descuentos superiores al 10 %.'),
  ('descuentos.autorizar',         'descuentos','Autorizar con PIN un descuento sobre el tope de otro usuario.'),

  -- Inteligencia (vistas 1, 9, 10)
  ('dashboard.ver',                'dashboard', 'Ver el dashboard de KPIs en tiempo real.'),
  ('reportes.ver',                 'reportes',  'Consultar el centro de reportes.'),
  ('reportes.exportar',            'reportes',  'Exportar reportes a PDF y Excel.'),
  ('auditoria.ver',                'auditoria', 'Consultar el historial de auditoria.');


-- ---------------------------------------------------------------------
-- ASIGNACION: Administrador -> todos los permisos.
-- FSD 3.1: "Control total del sistema".
-- ---------------------------------------------------------------------
INSERT INTO rol_permiso (id_rol, id_permiso)
SELECT 1, id_permiso FROM permiso;


-- ---------------------------------------------------------------------
-- ASIGNACION: Cajero (FSD 3.1)
-- "abre y cierra turnos de caja, cobra y factura, divide cuentas, aplica
--  descuentos dentro de su tope, registra salidas de efectivo y realiza el
--  arqueo ciego."
-- Necesita salon.ver y catalogo.ver porque la vista 18 muestra el mapa de
-- mesas y la 19 desglosa las lineas del consumo.
--
-- DECISIONES DEL NEGOCIO (validadas 2026-07-16, ver TRAZABILIDAD.md seccion 4):
--  - SIN tope de descuento: recibe descuentos.aplicar_mayor_10, asi que aplica
--    cualquier descuento sin pedir PIN del Administrador. (El FSD sugeria 10%;
--    el negocio opto por no poner tope.)
--  - SI recibe caja.abrir_cajon: todos los cajeros pueden abrir el cajon
--    manualmente. Sigue quedando auditado siempre (FSD 5.7).
-- ---------------------------------------------------------------------
INSERT INTO rol_permiso (id_rol, id_permiso)
SELECT 2, id_permiso FROM permiso WHERE codigo IN (
  'salon.ver',
  'catalogo.ver',
  'ordenes.ver_todas',
  'caja.turno.abrir',
  'caja.turno.cerrar',
  'caja.cobrar',
  'caja.dividir',
  'caja.registrar_salida',
  'caja.abrir_cajon',
  'descuentos.aplicar_menor_10',
  'descuentos.aplicar_mayor_10'
);


-- ---------------------------------------------------------------------
-- ASIGNACION: Cocinero (FSD 3.1)
-- "gestiona las comandas en el KDS, avanza estados de los platos, usa el
--  monitor consolidado y activa/desactiva platos agotados en tiempo real."
-- catalogo.ver es necesario para la vista 17 (buscador del menu de la estacion).
-- ---------------------------------------------------------------------
INSERT INTO rol_permiso (id_rol, id_permiso)
SELECT 3, id_permiso FROM permiso WHERE codigo IN (
  'catalogo.ver',
  'kds.ver',
  'kds.avanzar_estado',
  'kds.marcar_agotado'
);


-- ---------------------------------------------------------------------
-- ASIGNACION: Mesero (FSD 3.1)
-- "abre mesas, toma pedidos con modificadores, agrupa por tiempos de salida,
--  envia a cocina, hace seguimiento y solicita la pre-cuenta."
-- NO recibe ordenes.anular_enviada: FSD 5.5 dice que anular una linea enviada
-- "exige permiso ordenes.anular_enviada o autorizacion del Administrador".
-- NO recibe ordenes.ver_todas: vista 11 dice que las mesas de otros meseros
-- "aparecen atenuadas (segun permiso)".
-- ---------------------------------------------------------------------
INSERT INTO rol_permiso (id_rol, id_permiso)
SELECT 4, id_permiso FROM permiso WHERE codigo IN (
  'salon.ver',
  'catalogo.ver',
  'ordenes.abrir',
  'ordenes.tomar',
  'ordenes.enviar',
  'ordenes.precuenta'
);


-- ---------------------------------------------------------------------
-- Motivos de descuento (FSD 2.4.6: catalogo con porcentaje_max).
-- ---------------------------------------------------------------------
INSERT INTO motivo_descuento (nombre, porcentaje_max) VALUES
  ('Cliente frecuente',   10.00),
  ('Cortesia gerencia',  100.00),
  ('Error de cocina',    100.00),
  ('Promocion vigente',   25.00),
  ('Personal interno',    30.00);
