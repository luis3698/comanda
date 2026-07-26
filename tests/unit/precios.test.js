/**
 * Pruebas del servicio de precios.
 *
 * Cubre la regla del FSD 5.3 ("variante aplicable > precio base") y la
 * deteccion de solapes. Es la base de CA-04, asi que se prueba en aislado
 * antes de que el comandero dependa de ella.
 *
 * Ejecutar:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  varianteAplica, resolverPrecio, detectarSolapes, variantesSeSolapan,
} from '../../server/servicios/precios.js';

const PRODUCTO = { precio_base: '22000.00', tasa_impuesto: '8.00' };

/** Un lunes a las 15:30. */
const LUNES_1530 = new Date(2026, 6, 13, 15, 30);
/** Un lunes a las 20:00. */
const LUNES_2000 = new Date(2026, 6, 13, 20, 0);
/** Un sabado a las 15:30. */
const SABADO_1530 = new Date(2026, 6, 18, 15, 30);

const HAPPY_HOUR = {
  id_precio: 1,
  nombre: 'Happy hour',
  precio: '15000.00',
  hora_inicio: '14:00:00',
  hora_fin: '18:00:00',
  fecha_inicio: null,
  fecha_fin: null,
  dias_semana: 'L,M,X,J,V',
  activo: true,
};

/* ---------------------------------------------------------------
   Resolucion de precio
   --------------------------------------------------------------- */

test('sin variantes se cobra el precio base', () => {
  const r = resolverPrecio(PRODUCTO, [], LUNES_1530);
  assert.equal(r.precio, '22000.00');
  assert.equal(r.idPrecio, null);
});

test('dentro de la ventana de happy hour se cobra la variante', () => {
  const r = resolverPrecio(PRODUCTO, [HAPPY_HOUR], LUNES_1530);
  assert.equal(r.precio, '15000.00');
  assert.equal(r.nombre, 'Happy hour');
});

test('fuera del horario se vuelve al precio base', () => {
  const r = resolverPrecio(PRODUCTO, [HAPPY_HOUR], LUNES_2000);
  assert.equal(r.precio, '22000.00');
});

test('el sabado no aplica una variante de lunes a viernes', () => {
  const r = resolverPrecio(PRODUCTO, [HAPPY_HOUR], SABADO_1530);
  assert.equal(r.precio, '22000.00');
});

test('el limite inferior de la ventana entra y el superior no', () => {
  const alas14 = new Date(2026, 6, 13, 14, 0);
  const alas18 = new Date(2026, 6, 13, 18, 0);
  assert.equal(varianteAplica(HAPPY_HOUR, alas14), true, '14:00 debe entrar');
  assert.equal(varianteAplica(HAPPY_HOUR, alas18), false, '18:00 ya no debe entrar');
});

test('una variante inactiva se ignora', () => {
  const r = resolverPrecio(PRODUCTO, [{ ...HAPPY_HOUR, activo: false }], LUNES_1530);
  assert.equal(r.precio, '22000.00');
});

test('una variante sin restricciones aplica siempre', () => {
  const temporada = {
    id_precio: 2, nombre: 'Temporada alta', precio: '26000.00',
    hora_inicio: null, hora_fin: null, fecha_inicio: null, fecha_fin: null,
    dias_semana: null, activo: true,
  };
  assert.equal(resolverPrecio(PRODUCTO, [temporada], LUNES_2000).precio, '26000.00');
  assert.equal(resolverPrecio(PRODUCTO, [temporada], SABADO_1530).precio, '26000.00');
});

test('la vigencia por fechas se respeta', () => {
  const navidad = {
    id_precio: 3, nombre: 'Navidad', precio: '30000.00',
    hora_inicio: null, hora_fin: null,
    fecha_inicio: '2026-12-20', fecha_fin: '2026-12-31',
    dias_semana: null, activo: true,
  };
  assert.equal(varianteAplica(navidad, new Date(2026, 11, 25, 12, 0)), true);
  assert.equal(varianteAplica(navidad, new Date(2026, 11, 19, 12, 0)), false);
  assert.equal(varianteAplica(navidad, new Date(2027, 0, 1, 12, 0)), false);
});

