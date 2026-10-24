/**
 * 页面绘制入口。
 *
 * 绘制阶段同步执行：beginPage → identity → setTransform(M_page) → 图层/模板顺序 →
 * 注释 → endPage。不解析 DrawParam、不查资源、不直接调用 Canvas（除透传 ctx）。
 */

import type { PageModel, Layer, PageObject, ResourceId } from '../model/types';
import type { PreparedPageBundle } from './prepare';
import type { Renderer, CanvasRenderingContext2DLike } from '../renderer/types';
import type { Matrix, Viewport } from '../common/types';
import type { WarningHandler } from '../warnings';
import { IDENTITY_MATRIX, invertMatrix, multiplyMatrix, translateMatrix } from '../common/matrix';
import { createPaintBinder } from './paint';
import { drawBlock, drawObjects, resolveDisplayImage } from './object';
import { replayDisplayList } from './display-list';
import { wrapPatternBinder } from './prepare';
import type { ImageSubstitutionMode } from './image';
import type { PageContentFilter } from './content-filter';
import {
  isAnnotationTypeVisible,
  isPageLayerVisible,
  isSignatureVisible,
  isTemplateLayerVisible,
  resolveContentFilter,
} from './content-filter';

/** 页面图层类型顺序（设计方案图 16）。 */
const LAYER_TYPES: readonly Layer['type'][] = ['Background', 'Body', 'Foreground', 'Custom'];

/** 页面绘制选项。 */
export interface DrawPageOptions {
  /** 图层顺序：默认 `type`，`document` 为严格 XML 顺序。 */
  layerOrder?: 'document' | 'type';
  /** 图片缺 CTM 时是否严格 identity，默认 true。 */
  strictImageCtm?: boolean;
  /** 替换图选择模式，默认 auto。 */
  substitutionMode?: ImageSubstitutionMode;
  /** 取消信号；每个对象检查一次。 */
  signal?: AbortSignal;
  /** warning 回调。 */
  onWarning?: WarningHandler;
  /** 页索引，从 0 开始；仅用于 warning。 */
  pageIndex?: number;
  /** 页级绘制内容白名单；不传表示全部绘制。 */
  contentFilter?: PageContentFilter;
}

/** 页面绘制顺序项；模板/页图层按绘制顺序展开，注释块单独一项。 */
export type PageDrawEntry =
  | {
      /** 模板图层或页面图层。 */
      kind: 'template' | 'page';
      /** 图层类型。 */
      layerType: Layer['type'];
      /** 该图层按 XML 顺序的绘制对象。 */
      objects: readonly PageObject[];
      /** 模板页 ID；页面图层为 undefined。 */
      templateId?: ResourceId;
      /** 模板有效 ZOrder；页面图层为 undefined。 */
      zOrder?: 'Background' | 'Body' | 'Foreground';
    }
  | {
      /** 注释外观块。 */
      kind: 'annotation';
      /** 准备阶段构建的注释独立块。 */
      block: import('../model/types').IndependentBlock;
    };

/** 页面绘制顺序选项。 */
export interface PageDrawOrderOptions {
  /** 图层顺序：默认 `type`，`document` 为严格 XML 顺序。 */
  layerOrder?: 'document' | 'type';
  /** 是否在末尾返回注释块，默认 false。 */
  includeAnnotations?: boolean;
  /** warning 回调；用于模板缺失与非法图层顺序。 */
  onWarning?: WarningHandler;
  /** 页级绘制内容白名单；不传表示全部绘制。 */
  contentFilter?: PageContentFilter;
}

/**
 * 解析页面绘制顺序，供绘制与文本收集共用。
 *
 * 顺序与 `drawPage` 一致：type 模式按 Background/Body/Foreground/Custom，
 * 每组先模板（按页面引用顺序）后页图层；document 模式模板整体在前。模板
 * 组内按模板自身图层类型 + XML 顺序；注释块始终最后。
 *
 * 过滤在同一次展开中统一应用：页面图层按 `Layer/@Type` 判定，模板图层按
 * `Template/@ZOrder` 判定（不看模板内部图层类型），注释按 `annotationType` 白名单判定。
 *
 * @param prepared 已准备的页面。
 * @param options 图层顺序、注释、内容过滤与 warning 选项。
 * @returns 按绘制顺序展开的图层项与可选注释项。
 */
