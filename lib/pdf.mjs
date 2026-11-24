import fs from 'node:fs';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

// Acrobat/PDF 1.x cap: a page side may not exceed 200 in = 14 400 pt.
const MAX_PT = 14400;

/**
 * Put a full-page screenshot on a single PDF page, lossless.
 * Page size follows CSS pixels (1 CSS px = 0.75 pt), so the PDF prints at the
 * page's natural size. Very tall pages are scaled to fit the 14 400 pt limit,
 * but the embedded image keeps its full resolution, so you can zoom in without
 * losing detail.
 */
export async function pngToPdf(pngPath, pdfPath, { dpr = 1, title = '', url = '' } = {}) {
  // Flatten alpha: an RGB image embeds faster and produces a smaller PDF.
  const rgb = await sharp(pngPath, { limitInputPixels: false })
    .flatten({ background: '#ffffff' }).png({ compressionLevel: 9 }).toBuffer();
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  if (url) doc.setSubject(url);
  doc.setCreator('capture.mjs');
  doc.setCreationDate(new Date());

  const img = await doc.embedPng(rgb);
  let w = (img.width / dpr) * 0.75;
  let h = (img.height / dpr) * 0.75;
  const k = Math.min(1, MAX_PT / h, MAX_PT / w);
  w *= k; h *= k;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  fs.writeFileSync(pdfPath, await doc.save());
  return { widthPt: Math.round(w), heightPt: Math.round(h), scaled: k < 1 };
}
