-- =====================================================================
-- SIGR - Datos de demostracion
--
-- Restaurante de ejemplo para poder operar el sistema de inmediato.
-- SOLO PARA DESARROLLO. En produccion los usuarios se crean desde la
-- vista 4 (registro de usuarios) y este archivo no debe cargarse.
--
-- CREDENCIALES DE DEMOSTRACION
--   admin@sigr.local     Admin123!   PIN 1111   (Administrador)
--   cajero@sigr.local    Cajero123!  PIN 2222   (Cajero)
--   cocinero@sigr.local  Cocina123!  PIN 3333   (Cocinero)
--   mesero@sigr.local    Mesero123!  PIN 4444   (Mesero)
--
-- Los hashes son bcrypt de costo 12 (FSD 6.1), generados con `npm run hash`.
-- =====================================================================

USE sigr;


-- ---------------------------------------------------------------------
-- Usuarios: uno por cada rol preestablecido.
-- ---------------------------------------------------------------------
INSERT INTO usuario (id_usuario, id_rol, nombre_completo, documento, correo, hash_password, hash_pin) VALUES
  (1, 1, 'Ana Restrepo',    'CC1001', 'admin@sigr.local',
      '$2a$12$EdYMsSozMNmjb8zOw/.b1OV/hXVKDSOjeCGAvBzxIE3V0HHV9frC2',
      '$2a$12$9wP6UTQ1tK2mC44eRMgXx.H3gFF70aki0t.IkMSNNP0wSBgUBeih6'),
  (2, 2, 'Carlos Jimenez',  'CC1002', 'cajero@sigr.local',
      '$2a$12$CfE7kbjxOgRdUId5vWONi.p6aIAPcscxi8wqG6m7OBOqdDLe6QUKm',
      '$2a$12$CFG/W1j.LrCgnV8vpPFjYu1nWPIRM.NI2jkrPSoJqg8EEbNk.ZTeK'),
  (3, 3, 'Marta Delgado',   'CC1003', 'cocinero@sigr.local',
      '$2a$12$IdqUeSYooMMdQ/Aiz2A.OuH.LUwK4njKfMmWubnXWF78QTDkTgEcK',
      '$2a$12$rjR1HPlMBS4QiGVF79EvKOsJkrYuoIEWB9TMQWNMyJdNsicLXlqAm'),
  (4, 4, 'Luis Barrera',    'CC1004', 'mesero@sigr.local',
      '$2a$12$K./8k6m4E1HO88tR.NpQ4.vkmwPZXM2o1n7MfQ/qUQE73QgByJ9A.',
      '$2a$12$gB7w.4lTIQZ2Z6ll6rDCfOiSfaJc1bslnqrVNvoz6p48QsoSfw8le');


-- ---------------------------------------------------------------------
-- Salon: zonas y mesas (FSD 2.4.2).
--
-- A PROPOSITO NO SE SIEMBRA NINGUNA. El plano de un restaurante es suyo: el
-- numero de mesas, su forma y su sitio no se parecen a los de ningun otro, asi
-- que unas zonas de ejemplo solo servirian para que el administrador empezara
-- borrandolas. El disenador (vista 2) arranca en blanco y se dibuja el salon
-- real desde ahi.
--
-- Las pruebas automaticas no dependen de esto: crean su propia zona con el
-- ayudante de tests/comun/salon.mjs.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- Catalogo: categorias. destino_preparacion enruta la linea al KDS
-- correspondiente (FSD 5.5): la comida va a cocina, la bebida a barra.
-- ---------------------------------------------------------------------
INSERT INTO categoria (id_categoria, nombre, destino_preparacion, orden_visual) VALUES
  (1, 'Entradas',       'cocina', 1),
  (2, 'Platos Fuertes', 'cocina', 2),
  (3, 'Postres',        'cocina', 3),
  (4, 'Bebidas',        'barra',  4),
  (5, 'Cocteles',       'barra',  5);


