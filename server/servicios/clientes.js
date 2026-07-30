/**
 * Cuentas de los clientes de la aplicacion movil.
 *
 * Registro, autenticacion, perfil y baja. Es el equivalente de
 * `rutas/usuarios.js` + `rutas/auth.js`, pero para el comensal, y con dos
 * diferencias de fondo:
 *
 *  1. NO HAY AUDITORIA. `log_auditoria.id_usuario` es una clave foranea a
 *     `usuario`, y un cliente no esta en esa tabla. Auditar sus acciones
 *     exigiria cambiar el esquema de una tabla que el FSD declara inmutable y
 *     de solo insercion. Las acciones del PERSONAL sobre reservas y pedidos si
 *     se auditan, que es donde esta el riesgo real (aceptar, rechazar, cobrar).
 *
 *  2. LA CUENTA LA CREA EL PROPIO CLIENTE. En el backoffice, un administrador
 *     da de alta a los empleados. Aqui el alta es publica, asi que el endpoint
 *     esta detras de un limite por IP (`middleware/limite.js`) y se valida todo
 *     en servidor sin excepcion.
 */
import bcrypt from 'bcryptjs';
import { consultar, consultarUno, pool, transaccion } from '../db.js';
import { errores } from '../middleware/errores.js';
import { destruirSesionesDeCliente } from '../middleware/authCliente.js';
import { borrarImagen } from './imagenes.js';

const COSTO_BCRYPT = Number(process.env.BCRYPT_COSTO || 12);   // FSD 6.1: >= 12
const MAX_INTENTOS = 5;          // FSD 5.1
const BLOQUEO_MINUTOS = 15;      // FSD 5.1

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Cedula colombiana y documentos equivalentes: solo digitos, 5 a 15. Se
// normaliza quitando puntos y espacios antes de validar, porque la gente la
// escribe como "1.020.304.050".
const RE_DOCUMENTO = /^\d{5,15}$/;
// Telefono: digitos, espacios, guiones, parentesis y un + inicial opcional.
const RE_TELEFONO = /^\+?[\d\s\-()]{7,20}$/;

/** Quita puntos, espacios y guiones de un documento. */
export function normalizarDocumento(valor) {
  return String(valor ?? '').replace(/[.\s-]/g, '');
}

/**
 * Valida los datos de registro o de edicion.
 * Devuelve un objeto { campo: mensaje }; vacio significa que todo esta bien.
 * El cliente movil pinta cada mensaje bajo su campo, igual que hace la web.
 */
export function validarCliente(datos, { esNuevo }) {
  const fallos = {};
  const { nombreCompleto, correo, telefono, documento, password } = datos;

  if (esNuevo || nombreCompleto != null) {
    if (!nombreCompleto || String(nombreCompleto).trim().length < 3) {
      fallos.nombreCompleto = 'Indique su nombre completo (minimo 3 caracteres).';
    } else if (String(nombreCompleto).trim().length > 120) {
      fallos.nombreCompleto = 'El nombre no puede superar 120 caracteres.';
    }
  }

  if (esNuevo || correo != null) {
    if (!correo || !RE_CORREO.test(String(correo).trim())) {
      fallos.correo = 'El correo no tiene un formato valido.';
    }
  }

  if (esNuevo || telefono != null) {
    if (!telefono || !RE_TELEFONO.test(String(telefono).trim())) {
      fallos.telefono = 'Indique un telefono valido.';
    }
  }

  // El documento solo se valida al crear: despues no se puede cambiar. Es el
  // dato que identifica a la persona en la factura; permitir editarlo dejaria
  // el historico de pedidos apuntando a alguien distinto.
  if (esNuevo) {
    if (!RE_DOCUMENTO.test(normalizarDocumento(documento))) {
      fallos.documento = 'La cedula debe tener entre 5 y 15 digitos.';
    }
  }

  if (esNuevo || password != null) {
    if (!password || String(password).length < 8) {
      fallos.password = 'La contrasena debe tener al menos 8 caracteres.';
    } else if (String(password).length > 100) {
      // bcrypt trunca en 72 bytes; un limite explicito evita la sorpresa de
      // que dos contrasenas larguisimas distintas sean equivalentes.
      fallos.password = 'La contrasena no puede superar 100 caracteres.';
    }
  }

  return fallos;
}

