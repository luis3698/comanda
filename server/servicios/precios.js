/**
 * Resolucion de precios y validacion de variantes.
 *
 * FSD 5.3:
 *  - "Resolucion de precio en venta: variante activa aplicable (hora/dia/fecha)
 *     > precio base. El precio se congela en orden_detalle.precio_unitario."
 *  - "variantes de precio no pueden solapar ventanas horario/fecha para el
 *     mismo producto (validacion JS en el editor + verificacion en servidor)."
 *
 * CA-04: "El precio cobrado corresponde a la variante vigente en el momento del
 * envio y no cambia si el catalogo se edita despues."
 *
 * IMPORTES COMO STRING
 * mysql2 devuelve los DECIMAL como string a proposito: convertirlos a Number
 * pierde precision y descuadra la caja. Este modulo los trata como string y
 * nunca hace aritmetica de coma flotante con ellos.
 */
import { consultar } from '../db.js';

/**
 * Dias de la semana como los escribe el FSD 2.4.3: "L,M,X,J,V".
 * El indice coincide con Date.getDay() (0 = domingo).
 */
const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

export function letraDiaDe(fecha) {
  return DIAS[fecha.getDay()];
}

/** 'HH:MM:SS' -> minutos desde medianoche. */
function aMinutos(hora) {
  if (!hora) return null;
  const [h, m] = String(hora).split(':').map(Number);
  return h * 60 + m;
}

/** Convierte "L,M,X" en un conjunto. Vacio o nulo significa "todos los dias". */
function parsearDias(dias) {
  if (!dias || !String(dias).trim()) return null;
  return new Set(String(dias).split(',').map((d) => d.trim().toUpperCase()).filter(Boolean));
}