-- ---------------------------------------------------------------------
-- Insumos (materia prima). Stock inicial suficiente para operar la demo.
-- ---------------------------------------------------------------------
INSERT INTO insumo (id_insumo, nombre, unidad_medida, stock_actual, stock_minimo, costo_promedio) VALUES
  ( 1, 'Carne de res',      'g',      50000,  5000,  0.0450),
  ( 2, 'Pechuga de pollo',  'g',      40000,  4000,  0.0280),
  ( 3, 'Pan brioche',       'unidad',   300,    40,  1200.0000),
  ( 4, 'Queso cheddar',     'g',      12000,  1500,  0.0320),
  ( 5, 'Lechuga',           'g',       8000,  1000,  0.0060),
  ( 6, 'Tomate',            'g',      10000,  1200,  0.0048),
  ( 7, 'Papa',              'g',      60000,  8000,  0.0035),
  ( 8, 'Pasta',             'g',      25000,  3000,  0.0070),
  ( 9, 'Salsa de tomate',   'ml',     15000,  2000,  0.0090),
  (10, 'Tocineta',          'g',       6000,   800,  0.0520),
  (11, 'Huevo',             'unidad',   240,    36,  600.0000),
  (12, 'Aguacate',          'unidad',    80,    12,  2500.0000),
  (13, 'Cafe molido',       'g',       9000,  1000,  0.0400),
  (14, 'Leche entera',      'ml',     30000,  4000,  0.0035),
  (15, 'Ron blanco',        'ml',     12000,  1500,  0.0850),
  (16, 'Limon',             'unidad',   200,    30,  400.0000),
  (17, 'Azucar',            'g',      20000,  2500,  0.0028),
  (18, 'Hielo',             'g',      80000, 10000,  0.0004),
  (19, 'Hierbabuena',       'g',       1200,   200,  0.0300),
  (20, 'Gaseosa lata',      'unidad',   180,    24,  1800.0000),
  (21, 'Chocolate',         'g',       7000,   900,  0.0620),
  (22, 'Harina',            'g',      18000,  2000,  0.0032),
  (23, 'Queso crema',       'g',       6000,   800,  0.0410),
  (24, 'Helado vainilla',   'ml',      9000,  1200,  0.0180),
  (25, 'Nachos',            'g',       5000,   700,  0.0250);


-- ---------------------------------------------------------------------
-- Productos. tasa_impuesto 8 % = impoconsumo tipico de restaurantes.
-- FSD 5.3: el impuesto se parametriza por producto.
-- ---------------------------------------------------------------------
INSERT INTO producto (id_producto, id_categoria, nombre, descripcion, precio_base, tasa_impuesto) VALUES
  -- Entradas
  ( 1, 1, 'Papas a la Francesa', 'Papa criolla frita con sal de mar.',               12000, 8.00),
  ( 2, 1, 'Nachos con Queso',    'Nachos crocantes con cheddar fundido.',            18000, 8.00),
  -- Platos fuertes
  ( 3, 2, 'Hamburguesa Clasica', 'Carne de res 150 g, cheddar, lechuga y tomate.',   32000, 8.00),
  ( 4, 2, 'Hamburguesa de Pollo','Pechuga a la plancha, lechuga y tomate.',          30000, 8.00),
  ( 5, 2, 'Pasta Bolonesa',      'Pasta al dente con salsa bolonesa de la casa.',    28000, 8.00),
  -- Postres
  ( 6, 3, 'Brownie con Helado',  'Brownie de chocolate tibio con helado de vainilla.',15000, 8.00),
  ( 7, 3, 'Cheesecake',          'Tarta de queso con salsa de frutos rojos.',        16000, 8.00),
  -- Bebidas
  ( 8, 4, 'Limonada Natural',    'Limonada exprimida al momento.',                    8000, 8.00),
  ( 9, 4, 'Cafe Americano',      'Cafe de origen, 8 oz.',                             6000, 8.00),
  (10, 4, 'Gaseosa',             'Lata 330 ml.',                                      5000, 8.00),
  -- Cocteles
  (11, 5, 'Mojito',              'Ron blanco, hierbabuena, limon y azucar.',         22000, 8.00),
  (12, 5, 'Cuba Libre',          'Ron blanco con gaseosa de cola y limon.',          20000, 8.00);


-- ---------------------------------------------------------------------
-- Variante de precio por horario (FSD 2.4.3).
-- Happy hour de cocteles: lunes a viernes de 14:00 a 18:00.
-- Sirve para verificar CA-04 (el precio se congela al enviar la comanda).
-- ---------------------------------------------------------------------
INSERT INTO producto_precio (id_producto, nombre, precio, hora_inicio, hora_fin, dias_semana) VALUES
  (11, 'Happy hour', 15000, '14:00:00', '18:00:00', 'L,M,X,J,V'),
  (12, 'Happy hour', 14000, '14:00:00', '18:00:00', 'L,M,X,J,V');