export function resolvePageDrawOrder(
  prepared: PreparedPageBundle,
  options: PageDrawOrderOptions = {},
): PageDrawEntry[] {
  const page = prepared.page.page;
  const warn = (code: string, message: string, objectId?: ResourceId): void => {
    options.onWarning?.({ code, message, ...(objectId !== undefined ? { objectId } : {}) });
  };
  const rawOrder = options.layerOrder ?? 'type';
  if (rawOrder !== 'document' && rawOrder !== 'type') {
    warn('W_LAYER_ORDER', `未知图层顺序 ${String(rawOrder)}，已按 type 处理`);
  }
  const layerOrder = rawOrder === 'document' ? 'document' : 'type';
  const filter = resolveContentFilter(options.contentFilter);
  const templates = resolveTemplates(page, prepared.templates, warn);
  const entries: PageDrawEntry[] = [];
  const pushLayer = (
    layer: Layer,
    template?: { id: ResourceId; zOrder: 'Background' | 'Body' | 'Foreground' },
  ): void => {
    if (layer.children.length === 0) return;
    const visible = template
      ? isTemplateLayerVisible(filter, template.zOrder)
      : isPageLayerVisible(filter, layer.type);
    if (!visible) return;
    entries.push({
      kind: template ? 'template' : 'page',
      layerType: layer.type,
      objects: layer.children,
      ...(template ? { templateId: template.id, zOrder: template.zOrder } : {}),
    });
  };

  if (layerOrder === 'document') {
    for (const template of templates) {
      for (const layer of template.model.layers) {
        pushLayer(layer, { id: template.model.id, zOrder: templateZOrder(template.ref) });
      }
    }
    for (const layer of page.layers) pushLayer(layer);
  } else {
    for (const type of LAYER_TYPES) {
      for (const template of templates) {
        const zOrder = templateZOrder(template.ref);
        if (zOrder !== type) continue;
        for (const templateType of LAYER_TYPES) {
          for (const layer of template.model.layers) {
            if (layer.type !== templateType) continue;
            pushLayer(layer, { id: template.model.id, zOrder });
          }
        }
      }
      for (const layer of page.layers) {
        if (layer.type !== type) continue;
        pushLayer(layer);
      }
    }
  }

  if (options.includeAnnotations) {
    for (const block of prepared.page.annotationBlocks) {
      if (!isAnnotationTypeVisible(filter, block.annotationType)) continue;
      entries.push({ kind: 'annotation', block });
    }
  }
  return entries;
}

/**
 * 绘制已准备的页面。
 *
 * @param prepared 准备阶段产物（含模板、字体、图片与独立块运行时）。
 * @param renderer 目标渲染器。
 * @param canvasContext 宿主 2D 上下文，仅透传给 renderer。
 * @param viewport 页面像素尺寸与 DPI。
 * @param options 图层顺序、内容过滤、取消与 warning 选项。
 */
