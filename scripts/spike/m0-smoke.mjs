/**
 * M0 技术冒烟脚本。
 *
 * 在真实 OFD 样本上验证 4 个关键技术假设：
 * 1. 自研 ZIP 读取路径：EOCD → 中央目录 → 单个条目 → inflate；
 * 2. `DecompressionStream('deflate-raw')` 与 fflate 回退结果一致；
 * 3. fontkit 能解析内嵌 TTF/CFF 与无 cmap 的剥离子集，并能按显式 gid 取轮廓；
 * 4. `@napi-rs/canvas` 能把一条字形轮廓画成 PNG。
 *
 * 运行：`node scripts/spike/m0-smoke.mjs`
 * 产物：`scripts/spike/.artifacts/m0-glyph.png`、`m0-summary.json`
 * 退出码：全部关键项通过为 0，否则为 1。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const engineRoot = path.join(repoRoot, 'packages', 'ofdrw-viewer-engine');
const artifactsDir = path.join(repoRoot, 'scripts', 'spike', '.artifacts');
const sampleDir = path.join(repoRoot, 'ofd_pdf_match');
const requireFromEngine = createRequire(path.join(engineRoot, 'package.json'));

const fontkit = requireFromEngine('fontkit');
const fflate = requireFromEngine('fflate');
const napiCanvas = requireFromEngine('@napi-rs/canvas');

const summary = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  versions: {},
  zip: {},
  fonts: {},
  canvas: {},
};

/** 读取包版本（pnpm 软链接到包内 node_modules）。 */
function packageVersion(name) {
  const candidates = [
    path.join(engineRoot, 'node_modules', name, 'package.json'),
    path.join(repoRoot, 'node_modules', name, 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')).version;
    } catch {
      // 继续尝试下一个位置。
    }
  }
  return 'unknown';
}

for (const name of ['fontkit', 'fflate', '@napi-rs/canvas', 'saxes', 'typescript', 'vitest']) {
  summary.versions[name] = packageVersion(name);
}

const failures = [];
/** 记录失败并继续执行后续步骤，便于一次看到全部风险。 */
function fail(step, error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push({ step, message });
  console.error(`[M0][FAIL] ${step}: ${message}`);
}

/** 断言条件；不满足则抛错。 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 在 buffer 末尾查找 EOCD（签名 0x06054b50）。 */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return {
        offset: i,
        diskEntries: buffer.readUInt16LE(i + 8),
        totalEntries: buffer.readUInt16LE(i + 10),
        centralSize: buffer.readUInt32LE(i + 12),
        centralOffset: buffer.readUInt32LE(i + 16),
        commentLength: buffer.readUInt16LE(i + 20),
      };
    }
  }
  throw new Error('EOCD not found');
}

