/**
 * Dashboard, reportes y auditoría.  RF-21, RF-22, RF-23  ·  Vistas 1, 9, 10.
 *
 * FSD 5.8: "La auditoría y los reportes son de acceso exclusivo del
 * Administrador."
 */
import { Router } from 'express';
import { consultar, consultarUno } from '../db.js';
import { errores, asyncHandler } from '../middleware/errores.js';
import { requiereAutenticacion } from '../middleware/auth.js';
import { requierePermiso } from '../middleware/permisos.js';
import { kpisDelDia, generarReporte, REPORTES, validarRango } from '../servicios/reportes.js';
import { aPdf, aExcel, aCsv } from '../servicios/exportar.js';
import { verificarCadena } from '../servicios/auditoria.js';

const router = Router();
router.use(requiereAutenticacion);

/* =====================================================================
   Dashboard (RF-21)
   ===================================================================== */

router.get('/dashboard/kpis', requierePermiso('dashboard.ver'), asyncHandler(async (req, res) => {
  const fecha = req.query.fecha;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
    throw errores.peticionInvalida('La fecha debe tener formato AAAA-MM-DD.');
  }
  const kpis = await kpisDelDia(fecha);
  return res.json(kpis);
}));

/* =====================================================================
   Reportes (RF-22)
   ===================================================================== */

/** Catálogo de reportes disponibles para el panel izquierdo de la vista 10. */
router.get('/reportes', requierePermiso('reportes.ver'), asyncHandler(async (_req, res) => {
  return res.json({
    reportes: Object.entries(REPORTES).map(([tipo, def]) => ({
      tipo, titulo: def.titulo, columnas: def.columnas,
    })),
  });
}));

/**
 * GET /reportes/:tipo?desde=&hasta=&formato=
 * Sin `formato` devuelve JSON para la vista previa; con `pdf` o `xlsx`, el archivo.
 *
 * La vista previa y la exportación llaman a la MISMA `generarReporte()`, así
 * que es imposible que el archivo tenga totales distintos de los que se vieron
 * en pantalla (FSD 5.8).
 */
router.get('/reportes/:tipo', requierePermiso('reportes.ver'), asyncHandler(async (req, res) => {
  const { tipo } = req.params;
  const { desde, hasta, formato, idCajero, idZona, idCategoria } = req.query;

  const reporte = await generarReporte(tipo, { desde, hasta, idCajero, idZona, idCategoria });

  if (!formato) return res.json(reporte);

  // La exportación es un permiso aparte del de consulta.
  if (!req.usuario.permisos.has('reportes.exportar')) {
    throw errores.sinPermiso('reportes.exportar');
  }

  const nombre = `${tipo}_${desde}_a_${hasta}`;

  if (formato === 'pdf') {
    const buffer = await aPdf(reporte);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.pdf"`);
    return res.end(buffer);
  }

  if (formato === 'xlsx') {
    const buffer = await aExcel(reporte);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    return res.end(buffer);
  }

  if (formato === 'csv') {
    const buffer = aCsv(reporte.columnas, reporte.filas);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.csv"`);
    return res.end(buffer);
  }

  throw errores.peticionInvalida('Formato no soportado. Use pdf, xlsx o csv.');
}));

/* =====================================================================
   Auditoría (RF-23)  ·  Vista 9
   ===================================================================== */

const ACCIONES_SEVERIDAD = {
  // Eventos que un auditor querría ver primero.
  alta: ['orden.anulacion', 'caja.abrir_cajon', 'auth.bloqueo', 'compra.anulacion',
         'rol.permisos', 'usuario.baja', 'factura.anulacion', 'inventario.ajuste', 'inventario.merma'],
  media: ['producto.cambio_precio', 'caja.salida_efectivo', 'caja.turno_cierre',
          'usuario.creacion', 'usuario.edicion', 'rol.creacion', 'rol.eliminacion'],
};

function severidadDe(accion) {
  if (ACCIONES_SEVERIDAD.alta.includes(accion)) return 'alta';
  if (ACCIONES_SEVERIDAD.media.includes(accion)) return 'media';
  return 'baja';
}

/**
 * GET /auditoria — filtros + paginación por cursor (FSD 4.1 vista 9).
 *
 * Se pagina por cursor y no por OFFSET porque el log crece mientras se
 * consulta: con OFFSET, un registro nuevo desplaza la ventana y el usuario ve
 * filas repetidas al hacer scroll.
 *
 * NO existe ninguna ruta de escritura aquí. La tabla es de solo inserción, y
 * el usuario de base de datos de la aplicación ni siquiera tiene UPDATE ni
 * DELETE sobre ella (db/04_privilegios.sql).
 */
