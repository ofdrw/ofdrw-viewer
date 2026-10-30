/**
 * 注释类型探测（设计方案 §I.3）。
 *
 * 引擎没有公开的“本页注释类型列表”接口，这里只用公开的 `page.getTextContent()`
 * 做白名单试探：对每个候选类型单独请求“只看该类型注释”的文本，只要返回任意
 * `layer === 'annotation'` 的文本项，就判定该类型在本页出现。
 *
 * 探测是纯读取：不触发渲染、不写状态、不发事件；失败（不支持/抛错/无文字外观）
 * 一律降级为“没有追加类型”，由调用方只列常见五类，不重试也不告警。
 */

import type { AnnotationType, TextContent } from '@ofdrw/ofdrw-viewer-engine';
import type { EngineDocument, EnginePage } from '../document-controller';
import {
  annotationTypeProbeCandidates,
  annotationTypesForGroup,
  knownAnnotationTypes,
} from './content-filter';

/** 探测用的低分辨率（只判断形状与文字是否存在，不关心清晰度）。 */
const PROBE_DPI = 4;

/** 探测文本收集所需的页面能力。 */
type ProbePage = Pick<EnginePage, 'getTextContent'>;

/**
 * 探测某一页实际出现的不常见注释类型。
 *
 * @param page 引擎页。
 * @param signal 取消信号。
 * @returns 追加类型（字典序）；无追加类型返回空数组，探测不受支持时返回 null。
 */
export async function probePageAnnotationTypes(
  page: ProbePage,
  signal: AbortSignal,
): Promise<readonly AnnotationType[] | null> {
  if (typeof page.getTextContent !== 'function') return null;
  const known = knownAnnotationTypes();
  const found: AnnotationType[] = [];
  for (const candidate of annotationTypeProbeCandidates()) {
    if (signal.aborted) return null;
    if (known.indexOf(candidate) >= 0) continue;
    let content: TextContent;
    try {
      content = await page.getTextContent({
        dpi: PROBE_DPI,
        includeChars: false,
        includeAnnotations: true,
        includeInvisible: false,
        contentFilter: { annotations: true, annotationTypes: [candidate] },
        signal,
      });
    } catch {
      // 该类型不存在或无文字外观时引擎可能返回空内容或抛错；两者都视为“未出现”。
      continue;
    }
    if (signal.aborted) return null;
    if (hasAnnotationText(content)) found.push(candidate);
  }
  return found;
}

/**
 * 统计内容里是否含注释文本项。
 *
 * @param content 引擎文本内容。
 * @returns 含注释文本返回 true。
 */
function hasAnnotationText(content: TextContent): boolean {
  const items = content.items ?? [];
  for (const item of items) {
    if (item.layer === 'annotation') return true;
  }
  return false;
}

/**
 * 通过文档控制器读取某页并探测其追加注释类型。
 *
 * @param controller 文档控制器。
 * @param pageIndex 页索引，0-based。
 * @returns 追加类型（字典序）；无法探测时返回 null。
 */
export async function probeAnnotationTypesForPage(
  controller: Pick<EngineDocument, 'getPage'>,
  pageIndex: number,
): Promise<readonly AnnotationType[] | null> {
  let page: ProbePage;
  try {
    page = await controller.getPage(pageIndex);
  } catch {
    return null;
  }
  const result = await probePageAnnotationTypes(page, new AbortController().signal);
  if (result === null) return null;
  return annotationTypesForGroup(result).filter(
    (type) => knownAnnotationTypes().indexOf(type) < 0,
  );
}
