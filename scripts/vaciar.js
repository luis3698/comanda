/**
 * Vaciado de la base de datos para entornos de prueba.
 *
 *   node scripts/vaciar.js              muestra qué se borraría, sin borrar
 *   node scripts/vaciar.js --si         vacía la operación
 *   node scripts/vaciar.js --todo --si  vacía todo y vuelve a sembrar el catálogo
 *
 * POR QUÉ NO BORRA NADA SIN --si
 * Un vaciado no se deshace. Sin la confirmación explícita el script solo cuenta
 * filas y las enseña, para que se vea qué hay delante antes de perderlo. Cuesta
 * una tecla más y evita el "creía que esa base estaba vacía".
 *
 * POR QUÉ SE CONECTA COMO ROOT
 * El usuario de la aplicación no puede borrar facturas ni auditoría, y es a
 * propósito (db/04_privilegios.sql, FSD 6.5). Este script es una herramienta de
 * mantenimiento, no parte de la aplicación, así que usa la credencial de
 * administración de la base.
 *
 * LA CADENA DE HASHES DE LA AUDITORÍA
 * log_auditoria encadena el hash de cada registro con el anterior. Borrar
 * ALGUNAS filas rompe la cadena y la vista de auditoría reportaría manipulación
 * sobre registros que nadie tocó. Por eso solo se vacía ENTERA (en modo --todo):
 * sin filas, la cadena vuelve a empezar limpia desde su génesis.
 */
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OBJETIVO = process.env.DB_NAME || 'sigr';

const args = new Set(process.argv.slice(2));
const CONFIRMADO = args.has('--si');
const TODO = args.has('--todo');

/**
 * Tablas de la operación diaria, en el orden que imponen las claves foráneas:
 * lo que apunta se borra antes que aquello a lo que apunta.
 */
const OPERACION = [
  'pago',
  'factura_detalle',
  'factura',
  'movimiento_caja',
  'turno_caja',
  'orden_detalle_modificador',
  'orden_detalle',
  'orden',
  'mesa',
  'zona',
];

/**
 * Lo que además se lleva --todo: catálogo, recetario, compras y kárdex.
 * `sesion` entra aquí para que nadie siga navegando con una sesión que apunta a
 * un catálogo que ya no existe.
 */
const RESTO = [
  'sesion',
  'compra_detalle',
  'compra',
  'movimiento_inventario',
  'receta',
  'producto_grupo_modificador',
  'producto_precio',
  'modificador',
  'grupo_modificador',
  'producto',
  'categoria',
  'insumo',
  'proveedor',
  'motivo_descuento',
  'log_auditoria',
];

/** Nunca se tocan: sin ellas no se puede ni entrar a la aplicación. */
const INTOCABLES = ['rol', 'permiso', 'rol_permiso', 'usuario'];

/** Contadores que vuelven a empezar, para que los ids no arranquen en 47. */
const REINICIAR_ID = ['zona', 'mesa', 'orden', 'turno_caja', 'factura'];

function bandera(texto) {
  return `\n${'─'.repeat(66)}\n${texto}\n${'─'.repeat(66)}`;
}

/**
 * Trocea un archivo .sql en sentencias ejecutables.
 *
 * Los comentarios se quitan ANTES de partir por ";". Al revés no funciona: cada
 * trozo empieza por las líneas de comentario que preceden a su INSERT, y
 * descartar los trozos "que empiezan por --" se saltaba en silencio la mitad de
 * las inserciones. El síntoma era una violación de clave foránea varias tablas
 * más adelante, sin ninguna pista de dónde venía.
 *
 * Y SE DESCARTAN LOS "USE"
 * Los archivos de db/ empiezan con `USE sigr;` porque MySQL los carga sueltos al
 * crear el contenedor. Aquí la conexión ya apunta a la base correcta, que puede
 * NO ser `sigr`: si se dejara pasar ese USE, el script se saltaría a otra base a
 * mitad de trabajo y escribiría donde no debe. Pasó: sembró el catálogo de
 * ejemplo en la base real mientras creía estar en una desechable.
 */
function sentenciasDe(sql) {
  return sql
    .split('\n')
    .filter((linea) => !/^\s*--/.test(linea))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^USE\s/i.test(s));
}