/** Forma con la que se devuelve un cliente a la aplicacion. */
function comoDto(fila) {
  return {
    id: fila.id_cliente,
    documento: fila.documento,
    nombre: fila.nombre_completo,
    correo: fila.correo,
    telefono: fila.telefono,
    urlFoto: fila.url_foto,
    aceptaPromociones: Boolean(fila.acepta_promociones),
    creadoEn: fila.creado_en,
  };
}

/**
 * Registra un cliente nuevo.
 *
 * Los choques de unicidad se comprueban ANTES de insertar para poder devolver
 * el campo concreto que falla ("ya hay una cuenta con ese correo") en vez del
 * 409 generico de ER_DUP_ENTRY, que no dice cual de los dos campos unicos
 * choco. La insercion sigue protegida por el indice: si dos registros
 * simultaneos pasan la comprobacion, el motor rechaza el segundo.
 */
export async function registrar({ nombreCompleto, correo, telefono, documento, password }) {
  const fallos = validarCliente(
    { nombreCompleto, correo, telefono, documento, password },
    { esNuevo: true }
  );
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const doc = normalizarDocumento(documento);
  const correoLimpio = String(correo).trim().toLowerCase();

  const choque = await consultarUno(
    'SELECT documento, correo FROM cliente WHERE documento = ? OR correo = ? LIMIT 1',
    [doc, correoLimpio]
  );
  if (choque) {
    const campos = {};
    if (choque.documento === doc) campos.documento = 'Ya existe una cuenta con esa cedula.';
    if (choque.correo === correoLimpio) campos.correo = 'Ya existe una cuenta con ese correo.';
    throw errores.conflicto('Ya existe una cuenta con esos datos.', { campos });
  }

  const hash = await bcrypt.hash(String(password), COSTO_BCRYPT);

  const [r] = await pool.execute(
    `INSERT INTO cliente (documento, nombre_completo, correo, telefono, hash_password)
     VALUES (?, ?, ?, ?, ?)`,
    [doc, String(nombreCompleto).trim(), correoLimpio, String(telefono).trim(), hash]
  );

  const fila = await consultarUno('SELECT * FROM cliente WHERE id_cliente = ?', [r.insertId]);
  return comoDto(fila);
}

/** SQL comun de las consultas de autenticacion. */
const SQL_CLIENTE_AUTH = `
  SELECT id_cliente, documento, nombre_completo, correo, telefono, url_foto,
         hash_password, activo, acepta_promociones, creado_en, intentos_fallidos,
         CASE WHEN bloqueado_hasta IS NULL OR bloqueado_hasta <= NOW() THEN NULL
              ELSE TIMESTAMPDIFF(MINUTE, NOW(), bloqueado_hasta) + 1 END AS minutos_bloqueo
    FROM cliente
`;

/** Suma un intento fallido y bloquea al llegar al tope. Devuelve el error a lanzar. */
async function registrarFallo(cliente) {
  const intentos = cliente.intentos_fallidos + 1;

  if (intentos >= MAX_INTENTOS) {
    await pool.execute(
      `UPDATE cliente
          SET intentos_fallidos = ?, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE id_cliente = ?`,
      [intentos, BLOQUEO_MINUTOS, cliente.id_cliente]
    );
    return errores.cuentaBloqueada(BLOQUEO_MINUTOS);
  }

  await pool.execute(
    'UPDATE cliente SET intentos_fallidos = ? WHERE id_cliente = ?',
    [intentos, cliente.id_cliente]
  );
  return errores.credencialesInvalidas();
}

/**
 * Verifica credenciales y devuelve el cliente.
 *
 * Acepta correo O cedula en el mismo campo `identificador`: en un movil,
 * obligar a elegir de antemano cual de los dos se va a escribir es una
 * friccion gratuita. Se distingue por la forma del valor.
 */
