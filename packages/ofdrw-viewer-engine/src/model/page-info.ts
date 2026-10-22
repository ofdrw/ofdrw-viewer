/**
 * 轻量页面区域读取（getPageInfos 专用）。
 *
 * 只扫描 Page.xml 中 `Area/PhysicalBox` 与页级 `Template@TemplateID`，不构建
 * XML 树、不解码 Content/图层/资源；页尺寸回退仍由 `page-area.ts` 统一处理。
 */

import type { Box } from '../common/types';
import type { OFDWarning } from '../warnings';
import type { ResourceId, TemplateRef } from './types';
import { decodeBoundary, emitWarning } from './decode-utils';

/** 轻量页区域信息。 */
export interface PageAreaInfo {
  /** 页面 PhysicalBox；缺失/非法时为 undefined。 */
  area?: Box;
  /** 按 XML 顺序排列的模板引用；仅含 TemplateID。 */
  templates: TemplateRef[];
}

/** 匹配一个 XML 元素（允许命名空间前缀）。 */
const areaPattern = /<(?:[\w.-]+:)?Area\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Area\s*>/i;
/** 匹配 PhysicalBox 文本内容。 */
const physicalBoxPattern =
  /<(?:[\w.-]+:)?PhysicalBox\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?PhysicalBox\s*>/i;
/** 匹配页级 Template 开始标签。 */
const templatePattern = /<(?:[\w.-]+:)?Template\b([^>]*?)(?:\/?)>/gi;
/** 匹配 XML 属性。 */
const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** 匹配 Content 开始标签，用于截断页头扫描。 */
const contentPattern = /<(?:[\w.-]+:)?Content\b/i;

/**
 * 扫描 Page.xml 字节，读取页区域与模板引用。
 *
 * 只读取 Content 之前的页头；发现 DTD/ENTITY 时拒绝解析并按缺失 Area 回退。
 *
 * @param bytes Page.xml 原始字节。
 * @param pageId 页面资源 ID，用于诊断。
 * @param onWarning warning 回调。
 * @returns 页区域与模板引用。
 */
export function decodePageAreaXml(
  bytes: Uint8Array,
  pageId: ResourceId,
  onWarning?: (warning: OFDWarning) => void,
): PageAreaInfo {
  const context = onWarning ? { onWarning } : undefined;
  let text = '';
  try {
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    emitWarning(context, 'W_BAD_NUMBER', `第 ${pageId} 页 Content.xml 不是有效 UTF-8`);
    return { templates: [] };
  }
  if (!text.trim()) {
    emitWarning(context, 'W_BAD_NUMBER', `第 ${pageId} 页 Content.xml 为空`);
    return { templates: [] };
  }
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) {
    emitWarning(context, 'W_BAD_NUMBER', `第 ${pageId} 页 Content.xml 含 DTD/实体声明，已拒绝`);
    return { templates: [] };
  }

  const contentStart = text.search(contentPattern);
  const header = contentStart >= 0 ? text.slice(0, contentStart) : text;
  const areaMatch = areaPattern.exec(header);
  let area: Box | undefined;
  // 缺失 Area/PhysicalBox 不在此处提示：页尺寸由上层按页 → 模板 → CommonData →
  // A4 统一回退，只有最终回退 A4 才产生 warning（见 page-area.ts）。
  if (areaMatch) {
    const boxMatch = physicalBoxPattern.exec(areaMatch[1] ?? '');
    if (boxMatch) {
      // 与 getPageEntry/decodePageContent 使用同一 Boundary 归一化语义。
      area = decodeBoundary(boxMatch[1]?.trim(), context, false);
      // 显式 Area/PhysicalBox 宽高非正仍是坏值；缺失 Area 不在此处提示。
      if (area.w <= 0 || area.h <= 0) {
        emitWarning(context, 'W_BAD_NUMBER', `PhysicalBox 宽高非正：${area.w} × ${area.h}`);
      }
      if (area.x !== 0 || area.y !== 0) {
        emitWarning(
          context,
          'W_PHYSICALBOX_ORIGIN',
          `PhysicalBox 原点非零：(${area.x}, ${area.y})；页尺寸仍取 width/height`,
        );
      }
    }
  }

  const templates: TemplateRef[] = [];
  templatePattern.lastIndex = 0;
  for (let match = templatePattern.exec(header); match; match = templatePattern.exec(header)) {
    const attrs = match[1] ?? '';
    let id = '';
    attributePattern.lastIndex = 0;
    for (let attr = attributePattern.exec(attrs); attr; attr = attributePattern.exec(attrs)) {
      if (attr[1] === 'TemplateID') {
        id = (attr[2] ?? attr[3] ?? '').trim();
        break;
      }
    }
    if (!id) {
      emitWarning(context, 'W_BAD_NUMBER', 'Template 缺少 TemplateID，已跳过');
      continue;
    }
    templates.push({ id });
  }
  return { area, templates };
}
