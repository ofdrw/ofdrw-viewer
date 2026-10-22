/**
 * 生成 E2E 专用大文档与签章降级夹具。
 *
 * - thousand.ofd：1000 页、每页一行文本，嵌入 SimSun 子集，用于性能与虚拟化验收；
 * - signature-missing-value.ofd：删除 SignedValue.dat，用于签章信息不完整降级验收。
 *
 * 生成结果位于 test/acceptance/fixtures（已 gitignore），不进入提交。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = resolve(packageRoot, '../..');
const outputDir = resolve(packageRoot, 'test/acceptance/fixtures');
const sourceDir = resolve(repositoryRoot, 'ofd_pdf_match');
mkdirSync(outputDir, { recursive: true });

const thousandPath = resolve(outputDir, 'thousand.ofd');
if (!existsSync(thousandPath)) {
  const dense = unzipSync(readFileSync(resolve(sourceDir, 'dense-text-perf.ofd')));
  const font = dense['Doc_0/Res/SimSun.ttf'];
  if (!font) throw new Error('dense-text-perf.ofd 缺少 SimSun.ttf');
  const pageCount = 1000;
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
  const ns = 'xmlns:ofd="http://www.ofdspec.org/2016"';
  const pages = [];
  const files = {};
  files['OFD.xml'] = new TextEncoder().encode(
    `${xmlHeader}<ofd:OFD ${ns} Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocInfo><ofd:DocID>e2e-thousand-pages</ofd:DocID><ofd:CreationDate>2026-01-01</ofd:CreationDate><ofd:Creator>ofdrw-viewer-ui e2e</ofd:Creator></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
  );
  files['Doc_0/PublicRes.xml'] = new TextEncoder().encode(
    `${xmlHeader}<ofd:Res ${ns} BaseLoc="Res"><ofd:Fonts><ofd:Font ID="1" FontName="SimSun" FamilyName="宋体" Charset="unicode"><ofd:FontFile>SimSun.ttf</ofd:FontFile></ofd:Font></ofd:Fonts></ofd:Res>`,
  );
  files['Doc_0/Res/SimSun.ttf'] = font;
  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = index + 1;
    pages.push(`<ofd:Page ID="${pageNumber}" BaseLoc="Pages/Page_${index}/Content.xml"/>`);
    const text = `第 ${pageNumber} 页 OFD 千页性能测试 hello world keyword`;
    const deltaX = Array.from(text, (char) => (char.codePointAt(0) > 0x2e80 ? 3.2 : 1.6)).join(' ');
    files[`Doc_0/Pages/Page_${index}/Content.xml`] = new TextEncoder().encode(
      `${xmlHeader}<ofd:Page ${ns}><ofd:Content><ofd:Layer ID="1"><ofd:TextObject ID="${100 + pageNumber}" Boundary="10 10 150 6" Font="1" Size="3"><ofd:TextCode X="0" Y="3" DeltaX="${deltaX}">${text}</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`,
    );
  }
  files['Doc_0/Document.xml'] = new TextEncoder().encode(
    `${xmlHeader}<ofd:Document ${ns}><ofd:CommonData><ofd:MaxUnitID>${100 + pageCount}</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox><ofd:ApplicationBox>0 0 210 297</ofd:ApplicationBox></ofd:PageArea><ofd:PublicRes>PublicRes.xml</ofd:PublicRes></ofd:CommonData><ofd:Pages>${pages.join('')}</ofd:Pages></ofd:Document>`,
  );
  writeFileSync(thousandPath, zipSync(files, { level: 0 }));
}

const missingValuePath = resolve(outputDir, 'signature-missing-value.ofd');
if (!existsSync(missingValuePath)) {
  const source = unzipSync(readFileSync(resolve(sourceDir, 'SESV4SignDoc.ofd')));
  delete source['Doc_0/Signs/Sign_0/SignedValue.dat'];
  writeFileSync(missingValuePath, zipSync(source, { level: 0 }));
}

console.log(
  `E2E fixtures ready: thousand=${(readFileSync(thousandPath).byteLength / 1024).toFixed(0)}KiB, missing=${(
    readFileSync(missingValuePath).byteLength / 1024
  ).toFixed(0)}KiB`,
);