export async function autenticar({ identificador, password }) {
  if (!identificador || !password) {
    throw errores.peticionInvalida('Indique su correo o cedula y su contrasena.');
  }

  const texto = String(identificador).trim();
  const esCorreo = texto.includes('@');
  const cliente = esCorreo
    ? await consultarUno(`${SQL_CLIENTE_AUTH} WHERE correo = ?`, [texto.toLowerCase()])
    : await consultarUno(`${SQL_CLIENTE_AUTH} WHERE documento = ?`, [normalizarDocumento(texto)]);

  // Mismo mensaje exista o no la cuenta: si dijeramos "ese correo no esta
  // registrado", la pantalla de login se convertiria en un comprobador de
  // quien es cliente del restaurante.
  if (!cliente) throw errores.credencialesInvalidas();

  if (!cliente.activo) throw errores.cuentaInactiva();
  if (cliente.minutos_bloqueo !== null && Number(cliente.minutos_bloqueo) > 0) {
    throw errores.cuentaBloqueada(Math.max(1, Number(cliente.minutos_bloqueo)));
  }

  const correcto = await bcrypt.compare(String(password), cliente.hash_password);
  if (!correcto) throw await registrarFallo(cliente);

  await pool.execute(
    `UPDATE cliente SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = NOW()
      WHERE id_cliente = ?`,
    [cliente.id_cliente]
  );

  return comoDto(cliente);
}

/** Perfil completo del cliente. */
export async function perfil(idCliente) {
  const fila = await consultarUno(
    'SELECT * FROM cliente WHERE id_cliente = ? AND activo = TRUE',
    [idCliente]
  );
  if (!fila) throw errores.noEncontrado('La cuenta');
  return comoDto(fila);
}

/**
 * Actualiza los datos que el cliente SI puede cambiar por su cuenta.
 *
 * La cedula no esta aqui y no es un olvido: identifica a la persona en las
 * facturas ya emitidas. El correo y la contrasena tampoco, porque cambiarlos
 * exige confirmar la contrasena actual y tienen su propia funcion.
 */
export async function actualizarPerfil(idCliente, { nombreCompleto, telefono, aceptaPromociones }) {
  const fallos = validarCliente({ nombreCompleto, telefono }, { esNuevo: false });
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const cambios = [];
  const valores = [];
  if (nombreCompleto != null) { cambios.push('nombre_completo = ?'); valores.push(String(nombreCompleto).trim()); }
  if (telefono != null)       { cambios.push('telefono = ?');        valores.push(String(telefono).trim()); }
  if (aceptaPromociones != null) {
    cambios.push('acepta_promociones = ?');
    valores.push(aceptaPromociones === true || aceptaPromociones === 'true' ? 1 : 0);
  }

  if (!cambios.length) return perfil(idCliente);

  valores.push(idCliente);
  await pool.execute(`UPDATE cliente SET ${cambios.join(', ')} WHERE id_cliente = ?`, valores);

  return perfil(idCliente);
}

/** Comprueba la contrasena actual. Puerta de las operaciones sensibles. */
async function exigirPassword(idCliente, password) {
  if (!password) throw errores.peticionInvalida('Confirme su contrasena actual.');

  const fila = await consultarUno(
    'SELECT hash_password FROM cliente WHERE id_cliente = ? AND activo = TRUE',
    [idCliente]
  );
  if (!fila) throw errores.noEncontrado('La cuenta');

  const correcto = await bcrypt.compare(String(password), fila.hash_password);
  if (!correcto) {
    throw errores.peticionInvalida('La contrasena actual no es correcta.',
      { campos: { password: 'Contrasena incorrecta.' } });
  }
}

/**
 * Cambia el correo. Exige la contrasena actual: el correo es la via de
 * recuperacion de la cuenta, asi que quien pueda cambiarlo sin mas se queda
 * con la cuenta si encuentra un movil desbloqueado.
 */
export async function cambiarCorreo(idCliente, { correo, password }) {
  await exigirPassword(idCliente, password);

  const nuevo = String(correo ?? '').trim().toLowerCase();
  if (!RE_CORREO.test(nuevo)) {
    throw errores.peticionInvalida('El correo no tiene un formato valido.',
      { campos: { correo: 'El correo no tiene un formato valido.' } });
  }

  const ocupado = await consultarUno(
    'SELECT id_cliente FROM cliente WHERE correo = ? AND id_cliente <> ?',
    [nuevo, idCliente]
  );
  if (ocupado) {
    throw errores.conflicto('Ese correo ya esta en uso.',
      { campos: { correo: 'Ya existe una cuenta con ese correo.' } });
  }

  await pool.execute('UPDATE cliente SET correo = ? WHERE id_cliente = ?', [nuevo, idCliente]);
  return perfil(idCliente);
}

