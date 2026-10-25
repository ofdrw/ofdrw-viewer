import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { openTestDocument, createTestRenderer } from './helpers';
import { drawPage } from '../../src/render/page';

it('direct drawPage', async () => {
  const path = fileURLToPath(new URL('../../../../ofd_pdf_match/draw_param_ref.ofd', import.meta.url));
  const bytes = new Uint8Array(readFileSync(path));
  const renderer = createTestRenderer();
  const doc = await openTestDocument(bytes, { renderer } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDoc = doc as any;
  const page = await doc.getPage(0);
  await page.prepare({});
  const entry = [...anyDoc.preparedBundles.values()][0];
  const viewport = page.getViewport({ dpi: 96 });
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const warns: unknown[] = [];
  drawPage(entry.bundle, renderer, ctx as never, viewport, {
    onWarning: (w: unknown) => warns.push(w),
  });
  writeFileSync(
    fileURLToPath(new URL('../../../../.cache/page0-direct.png', import.meta.url)),
    canvas.toBuffer('image/png'),
  );
  console.log('DIRECT_WARNS', JSON.stringify(warns));
  const line = ctx.getImageData(340, 70, 120, 1).data;
  const reds: number[] = [];
  for (let i = 0; i < line.length; i += 4) {
    if (line[i] > 180 && line[i + 1] < 130) reds.push(i / 4 + 340);
  }
  console.log('RED_X', reds.length ? `${reds[0]}..${reds[reds.length - 1]} (${reds.length})` : 'NONE');
});
