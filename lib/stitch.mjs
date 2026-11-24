import sharp from 'sharp';

/**
 * Stitch viewport tiles into one image.
 *
 * Each tile is { buf, scrollY } where scrollY is the CSS-pixel scroll offset
 * at which the tile was taken. Every output row is taken from the tile in which
 * that row sat closest to the viewport centre. That's where animations are
 * most likely to have triggered, and it keeps seams away from elements
 * half-entering at the bottom edge.
 *
 * @param {{buf: Buffer, scrollY: number}[]} tiles  sorted by scrollY
 * @param {{viewportHeight:number, pageHeight:number, width:number, dpr:number}} geo
 * @param {string} outPath
 */
export async function stitch(tiles, { viewportHeight, pageHeight, width, dpr }, outPath) {
  const W = Math.round(width * dpr);
  const H = Math.round(pageHeight * dpr);
  const composites = [];

  for (let i = 0; i < tiles.length; i++) {
    const { buf, scrollY } = tiles[i];
    const centre = scrollY + viewportHeight / 2;
    const prevCentre = i > 0 ? tiles[i - 1].scrollY + viewportHeight / 2 : -Infinity;
    const nextCentre = i < tiles.length - 1 ? tiles[i + 1].scrollY + viewportHeight / 2 : Infinity;

    // Band of page rows (CSS px) this tile owns.
    const bandTop = Math.max(scrollY, i === 0 ? 0 : (prevCentre + centre) / 2);
    const bandBot = Math.min(scrollY + viewportHeight, i === tiles.length - 1 ? pageHeight : (centre + nextCentre) / 2);
    if (bandBot <= bandTop) continue;

    const top = Math.round((bandTop - scrollY) * dpr);
    const height = Math.min(Math.round((bandBot - bandTop) * dpr), Math.round(viewportHeight * dpr) - top);
    const destTop = Math.round(bandTop * dpr);
    if (height <= 0 || destTop >= H) continue;

    const piece = await sharp(buf)
      .extract({ left: 0, top, width: W, height: Math.min(height, H - destTop) })
      .toBuffer();
    composites.push({ input: piece, top: destTop, left: 0 });
  }

  await sharp({ create: { width: W, height: H, channels: 4, background: '#ffffff' }, limitInputPixels: false })
    .composite(composites)
    .png()
    .toFile(outPath);
  return { width: W, height: H, tiles: composites.length };
}

/** Concatenate vertical segments (used for very tall pages in latch mode). */
export async function concatVertical(segments, width, outPath) {
  let y = 0;
  const composites = [];
  for (const buf of segments) {
    const { height } = await sharp(buf).metadata();
    composites.push({ input: buf, top: y, left: 0 });
    y += height;
  }
  await sharp({ create: { width, height: y, channels: 4, background: '#ffffff' }, limitInputPixels: false })
    .composite(composites)
    .png()
    .toFile(outPath);
  return { width, height: y };
}
