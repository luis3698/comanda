/**
 * Registro de usuarios y credenciales.  RF-03  ·  Vista 4.
 *
 * FSD 5.1:
 *  - "baja logica (activo = FALSE) -- restriccion de aplicacion impide
 *     eliminar usuarios con registros historicos."
 *  - "Contrasenas y PIN se almacenan solo como hash."
 * FSD 6.2: "Paginacion server-side en todas las tablas administrativas."
 *
 * Aqui NO hay ningun DELETE de usuario, y es deliberado: cada orden, factura y
 * evento de auditoria apunta a un id_usuario. Borrarlo romperia la trazabilidad
 * de todo el historico.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { consultar, consultarUno, pool, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';

const router = Router();

const COSTO_BCRYPT = Number(process.env.BCRYPT_COSTO || 12);   // FSD 6.1: >= 12
const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_PIN = /^\d{4}$/;

router.use(requiereAutenticacion);

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/**
 * Valida los datos de un usuario. Devuelve un objeto de errores por campo para
 * que la vista 4 los pinte junto a cada input.
 *
 * El cliente ya valida en vivo (FSD 4.1 vista 4), pero esa validacion es solo
 * experiencia de usuario: la autoritativa es esta (FSD 6.1).
 */
function validarUsuario({ nombreCompleto, correo, password, pin, idRol, documento }, { esNuevo }) {
  const fallos = {};

  if (!nombreCompleto || String(nombreCompleto).trim().length < 3) {
    fallos.nombreCompleto = 'Indique el nombre completo (minimo 3 caracteres).';
  }
  if (!correo || !RE_CORREO.test(String(correo))) {
    fallos.correo = 'El correo no tiene un formato valido.';
  }
  if (!idRol || !Number.isInteger(Number(idRol))) {
    fallos.idRol = 'Seleccione un rol.';
  }
  if (documento != null && String(documento).trim() !== '' && String(documento).length > 30) {
    fallos.documento = 'El documento no puede superar 30 caracteres.';
  }

  // En alta, contrasena y PIN son obligatorios. En edicion, solo se validan si
  // se envian: dejarlos vacios significa "no cambiar".
  if (esNuevo || password != null) {
    if (!password || String(password).length < 8) {
      fallos.password = 'La contrasena debe tener al menos 8 caracteres.';
    }
  }
  if (esNuevo || pin != null) {
    if (!RE_PIN.test(String(pin ?? ''))) {
      fallos.pin = 'El PIN debe tener exactamente 4 digitos numericos.';
    }
  }

  return fallos;
}

/**
 * GET /api/v1/usuarios
 * Listado paginado con buscador (FSD 4.1 vista 4 y 6.2).
 */
router.get('/', requierePermiso('seguridad.usuarios.ver'), asyncHandler(async (req, res) => {
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 20));
  const offset = (pagina - 1) * limite;
  const buscar = String(req.query.buscar ?? '').trim();
  const patron = `%${buscar}%`;

  // LIMIT/OFFSET van interpolados y no como placeholders porque MySQL no
  // acepta parametros ahi en sentencias preparadas. Es seguro: ambos pasaron
  // por Number() y estan acotados, nunca son texto del usuario.
  const filtro = buscar
    ? 'WHERE (u.nombre_completo LIKE ? OR u.correo LIKE ? OR u.documento LIKE ?)'
    : '';
  const params = buscar ? [patron, patron, patron] : [];

  const filas = await consultar(
    `SELECT u.id_usuario, u.nombre_completo, u.documento, u.correo, u.activo,
            u.uid_rfid, u.ultimo_acceso, u.intentos_fallidos,
            u.bloqueado_hasta IS NOT NULL AND u.bloqueado_hasta > NOW() AS bloqueado,
            r.id_rol, r.nombre AS rol
       FROM usuario u
       JOIN rol r ON r.id_rol = u.id_rol
       ${filtro}
      ORDER BY u.nombre_completo
      LIMIT ${limite} OFFSET ${offset}`,
    params
  );

  const total = await consultarUno(
    `SELECT COUNT(*) AS n FROM usuario u ${filtro}`, params
  );

  return res.json({
    usuarios: filas.map((f) => ({
      id: f.id_usuario,
      nombreCompleto: f.nombre_completo,
      documento: f.documento,
      correo: f.correo,
      activo: Boolean(f.activo),
      tieneRfid: Boolean(f.uid_rfid),
      bloqueado: Boolean(Number(f.bloqueado)),
      ultimoAcceso: f.ultimo_acceso,
      idRol: f.id_rol,
      rol: f.rol,
    })),
    paginacion: { pagina, limite, total: total.n, paginas: Math.ceil(total.n / limite) },
  });
}));