test('una ventana que cruza medianoche cubre ambos lados', () => {
  const trasnoche = {
    id_precio: 4, nombre: 'Trasnoche', precio: '18000.00',
    hora_inicio: '22:00:00', hora_fin: '02:00:00',
    fecha_inicio: null, fecha_fin: null, dias_semana: null, activo: true,
  };
  assert.equal(varianteAplica(trasnoche, new Date(2026, 6, 13, 23, 0)), true, '23:00 entra');
  assert.equal(varianteAplica(trasnoche, new Date(2026, 6, 13, 1, 0)), true, '01:00 entra');
  assert.equal(varianteAplica(trasnoche, new Date(2026, 6, 13, 12, 0)), false, '12:00 no entra');
});

test('entre dos variantes aplicables gana la mas especifica', () => {
  const general = {
    id_precio: 5, nombre: 'General', precio: '20000.00',
    hora_inicio: null, hora_fin: null, fecha_inicio: null, fecha_fin: null,
    dias_semana: null, activo: true,
  };
  // Happy hour restringe por hora y por dias: es mas especifica.
  const r = resolverPrecio(PRODUCTO, [general, HAPPY_HOUR], LUNES_1530);
  assert.equal(r.nombre, 'Happy hour');
});

/* ---------------------------------------------------------------
   Deteccion de solapes (FSD 5.3)
   --------------------------------------------------------------- */

test('dos ventanas horarias que se pisan son un solape', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1, hora_inicio: '14:00:00', hora_fin: '18:00:00' };
  const b = { ...HAPPY_HOUR, id_precio: 2, hora_inicio: '17:00:00', hora_fin: '20:00:00' };
  assert.equal(variantesSeSolapan(a, b), true);
  assert.equal(detectarSolapes([a, b]).length, 1);
});

test('ventanas horarias contiguas no se solapan', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1, hora_inicio: '14:00:00', hora_fin: '18:00:00' };
  const b = { ...HAPPY_HOUR, id_precio: 2, hora_inicio: '18:00:00', hora_fin: '22:00:00' };
  assert.equal(variantesSeSolapan(a, b), false);
  assert.equal(detectarSolapes([a, b]).length, 0);
});

test('la misma franja en dias distintos no se solapa', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1, dias_semana: 'L,M,X' };
  const b = { ...HAPPY_HOUR, id_precio: 2, dias_semana: 'J,V' };
  assert.equal(variantesSeSolapan(a, b), false);
});

test('la misma franja compartiendo un dia si se solapa', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1, dias_semana: 'L,M,X' };
  const b = { ...HAPPY_HOUR, id_precio: 2, dias_semana: 'X,J,V' };
  assert.equal(variantesSeSolapan(a, b), true, 'comparten el miercoles');
});

test('la misma franja en temporadas distintas no se solapa', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1, fecha_inicio: '2026-01-01', fecha_fin: '2026-06-30' };
  const b = { ...HAPPY_HOUR, id_precio: 2, fecha_inicio: '2026-07-01', fecha_fin: '2026-12-31' };
  assert.equal(variantesSeSolapan(a, b), false);
});

test('una variante sin restricciones choca con cualquier otra', () => {
  const libre = {
    id_precio: 9, nombre: 'Libre', precio: '1.00',
    hora_inicio: null, hora_fin: null, fecha_inicio: null, fecha_fin: null,
    dias_semana: null, activo: true,
  };
  assert.equal(variantesSeSolapan(libre, HAPPY_HOUR), true);
});

test('una variante inactiva no genera conflicto', () => {
  const a = { ...HAPPY_HOUR, id_precio: 1 };
  const b = { ...HAPPY_HOUR, id_precio: 2, activo: false };
  assert.equal(detectarSolapes([a, b]).length, 0);
});
