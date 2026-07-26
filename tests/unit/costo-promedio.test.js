/**
 * Pruebas del costo promedio ponderado.  RF-08.
 *
 * Este número alimenta el costo teórico de cada receta y los reportes de
 * rentabilidad. Un error aquí no rompe nada de forma visible: simplemente hace
 * que los márgenes mientan, y nadie lo nota hasta que se cierra el mes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { costoPromedioPonderado } from '../../server/servicios/compras.js';

test('sin stock previo, el promedio es el costo de la compra', () => {
  assert.equal(costoPromedioPonderado(0, 0, 100, '5.0000'), '5.0000');
});

test('comprando al mismo costo, el promedio no se mueve', () => {
  assert.equal(costoPromedioPonderado(100, '5.0000', 100, '5.0000'), '5.0000');
});

test('el promedio queda entre el costo viejo y el nuevo', () => {
  // 100 uds a $5 + 100 uds a $7 → 200 uds; promedio = (500 + 700)/200 = 6
  assert.equal(costoPromedioPonderado(100, '5.0000', 100, '7.0000'), '6.0000');
});

test('el promedio se pondera por cantidad, no es la media simple', () => {
  // 300 uds a $5 + 100 uds a $9 → (1500 + 900)/400 = 6, NO 7 (media simple)
  assert.equal(costoPromedioPonderado(300, '5.0000', 100, '9.0000'), '6.0000');
});

test('una compra pequeña casi no mueve un stock grande', () => {
  // 10000 uds a $2 + 1 ud a $100 → (20000 + 100)/10001 = 2.0098
  assert.equal(costoPromedioPonderado(10000, '2.0000', 1, '100.0000'), '2.0098');
});

test('funciona con los 4 decimales de la columna costo_promedio', () => {
  // Costos con decimales finos: 0.0450 (carne por gramo) mezclado con 0.0500
  const r = costoPromedioPonderado(50000, '0.0450', 50000, '0.0500');
  assert.equal(r, '0.0475');
});

test('funciona con los 3 decimales de las cantidades', () => {
  // 1.5 kg a $10 + 0.5 kg a $14 → (15 + 7)/2 = 11
  assert.equal(costoPromedioPonderado('1.500', '10.0000', '0.500', '14.0000'), '11.0000');
});

test('un stock previo negativo no rompe el cálculo', () => {
  // El stock puede quedar negativo (FSD 5.4). Al comprar, el promedio se
  // recalcula sobre el stock resultante, que aquí sí es positivo.
  // −50 a $4 + 150 a $6 → (−200 + 900)/100 = 7
  assert.equal(costoPromedioPonderado(-50, '4.0000', 150, '6.0000'), '7.0000');
});

test('si el stock resultante es cero o negativo, se conserva el costo de la compra', () => {
  // Caso patológico: sin existencias no hay promedio ponderado posible.
  assert.equal(costoPromedioPonderado(-100, '4.0000', 50, '6.0000'), '6.0000');
});

test('cifras grandes no pierden precisión (BigInt)', () => {
  // Un almacén con 1.000.000 de gramos a $0.05 recibe 500.000 a $0.08
  // → (50000 + 40000)/1500000 = 0.06
  assert.equal(costoPromedioPonderado(1000000, '0.0500', 500000, '0.0800'), '0.0600');
});

test('el redondeo va al diezmilésimo más cercano', () => {
  // 3 uds a $1 + 1 ud a $2 → 5/4 = 1.25 exacto
  assert.equal(costoPromedioPonderado(3, '1.0000', 1, '2.0000'), '1.2500');
  // 3 uds a $1 + 1 ud a $1.0001 → 4.0001/4 = 1.000025 → 1.0000
  assert.equal(costoPromedioPonderado(3, '1.0000', 1, '1.0001'), '1.0000');
});

test('compras sucesivas acumulan sin derivar', () => {
  // Diez compras de 100 uds a $10 sobre un stock inicial de 100 a $10:
  // el promedio debe seguir siendo exactamente 10.
  let stock = 100;
  let costo = '10.0000';
  for (let i = 0; i < 10; i++) {
    costo = costoPromedioPonderado(stock, costo, 100, '10.0000');
    stock += 100;
  }
  assert.equal(costo, '10.0000');
  assert.equal(stock, 1100);
});
