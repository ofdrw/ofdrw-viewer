/**
 * 生成「只声明黑体、不内嵌字体」的最小 OFD 夹具。
 *
 * 仓库中的真实样本虽声明 `FontName="黑体"`，但页面从未引用该字体（TextObject 的
 * `Font` 指向宋体/楷体），无法验证「黑体类文档的字体兜底」。本脚本生成一份恒定
 * 夹具：PublicRes 只声明黑体且无 FontFile，页面正文全部使用 Font="5"。
 *
 * 输出：site/test/fixtures/black-font-only.ofd
 * 运行：node scripts/make-black-font-fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** 从已安装的 workspace 依赖中定位 fflate，避免为一次性脚本新增根依赖。 */
async function loadFflate() {
  const candidates = [
    '../node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs',
    '../packages/ofdrw-viewer-ui/node_modules/fflate/esm/index.mjs',
  ];
  for (const candidate of candidates) {
    try {
      return await import(new URL(candidate, import.meta.url).href);
    } catch {
      // 尝试下一个候选路径。
    }
  }
  throw new Error('找不到 fflate；请先在仓库内执行 pnpm install');
}

const { zipSync, strToU8 } = await loadFflate();

/** 仓库根目录。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 输出路径。 */
const OUT = resolve(REPO_ROOT, 'site/test/fixtures/black-font-only.ofd');

const NS = 'xmlns:ofd="http://www.ofdspec.org/2016"';
const HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * 构造一个使用黑体的文本对象。
 *
 * @param id 对象 ID
 * @param x 左边界，单位 mm
 * @param y 上边界，单位 mm
 * @param size 字号，单位 mm
 * @param text 文本内容
 * @returns TextObject XML
 */
function textObject(id, x, y, size, text) {
  const deltaX = Array.from({ length: [...text].length }, () => size).join(' ');
  return (
    `<ofd:TextObject ID="${id}" Boundary="${x} ${y} 150 ${size + 1}" Font="5" Size="${size}">` +
    `<ofd:TextCode X="0" Y="${size}" DeltaX="${deltaX}">${text}</ofd:TextCode></ofd:TextObject>`
  );
}

const files = {
  'OFD.xml': strToU8(
    `${HEADER}<ofd:OFD ${NS} Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocInfo>` +
      `<ofd:DocID>site-black-font-fixture</ofd:DocID><ofd:CreationDate>2026-01-01</ofd:CreationDate>` +
      `<ofd:Creator>ofdrw-viewer site fixture</ofd:Creator></ofd:DocInfo>` +
      `<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
  ),
  'Doc_0/Document.xml': strToU8(
    `${HEADER}<ofd:Document ${NS}><ofd:CommonData><ofd:PageArea>` +
      `<ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox>` +
      `<ofd:ApplicationBox>0 0 210 297</ofd:ApplicationBox></ofd:PageArea>` +
      `<ofd:PublicRes>PublicRes.xml</ofd:PublicRes><ofd:MaxUnitID>20</ofd:MaxUnitID>` +
      `</ofd:CommonData><ofd:Pages>` +
      `<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>`,
  ),
  // 只声明字体名、无 FontFile：文字渲染必须依赖宿主提供的字体。
  'Doc_0/PublicRes.xml': strToU8(
    `${HEADER}<ofd:Res ${NS} BaseLoc="Res"><ofd:Fonts>` +
      `<ofd:Font FontName="黑体" FamilyName="黑体" ID="5"/>` +
      `</ofd:Fonts></ofd:Res>`,
  ),
  'Doc_0/Pages/Page_0/Content.xml': strToU8(
    `${HEADER}<ofd:Page ${NS}><ofd:Content><ofd:Layer ID="1">` +
      textObject(10, 30, 30, 8, '黑体兜底测试') +
      textObject(11, 30, 45, 5, '本文档仅声明黑体且未内嵌字体文件') +
      textObject(12, 30, 55, 5, '无字体时应整页空白，配置思源黑体后应可见') +
      textObject(13, 30, 65, 5, 'ABCDEFG 0123456789 中文混排测试') +
      `</ofd:Layer></ofd:Content></ofd:Page>`,
  ),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zipSync(files, { level: 9 }));
console.log(`已生成 ${OUT}`);
