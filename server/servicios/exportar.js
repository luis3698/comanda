/**
 * Exportación de reportes a PDF, Excel y CSV.  RF-22.
 *
 * FSD 5.8: "exportación a PDF y Excel con los MISMOS TOTALES que la vista previa."
 *
 * Por eso estas funciones NO consultan la base ni recalculan nada: reciben el
 * objeto que ya devolvió `generarReporte()` —el mismo que alimenta la vista
 * previa— y solo lo dan formato. Si recalcularan por su cuenta, el archivo
 * podría diferir de lo que el administrador vio en pantalla, y un informe
 * fiscal que no cuadra con su vista previa es un problema serio.
 */
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

const FORMATO_MONEDA = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2,
});

/** Da formato a una celda según el tipo declarado por la columna. */
function formatearCelda(valor, tipo) {
  if (valor == null || valor === '') return '—';
  if (tipo === 'dinero') return FORMATO_MONEDA.format(Number(valor));
  if (tipo === 'entero') return String(valor);
  // Las fechas llegan como 'YYYY-MM-DD HH:mm:ss' desde MySQL (dateStrings).
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(valor)) {
    const [f, h] = valor.split(' ');
    const [a, m, d] = f.split('-');
    return `${d}/${m}/${a} ${h.slice(0, 5)}`;
  }
  return String(valor);
}

/* =====================================================================
   PDF
   ===================================================================== */

/**
 * Genera el PDF de un reporte.
 * @param {object} reporte  Salida de generarReporte().
 * @returns {Promise<Buffer>}
 */
export function aPdf(reporte) {
  return new Promise((resolver, rechazar) => {
    // Apaisado: los reportes tienen muchas columnas y en vertical no caben.
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 40 });
    const trozos = [];
    doc.on('data', (t) => trozos.push(t));
    doc.on('end', () => resolver(Buffer.concat(trozos)));
    doc.on('error', rechazar);

    const anchoUtil = doc.page.width - 80;

    // --- Encabezado ---
    doc.fontSize(18).fillColor('#0f766e').text('SIGR', { continued: true })
       .fillColor('#334155').fontSize(12).text('  ·  Sistema Integral de Gestión para Restaurantes');
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor('#0f172a').text(reporte.titulo);
    doc.fontSize(9).fillColor('#64748b')
       .text(`Del ${reporte.rango.desde} al ${reporte.rango.hasta}  ·  Generado el ${new Date(reporte.generadoEn).toLocaleString('es-CO')}`);
    doc.moveDown(0.8);

    // --- Tabla ---
    const cols = reporte.columnas;
    const anchoCol = anchoUtil / cols.length;
    let y = doc.y;

    const pintarCabecera = () => {
      doc.rect(40, y, anchoUtil, 20).fill('#f1f5f9');
      doc.fillColor('#334155').fontSize(9);
      cols.forEach((c, i) => {
        doc.text(c.etiqueta, 44 + i * anchoCol, y + 6, { width: anchoCol - 8, ellipsis: true });
      });
      y += 20;
    };
    pintarCabecera();

    doc.fontSize(8.5);
    for (const fila of reporte.filas) {
      // Salto de página con la cabecera repetida: un reporte de 200 facturas
      // sin encabezados en la página 2 es ilegible.
      if (y > doc.page.height - 70) {
        doc.addPage();
        y = 40;
        pintarCabecera();
        doc.fontSize(8.5);
      }
      doc.fillColor('#0f172a');
      cols.forEach((c, i) => {
        const tipo = c.tipo;
        const alineado = (tipo === 'dinero' || tipo === 'entero') ? 'right' : 'left';
        doc.text(formatearCelda(fila[c.clave], tipo), 44 + i * anchoCol, y + 4,
          { width: anchoCol - 8, align: alineado, ellipsis: true });
      });
      y += 16;
      doc.moveTo(40, y).lineTo(40 + anchoUtil, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    }

    // --- Totales ---
    if (reporte.totales && Object.keys(reporte.totales).length) {
      y += 8;
      if (y > doc.page.height - 70) { doc.addPage(); y = 40; }
      doc.rect(40, y, anchoUtil, 22).fill('#0f766e');
      doc.fillColor('#ffffff').fontSize(9.5);
      const texto = Object.entries(reporte.totales)
        .map(([k, v]) => {
          const col = cols.find((c) => c.clave === k);
          const etiqueta = col?.etiqueta ?? k;
          return `${etiqueta}: ${formatearCelda(v, col?.tipo ?? (isNaN(Number(v)) ? undefined : 'dinero'))}`;
        })
        .join('     ');
      doc.text(`TOTALES     ${texto}`, 44, y + 6, { width: anchoUtil - 8 });
      y += 22;
    }

    if (!reporte.filas.length) {
      doc.fillColor('#64748b').fontSize(10)
         .text('No hay datos en el rango seleccionado.', 40, y + 12);
    }

    // Pie con numeración.
    const paginas = doc.bufferedPageRange();
    for (let i = 0; i < paginas.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7.5).fillColor('#94a3b8')
         .text(`Página ${i + 1} de ${paginas.count}  ·  SIGR`,
               40, doc.page.height - 30, { width: anchoUtil, align: 'center' });
    }

    doc.end();
  });
}