router.get('/auditoria', requierePermiso('auditoria.ver'), asyncHandler(async (req, res) => {
  const { desde, hasta, idUsuario, accion, entidad, cursor } = req.query;
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 50));

  const cond = [];
  const params = [];

  if (desde) { cond.push('l.fecha >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { cond.push('l.fecha <= ?'); params.push(`${hasta} 23:59:59.999`); }
  if (idUsuario) { cond.push('l.id_usuario = ?'); params.push(Number(idUsuario)); }
  if (accion) { cond.push('l.accion LIKE ?'); params.push(`${accion}%`); }
  if (entidad) { cond.push('l.entidad = ?'); params.push(String(entidad)); }
  // El cursor es el id_log del último visto: todo lo anterior a él.
  if (cursor) { cond.push('l.id_log < ?'); params.push(Number(cursor)); }

  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const filas = await consultar(
    `SELECT l.id_log, l.id_usuario, l.id_autorizador, l.accion, l.entidad, l.id_entidad,
            l.detalle, l.ip_origen, l.fecha,
            u.nombre_completo AS usuario,
            a.nombre_completo AS autorizador
       FROM log_auditoria l
       JOIN usuario u      ON u.id_usuario = l.id_usuario
       LEFT JOIN usuario a ON a.id_usuario = l.id_autorizador
       ${where}
      ORDER BY l.id_log DESC
      LIMIT ${limite + 1}`,
    params
  );

  // Se pide uno de más para saber si hay página siguiente sin un COUNT aparte.
  const hayMas = filas.length > limite;
  const pagina = hayMas ? filas.slice(0, limite) : filas;

  return res.json({
    eventos: pagina.map((l) => ({
      id: l.id_log,
      fecha: l.fecha,
      usuario: l.usuario,
      idUsuario: l.id_usuario,
      autorizador: l.autorizador,
      accion: l.accion,
      entidad: l.entidad,
      idEntidad: l.id_entidad,
      detalle: l.detalle,
      ipOrigen: l.ip_origen,
      severidad: severidadDe(l.accion),
    })),
    cursorSiguiente: hayMas ? pagina[pagina.length - 1].id_log : null,
  });
}));

/** GET /auditoria/acciones — catálogo para el filtro. */
router.get('/auditoria/acciones', requierePermiso('auditoria.ver'), asyncHandler(async (_req, res) => {
  const filas = await consultar(
    'SELECT accion, COUNT(*) AS veces FROM log_auditoria GROUP BY accion ORDER BY accion'
  );
  return res.json({
    acciones: filas.map((a) => ({
      accion: a.accion, veces: a.veces, severidad: severidadDe(a.accion),
    })),
  });
}));

/**
 * GET /auditoria/integridad — verifica la cadena de hashes.
 * FSD 5.8: "cada registro encadena un hash del anterior para evidenciar
 * manipulación". Esto lo comprueba de verdad, recorriendo la cadena completa.
 */
router.get('/auditoria/integridad', requierePermiso('auditoria.ver'), asyncHandler(async (_req, res) => {
  const r = await verificarCadena();
  const detalleMotivo = r.motivo === 'contenido_alterado'
    ? `Se editó el contenido del registro ${r.rotoEn} con acceso directo a la base de datos.`
    : `Falta al menos un registro antes del ${r.rotoEn} (fue eliminado o reordenado con acceso directo a la base de datos).`;
  return res.json({
    integra: r.integra,
    revisados: r.revisados,
    rotoEn: r.rotoEn,
    motivo: r.motivo,
    mensaje: r.integra
      ? `Cadena íntegra: ${r.revisados} registro(s) verificados.`
      : `Cadena rota en el registro ${r.rotoEn}. ${detalleMotivo}`,
  });
}));

/** GET /auditoria/exportar — CSV del filtro activo (FSD 4.1 vista 9). */
router.get('/auditoria-exportar', requierePermiso('auditoria.ver'), asyncHandler(async (req, res) => {
  const { desde, hasta, idUsuario, accion, entidad } = req.query;

  const cond = [];
  const params = [];
  if (desde) { cond.push('l.fecha >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { cond.push('l.fecha <= ?'); params.push(`${hasta} 23:59:59.999`); }
  if (idUsuario) { cond.push('l.id_usuario = ?'); params.push(Number(idUsuario)); }
  if (accion) { cond.push('l.accion LIKE ?'); params.push(`${accion}%`); }
  if (entidad) { cond.push('l.entidad = ?'); params.push(String(entidad)); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const filas = await consultar(
    `SELECT l.id_log, l.fecha, u.nombre_completo AS usuario, a.nombre_completo AS autorizador,
            l.accion, l.entidad, l.id_entidad, l.detalle, l.ip_origen
       FROM log_auditoria l
       JOIN usuario u      ON u.id_usuario = l.id_usuario
       LEFT JOIN usuario a ON a.id_usuario = l.id_autorizador
       ${where}
      ORDER BY l.id_log DESC
      LIMIT 10000`,
    params
  );

  const columnas = [
    { clave: 'id_log', etiqueta: 'ID' },
    { clave: 'fecha', etiqueta: 'Fecha' },
    { clave: 'usuario', etiqueta: 'Usuario' },
    { clave: 'autorizador', etiqueta: 'Autorizador' },
    { clave: 'accion', etiqueta: 'Acción' },
    { clave: 'entidad', etiqueta: 'Entidad' },
    { clave: 'id_entidad', etiqueta: 'ID entidad' },
    { clave: 'detalle', etiqueta: 'Detalle' },
    { clave: 'ip_origen', etiqueta: 'IP' },
  ];

  const buffer = aCsv(columnas, filas);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="auditoria_${desde ?? 'inicio'}_a_${hasta ?? 'hoy'}.csv"`);
  return res.end(buffer);
}));

export default router;
