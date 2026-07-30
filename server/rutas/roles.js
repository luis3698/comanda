/**
 * Gestor de roles y matriz de permisos.  RF-02  ·  Vista 3.
 *
 * FSD 3.1: los 4 roles preestablecidos (es_sistema = TRUE) no pueden
 * eliminarse, pero el Administrador si puede crear roles personalizados
 * adicionales "sin modificar el codigo".
 * FSD 4.1 vista 3: "guardado por lote (PUT /api/v1/roles/:id/permisos)".
 */
import { Router } from 'express';
import { consultar, consultarUno, transaccion } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { auditar } from '../servicios/auditoria.js';
import { invalidar as invalidarPermisos } from '../servicios/permisosRol.js';

const router = Router();

router.use(requiereAutenticacion);

// Sin este permiso nadie podria volver a editar la matriz: es la llave que
// nunca debe perderse por accidente.
const PERMISO_LLAVE = 'seguridad.roles.gestionar';

function ipDe(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || null;
}

/** GET /api/v1/roles */
router.get('/', requierePermiso('seguridad.roles.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    `SELECT r.id_rol, r.nombre, r.descripcion, r.es_sistema,
            (SELECT COUNT(*) FROM usuario u WHERE u.id_rol = r.id_rol) AS usuarios,
            (SELECT COUNT(*) FROM rol_permiso rp WHERE rp.id_rol = r.id_rol) AS permisos
       FROM rol r
      ORDER BY r.es_sistema DESC, r.nombre`
  );
  return res.json({
    roles: filas.map((f) => ({
      id: f.id_rol,
      nombre: f.nombre,
      descripcion: f.descripcion,
      esSistema: Boolean(f.es_sistema),
      usuarios: f.usuarios,
      permisos: f.permisos,
    })),
  });
}));

/**
 * GET /api/v1/roles/permisos
 * Catalogo completo agrupado por modulo: son los acordeones de la vista 3.
 */
router.get('/permisos', requierePermiso('seguridad.roles.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    'SELECT id_permiso, codigo, modulo, descripcion FROM permiso ORDER BY modulo, codigo'
  );

  const modulos = {};
  for (const f of filas) {
    (modulos[f.modulo] ??= []).push({
      id: f.id_permiso,
      codigo: f.codigo,
      descripcion: f.descripcion,
    });
  }

  return res.json({
    modulos: Object.entries(modulos).map(([nombre, permisos]) => ({ nombre, permisos })),
  });
}));

/** GET /api/v1/roles/:id/permisos */
router.get('/:id/permisos', requierePermiso('seguridad.roles.ver'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rol = await consultarUno('SELECT id_rol FROM rol WHERE id_rol = ?', [id]);
  if (!rol) throw errores.noEncontrado('El rol');

  const filas = await consultar(
    `SELECT p.id_permiso, p.codigo
       FROM rol_permiso rp JOIN permiso p ON p.id_permiso = rp.id_permiso
      WHERE rp.id_rol = ?`,
    [id]
  );

  return res.json({
    idRol: id,
    permisos: filas.map((f) => f.id_permiso),
    codigos: filas.map((f) => f.codigo),
  });
}));

/** POST /api/v1/roles */
router.post('/', requierePermiso(PERMISO_LLAVE), asyncHandler(async (req, res) => {
  const { nombre, descripcion } = req.body ?? {};
  if (!nombre || String(nombre).trim().length < 3) {
    throw errores.peticionInvalida('El nombre del rol debe tener al menos 3 caracteres.',
      { campos: { nombre: 'Minimo 3 caracteres.' } });
  }

  const id = await transaccion(async (cx) => {
    // es_sistema queda en FALSE: solo los 4 roles del FSD son de sistema.
    const [r] = await cx.execute(
      'INSERT INTO rol (nombre, descripcion, es_sistema) VALUES (?, ?, FALSE)',
      [String(nombre).trim(), descripcion ? String(descripcion).trim() : null]
    );
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'rol.creacion',
      entidad: 'rol',
      idEntidad: r.insertId,
      detalle: `Creacion del rol "${nombre}".`,
      ipOrigen: ipDe(req),
    });
    return r.insertId;
  });

  return res.status(201).json({ id });
}));

/** PUT /api/v1/roles/:id */
router.put('/:id', requierePermiso(PERMISO_LLAVE), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, descripcion } = req.body ?? {};

  const rol = await consultarUno('SELECT id_rol, nombre, es_sistema FROM rol WHERE id_rol = ?', [id]);
  if (!rol) throw errores.noEncontrado('El rol');

  if (!nombre || String(nombre).trim().length < 3) {
    throw errores.peticionInvalida('El nombre del rol debe tener al menos 3 caracteres.',
      { campos: { nombre: 'Minimo 3 caracteres.' } });
  }

  // Renombrar un rol de sistema romperia la correspondencia con el FSD 3.1;
  // su descripcion si puede ajustarse.
  if (rol.es_sistema && String(nombre).trim() !== rol.nombre) {
    throw errores.reglaDeNegocio('Los roles preestablecidos del sistema no se pueden renombrar.');
  }

  await transaccion(async (cx) => {
    await cx.execute('UPDATE rol SET nombre = ?, descripcion = ? WHERE id_rol = ?',
      [String(nombre).trim(), descripcion ? String(descripcion).trim() : null, id]);
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'rol.edicion',
      entidad: 'rol',
      idEntidad: id,
      detalle: `Edicion del rol "${nombre}".`,
      ipOrigen: ipDe(req),
    });
  });

  return res.json({ ok: true });
}));

/** DELETE /api/v1/roles/:id */
router.delete('/:id', requierePermiso(PERMISO_LLAVE), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const rol = await consultarUno('SELECT id_rol, nombre, es_sistema FROM rol WHERE id_rol = ?', [id]);
  if (!rol) throw errores.noEncontrado('El rol');

  // FSD 3.1: "Los cuatro roles preestablecidos (es_sistema = TRUE) no pueden
  // eliminarse." La vista 3 los muestra con candado; aqui se comprueba de
  // verdad, porque el candado del cliente se puede saltar.
  if (rol.es_sistema) {
    throw errores.reglaDeNegocio('Los roles preestablecidos del sistema no se pueden eliminar.');
  }

  const enUso = await consultarUno('SELECT COUNT(*) AS n FROM usuario WHERE id_rol = ?', [id]);
  if (enUso.n > 0) {
    throw errores.conflicto(
      `El rol tiene ${enUso.n} usuario(s) asignado(s). Reasignelos antes de eliminarlo.`
    );
  }

  await transaccion(async (cx) => {
    await cx.execute('DELETE FROM rol WHERE id_rol = ?', [id]);
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'rol.eliminacion',
      entidad: 'rol',
      idEntidad: id,
      detalle: `Eliminacion del rol "${rol.nombre}".`,
      ipOrigen: ipDe(req),
    });
  });

  // El DELETE arrastra sus filas de rol_permiso por la clave foranea en
  // cascada, asi que la entrada cacheada de ese rol ya no describe nada.
  invalidarPermisos(id);

  return res.json({ ok: true });
}));

/**
 * PUT /api/v1/roles/:id/permisos    { permisos: [idPermiso, ...] }
 * Guardado por lote de la matriz (FSD 4.1 vista 3).
 *
 * Se reemplaza el conjunto completo en una transaccion en vez de aplicar
 * altas y bajas sueltas: si algo falla a mitad, el rol no queda con permisos
 * a medio aplicar.
 */
router.put('/:id/permisos', requierePermiso(PERMISO_LLAVE), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const solicitados = req.body?.permisos;

  if (!Array.isArray(solicitados)) {
    throw errores.peticionInvalida('Envie el arreglo "permisos" con los ids concedidos.');
  }

  const rol = await consultarUno('SELECT id_rol, nombre FROM rol WHERE id_rol = ?', [id]);
  if (!rol) throw errores.noEncontrado('El rol');

  const ids = [...new Set(solicitados.map(Number).filter(Number.isInteger))];

  // Todos los ids deben existir: un id inventado quedaria silenciosamente
  // ignorado y la matriz mostraria algo distinto a lo guardado.
  if (ids.length) {
    const marcadores = ids.map(() => '?').join(',');
    const existentes = await consultar(
      `SELECT id_permiso FROM permiso WHERE id_permiso IN (${marcadores})`, ids
    );
    if (existentes.length !== ids.length) {
      throw errores.peticionInvalida('Uno o mas permisos indicados no existen.');
    }
  }

  // Candado anti-bloqueo: si el administrador se quita a si mismo el permiso
  // que gobierna esta pantalla, nadie podria volver a concederlo y el sistema
  // quedaria sin forma de administrar permisos. Se comprueba contra su propio
  // rol, que es el unico caso irrecuperable.
  if (id === req.usuario.idRol) {
    const llave = await consultarUno('SELECT id_permiso FROM permiso WHERE codigo = ?', [PERMISO_LLAVE]);
    if (llave && !ids.includes(llave.id_permiso)) {
      throw errores.reglaDeNegocio(
        `No puede quitarle "${PERMISO_LLAVE}" a su propio rol: nadie podria volver a editar los permisos.`
      );
    }
  }

  await transaccion(async (cx) => {
    await cx.execute('DELETE FROM rol_permiso WHERE id_rol = ?', [id]);
    if (ids.length) {
      const valores = ids.map(() => '(?, ?)').join(',');
      const params = ids.flatMap((idPermiso) => [id, idPermiso]);
      await cx.execute(`INSERT INTO rol_permiso (id_rol, id_permiso) VALUES ${valores}`, params);
    }
    await auditar(cx, {
      idUsuario: req.usuario.id,
      accion: 'rol.permisos',
      entidad: 'rol',
      idEntidad: id,
      detalle: `Actualizacion de permisos del rol "${rol.nombre}": ${ids.length} permiso(s) concedido(s).`,
      ipOrigen: ipDe(req),
    });
  });

  // La matriz vive cacheada en memoria (servicios/permisosRol.js): se tira la
  // entrada del rol para que la siguiente peticion lea lo recien guardado. Esto
  // es lo que sostiene la garantia del FSD 5.1 ahora que no hay un SELECT por
  // peticion, y de paso reajusta los permisos de los WebSocket ya abiertos.
  invalidarPermisos(id);

  // No hace falta cerrar sesiones: los permisos se releen en cada peticion
  // (FSD 5.1), asi que el cambio ya afecta a la siguiente accion de todos.
  return res.json({ ok: true, permisos: ids.length });
}));

export default router;
