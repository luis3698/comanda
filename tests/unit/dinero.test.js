/**
 * Pruebas de la aritmética monetaria en centavos.
 *
 * El punto: sumar dinero en coma flotante descuadra el arqueo. Estas pruebas
 * fijan que el paso por centavos enteros es exacto.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aCentavos, aDecimal, calcularTotal, impuestoDe, formatear } from '../../server/servicios/dinero.js';

test('aCentavos convierte strings de la base a enteros', () => {
  assert.equal(aCentavos('12345.67'), 1234567);
  assert.equal(aCentavos('0.00'), 0);
  assert.equal(aCentavos('8000.00'), 800000);
  assert.equal(aCentavos('0.05'), 5);
});

test('aCentavos maneja enteros sin decimales', () => {
  assert.equal(aCentavos('100'), 10000);
  assert.equal(aCentavos(100), 10000);
});

test('aCentavos redondea el tercer decimal', () => {
  assert.equal(aCentavos('10.005'), 1001, 'redondea hacia arriba');
  assert.equal(aCentavos('10.004'), 1000, 'redondea hacia abajo');
});

test('aDecimal es la inversa exacta de aCentavos', () => {
  for (const v of ['0.00', '1.00', '12345.67', '999999.99', '0.05']) {
    assert.equal(aDecimal(aCentavos(v)), v);
  }
});

test('aDecimal rellena los centavos con cero', () => {
  assert.equal(aDecimal(1000), '10.00');
  assert.equal(aDecimal(1005), '10.05');
  assert.equal(aDecimal(5), '0.05');
});

test('el caso clásico 0.1 + 0.2 es exacto en centavos', () => {
  // En coma flotante esto daría 0.30000000000000004.
  const suma = aCentavos('0.1') + aCentavos('0.2');
  assert.equal(aDecimal(suma), '0.30');
});

test('calcularTotal aplica subtotal − descuento + impuestos + propina', () => {
  const total = calcularTotal({
    subtotalCentavos: 100000,   // 1000.00
    descuentoCentavos: 10000,   //  100.00
    impuestosCentavos: 7200,    //   72.00
    propinaCentavos: 5000,      //   50.00
  });
  // 1000 − 100 + 72 + 50 = 1022.00
  assert.equal(aDecimal(total), '1022.00');
});

test('impuestoDe calcula el porcentaje sobre la base', () => {
  assert.equal(aDecimal(impuestoDe(100000, '8.00')), '80.00');   // 8% de 1000
  assert.equal(aDecimal(impuestoDe(100000, '19.00')), '190.00'); // 19% de 1000
  assert.equal(aDecimal(impuestoDe(100000, '0.00')), '0.00');
});

test('impuestoDe redondea al centavo', () => {
  // 8% de 12.50 = 1.00 exacto; 8% de 12.55 = 1.004 -> 1.00
  assert.equal(aDecimal(impuestoDe(1250, '8.00')), '1.00');
  assert.equal(aDecimal(impuestoDe(1255, '8.00')), '1.00');
});

test('una suma de muchas líneas pequeñas no acumula error', () => {
  // 1000 líneas de 0.07 = 70.00 exacto. En flotante iría derivando.
  let total = 0;
  for (let i = 0; i < 1000; i++) total += aCentavos('0.07');
  assert.equal(aDecimal(total), '70.00');
});

test('formatear muestra el símbolo de moneda', () => {
  assert.equal(formatear(1234567), '$12345.67');
  assert.equal(formatear(-500), '$-5.00');
});
