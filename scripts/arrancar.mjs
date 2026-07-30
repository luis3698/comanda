/**
 * Arranca SIGR entero con un solo comando.
 *
 *   npm run arrancar                 la web, lista para usar
 *   npm run arrancar -- --movil      además compila e instala la app Android
 *   npm run arrancar -- --pruebas    y al final pasa la batería completa
 *   npm run arrancar -- --limpio     desde cero: borra la base y la recrea
 *   npm run arrancar -- --rapido     sin reconstruir la imagen
 *   npm run arrancar -- --local      base en Docker, servidor con node --watch
 *   npm run arrancar -- --parar      baja los contenedores
 *
 * POR QUÉ EXISTE
 * La secuencia de arranque estaba repartida entre el README y la cabeza de
 * quien ya la había hecho, y tenía trampas que no avisan:
 *
 *   · `docker compose` FALLA ENTERO si no existe .env, porque el servicio api
 *     lo declara en env_file. El mensaje habla de GetFileAttributesEx y no de
 *     copiar .env.example, así que el primer arranque en una máquina nueva se
 *     estrella antes de empezar.
 *   · El contenedor de MySQL dice "up" mucho antes de aceptar conexiones. Quien
 *     abra el navegador en ese hueco ve un error y cree que algo se rompió.
 *   · El entrypoint de MySQL ejecuta db/*.sql SOLO la primera vez que se crea
 *     el volumen. Cualquier archivo nuevo —el canal digital, los pagos, los
 *     índices— hay que aplicarlo a mano sobre una base que ya existe, y el
 *     síntoma de no hacerlo aparece días después: "no hay posiciones de
 *     domicilio configuradas" cuando un cajero acepta su primer pedido.
 *
 * Aquí cada paso se comprueba, y si falla se para diciendo qué hacer. Es el
 * mismo criterio de movil/arrancar.sh, que resolvió lo mismo para el lado
 * Android; este cubre el lado servidor y sabe llamar a aquel.
 *
 * POR QUÉ EN NODE Y NO EN BASH
 * El proyecto se desarrolla en Windows y se despliega en Linux. movil/
 * arrancar.sh necesita Git Bash, que no todo el mundo tiene abierto: en la
 * PowerShell que VS Code abre por defecto, `./arrancar.sh` no es nada. Node ya
 * es requisito del proyecto y corre igual en los dos sitios, así que este guion
 * funciona tal cual desde PowerShell, desde cmd y desde Git Bash.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// =====================================================================
// Presentación
// =====================================================================

// Colores solo si la salida es una terminal de verdad: redirigida a un archivo
// o leída por otro programa, los códigos de escape solo estorban.
const tty = process.stdout.isTTY;
const c = tty
  ? { rojo: '\x1b[31m', verde: '\x1b[32m', ambar: '\x1b[33m', gris: '\x1b[90m', negrita: '\x1b[1m', fin: '\x1b[0m' }
  : { rojo: '', verde: '', ambar: '', gris: '', negrita: '', fin: '' };

const paso = (t) => console.log(`\n${c.negrita}▶ ${t}${c.fin}`);
const bien = (t) => console.log(`  ${c.verde}✓${c.fin} ${t}`);
const aviso = (t) => console.log(`  ${c.ambar}!${c.fin} ${t}`);
const nota = (t) => console.log(`  ${c.gris}${t}${c.fin}`);

/** Todo error sale por aquí: qué pasó y, debajo, qué hacer. */
function morir(titulo, ...pistas) {
  console.error(`\n${c.rojo}${c.negrita}✗ ${titulo}${c.fin}`);
  for (const linea of pistas) console.error(`  ${linea}`);
  console.error('');
  process.exit(1);
}

// =====================================================================
// Ejecución de procesos
// =====================================================================