-- ---------------------------------------------------------------------
-- Modificadores (FSD 2.4.3).
-- ---------------------------------------------------------------------
INSERT INTO grupo_modificador (id_grupo_mod, nombre, obligatorio, seleccion_min, seleccion_max) VALUES
  (1, 'Termino de coccion', TRUE,  1, 1),   -- obligatorio: exactamente uno
  (2, 'Adicionales',        FALSE, 0, 4),   -- opcional: hasta 4
  (3, 'Tipo de leche',      FALSE, 0, 1),
  (4, 'Preparacion',        FALSE, 0, 1);

INSERT INTO modificador (id_grupo_mod, nombre, precio_extra) VALUES
  -- Termino de coccion
  (1, 'Poco hecho',      0),
  (1, 'Termino medio',   0),
  (1, 'Tres cuartos',    0),
  (1, 'Bien cocido',     0),
  -- Adicionales
  (2, 'Queso extra',     3000),
  (2, 'Tocineta',        4000),
  (2, 'Huevo',           2500),
  (2, 'Aguacate',        3500),
  -- Tipo de leche
  (3, 'Leche entera',       0),
  (3, 'Leche deslactosada', 1000),
  (3, 'Leche de almendra',  2000),
  -- Preparacion
  (4, 'Sin hielo',      0),
  (4, 'Extra limon',  500);

INSERT INTO producto_grupo_modificador (id_producto, id_grupo_mod) VALUES
  (3, 1),  -- Hamburguesa Clasica: termino obligatorio
  (3, 2),  -- Hamburguesa Clasica: adicionales
  (4, 2),  -- Hamburguesa de Pollo: adicionales
  (9, 3),  -- Cafe Americano: tipo de leche
  (11, 4), -- Mojito: preparacion
  (12, 4); -- Cuba Libre: preparacion


-- ---------------------------------------------------------------------
-- Recetas / fichas tecnicas (FSD 2.4.3).
-- Al enviar una comanda se descuenta receta.cantidad x cantidad vendida
-- de cada insumo, en la misma transaccion (CA-03).
-- ---------------------------------------------------------------------
INSERT INTO receta (id_producto, id_insumo, cantidad) VALUES
  -- Papas a la Francesa
  (1,  7, 200.000),
  -- Nachos con Queso
  (2, 25, 120.000),
  (2,  4,  60.000),
  -- Hamburguesa Clasica
  (3,  1, 150.000),
  (3,  3,   1.000),
  (3,  4,  30.000),
  (3,  5,  20.000),
  (3,  6,  30.000),
  -- Hamburguesa de Pollo
  (4,  2, 150.000),
  (4,  3,   1.000),
  (4,  5,  20.000),
  (4,  6,  30.000),
  -- Pasta Bolonesa
  (5,  8, 120.000),
  (5,  1, 100.000),
  (5,  9,  80.000),
  -- Brownie con Helado
  (6, 21,  60.000),
  (6, 22,  40.000),
  (6, 11,   1.000),
  (6, 24,  50.000),
  -- Cheesecake
  (7, 23,  90.000),
  (7, 22,  30.000),
  (7, 17,  25.000),
  -- Limonada Natural
  (8, 16,   2.000),
  (8, 17,  20.000),
  (8, 18, 100.000),
  -- Cafe Americano
  (9, 13,  18.000),
  -- Gaseosa
  (10, 20,  1.000),
  -- Mojito
  (11, 15,  60.000),
  (11, 16,   1.000),
  (11, 17,  20.000),
  (11, 18, 100.000),
  (11, 19,   5.000),
  -- Cuba Libre
  (12, 15,  60.000),
  (12, 20,   1.000),
  (12, 16,   0.500),
  (12, 18, 100.000);


-- ---------------------------------------------------------------------
-- Proveedores (FSD 2.4.4).
-- ---------------------------------------------------------------------
INSERT INTO proveedor (razon_social, nit, contacto_nombre, telefono, correo) VALUES
  ('Carnes del Valle S.A.S.',   '900123456-1', 'Jorge Medina',  '3101234567', 'ventas@carnesdelvalle.co'),
  ('Distribuidora La Huerta',   '900234567-2', 'Sofia Ramirez', '3112345678', 'pedidos@lahuerta.co'),
  ('Licores y Bebidas Ltda.',   '900345678-3', 'Andres Pena',   '3123456789', 'contacto@licoresyb.co'),
  ('Panaderia El Trigal',       '900456789-4', 'Clara Ospina',  '3134567890', 'trigal@panaderia.co');