/**
 * Cambia la contrasena y CIERRA TODAS LAS SESIONES, incluida la que hizo el
 * cambio. Es lo que convierte el cambio de contrasena en una herramienta util
 * cuando alguien sospecha que le robaron la cuenta: si las demas sesiones
 * sobrevivieran, cambiarla no serviria de nada.
 */
export async function cambiarPassword(idCliente, { passwordActual, passwordNueva }) {
  await exigirPassword(idCliente, passwordActual);

  const fallos = validarCliente({ password: passwordNueva }, { esNuevo: false });
  if (fallos.password) {
    throw errores.peticionInvalida(fallos.password, { campos: { passwordNueva: fallos.password } });
  }

  const hash = await bcrypt.hash(String(passwordNueva), COSTO_BCRYPT);
  await pool.execute('UPDATE cliente SET hash_password = ? WHERE id_cliente = ?', [hash, idCliente]);
  await destruirSesionesDeCliente(idCliente);

  return { sesionesCerradas: true };
}

/** Cambia la foto de perfil y borra la anterior del disco. */
export async function cambiarFoto(idCliente, rutaPublica) {
  const fila = await consultarUno('SELECT url_foto FROM cliente WHERE id_cliente = ?', [idCliente]);
  if (!fila) throw errores.noEncontrado('La cuenta');

  await pool.execute('UPDATE cliente SET url_foto = ? WHERE id_cliente = ?', [rutaPublica, idCliente]);

  // La anterior se borra despues de que la nueva este guardada: si el borrado
  // falla queda un archivo huerfano, que es mucho mejor que quedarse sin foto.
  if (fila.url_foto && fila.url_foto !== rutaPublica) {
    await borrarImagen(fila.url_foto).catch(() => {});
  }

  return perfil(idCliente);
}

/**
 * Da de baja la cuenta: ANONIMIZA, no borra.
 *
 * Un DELETE fisico romperia las claves foraneas de reservas y pedidos ya
 * facturados, y violaria la regla de baja logica del FSD 2.4.1. Sobrescribir
 * el dato personal consigue las tres cosas a la vez:
 *   - el cliente deja de ser identificable, que es lo que pidio
 *   - el historico contable sigue cuadrando
 *   - la cedula y el correo reales quedan LIBRES, asi que esa misma persona
 *     puede volver a registrarse manana si quiere
 *
 * Los pedidos en curso se comprueban antes: dar de baja la cuenta con un
 * domicilio en camino dejaria al repartidor sin a quien llamar.
 */
export async function eliminarCuenta(idCliente, { password }) {
  await exigirPassword(idCliente, password);

  const enCurso = await consultarUno(
    `SELECT
       (SELECT COUNT(*) FROM pedido_domicilio
         WHERE id_cliente = ? AND estado IN ('pendiente','aceptado','en_preparacion','en_camino')) AS pedidos,
       (SELECT COUNT(*) FROM reserva
         WHERE id_cliente = ? AND estado IN ('pendiente','confirmada')) AS reservas`,
    [idCliente, idCliente]
  );

  if (Number(enCurso.pedidos) > 0) {
    throw errores.reglaDeNegocio(
      'Tiene pedidos en curso. Espere a que se entreguen o cancelelos antes de eliminar la cuenta.'
    );
  }
  if (Number(enCurso.reservas) > 0) {
    throw errores.reglaDeNegocio(
      'Tiene reservas activas. Cancelelas antes de eliminar la cuenta.'
    );
  }

  const fila = await consultarUno('SELECT url_foto FROM cliente WHERE id_cliente = ?', [idCliente]);

  await transaccion(async (cx) => {
    await cx.execute(
      `UPDATE cliente
          SET documento = ?, correo = ?, nombre_completo = 'Cuenta eliminada',
              telefono = '', url_foto = NULL, acepta_promociones = FALSE,
              activo = FALSE, eliminado_en = NOW(),
              hash_password = ?
        WHERE id_cliente = ?`,
      [
        `ELIMINADO-${idCliente}`,
        `eliminado-${idCliente}@borrado.local`,
        // Hash imposible de acertar: la fila deja de ser una cuenta con la que
        // se pueda entrar, aunque alguien conociera la contrasena anterior.
        '$2a$12$0000000000000000000000000000000000000000000000000000',
        idCliente,
      ]
    );
    // Las direcciones guardadas tambien son dato personal.
    await cx.execute('DELETE FROM direccion_cliente WHERE id_cliente = ?', [idCliente]);
    // Sin dispositivos no hay push: dejarlos vivos seguiria enviando
    // promociones a un movil de alguien que se dio de baja.
    await cx.execute('DELETE FROM dispositivo_cliente WHERE id_cliente = ?', [idCliente]);
    await cx.execute('DELETE FROM sesion_cliente WHERE id_cliente = ?', [idCliente]);
  });

  if (fila?.url_foto) await borrarImagen(fila.url_foto).catch(() => {});

  return { eliminada: true };
}