/* =====================================================================
   Excel
   ===================================================================== */

/**
 * Genera el .xlsx de un reporte.
 * Los importes van como NÚMERO con formato de moneda, no como texto: un
 * contador tiene que poder sumar la columna en Excel.
 */
export async function aExcel(reporte) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGR';
  wb.created = new Date();

  const ws = wb.addWorksheet(reporte.titulo.slice(0, 31));   // Excel limita a 31 caracteres

  // --- Encabezado ---
  ws.mergeCells(1, 1, 1, reporte.columnas.length);
  ws.getCell(1, 1).value = reporte.titulo;
  ws.getCell(1, 1).font = { size: 14, bold: true, color: { argb: 'FF0F766E' } };

  ws.mergeCells(2, 1, 2, reporte.columnas.length);
  ws.getCell(2, 1).value = `Del ${reporte.rango.desde} al ${reporte.rango.hasta} · Generado el ${new Date(reporte.generadoEn).toLocaleString('es-CO')}`;
  ws.getCell(2, 1).font = { size: 9, color: { argb: 'FF64748B' } };

  // --- Cabecera de la tabla ---
  const filaCabecera = 4;
  reporte.columnas.forEach((c, i) => {
    const celda = ws.getCell(filaCabecera, i + 1);
    celda.value = c.etiqueta;
    celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    celda.alignment = { vertical: 'middle' };
  });
  ws.getRow(filaCabecera).height = 20;

  // --- Datos ---
  reporte.filas.forEach((fila, f) => {
    reporte.columnas.forEach((c, i) => {
      const celda = ws.getCell(filaCabecera + 1 + f, i + 1);
      const valor = fila[c.clave];

      if (c.tipo === 'dinero') {
        celda.value = Number(valor ?? 0);
        celda.numFmt = '"$"#,##0.00';
      } else if (c.tipo === 'entero') {
        celda.value = Number(valor ?? 0);
        celda.numFmt = '#,##0';
      } else {
        celda.value = valor ?? '';
      }
    });
  });

  // --- Totales ---
  if (reporte.totales && Object.keys(reporte.totales).length) {
    const filaTot = filaCabecera + reporte.filas.length + 1;
    ws.getCell(filaTot, 1).value = 'TOTALES';
    ws.getCell(filaTot, 1).font = { bold: true };

    reporte.columnas.forEach((c, i) => {
      if (reporte.totales[c.clave] == null) return;
      const celda = ws.getCell(filaTot, i + 1);
      if (c.tipo === 'dinero') {
        celda.value = Number(reporte.totales[c.clave]);
        celda.numFmt = '"$"#,##0.00';
      } else if (c.tipo === 'entero') {
        celda.value = Number(reporte.totales[c.clave]);
      } else {
        celda.value = reporte.totales[c.clave];
      }
      celda.font = { bold: true };
      celda.border = { top: { style: 'double' } };
    });
  }

  // Ancho de columnas según el contenido.
  reporte.columnas.forEach((c, i) => {
    const largos = reporte.filas.map((f) => String(f[c.clave] ?? '').length);
    ws.getColumn(i + 1).width = Math.min(40, Math.max(c.etiqueta.length + 4, ...largos, 10));
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* =====================================================================
   CSV (auditoría, FSD 4.1 vista 9)
   ===================================================================== */

/** Escapa un campo CSV según RFC 4180. */
function campoCsv(valor) {
  const s = valor == null ? '' : String(valor);
  // Un campo con coma, comilla o salto de línea va entrecomillado, y las
  // comillas internas se duplican. Sin esto, una nota de comanda con una coma
  // rompería la alineación de todas las columnas siguientes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Genera un CSV a partir de columnas y filas.
 * @param {Array<{clave:string, etiqueta:string}>} columnas
 * @param {Array<object>} filas
 */
export function aCsv(columnas, filas) {
  const lineas = [columnas.map((c) => campoCsv(c.etiqueta)).join(',')];
  for (const f of filas) {
    lineas.push(columnas.map((c) => campoCsv(f[c.clave])).join(','));
  }
  // BOM UTF-8: sin él, Excel abre el CSV en Latin-1 y destroza los acentos.
  return Buffer.from('﻿' + lineas.join('\r\n'), 'utf8');
}