const bd = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3307),
  user: 'root',
  password: process.env.DB_ROOT_PASSWORD || 'root_sigr_dev',
  database: OBJETIVO,
  multipleStatements: true,
});

try {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('NODE_ENV=production. Este script no se ejecuta contra una base en producción.');
    process.exit(1);
  }

  const tablas = TODO ? [...OPERACION, ...RESTO] : OPERACION;

  // Recuento previo: es lo único que se hace sin --si.
  const filas = [];
  let total = 0;
  for (const t of tablas) {
    const [[r]] = await bd.execute(`SELECT COUNT(*) AS n FROM \`${t}\``);
    filas.push([t, r.n]);
    total += r.n;
  }

  console.log(bandera(
    `Base "${process.env.DB_NAME || 'sigr'}" en ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3307}\n` +
    `Modo: ${TODO ? '--todo (operación + catálogo + auditoría)' : 'operación'}`
  ));

  for (const [t, n] of filas) {
    if (n > 0) console.log(`  ${String(n).padStart(7)}  ${t}`);
  }
  console.log(`  ${String(total).padStart(7)}  TOTAL`);
  console.log(`\n  Se conservan: ${INTOCABLES.join(', ')}` +
    (TODO ? '' : ', catálogo, insumos, recetas, proveedores y auditoría'));

  if (!CONFIRMADO) {
    console.log('\nNo se ha borrado nada. Añada --si para ejecutarlo de verdad:');
    console.log(`  node scripts/vaciar.js ${TODO ? '--todo ' : ''}--si\n`);
    process.exit(0);
  }

  if (total === 0 && !TODO) {
    console.log('\nYa estaba vacía. Nada que hacer.\n');
    process.exit(0);
  }

  console.log('\nVaciando…');

  // Borrado y resiembra van en LA MISMA transacción. Separarlos dejaba la base
  // vacía si la resiembra fallaba, y encima el mensaje de error afirmaba haber
  // deshecho lo que ya estaba confirmado.
  await bd.beginTransaction();

  for (const t of tablas) {
    const [r] = await bd.execute(`DELETE FROM \`${t}\``);
    if (r.affectedRows > 0) console.log(`  ${String(r.affectedRows).padStart(7)}  ${t}`);
  }

  // El consecutivo fiscal vuelve a cero solo si se borran las facturas que lo
  // gastaron; si no, dos facturas podrían acabar con el mismo número.
  await bd.execute("UPDATE secuencia SET valor = 0 WHERE nombre = 'factura_fiscal'");

  if (TODO) {
    console.log('\nSembrando de nuevo el catálogo de demostración (db/03_seed.sql)…');
    const seed = await readFile(path.join(RAIZ, 'db', '03_seed.sql'), 'utf8');

    for (const sql of sentenciasDe(seed)) {
      try {
        await bd.query(sql);
      } catch (e) {
        // Los usuarios no se borran, así que su INSERT del seed choca. Es lo
        // único que puede duplicarse aquí; cualquier otro error se propaga.
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    console.log('  catálogo restaurado');
  }

  // Red de seguridad antes de confirmar: si algo hubiera movido la conexión a
  // otra base, aquí se aborta y se deshace todo en vez de dejar los cambios
  // repartidos entre dos bases de datos.
  const [[donde]] = await bd.query('SELECT DATABASE() AS bd');
  if (donde.bd !== OBJETIVO) {
    throw new Error(`la conexión acabó en "${donde.bd}" y no en "${OBJETIVO}"`);
  }

  await bd.commit();

  // Los AUTO_INCREMENT van al final y fuera de la transacción: ALTER TABLE hace
  // commit implícito en MySQL y dentro la habría cerrado a medias.
  for (const t of REINICIAR_ID) {
    await bd.execute(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`);
  }

  console.log(bandera('Listo. El salón arranca en blanco: dibújelo en Administración → Salón.'));
} catch (error) {
  await bd.rollback().catch(() => {});
  console.error('\nFalló el vaciado. Se deshizo entero: la base queda como estaba.');
  console.error(`Motivo: ${error.message}`);
  process.exitCode = 1;
} finally {
  await bd.end();
}