/* =====================================================================
   Direcciones de entrega
   ===================================================================== */

/** Direcciones activas del cliente, la predeterminada primero. */
export async function listarDirecciones(idCliente) {
  const filas = await consultar(
    `SELECT id_direccion, etiqueta, direccion, referencia, lat, lng, predeterminada
       FROM direccion_cliente
      WHERE id_cliente = ? AND activa = TRUE
      ORDER BY predeterminada DESC, id_direccion ASC`,
    [idCliente]
  );
  return filas.map((d) => ({
    id: d.id_direccion,
    etiqueta: d.etiqueta,
    direccion: d.direccion,
    referencia: d.referencia,
    lat: Number(d.lat),
    lng: Number(d.lng),
    predeterminada: Boolean(d.predeterminada),
  }));
}

/** Valida los campos de una direccion. */
function validarDireccion({ etiqueta, direccion, lat, lng }) {
  const fallos = {};
  if (!etiqueta || String(etiqueta).trim().length < 2) {
    fallos.etiqueta = 'Ponga un nombre a la direccion (por ejemplo "Casa").';
  }
  if (!direccion || String(direccion).trim().length < 5) {
    fallos.direccion = 'Escriba la direccion completa.';
  }
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || nLat < -90 || nLat > 90 ||
      !Number.isFinite(nLng) || nLng < -180 || nLng > 180) {
    fallos.ubicacion = 'Marque la ubicacion en el mapa.';
  }
  return fallos;
}

/**
 * Crea una direccion. Si es la primera del cliente, queda predeterminada sola:
 * pedirle que marque la casilla cuando solo tiene una direccion es ruido.
 */
