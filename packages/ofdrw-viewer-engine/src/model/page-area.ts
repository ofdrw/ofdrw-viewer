/**
 * 页尺寸回退链（设计方案 8.2）。
 *
 * 顺序：页面 `Area/PhysicalBox` → 按 Template 引用顺序找到的第一个带 Area 的模板页
 * → `CommonData/PageArea` → A4（210×297 mm）。宽或高 ≤0/非有限值视为缺失。
 */

import type { Box } from '../common/types';
import type { OFDWarning } from '../warnings';
import type { PageModel, PageSize, ResourceId } from './types';

/** 模板页候选；按页面 Template 引用顺序传入。 */
export interface PageAreaCandidate {
  /** 模板页 ID，仅用于诊断。 */
  id?: ResourceId;
  /** 模板页 Area；缺失/非法时跳过。 */
  area?: Box;
}

/** 页尺寸解析输入。 */
export interface ResolvePageAreaInput {
  /** 页面自己的 PhysicalBox。 */
  pageArea?: Box;
  /** 模板页候选，按页面 Template 引用顺序排列。 */
  templateAreas?: readonly PageAreaCandidate[];
  /** CommonData/PageArea。 */
  commonDataArea?: Box;
  /** warning 回调。 */
  onWarning?: (warning: OFDWarning) => void;
}

/** 页尺寸来源。 */
export type PageAreaSource = 'page' | 'template' | 'common-data' | 'fallback';

/** 页尺寸解析结果。 */
export interface PageAreaResolution {
  /** 页面坐标区域；使用模板/CommonData 回退时原点归零。 */
  area: Box;
  /** 页尺寸，单位 mm。 */
  size: PageSize;
  /** 命中的回退层级。 */
  source: PageAreaSource;
  /** 命中的模板 ID（source=template 时）。 */
  templateId?: ResourceId;
}

/** A4 尺寸，单位 mm。 */
export const A4_PAGE_SIZE: Readonly<PageSize> = Object.freeze({ width: 210, height: 297 });

/**
 * 判断 Area 是否可用于页尺寸：宽高有限且均大于 0。
 *
 * @param area 候选区域。
 * @returns 是否有效。
 */
export function isValidPageArea(area: Box | undefined): boolean {
  if (!area) return false;
  return (
    Number.isFinite(area.x) &&
    Number.isFinite(area.y) &&
    Number.isFinite(area.w) &&
    Number.isFinite(area.h) &&
    area.w > 0 &&
    area.h > 0
  );
}

/**
 * 按回退链解析页尺寸。
 *
 * @param input 页面/模板/CommonData 候选。
 * @returns 解析结果；始终返回有效尺寸（最终 A4）。
 */
export function resolvePageArea(input: ResolvePageAreaInput): PageAreaResolution {
  const warn = (message: string): void => {
    input.onWarning?.({ code: 'W_BAD_NUMBER', message });
  };

  const pageArea = input.pageArea;
  if (pageArea !== undefined && isValidPageArea(pageArea)) {
    return {
      area: { ...pageArea },
      size: { width: pageArea.w, height: pageArea.h },
      source: 'page',
    };
  }
  if (pageArea) warn(`页面 PhysicalBox 尺寸非正：${pageArea.w} × ${pageArea.h}，进入回退链`);

  for (const candidate of input.templateAreas ?? []) {
    const area = candidate.area;
    if (area === undefined || !isValidPageArea(area)) {
      if (area) {
        warn(`模板 ${candidate.id ?? '(无 ID)'} 的 Area 尺寸非正，跳过`);
      }
      continue;
    }
    return {
      area: { x: 0, y: 0, w: area.w, h: area.h },
      size: { width: area.w, height: area.h },
      source: 'template',
      ...(candidate.id ? { templateId: candidate.id } : {}),
    };
  }

  const commonDataArea = input.commonDataArea;
  if (commonDataArea !== undefined && isValidPageArea(commonDataArea)) {
    return {
      area: { x: 0, y: 0, w: commonDataArea.w, h: commonDataArea.h },
      size: { width: commonDataArea.w, height: commonDataArea.h },
      source: 'common-data',
    };
  }

  warn(`页尺寸回退到 A4：${A4_PAGE_SIZE.width} × ${A4_PAGE_SIZE.height} mm`);
  return {
    area: { x: 0, y: 0, w: A4_PAGE_SIZE.width, h: A4_PAGE_SIZE.height },
    size: { width: A4_PAGE_SIZE.width, height: A4_PAGE_SIZE.height },
    source: 'fallback',
  };
}

/**
 * 把页尺寸解析结果写回 PageModel（返回新对象，不修改入参）。
 *
 * @param page 页面模型。
 * @param resolution 解析结果。
 * @returns 更新 area/size 后的页面模型。
 */
export function applyPageArea(page: PageModel, resolution: PageAreaResolution): PageModel {
  return {
    ...page,
    area: { ...resolution.area },
    size: { ...resolution.size },
  };
}