/**
 * GET /api/v1/usuarios/disponibilidad?correo=...&documento=...&uidRfid=...&excluir=id
 * Comprobacion de unicidad en vivo para la vista 4 ("verificacion de unicidad
 * via API"). No revela datos: solo responde si esta libre.
 */
router.get('/disponibilidad', requierePermiso('seguridad.usuarios.ver'), asyncHandler(async (req, res) => {
  const { correo, documento, uidRfid, excluir } = req.query;
  const idExcluir = Number(excluir) || 0;
  const salida = {};

  if (correo) {
    const f = await consultarUno(
      'SELECT id_usuario FROM usuario WHERE correo = ? AND id_usuario <> ?',
      [String(correo), idExcluir]
    );
    salida.correo = { disponible: !f };
  }
  if (documento) {
    const f = await consultarUno(
      'SELECT id_usuario FROM usuario WHERE documento = ? AND id_usuario <> ?',
      [String(documento), idExcluir]
    );
    salida.documento = { disponible: !f };
  }
  if (uidRfid) {
    const f = await consultarUno(
      'SELECT id_usuario FROM usuario WHERE uid_rfid = ? AND id_usuario <> ?',
      [String(uidRfid), idExcluir]
    );
    salida.uidRfid = { disponible: !f };
  }

  return res.json(salida);
}));

/** GET /api/v1/usuarios/:id */
router.get('/:id', requierePermiso('seguridad.usuarios.ver'), asyncHandler(async (req, res) => {
  const f = await consultarUno(
    `SELECT u.id_usuario, u.nombre_completo, u.documento, u.correo, u.activo,
            u.uid_rfid, u.ultimo_acceso, r.id_rol, r.nombre AS rol
       FROM usuario u JOIN rol r ON r.id_rol = u.id_rol
      WHERE u.id_usuario = ?`,
    [Number(req.params.id)]
  );
  if (!f) throw errores.noEncontrado('El usuario');

  return res.json({
    id: f.id_usuario,
    nombreCompleto: f.nombre_completo,
    documento: f.documento,
    correo: f.correo,
    activo: Boolean(f.activo),
    uidRfid: f.uid_rfid,
    ultimoAcceso: f.ultimo_acceso,
    idRol: f.id_rol,
    rol: f.rol,
  });
}));