export async function crearDireccion(idCliente, datos) {
  const fallos = validarDireccion(datos);
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  return transaccion(async (cx) => {
    const [previas] = await cx.execute(
      'SELECT COUNT(*) AS n FROM direccion_cliente WHERE id_cliente = ? AND activa = TRUE',
      [idCliente]
    );
    const esPrimera = Number(previas[0].n) === 0;
    const predeterminada = esPrimera || datos.predeterminada === true;

    if (predeterminada) {
      await cx.execute(
        'UPDATE direccion_cliente SET predeterminada = FALSE WHERE id_cliente = ?',
        [idCliente]
      );
    }

    const [r] = await cx.execute(
      `INSERT INTO direccion_cliente
         (id_cliente, etiqueta, direccion, referencia, lat, lng, predeterminada)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        idCliente,
        String(datos.etiqueta).trim().slice(0, 40),
        String(datos.direccion).trim().slice(0, 200),
        datos.referencia ? String(datos.referencia).trim().slice(0, 200) : null,
        Number(datos.lat),
        Number(datos.lng),
        predeterminada ? 1 : 0,
      ]
    );
    return { id: r.insertId };
  });
}

/** Actualiza una direccion del propio cliente. */
export async function actualizarDireccion(idCliente, idDireccion, datos) {
  const fallos = validarDireccion(datos);
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  return transaccion(async (cx) => {
    // El filtro por id_cliente es la autorizacion: sin el, cualquiera podria
    // editar la direccion de otro cambiando el id de la URL.
    const [filas] = await cx.execute(
      'SELECT id_direccion FROM direccion_cliente WHERE id_direccion = ? AND id_cliente = ? AND activa = TRUE',
      [idDireccion, idCliente]
    );
    if (!filas.length) throw errores.noEncontrado('La direccion');

    if (datos.predeterminada === true) {
      await cx.execute(
        'UPDATE direccion_cliente SET predeterminada = FALSE WHERE id_cliente = ?',
        [idCliente]
      );
    }

    await cx.execute(
      `UPDATE direccion_cliente
          SET etiqueta = ?, direccion = ?, referencia = ?, lat = ?, lng = ?,
              predeterminada = ?
        WHERE id_direccion = ? AND id_cliente = ?`,
      [
        String(datos.etiqueta).trim().slice(0, 40),
        String(datos.direccion).trim().slice(0, 200),
        datos.referencia ? String(datos.referencia).trim().slice(0, 200) : null,
        Number(datos.lat),
        Number(datos.lng),
        datos.predeterminada === true ? 1 : 0,
        idDireccion,
        idCliente,
      ]
    );
    return { id: idDireccion };
  });
}

/**
 * Retira una direccion (baja logica).
 *
 * No se borra fisicamente porque los pedidos ya despachados no la referencian
 * -- guardan una copia congelada -- pero el historial de la app la muestra, y
 * un DELETE dejaria huecos raros. Si era la predeterminada, se asciende otra:
 * quedarse sin ninguna obligaria al cliente a elegir en cada pedido.
 */
export async function borrarDireccion(idCliente, idDireccion) {
  return transaccion(async (cx) => {
    const [filas] = await cx.execute(
      'SELECT id_direccion, predeterminada FROM direccion_cliente WHERE id_direccion = ? AND id_cliente = ? AND activa = TRUE',
      [idDireccion, idCliente]
    );
    if (!filas.length) throw errores.noEncontrado('La direccion');

    await cx.execute(
      'UPDATE direccion_cliente SET activa = FALSE, predeterminada = FALSE WHERE id_direccion = ?',
      [idDireccion]
    );

    if (filas[0].predeterminada) {
      await cx.execute(
        `UPDATE direccion_cliente SET predeterminada = TRUE
          WHERE id_cliente = ? AND activa = TRUE
          ORDER BY id_direccion ASC LIMIT 1`,
        [idCliente]
      );
    }
    return { borrada: true };
  });
}

/* =====================================================================
   Consulta desde el backoffice
   ===================================================================== */

/**
 * Listado de clientes para el modulo Administrador (permiso clientes.ver).
 * Solo lectura: el personal no crea ni edita cuentas de clientes.
 */
export async function listarParaBackoffice({ buscar = '', pagina = 1, limite = 20 }) {
  const p = Math.max(1, Number(pagina) || 1);
  const l = Math.min(100, Math.max(1, Number(limite) || 20));
  const offset = (p - 1) * l;
  const patron = `%${String(buscar).trim()}%`;

  const filtro = `WHERE (? = '%%' OR nombre_completo LIKE ? OR correo LIKE ? OR documento LIKE ?)`;
  const params = [patron, patron, patron, patron];

  const total = await consultarUno(
    `SELECT COUNT(*) AS n FROM cliente ${filtro}`, params
  );

  // LIMIT/OFFSET interpolados porque MySQL no admite parametros ahi en
  // sentencias preparadas. Son enteros ya acotados arriba, no entrada cruda.
  const filas = await consultar(
    `SELECT id_cliente, documento, nombre_completo, correo, telefono, activo,
            ultimo_acceso, creado_en,
            (SELECT COUNT(*) FROM pedido_domicilio pd WHERE pd.id_cliente = cliente.id_cliente) AS pedidos,
            (SELECT COUNT(*) FROM reserva r WHERE r.id_cliente = cliente.id_cliente) AS reservas
       FROM cliente ${filtro}
      ORDER BY creado_en DESC
      LIMIT ${l} OFFSET ${offset}`,
    params
  );

  return {
    total: Number(total.n),
    pagina: p,
    limite: l,
    clientes: filas.map((c) => ({
      id: c.id_cliente,
      documento: c.documento,
      nombre: c.nombre_completo,
      correo: c.correo,
      telefono: c.telefono,
      activo: Boolean(c.activo),
      ultimoAcceso: c.ultimo_acceso,
      creadoEn: c.creado_en,
      pedidos: Number(c.pedidos),
      reservas: Number(c.reservas),
    })),
  };
}