/**
 * ¿Hace falta pasar por el intérprete del sistema?
 *
 * Solo en Windows, y solo para lo que no es un .exe: `npm` allí es npm.cmd, y
 * desde Node 20 un .cmd no se puede lanzar sin shell (se cerró así CVE-2024-
 * 27980). docker.exe sí es un binario de verdad y se invoca directo.
 */
const necesitaShell = (cmd) => process.platform === 'win32' && cmd !== 'docker';

/**
 * Entrecomilla un argumento para la línea de comandos de Windows.
 *
 * Hace falta porque la ruta del proyecto puede tener espacios -- este mismo se
 * desarrolla en "F:\claude code\comanda" -- y sin comillas el intérprete parte
 * la ruta por el espacio: `bash F:\claude code\...\arrancar.sh` le pasa a bash
 * dos argumentos rotos y falla con un "no such file" que señala a un archivo
 * que sí existe.
 */
const entrecomillar = (a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Ejecuta un comando y devuelve { ok, salida }.
 *
 * Cuando toca usar shell se pasa UNA cadena ya entrecomillada en vez de la
 * lista de argumentos. No es un capricho de estilo: combinar `shell: true` con
 * un arreglo de argumentos está obsoleto desde Node 22 (DEP0190) precisamente
 * porque Node los concatena sin escapar, que es la puerta por la que se cuela
 * una inyección de comandos. Aquí todos los argumentos son constantes de este
 * archivo, pero se hace bien igual: el día que alguien meta una variable, la
 * forma correcta ya está puesta.
 */
function correr(cmd, args, { silencioso = true, entrada = null, cwd = RAIZ } = {}) {
  const shell = necesitaShell(cmd);
  const r = spawnSync(
    shell ? [cmd, ...args].map(entrecomillar).join(' ') : cmd,
    shell ? undefined : args,
    {
      cwd,
      input: entrada ?? undefined,
      encoding: 'utf8',
      shell,
      stdio: silencioso ? 'pipe' : 'inherit',
    }
  );
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, codigo: r.status, salida };
}

/** Igual, pero mostrando la salida en vivo. Para lo que tarda. */
function correrVisible(cmd, args, cwd = RAIZ) {
  return correr(cmd, args, { silencioso: false, cwd });
}

// =====================================================================
// Argumentos
// =====================================================================

const args = new Set(process.argv.slice(2));
const OPCIONES = {
  limpio: args.has('--limpio'),
  rapido: args.has('--rapido'),
  movil: args.has('--movil'),
  pruebas: args.has('--pruebas'),
  local: args.has('--local'),
  parar: args.has('--parar'),
  ayuda: args.has('--ayuda') || args.has('-h') || args.has('--help'),
  // Se reenvían tal cual a movil/arrancar.sh, que es quien las entiende.
  sinEmulador: args.has('--sin-emulador'),
  sinCompilar: args.has('--sin-compilar'),
};

const CONOCIDAS = new Set(['--limpio', '--rapido', '--movil', '--pruebas', '--local', '--parar',
  '--sin-emulador', '--sin-compilar', '--ayuda', '-h', '--help']);
const desconocida = [...args].find((a) => !CONOCIDAS.has(a));
if (desconocida) {
  morir(`No conozco la opción "${desconocida}".`, 'Vea las que hay con:', '', '    npm run arrancar -- --ayuda');
}

if (OPCIONES.ayuda) {
  console.log(`
${c.negrita}SIGR · arranque${c.fin}

  ${c.negrita}npm run arrancar${c.fin}                 Levanta la web y la deja lista
  ${c.negrita}npm run arrancar -- --rapido${c.fin}     Igual, sin reconstruir la imagen
  ${c.negrita}npm run arrancar -- --limpio${c.fin}     Desde cero: ${c.ambar}borra la base${c.fin} y la recrea
  ${c.negrita}npm run arrancar -- --movil${c.fin}      Además compila e instala la app Android
                                   ${c.gris}(cable, wifi o emulador; si no hay nada, lo arranca)${c.fin}
  ${c.negrita}   … --movil --sin-emulador${c.fin}      No arranca un emulador si no hay dispositivo
  ${c.negrita}   … --movil --sin-compilar${c.fin}      Solo reabre el puente; no toca el APK
  ${c.negrita}npm run arrancar -- --pruebas${c.fin}    Y al final pasa la batería completa
  ${c.negrita}npm run arrancar -- --local${c.fin}      Base en Docker, servidor con node --watch
  ${c.negrita}npm run arrancar -- --parar${c.fin}      Baja los contenedores (la base se conserva)

  Se pueden combinar:  npm run arrancar -- --limpio --pruebas
`);
  process.exit(0);
}

