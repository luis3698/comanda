/**
 * Verificación de contraste WCAG 2.1 AA sobre la paleta del sistema.
 *
 * FSD 6.4: "Conformidad objetivo WCAG 2.1 nivel AA: contraste >= 4.5:1
 * (>= 7:1 en KDS)".
 *
 * El KDS pide 7:1 (que es nivel AAA) porque se lee a 1-2 metros de distancia,
 * de pie, con las manos ocupadas y en una cocina con vapor.
 *
 * Uso:  node scripts/contraste.mjs
 */

/** Convierte #rrggbb a [r,g,b]. */
function hexARgb(hex) {
  const h = hex.replace('#', '');
  const completo = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(completo.slice(i, i + 2), 16));
}

/** Luminancia relativa según WCAG 2.1. */
function luminancia(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste entre dos colores. */
function contraste(hex1, hex2) {
  const l1 = luminancia(hexARgb(hex1));
  const l2 = luminancia(hexARgb(hex2));
  const claro = Math.max(l1, l2);
  const oscuro = Math.min(l1, l2);
  return (claro + 0.05) / (oscuro + 0.05);
}

/* Paleta real del sistema (public/css/base.css y kds.css). */
const COMBINACIONES = [
  // [descripción, primer plano, fondo, mínimo exigido]
  ['Texto principal sobre superficie', '#0f172a', '#ffffff', 4.5],
  ['Texto principal sobre fondo', '#0f172a', '#f1f5f9', 4.5],
  ['Texto suave sobre superficie', '#475569', '#ffffff', 4.5],
  ['Texto tenue sobre superficie', '#5d6d84', '#ffffff', 4.5],
  ['Texto tenue sobre fondo', '#5d6d84', '#f1f5f9', 4.5],
  ['Botón primario (blanco sobre verde)', '#ffffff', '#0f766e', 4.5],
  ['Botón peligro (blanco sobre rojo)', '#ffffff', '#b91c1c', 4.5],
  ['Enlace/acento primario sobre superficie', '#0f766e', '#ffffff', 4.5],
  ['Insignia éxito', '#15803d', '#dcfce7', 4.5],
  ['Insignia alerta', '#b45309', '#fef3c7', 4.5],
  ['Insignia error', '#b91c1c', '#fee2e2', 4.5],
  ['Insignia info', '#1d4ed8', '#dbeafe', 4.5],
  ['Insignia neutra', '#475569', '#e2e8f0', 4.5],
  ['Precio del plato (primario fuerte)', '#115e59', '#ffffff', 4.5],
  ['Cabecera de tabla', '#5d6d84', '#f1f5f9', 4.5],
  ['Mesa libre (comandero)', '#15803d', '#dcfce7', 4.5],
  ['Mesa ocupada (comandero)', '#b91c1c', '#fee2e2', 4.5],
  ['Mesa pre-cuenta (comandero)', '#b45309', '#fef3c7', 4.5],

  // KDS: el FSD exige >= 7:1
  ['KDS texto sobre fondo oscuro', '#f8fafc', '#111111', 7],
  ['KDS texto secundario', '#cbd5e1', '#111111', 7],
  ['KDS superficie de tarjeta', '#f8fafc', '#1c1c1c', 7],
];

console.log('Verificación de contraste WCAG 2.1 AA (FSD 6.4)');
console.log('═'.repeat(74));
console.log('Combinación'.padEnd(42) + 'ratio'.padStart(9) + 'mínimo'.padStart(9) + '  estado');
console.log('─'.repeat(74));

let fallos = 0;
for (const [desc, fg, bg, minimo] of COMBINACIONES) {
  const r = contraste(fg, bg);
  const ok = r >= minimo;
  if (!ok) fallos++;
  console.log(
    desc.padEnd(42) +
    `${r.toFixed(2)}:1`.padStart(9) +
    `${minimo}:1`.padStart(9) +
    `  ${ok ? '✓' : '✗ FALLA'}`
  );
}

console.log('─'.repeat(74));
if (fallos === 0) {
  console.log(`✓ Las ${COMBINACIONES.length} combinaciones cumplen su mínimo.`);
} else {
  console.log(`✗ ${fallos} combinación(es) por debajo del mínimo exigido.`);
}
process.exit(fallos === 0 ? 0 : 1);