export function drawPage(
  prepared: PreparedPageBundle,
  renderer: Renderer,
  canvasContext: CanvasRenderingContext2DLike,
  viewport: Viewport,
  options: DrawPageOptions = {},
): void {
  const page = prepared.page.page;
  const warn = (code: string, message: string, objectId?: string): void => {
    options.onWarning?.({
      code,
      message,
      ...(options.pageIndex !== undefined ? { pageIndex: options.pageIndex } : {}),
      ...(objectId !== undefined ? { objectId } : {}),
    });
  };

  const scale = viewport.dpi / 25.4;
  const pageMatrix: Matrix = [
    scale,
    0,
    0,
    scale,
    -scale * page.area.x,
    -scale * page.area.y,
  ];
  if (page.area.x !== 0 || page.area.y !== 0) {
    warn(
      'W_PHYSICALBOX_ORIGIN',
      `页面 PhysicalBox 原点非零（${page.area.x}, ${page.area.y}），已按绝对坐标平移`,
    );
  }

  let currentObjectMatrix: Matrix | null = null;
  const inversePageMatrix = invertMatrix(pageMatrix);
  const binder = wrapPatternBinder(
    createPaintBinder(renderer, {
      dpi: viewport.dpi,
      onWarning: (code, message, patternId) => warn(code, message, patternId),
      patterns: {
        resolvePatternTile(patternId) {
          return prepared.blocks.get(patternId)?.displayList;
        },
      },
      // 当前对象空间 → 页面空间；供 RelativeTo=Page 的底纹计算页面原点。
      objectToPage: () => {
        const matrix = currentObjectMatrix;
        return matrix && inversePageMatrix ? multiplyMatrix(inversePageMatrix, matrix) : null;
      },
    }),
    // 底纹 tile 在 prepare 阶段没有渲染器，图片只能存占位句柄；绘制前按当前
    // 渲染器与 DPI 物化，再交给 renderer 内部平铺。
    (handle, role) =>
      resolveDisplayImage(renderer, prepared, handle, role, viewport.dpi),
  );

  const context = {
    prepared,
    renderer,
    binder,
    styles: prepared.page.styles,
    deviceMatrix: pageMatrix,
    strictImageCtm: options.strictImageCtm ?? true,
    substitutionMode: options.substitutionMode ?? 'auto',
    setObjectMatrix: (matrix: Matrix | null) => {
      currentObjectMatrix = matrix;
    },
    dpi: viewport.dpi,
    ...(options.pageIndex !== undefined ? { pageIndex: options.pageIndex } : {}),
    signal: options.signal,
    onWarning: warn,
  };

  const filter = resolveContentFilter(options.contentFilter);
  const entries = resolvePageDrawOrder(prepared, {
    layerOrder: options.layerOrder ?? 'type',
    contentFilter: options.contentFilter,
    onWarning: (warning) => warn(warning.code, warning.message, warning.objectId),
  });
  // 注释在展开阶段已按类型过滤；遍历时再按同一判定跳过，避免逐块复制过滤逻辑。
  const annotationBlocks = prepared.page.annotationBlocks.filter((block) =>
    isAnnotationTypeVisible(filter, block.annotationType),
  );
  const drawSignatures = isSignatureVisible(filter);
  renderer.beginPage(canvasContext, viewport);
  try {
    renderer.setTransform(IDENTITY_MATRIX);
    renderer.setTransform(pageMatrix);
    // 页面内容裁剪：Canvas 像素比页面 PhysicalBox 略大，避免最后一行画出页外模板边缘。
    renderer.beginPath();
    renderer.rect(0, 0, page.area.w, page.area.h);
    renderer.clip('nonzero');

    // 严格 XML / 图 16 顺序都由 resolvePageDrawOrder 统一展开，绘制与文本收集共用。
    for (const entry of entries) {
      if (entry.kind === 'template' || entry.kind === 'page') {
        drawObjects(context, entry.objects);
      }
    }

    // 注释/签章外观在所有图层之后，按 PageAnnot 文件顺序。
    for (const block of annotationBlocks) {
      if (options.signal?.aborted) break;
      const boundary = block.boundary;
      renderer.save();
      try {
        if (boundary) renderer.translate(boundary.x, boundary.y);
        const blockMatrix = boundary
          ? multiplyMatrix(pageMatrix, translateMatrix(IDENTITY_MATRIX, boundary.x, boundary.y))
          : pageMatrix;
        drawBlock(
          {
            renderer,
            binder,
            prepared,
            matrix: blockMatrix,
            alpha: 1,
            strictImageCtm: options.strictImageCtm ?? true,
            substitutionMode: options.substitutionMode ?? 'auto',
            setObjectMatrix: (matrix: Matrix | null) => {
              currentObjectMatrix = matrix;
            },
            dpi: viewport.dpi,
            onWarning: warn,
          },
          block,
        );
      } catch (error) {
        warn(
          'W_UNSUPPORTED_PAINT',
          `注释块绘制失败：${error instanceof Error ? error.message : String(error)}`,
          block.id,
        );
      } finally {
        try {
          renderer.restore();
        } catch {
          // 忽略 restore 失败，继续后续注释。
        }
      }
    }

    // 签章外观最后绘制；按 StampAnnot 顺序，后出现覆盖先出现。
    for (const block of drawSignatures ? (prepared.signatureBlocks ?? []) : []) {
      if (options.signal?.aborted) break;
      renderer.save();
      try {
        renderer.translate(block.boundary.x, block.boundary.y);
        renderer.beginPath();
        renderer.rect(0, 0, block.space.width, block.space.height);
        renderer.clip('nonzero');
        replayDisplayList(renderer, block.displayList, (handle, role) =>
          resolveDisplayImage(renderer, prepared, handle, role, viewport.dpi),
        );
      } catch (error) {
        warn(
          'W_UNSUPPORTED_PAINT',
          `签章块绘制失败：${error instanceof Error ? error.message : String(error)}`,
          block.id,
        );
      } finally {
        try {
          renderer.restore();
        } catch {
          // 忽略 restore 失败，继续后续签章。
        }
      }
    }
  } finally {
    renderer.endPage();
  }
}

/**
 * 把模板引用与实际模板页模型按引用顺序对齐。
 *
 * 加载失败的模板已被 prepare 丢弃，这里按模板 ID 匹配；缺失时退回同位置模型。
 *
 * @param page 页面模型。
 * @param templates 已加载模板页。
 * @returns 引用与模型对。
 */
function resolveTemplates(
  page: PageModel,
  templates: readonly PageModel[],
  warn: (code: string, message: string, objectId?: ResourceId) => void,
): { ref: PageModel['templates'][number]; model: PageModel }[] {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const result: { ref: PageModel['templates'][number]; model: PageModel }[] = [];
  for (const ref of page.templates) {
    const model = byId.get(ref.id);
    if (!model) {
      // 加载失败的模板只能跳过；禁止按数组位置回退，否则会错画/重复其他模板。
      warn('W_UNSUPPORTED_PAINT', `模板 ${ref.id} 未加载，已跳过`, ref.id);
      continue;
    }
    result.push({ ref, model });
  }
  return result;
}

/**
 * 取模板引用所属图层类型。
 *
 * 页面 Template/@ZOrder 优先；缺省/非法值回退 Background（与 T6e 模型侧一致）。
 *
 * @param ref 页面模板引用。
 * @returns 图层类型。
 */
function templateZOrder(
  ref: PageModel['templates'][number],
): 'Background' | 'Body' | 'Foreground' {
  const value = ref.zOrder;
  return value === 'Background' || value === 'Body' || value === 'Foreground'
    ? value
    : 'Background';
}