const URL_BASE = 'http://localhost:3000';
const URL_SALUD = `${URL_BASE}/api/v1/salud`;

// =====================================================================
// 0 · Parar, si es lo que se pide
// =====================================================================
if (OPCIONES.parar) {
  paso('Bajando los contenedores');
  const r = correrVisible('docker', ['compose', 'down']);
  if (!r.ok) morir('Docker no pudo bajar los contenedores.', 'Mire qué dice:', '', '    docker compose ps');
  bien('parados. La base se conserva en su volumen.');
  nota('Para borrarla también:  npm run arrancar -- --limpio');
  console.log('');
  process.exit(0);
}

// =====================================================================
// 1 · Herramientas y configuración
// =====================================================================
paso('Comprobando el entorno');

if (!correr('docker', ['--version']).ok) {
  morir('No encuentro Docker.', 'Instale Docker Desktop desde https://www.docker.com/products/docker-desktop/');
}

// `docker info` es lo que distingue "instalado" de "corriendo". Es el fallo
// número uno al empezar el día, y su mensaje nativo no lo dice tan claro.
if (!correr('docker', ['info']).ok) {
  morir('Docker está instalado pero el motor no responde.', 'Abra Docker Desktop y espere a que el icono deje de moverse.');
}
bien('docker');

const nodo = Number(process.versions.node.split('.')[0]);
if (nodo < 20) morir(`Node ${process.versions.node} es demasiado antiguo.`, 'El proyecto necesita Node 20 o superior.');
bien(`node ${process.versions.node}`);

// El .env que hace fallar a compose entero si no está.
const ENV = path.join(RAIZ, '.env');
const ENV_EJEMPLO = path.join(RAIZ, '.env.example');
if (!existsSync(ENV)) {
  if (!existsSync(ENV_EJEMPLO)) {
    morir('No hay .env ni .env.example.', 'El repositorio está incompleto: .env.example debería estar versionado.');
  }
  copyFileSync(ENV_EJEMPLO, ENV);
  bien('.env creado a partir de .env.example');
  nota('Los valores de fábrica sirven en local. Revíselo antes de exponer nada a internet.');
} else {
  bien('.env');
}

// =====================================================================
// 2 · Contenedores
// =====================================================================
if (OPCIONES.limpio) {
  paso('Borrando la base y empezando de cero');
  aviso('esto destruye el volumen: se pierden comandas, facturas y auditoría');
  correrVisible('docker', ['compose', 'down', '-v']);
  bien('volumen destruido; la base se recreará desde db/*.sql');
}

paso(OPCIONES.local ? 'Levantando solo la base de datos' : 'Levantando los contenedores');

const servicios = OPCIONES.local ? ['db'] : [];
const construir = OPCIONES.rapido || OPCIONES.local ? [] : ['--build'];
const arranque = correrVisible('docker', ['compose', 'up', '-d', ...construir, ...servicios]);

if (!arranque.ok) {
  morir(
    'Docker no pudo levantar los contenedores.',
    'Mire el detalle con:',
    '',
    '    docker compose logs --tail 40'
  );
}
bien('contenedores en marcha');

// =====================================================================
// 3 · Esperar a que responda de verdad
// =====================================================================