/** 'YYYY-MM-DD' de una fecha, en hora local. */
function aISO(fecha) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}`;
}

/**
 * Comprueba si una variante aplica en un momento dado.
 *
 * Una ventana tiene tres filtros y todos son opcionales; los que esten vacios
 * no restringen. Una variante sin ningun filtro aplica siempre.
 *
 * @param {object} variante  Fila de producto_precio.
 * @param {Date} momento
 */
export function varianteAplica(variante, momento = new Date()) {
  if (!variante.activo) return false;

  // Vigencia por temporada.
  const hoy = aISO(momento);
  if (variante.fecha_inicio && hoy < String(variante.fecha_inicio).slice(0, 10)) return false;
  if (variante.fecha_fin && hoy > String(variante.fecha_fin).slice(0, 10)) return false;

  // Dias de la semana.
  const dias = parsearDias(variante.dias_semana);
  if (dias && !dias.has(letraDiaDe(momento))) return false;

  // Ventana horaria.
  const inicio = aMinutos(variante.hora_inicio);
  const fin = aMinutos(variante.hora_fin);
  if (inicio !== null && fin !== null) {
    const ahora = momento.getHours() * 60 + momento.getMinutes();
    if (inicio <= fin) {
      // Ventana normal: 14:00-18:00
      if (ahora < inicio || ahora >= fin) return false;
    } else {
      // Ventana que cruza medianoche: 22:00-02:00
      if (ahora < inicio && ahora >= fin) return false;
    }
  }

  return true;
}

/**
 * Precio vigente de un producto.
 *
 * Regla del FSD 5.3: variante aplicable > precio base. Si varias variantes
 * aplican (no deberia: el solape se valida al guardar), gana la mas especifica
 * -- la que restringe por mas criterios -- y a igualdad, la mas reciente.
 *
 * @returns {{precio: string, idPrecio: number|null, nombre: string, tasaImpuesto: string}}
 */
export function resolverPrecio(producto, variantes, momento = new Date()) {
  const aplicables = (variantes ?? []).filter((v) => varianteAplica(v, momento));

  if (!aplicables.length) {
    return {
      precio: String(producto.precio_base),
      idPrecio: null,
      nombre: 'Precio base',
      tasaImpuesto: String(producto.tasa_impuesto),
    };
  }

  const especificidad = (v) =>
    (v.hora_inicio ? 1 : 0) + (v.dias_semana ? 1 : 0) + (v.fecha_inicio ? 1 : 0);

  aplicables.sort((a, b) => {
    const d = especificidad(b) - especificidad(a);
    return d !== 0 ? d : b.id_precio - a.id_precio;
  });

  const elegida = aplicables[0];
  return {
    precio: String(elegida.precio),
    idPrecio: elegida.id_precio,
    nombre: elegida.nombre,
    tasaImpuesto: String(producto.tasa_impuesto),
  };
}

/**
 * Precio vigente de un producto consultando la base.
 * Lo usara el comandero al enviar la comanda (fase 3) para congelar el precio.
 */
export async function precioVigenteDe(idProducto, momento = new Date()) {
  const filas = await consultar(
    `SELECT p.id_producto, p.precio_base, p.tasa_impuesto,
            pp.id_precio, pp.nombre, pp.precio, pp.hora_inicio, pp.hora_fin,
            pp.fecha_inicio, pp.fecha_fin, pp.dias_semana, pp.activo
       FROM producto p
       LEFT JOIN producto_precio pp ON pp.id_producto = p.id_producto AND pp.activo = TRUE
      WHERE p.id_producto = ?`,
    [idProducto]
  );
  if (!filas.length) return null;

  const producto = { precio_base: filas[0].precio_base, tasa_impuesto: filas[0].tasa_impuesto };
  const variantes = filas.filter((f) => f.id_precio !== null);
  return resolverPrecio(producto, variantes, momento);
}

/* =====================================================================
   Validacion de solapes
   ===================================================================== */

/** ¿Se pisan dos rangos de fechas? Un extremo nulo significa "sin limite". */
function fechasSeSolapan(a, b) {
  const iniA = a.fecha_inicio ? String(a.fecha_inicio).slice(0, 10) : null;
  const finA = a.fecha_fin ? String(a.fecha_fin).slice(0, 10) : null;
  const iniB = b.fecha_inicio ? String(b.fecha_inicio).slice(0, 10) : null;
  const finB = b.fecha_fin ? String(b.fecha_fin).slice(0, 10) : null;

  if (finA && iniB && finA < iniB) return false;
  if (finB && iniA && finB < iniA) return false;
  return true;
}

/** ¿Comparten al menos un dia? Nulo significa "todos los dias". */
function diasSeSolapan(a, b) {
  const dA = parsearDias(a.dias_semana);
  const dB = parsearDias(b.dias_semana);
  if (!dA || !dB) return true;
  for (const d of dA) if (dB.has(d)) return true;
  return false;
}

/** ¿Se pisan dos ventanas horarias? Nulo significa "todo el dia". */
function horasSeSolapan(a, b) {
  const iniA = aMinutos(a.hora_inicio);
  const finA = aMinutos(a.hora_fin);
  const iniB = aMinutos(b.hora_inicio);
  const finB = aMinutos(b.hora_fin);

  if (iniA === null || finA === null || iniB === null || finB === null) return true;

  // Una ventana que cruza medianoche se parte en dos para poder compararla.
  const tramos = (ini, fin) => (ini <= fin ? [[ini, fin]] : [[ini, 1440], [0, fin]]);

  for (const [i1, f1] of tramos(iniA, finA)) {
    for (const [i2, f2] of tramos(iniB, finB)) {
      if (i1 < f2 && i2 < f1) return true;
    }
  }
  return false;
}

/**
 * Dos variantes se solapan si coinciden en las TRES dimensiones a la vez.
 * Basta con que difieran en una para que puedan convivir: "L,M,X de 14 a 18" y
 * "J,V de 14 a 18" no chocan aunque compartan la franja horaria.
 */
export function variantesSeSolapan(a, b) {
  if (!a.activo || !b.activo) return false;
  return fechasSeSolapan(a, b) && diasSeSolapan(a, b) && horasSeSolapan(a, b);
}

/**
 * Busca solapes en un conjunto de variantes de un mismo producto.
 * FSD 5.3 lo exige en servidor, no solo en el editor.
 *
 * @returns {Array<{a: object, b: object}>} pares en conflicto
 */
export function detectarSolapes(variantes) {
  const activas = (variantes ?? []).filter((v) => v.activo !== false);
  const conflictos = [];

  for (let i = 0; i < activas.length; i++) {
    for (let j = i + 1; j < activas.length; j++) {
      if (variantesSeSolapan(activas[i], activas[j])) {
        conflictos.push({ a: activas[i], b: activas[j] });
      }
    }
  }
  return conflictos;
}

/**
 * Describe una ventana en lenguaje natural, para los mensajes de error.
 * FSD 6.3: los errores se explican "en lenguaje claro en espanol".
 */
export function describirVentana(v) {
  const partes = [];
  if (v.hora_inicio && v.hora_fin) {
    partes.push(`de ${String(v.hora_inicio).slice(0, 5)} a ${String(v.hora_fin).slice(0, 5)}`);
  }
  if (v.dias_semana) partes.push(`los días ${v.dias_semana}`);
  if (v.fecha_inicio || v.fecha_fin) {
    const i = v.fecha_inicio ? String(v.fecha_inicio).slice(0, 10) : 'siempre';
    const f = v.fecha_fin ? String(v.fecha_fin).slice(0, 10) : 'siempre';
    partes.push(`entre ${i} y ${f}`);
  }
  return partes.length ? partes.join(', ') : 'sin restricción (aplica siempre)';
}