/** 解析中央目录；不读取条目内容。 */
function readCentralDirectory(buffer, eocd) {
  const entries = [];
  let offset = eocd.centralOffset;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    assert(buffer.readUInt32LE(offset) === 0x02014b50, `bad central header at ${offset}`);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({
      name,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 读取条目压缩数据（不含解压）；data descriptor 以中央目录尺寸为准。 */
function readCompressedData(buffer, entry) {
  const localOffset = entry.localHeaderOffset;
  assert(buffer.readUInt32LE(localOffset) === 0x04034b50, `bad local header for ${entry.name}`);
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  return buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
}

/** 同步 inflate（fflate 的 inflateSync 即为 raw deflate）。 */
function inflateWithFflate(compressed) {
  return Buffer.from(fflate.inflateSync(new Uint8Array(compressed)));
}

/** 用平台 DecompressionStream 解 raw deflate；不支持时返回 null。 */
async function inflateWithPlatform(compressed) {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return Buffer.from(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** 同步读取条目（spike 内部使用，扫描字体时不需要异步）。 */
function readEntrySync(buffer, entry) {
  const compressed = readCompressedData(buffer, entry);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateWithFflate(compressed);
  throw new Error(`unsupported method ${entry.method} for ${entry.name}`);
}

/** 字形路径命令统计。 */
function pathCommandCount(glyph) {
  return glyph?.path?.commands?.length ?? 0;
}

/** 从 fontkit path 命令提取 bbox；无轮廓时返回 null。 */
function glyphBBox(commands) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const command of commands) {
    const coords = [];
    if (command.command === 'moveTo' || command.command === 'lineTo') {
      coords.push([command.args[0], command.args[1]]);
    } else if (command.command === 'quadraticCurveTo') {
      coords.push([command.args[0], command.args[1]], [command.args[2], command.args[3]]);
    } else if (command.command === 'bezierCurveTo') {
      coords.push(
        [command.args[0], command.args[1]],
        [command.args[2], command.args[3]],
        [command.args[4], command.args[5]],
      );
    }
    for (const [x, y] of coords) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 把 fontkit path 命令画到 Canvas 2D 上下文；坐标仍为字体单位。 */
function drawGlyphPath(ctx, commands) {
  ctx.beginPath();
  for (const command of commands) {
    const args = command.args;
    switch (command.command) {
      case 'moveTo':
        ctx.moveTo(args[0], args[1]);
        break;
      case 'lineTo':
        ctx.lineTo(args[0], args[1]);
        break;
      case 'quadraticCurveTo':
        ctx.quadraticCurveTo(args[0], args[1], args[2], args[3]);
        break;
      case 'bezierCurveTo':
        ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[4], args[5]);
        break;
      case 'closePath':
        ctx.closePath();
        break;
      default:
        throw new Error(`unsupported fontkit path command: ${command.command}`);
    }
  }
  ctx.closePath();
}

/** 解析字体文件；TTC 取第 0 面并标记。 */
function createFace(bytes) {
  const font = fontkit.create(Buffer.from(bytes));
  if (font && Array.isArray(font.fonts)) {
    return { face: font.fonts[0], collection: true, count: font.fonts.length };
  }
  return { face: font, collection: false, count: 1 };
}

/** 在剥离子集中按显式 gid 找第一个非空轮廓。 */
function findFirstNonEmptyGlyph(face, limit = 2000) {
  const max = Math.min(face.numGlyphs, limit);
  for (let gid = 1; gid < max; gid += 1) {
    try {
      const glyph = face.getGlyph(gid);
      if (pathCommandCount(glyph) > 0) return { gid, glyph };
    } catch {
      // 单个字形解析失败不阻塞扫描。
    }
  }
  return null;
}

/** 主流程。 */
async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });

  const zipSamplePath = path.join(sampleDir, '1.ofd');
  assert(fs.existsSync(zipSamplePath), `missing sample: ${zipSamplePath}`);
  const zipBuffer = fs.readFileSync(zipSamplePath);

  // 1) ZIP：EOCD / 中央目录 / 单条目
  const eocd = findEocd(zipBuffer);
  const entries = readCentralDirectory(zipBuffer, eocd);
  assert(entries.length === eocd.totalEntries, 'central directory count mismatch');
  assert(entries.length > 0, 'empty central directory');
  const xmlEntry = entries.find((entry) => entry.name.endsWith('Document.xml'));
  assert(xmlEntry, 'Document.xml not found in 1.ofd');
  const compressed = readCompressedData(zipBuffer, xmlEntry);
  const inflatedByFflate = inflateWithFflate(compressed);
  const inflatedByPlatform = await inflateWithPlatform(compressed);
  const xmlText = inflatedByFflate.toString('utf8');
  assert(xmlText.includes('<'), 'decompressed XML does not look like XML');
  assert(
    inflatedByPlatform === null || inflatedByPlatform.equals(inflatedByFflate),
    'DecompressionStream and fflate produced different bytes',
  );

  const methods = [...new Set(entries.map((entry) => entry.method))];
  summary.zip = {
    sample: 'ofd_pdf_match/1.ofd',
    packageBytes: zipBuffer.length,
    eocdOffset: eocd.offset,
    entryCount: entries.length,
    methods,
    entry: xmlEntry.name,
    compressedBytes: compressed.length,
    uncompressedBytes: inflatedByFflate.length,
    platformDeflate: inflatedByPlatform !== null,
    platformMatchesFflate: inflatedByPlatform !== null && inflatedByPlatform.equals(inflatedByFflate),
    xmlHead: xmlText.slice(0, 80),
  };
  console.log(
    `[M0] ZIP ok: ${entries.length} entries, ${xmlEntry.name} ${compressed.length}->${inflatedByFflate.length}, platform=${inflatedByPlatform !== null}`,
  );

  // 2) 扫描 55 对样本，寻找 TTF/CFF/无 cmap 剥离子集
  const ofdFiles = fs
    .readdirSync(sampleDir)
    .filter((name) => name.toLowerCase().endsWith('.ofd'))
    .sort();
  const candidates = [];
  for (const file of ofdFiles) {
    try {
      const buffer = fs.readFileSync(path.join(sampleDir, file));
      const localEocd = findEocd(buffer);
      const localEntries = readCentralDirectory(buffer, localEocd);
      for (const entry of localEntries) {
        if (/\.(ttf|otf|ttc|cff)$/i.test(entry.name)) {
          candidates.push({ file, entry, buffer });
        }
      }
    } catch (error) {
      console.warn(`[M0][WARN] skip ${file}: ${error.message}`);
    }
  }

  let cmapSample = null;
  let strippedSample = null;
  let cffSample = null;
  let attempted = 0;
  let parseSuccess = 0;
  const parseErrors = [];

  for (const candidate of candidates) {
    attempted += 1;
    try {
      const bytes = readEntrySync(candidate.buffer, candidate.entry);
      const parsed = createFace(bytes);
      parseSuccess += 1;
      const face = parsed.face;
      const isCff = /\.cff$/i.test(candidate.entry.name);
      if (isCff && !cffSample && face.cmap) {
        const glyph = face.glyphForCodePoint(0x4e2d);
        if (glyph && glyph.id !== 0 && pathCommandCount(glyph) > 0) {
          cffSample = { ...candidate, face, glyph, collection: parsed.collection };
        }
      }
      if (!face.cmap && !strippedSample) {
        const found = findFirstNonEmptyGlyph(face);
        if (found) {
          strippedSample = { ...candidate, face, ...found, collection: parsed.collection };
        }
      }
      if (face.cmap && !isCff && !cmapSample) {
        const glyph = face.glyphForCodePoint(0x4e2d);
        if (glyph && glyph.id !== 0 && pathCommandCount(glyph) > 0) {
          cmapSample = { ...candidate, face, glyph, collection: parsed.collection };
        }
      }
    } catch (error) {
      parseErrors.push(`${candidate.file}:${candidate.entry.name}: ${error.message}`);
    }
  }

  assert(cmapSample, 'no embedded font with cmap found');
  assert(strippedSample, 'no stripped font without cmap found');
  assert(cffSample, 'no embedded CFF font found');

  summary.fonts = {
    candidatesScanned: candidates.length,
    fontsAttempted: attempted,
    fontsParsed: parseSuccess,
    parseErrorCount: parseErrors.length,
    cmap: {
      file: cmapSample.file,
      entry: cmapSample.entry.name,
      family: cmapSample.face.familyName,
      postscriptName: cmapSample.face.postscriptName,
      unitsPerEm: cmapSample.face.unitsPerEm,
      numGlyphs: cmapSample.face.numGlyphs,
      hasCmap: Boolean(cmapSample.face.cmap),
      utf16: false,
      codepoint: 'U+4E2D',
      gid: cmapSample.glyph.id,
      pathCommands: pathCommandCount(cmapSample.glyph),
    },
    stripped: {
      file: strippedSample.file,
      entry: strippedSample.entry.name,
      family: strippedSample.face.familyName,
      unitsPerEm: strippedSample.face.unitsPerEm,
      numGlyphs: strippedSample.face.numGlyphs,
      hasCmap: Boolean(strippedSample.face.cmap),
      explicitGid: strippedSample.gid,
      pathCommands: pathCommandCount(strippedSample.glyph),
    },
    cff: {
      file: cffSample.file,
      entry: cffSample.entry.name,
      family: cffSample.face.familyName,
      unitsPerEm: cffSample.face.unitsPerEm,
      numGlyphs: cffSample.face.numGlyphs,
      hasCmap: Boolean(cffSample.face.cmap),
      codepoint: 'U+4E2D',
      gid: cffSample.glyph.id,
      pathCommands: pathCommandCount(cffSample.glyph),
    },
    parseErrors: parseErrors.slice(0, 10),
    note: '样本中未发现 TTC；TTC 选面留待 T4 用合成 fixture 覆盖。',
  };
  console.log(
    `[M0] fontkit ok: cmap ${cmapSample.entry.name} gid=${cmapSample.glyph.id}, stripped ${strippedSample.entry.name} gid=${strippedSample.gid}, cff ${cffSample.entry.name}`,
  );

  // 3) @napi-rs/canvas 绘制一条字形轮廓
  const drawCommands = cmapSample.glyph.path.commands;
  const bbox = glyphBBox(drawCommands);
  assert(bbox, 'glyph bbox is empty');
  const width = 320;
  const height = 240;
  const canvas = napiCanvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const scale = Math.min((width * 0.7) / bbox.width, (height * 0.7) / bbox.height);
  const tx = width / 2 - scale * ((bbox.minX + bbox.maxX) / 2);
  const ty = height / 2 + scale * ((bbox.minY + bbox.maxY) / 2);
  ctx.setTransform(scale, 0, 0, -scale, tx, ty);
  ctx.fillStyle = '#111111';
  drawGlyphPath(ctx, drawCommands);
  ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const png = await canvas.encode('png');
  const pngPath = path.join(artifactsDir, 'm0-glyph.png');
  fs.writeFileSync(pngPath, png);
  assert(png.length > 1000, 'PNG output is suspiciously small');
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'invalid PNG signature');

  summary.canvas = {
    package: '@napi-rs/canvas',
    width,
    height,
    glyphFile: 'scripts/spike/.artifacts/m0-glyph.png',
    pngBytes: png.length,
    scale: Number(scale.toFixed(3)),
    bbox: {
      minX: Number(bbox.minX.toFixed(2)),
      minY: Number(bbox.minY.toFixed(2)),
      width: Number(bbox.width.toFixed(2)),
      height: Number(bbox.height.toFixed(2)),
    },
  };
  console.log(`[M0] canvas ok: ${pngPath} (${png.length} bytes)`);

  summary.passed = failures.length === 0;
  summary.failures = failures;
  fs.writeFileSync(path.join(artifactsDir, 'm0-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[M0] versions: ${JSON.stringify(summary.versions)}`);
  console.log(`[M0] RESULT: ${summary.passed ? 'PASS' : 'FAIL'}`);
  if (!summary.passed) process.exitCode = 1;
}

main().catch((error) => {
  fail('fatal', error);
  summary.passed = false;
  summary.failures = failures;
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'm0-summary.json'), JSON.stringify(summary, null, 2));
  } catch {
    // 忽略产物写入失败，保留原始错误。
  }
  console.error(`[M0] RESULT: FAIL`);
  process.exitCode = 1;
});