/** Pregunta por la sonda de salud. Devuelve el cuerpo, o null si no responde. */
async function consultarSalud() {
  try {
    const r = await fetch(URL_SALUD, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch {
    return null;
  }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera hasta que la sonda diga que la base está conectada.
 *
 * Se espera al ESTADO REAL y no un número fijo de segundos: en un portátil
 * templado son doce segundos y en un primer arranque que además construye la
 * imagen pueden ser dos minutos. Un `sleep 30` se queda corto justo el día que
 * importa, y sobra los otros cien.
 */
async function esperarSalud(segundos) {
  const limite = Date.now() + segundos * 1000;
  let puntos = 0;
  while (Date.now() < limite) {
    const salud = await consultarSalud();
    if (salud?.bd === 'conectada') {
      if (puntos) process.stdout.write('\n');
      return salud;
    }
    if (tty) { process.stdout.write('.'); puntos++; }
    await espera(2000);
  }
  if (puntos) process.stdout.write('\n');
  return null;
}

if (OPCIONES.local) {
  // Con --local la API la levanta el desarrollador; aquí solo se comprueba que
  // MySQL acepta conexiones, preguntándoselo al propio contenedor.
  paso('Esperando a MySQL');
  let listo = false;
  for (let i = 0; i < 60 && !listo; i++) {
    listo = correr('docker', ['exec', 'sigr_db', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot',
      `-p${process.env.DB_ROOT_PASSWORD || 'root_sigr_dev'}`]).ok;
    if (!listo) { if (tty) process.stdout.write('.'); await espera(2000); }
  }
  if (tty) process.stdout.write('\n');
  if (!listo) morir('MySQL no llegó a aceptar conexiones.', '    docker compose logs --tail 40 db');
  bien('MySQL acepta conexiones en localhost:3307');
} else {
  paso('Esperando a que el servidor responda');
  process.stdout.write('  ');
  const salud = await esperarSalud(180);
  if (!salud) {
    morir(
      'El servidor no respondió en tres minutos.',
      'Mire qué dice:',
      '',
      '    docker compose logs --tail 40 api',
      '    docker compose logs --tail 40 db'
    );
  }
  bien(`${URL_SALUD} → ${JSON.stringify(salud)}`);
}

// =====================================================================
// 4 · Migraciones incrementales
// =====================================================================
//
// El entrypoint de MySQL ejecuta db/*.sql solo al CREAR el volumen. Sobre una
// base que ya existe, un archivo nuevo no se aplica nunca y el fallo aparece
// tarde y sin relación aparente con la causa. Todos los de esta lista están
// escritos para poder reaplicarse (CREATE TABLE IF NOT EXISTS, INSERT IGNORE,
// y los ALTER envueltos en un procedimiento que comprueba antes), así que
// pasarlos siempre es barato y quita una clase entera de problemas.
paso('Poniendo la base al día');

const INCREMENTALES = [
  ['05_movil.sql', 'canal digital: clientes, reservas, domicilios y cobertura'],
  ['06_pagos.sql', 'métodos de pago de la app y verificación de comprobantes'],
  ['07_rendimiento.sql', 'índices de las consultas calientes'],
  ['08_promocion_push.sql', 'promociones: bandeja y push contados por separado'],
  ['09_borrar_avisos.sql', 'el cliente puede borrar sus propios avisos'],
];

for (const [archivo, para] of INCREMENTALES) {
  const ruta = path.join(RAIZ, 'db', archivo);
  if (!existsSync(ruta)) { aviso(`${archivo} no está: se salta`); continue; }

  const sql = readFileSync(ruta, 'utf8');
  const r = correr('docker', [
    'exec', '-i', 'sigr_db',
    'mysql', '-uroot', `-p${process.env.DB_ROOT_PASSWORD || 'root_sigr_dev'}`,
    process.env.DB_NAME || 'sigr',
  ], { entrada: sql });

  // mysql avisa por stderr de que la contraseña va en la línea de comandos.
  // Es cierto, y aquí da igual: es la credencial de desarrollo del contenedor
  // local. Lo que no puede es confundirse con un error de verdad.
  const problema = r.salida
    .split('\n')
    .filter((l) => l.trim() && !l.includes('Using a password on the command line'))
    .join('\n');

  if (!r.ok) {
    morir(`Falló al aplicar db/${archivo}.`, problema || '(sin detalle)');
  }
  bien(`${archivo} — ${para}`);
}

// =====================================================================
// 5 · Servidor local, si se pidió
// =====================================================================
if (OPCIONES.local) {
  paso('Arrancando el servidor con recarga automática');

  if (!existsSync(path.join(RAIZ, 'node_modules'))) {
    nota('instalando dependencias (solo la primera vez)…');
    if (!correrVisible('npm', ['install']).ok) morir('npm install falló.');
  }

  console.log('');
  console.log(`  ${c.verde}${c.negrita}Todo listo.${c.fin}  El servidor arranca aquí abajo; Ctrl+C lo para.`);
  console.log(`  Web: ${c.negrita}${URL_BASE}${c.fin}`);
  console.log('');

  // Se cede el control: a partir de aquí manda `node --watch`, y su salida es
  // lo que el desarrollador quiere ver en esta terminal.
  const shell = necesitaShell('npm');
  const hijo = spawn(
    shell ? 'npm run dev' : 'npm',
    shell ? undefined : ['run', 'dev'],
    { cwd: RAIZ, stdio: 'inherit', shell }
  );
  hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
} else {
  // =====================================================================
  // 6 · Estado del canal digital
  // =====================================================================
  //
  // Si el interruptor está apagado, la app del comensal muestra exactamente la
  // misma pantalla que si no hubiera red. Merece decirse aquí para que no se
  // confunda con un problema de conexión, que es lo que siempre se supone.
  try {
    const r = await fetch(`${URL_BASE}/api/v1/app/estado`, { signal: AbortSignal.timeout(3000) });
    const estado = await r.json();
    if (estado?.activa === false) {
      aviso('el canal digital está APAGADO (Admin → Canal digital → App móvil)');
      aviso('la app mostrará «No disponible ahora mismo» aunque todo lo demás vaya bien');
    }
  } catch { /* la sonda de salud ya pasó: esto es información extra, no un requisito */ }

  // El plano del salón arranca VACÍO a propósito: el de un restaurante no se
  // parece al de ningún otro, así que se dibuja desde cero. Quien entra por
  // primera vez no lo sabe, ve una pantalla en blanco y concluye que la
  // instalación quedó a medias. Se avisa solo cuando de verdad está vacío.
  //
  // Se descuentan las 30 posiciones de la zona virtual `Domicilios`, que son
  // andamiaje interno para anclar los pedidos de la app y no mesas de sala.
  let salonVacio = false;
  const conteo = correr('docker', [
    'exec', 'sigr_db', 'mysql', '-uroot', `-p${process.env.DB_ROOT_PASSWORD || 'root_sigr_dev'}`,
    '-N', '-B', process.env.DB_NAME || 'sigr', '-e',
    "SELECT COUNT(*) FROM mesa m JOIN zona z ON z.id_zona = m.id_zona WHERE z.nombre <> 'Domicilios'",
  ]);
  if (conteo.ok) {
    const n = Number(conteo.salida.split('\n').find((l) => /^\d+$/.test(l.trim())));
    salonVacio = Number.isInteger(n) && n === 0;
  }

  // =====================================================================
  // 7 · Móvil
  // =====================================================================
  if (OPCIONES.movil) {
    paso('Preparando la app del comensal');
    const guion = path.join(RAIZ, 'movil', 'arrancar.sh');
    if (!existsSync(guion)) {
      aviso('no encuentro movil/arrancar.sh: se salta el móvil');
    } else {
      // Se delega en el guion que ya sabe de adb, del JDK y de las trampas del
      // puente —cable, wifi y emulador se comportan distinto—, en vez de
      // duplicar aquí esa lógica. Necesita bash: en Windows lo trae Git, que ya
      // está instalado si el repositorio se clonó.
      const suyas = [
        ...(OPCIONES.sinEmulador ? ['--sin-emulador'] : []),
        ...(OPCIONES.sinCompilar ? ['--sin-compilar'] : []),
      ];
      const r = correrVisible('bash', [guion, ...suyas], path.join(RAIZ, 'movil'));
      if (!r.ok) {
        aviso('el arranque del móvil no terminó; la web sigue en pie');
        nota('para verlo con detalle:  cd movil && ./arrancar.sh');
      }
    }
  }

  // =====================================================================
  // 8 · Pruebas
  // =====================================================================
  if (OPCIONES.pruebas) {
    paso('Pasando la batería de pruebas');

    if (!existsSync(path.join(RAIZ, 'node_modules'))) {
      nota('instalando dependencias (las pruebas corren fuera del contenedor)…');
      if (!correrVisible('npm', ['install']).ok) morir('npm install falló.');
    }

    // Orden deliberado: primero las que no necesitan servidor, para que un
    // fallo de lógica salga antes que uno de integración y sea más fácil de
    // situar. test:carga NO entra: tarda y mide, no verifica.
    const baterias = [
      ['test', 'unitarias y de aceptación'],
      ['test:e2e', 'casos de uso del FSD cap. 7'],
      ['test:seguridad', 'superficie de ataque'],
    ];

    const fallidas = [];
    for (const [guion, que] of baterias) {
      console.log(`\n  ${c.gris}── ${que} ──${c.fin}`);
      if (!correrVisible('npm', ['run', guion]).ok) fallidas.push(guion);
    }

    if (fallidas.length) {
      morir(
        `Fallaron ${fallidas.length} de ${baterias.length} baterías: ${fallidas.join(', ')}.`,
        'El sistema está levantado; puede repetir solo la que falló:',
        '',
        `    npm run ${fallidas[0]}`
      );
    }
    bien('todas las pruebas pasan');
  }

  // =====================================================================
  // 9 · Resumen
  // =====================================================================
  console.log('');
  console.log(`${c.verde}${c.negrita}Todo listo.${c.fin}`);
  console.log('');
  console.log(`  ${c.negrita}Entrar${c.fin}          ${URL_BASE}`);
  console.log(`  ${c.gris}Administración  ${URL_BASE}/admin/${c.fin}`);
  console.log(`  ${c.gris}Comandero       ${URL_BASE}/comandero/${c.fin}`);
  console.log(`  ${c.gris}Cocina y barra  ${URL_BASE}/kds/${c.fin}`);
  console.log(`  ${c.gris}Caja            ${URL_BASE}/caja/${c.fin}`);
  console.log('');
  console.log(`  ${c.negrita}Acceso de demostración${c.fin}   ${c.gris}(db/03_seed.sql — nunca en producción)${c.fin}`);
  console.log(`  ${c.gris}Escritorio  admin@sigr.local / Admin123!${c.fin}`);
  console.log(`  ${c.gris}Tablet      documento CC1001 / PIN 1111${c.fin}`);
  console.log('');

  if (salonVacio) {
    console.log(`  ${c.ambar}${c.negrita}El salón está vacío, y es a propósito.${c.fin}`);
    console.log(`  ${c.gris}Sin mesas no hay nada que comandar, así que el primer paso es dibujarlo:${c.fin}`);
    console.log(`  ${c.gris}Administración → Salón → crear una zona → arrastrar mesas → Guardar distribución${c.fin}`);
    console.log('');
  }
  console.log(`  ${c.gris}Ver los registros    docker compose logs -f api${c.fin}`);
  console.log(`  ${c.gris}Tras tocar server/   npm run arrancar${c.fin}`);
  console.log(`  ${c.gris}Parar                npm run parar${c.fin}`);
  console.log('');
}
