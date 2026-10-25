import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { openTestDocument, createTestRenderer } from './helpers';

it('document renderPage', async () => {
  const path = fileURLToPath(new URL('../../../../ofd_pdf_match/draw_param_ref.ofd', import.meta.url));
  const bytes = new Uint8Array(readFileSync(path));
  const renderer = createTestRenderer();
  const doc = await openTestDocument(bytes, { renderer } as never);
  const page = await doc.getPage(0);
  const viewport = page.getViewport({ dpi: 96 });
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvasContext: ctx as any, viewport } as any);
  writeFileSync(
    fileURLToPath(new URL('../../../../.cache/page0-doc.png', import.meta.url)),
    canvas.toBuffer('image/png'),
  );
  const line = ctx.getImageData(340, 70, 120, 1).data;
  const reds: number[] = [];
  for (let i = 0; i < line.length; i += 4) {
    if (line[i] > 180 && line[i + 1] < 130) reds.push(i / 4 + 340);
  }
  console.log('DOC_RED_X', reds.length ? `${reds[0]}..${reds[reds.length - 1]} (${reds.length})` : 'NONE');
  // 统计非白像素数量
  const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonWhite = 0;
  for (let i = 0; i < all.length; i += 4) {
    if (all[i] < 250 || all[i + 1] < 250 || all[i + 2] < 250) nonWhite++;
  }
  console.log('NON_WHITE', nonWhite);
});
