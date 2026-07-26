/**
 * Aritmética monetaria en centavos (enteros).
 *
 * FSD 5.7: "Cálculo en servidor: subtotal − descuento + impuestos + propina =
 * total; los totales del cliente son solo informativos."
 * CA-05: "Es imposible cerrar una factura si la suma de pagos difiere del total."
 *
 * POR QUÉ CENTAVOS Y NO DECIMALES DE JS
 * 0.1 + 0.2 en coma flotante da 0.30000000000000004. En una factura suelta no
 * se nota; sumado sobre cientos de pagos al día, el arqueo de caja no cuadra
 * por unos centavos y nadie sabe por qué. La única forma segura de sumar dinero
 * es en enteros: se trabaja en centavos y solo se convierte a decimal para
 * mostrar o para guardar en las columnas DECIMAL de la base.
 *
 * mysql2 devuelve los DECIMAL como string, así que aquí entran como string y
 * se parsean a entero de centavos sin pasar nunca por Number con decimales.
 */

/**
 * Convierte un importe (string '12345.67' o número) a centavos enteros.
 * Redondea al centavo más cercano.
 */
export function aCentavos(valor) {
  if (valor == null || valor === '') return 0;

  const texto = String(valor).trim();
  const negativo = texto.startsWith('-');
  const limpio = texto.replace(/[^\d.]/g, '');

  const [entero = '0', decimal = ''] = limpio.split('.');
  // Se toman exactamente dos decimales, rellenando o redondeando el tercero.
  const centavosDecimal = (decimal + '00').slice(0, 2);
  const tercero = decimal.charAt(2);

  let total = Number(entero) * 100 + Number(centavosDecimal);
  if (tercero && Number(tercero) >= 5) total += 1;   // redondeo del tercer decimal

  return negativo ? -total : total;
}

/** Convierte centavos enteros a string decimal 'XXXX.XX' para la base de datos. */
export function aDecimal(centavos) {
  const n = Math.trunc(centavos);
  const signo = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Calcula el total de una factura, todo en centavos.  FSD 5.7.
 *
 * @param {object} p
 * @param {number} p.subtotalCentavos    Suma de líneas antes de impuestos y descuento.
 * @param {number} p.descuentoCentavos   Descuento aplicado (>= 0).
 * @param {number} p.impuestosCentavos   Impuestos.
 * @param {number} p.propinaCentavos     Propina (>= 0).
 * @returns {number} total en centavos.
 */
export function calcularTotal({ subtotalCentavos, descuentoCentavos = 0, impuestosCentavos = 0, propinaCentavos = 0 }) {
  // subtotal − descuento + impuestos + propina, en el orden exacto del FSD.
  return subtotalCentavos - descuentoCentavos + impuestosCentavos + propinaCentavos;
}

/**
 * Impuesto de una línea sobre su base ya con descuento aplicado.
 * @param {number} baseCentavos  Base gravable en centavos.
 * @param {string|number} tasa   Porcentaje (p.ej. '8.00').
 */
export function impuestoDe(baseCentavos, tasa) {
  const puntos = aCentavos(tasa);   // 8.00% -> 800 (centésimas de punto)
  // baseCentavos * (tasa/100), redondeado al centavo.
  return Math.round((baseCentavos * puntos) / 10000);
}

/** Formatea centavos como moneda para mensajes del servidor. */
export function formatear(centavos) {
  return `$${aDecimal(centavos)}`;
}