/** POST /api/v1/usuarios */
router.post('/', requierePermiso('seguridad.usuarios.gestionar'), asyncHandler(async (req, res) => {
  const { nombreCompleto, correo, documento, password, pin, idRol, uidRfid } = req.body ?? {};

  const fallos = validarUsuario(req.body ?? {}, { esNuevo: true });
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  const rol = await consultarUno('SELECT id_rol FROM rol WHERE id_rol = ?', [Number(idRol)]);
  if (!rol) throw errores.peticionInvalida('El rol indicado no existe.', { campos: { idRol: 'Rol inexistente.' } });

  // Los hashes se calculan aqui, nunca llegan desde el cliente (FSD 5.1).
  const hashPassword = await bcrypt.hash(String(password), COSTO_BCRYPT);
  const hashPin = await bcrypt.hash(String(pin), COSTO_BCRYPT);

  const id = await transaccion(async (cx) => {
    const [r] = await cx.execute(
      `INSERT INTO usuario (id_rol, nombre_completo, documento, correo, hash_password, hash_pin, uid_rfid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Number(idRol), String(nombreCompleto).trim(),
       documento ? String(documento).trim() : null,
       String(correo).trim().toLowerCase(),
       hashPassword, hashPin,
       uidRfid ? String(uidRfid).trim() : null]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'usuario.creacion',
      entidad: 'usuario',
      idEntidad: r.insertId,
      detalle: `Alta del usuario ${correo} con rol id ${idRol}.`,
      ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  return res.status(201).json({ id });
}));

/** PUT /api/v1/usuarios/:id */
router.put('/:id', requierePermiso('seguridad.usuarios.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { nombreCompleto, correo, documento, password, pin, idRol, uidRfid } = req.body ?? {};

  const actual = await consultarUno('SELECT id_usuario, correo, id_rol FROM usuario WHERE id_usuario = ?', [id]);
  if (!actual) throw errores.noEncontrado('El usuario');

  const fallos = validarUsuario(req.body ?? {}, { esNuevo: false });
  if (Object.keys(fallos).length) {
    throw errores.peticionInvalida('Revise los campos marcados.', { campos: fallos });
  }

  // Un administrador no puede quitarse a si mismo el rol de administrador:
  // se dejaria sin acceso a la vista que acaba de usar.
  if (id === req.usuario.id && Number(idRol) !== actual.id_rol) {
    throw errores.reglaDeNegocio('No puede cambiar su propio rol. Pidaselo a otro administrador.');
  }

  await transaccion(async (cx) => {
    await cx.execute(
      `UPDATE usuario SET id_rol = ?, nombre_completo = ?, documento = ?, correo = ?, uid_rfid = ?
        WHERE id_usuario = ?`,
      [Number(idRol), String(nombreCompleto).trim(),
       documento ? String(documento).trim() : null,
       String(correo).trim().toLowerCase(),
       uidRfid ? String(uidRfid).trim() : null,
       id]
    );

    // Credenciales: solo se tocan si vienen en la peticion.
    if (password) {
      await cx.execute('UPDATE usuario SET hash_password = ? WHERE id_usuario = ?',
        [await bcrypt.hash(String(password), COSTO_BCRYPT), id]);
    }
    if (pin) {
      await cx.execute('UPDATE usuario SET hash_pin = ? WHERE id_usuario = ?',
        [await bcrypt.hash(String(pin), COSTO_BCRYPT), id]);
    }

    const cambioCredenciales = Boolean(password || pin);
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'usuario.edicion',
      entidad: 'usuario',
      idEntidad: id,
      detalle: `Edicion del usuario ${correo}${cambioCredenciales ? ' (incluye cambio de credenciales)' : ''}.`,
      ipOrigen: ipDe(req),
    });
  });

  // Un cambio de credenciales invalida las sesiones abiertas del usuario: si
  // se cambio por sospecha de compromiso, dejar viva la sesion del atacante
  // haria inutil el cambio.
  if (password || pin) {
    await pool.execute('DELETE FROM sesion WHERE id_usuario = ?', [id]);
  }

  return res.json({ ok: true });
}));

/**
 * PATCH /api/v1/usuarios/:id/estado   { activo: boolean }
 * Baja y alta logica (FSD 4.1 vista 4: "nunca borra el registro").
 */
router.patch('/:id/estado', requierePermiso('seguridad.usuarios.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const activo = Boolean(req.body?.activo);

  const usuario = await consultarUno(
    'SELECT id_usuario, correo, id_rol, activo FROM usuario WHERE id_usuario = ?', [id]
  );
  if (!usuario) throw errores.noEncontrado('El usuario');

  // Nadie puede darse de baja a si mismo: perderia el acceso en el acto.
  if (id === req.usuario.id && !activo) {
    throw errores.reglaDeNegocio('No puede darse de baja a si mismo.');
  }

  // El sistema no puede quedarse sin ningun administrador activo, o nadie
  // podria volver a entrar al backoffice.
  if (!activo && usuario.id_rol === 1) {
    const otros = await consultarUno(
      'SELECT COUNT(*) AS n FROM usuario WHERE id_rol = 1 AND activo = TRUE AND id_usuario <> ?', [id]
    );
    if (otros.n === 0) {
      throw errores.reglaDeNegocio('Es el unico administrador activo: el sistema quedaria sin acceso.');
    }
  }

  await transaccion(async (cx) => {
    await cx.execute('UPDATE usuario SET activo = ? WHERE id_usuario = ?', [activo, id]);
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: activo ? 'usuario.alta' : 'usuario.baja',
      entidad: 'usuario',
      idEntidad: id,
      detalle: `${activo ? 'Reactivacion' : 'Baja logica'} del usuario ${usuario.correo}.`,
      ipOrigen: ipDe(req),
    });
  });

  // Al dar de baja, se cierran sus sesiones abiertas.
  if (!activo) {
    await pool.execute('DELETE FROM sesion WHERE id_usuario = ?', [id]);
  }

  return res.json({ ok: true });
}));

/**
 * PATCH /api/v1/usuarios/:id/desbloquear
 * Levanta el bloqueo por intentos fallidos (FSD 5.1) sin esperar los 15 min.
 */
router.patch('/:id/desbloquear', requierePermiso('seguridad.usuarios.gestionar'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const usuario = await consultarUno('SELECT correo FROM usuario WHERE id_usuario = ?', [id]);
  if (!usuario) throw errores.noEncontrado('El usuario');

  await transaccion(async (cx) => {
    await cx.execute(
      'UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?', [id]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'usuario.desbloqueo',
      entidad: 'usuario',
      idEntidad: id,
      detalle: `Desbloqueo manual de la cuenta ${usuario.correo}.`,
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

export default router;
