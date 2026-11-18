/**
 * 动作（`CT_Action`）解码。
 *
 * 动作是增强信息：任何单条动作解析失败都只上报 warning 并跳过该条，不影响文档打开、
 * 页面渲染、文本层与导出。解析入口按**子节点名**查找 `Actions`/`Action`，不依赖子节点
 * 顺序（`Actions` 在 XML 中位于 `Border`、`AbbreviatedData` 之后）。
 *
 * 动作体 payload 使用判别联合；`Goto` 的 `Dest` 复用 `navigation.decodeDestination`，
 * 不维护第二套目标解析。
 */

import type { Box } from '../common/types';
import type { XmlNode } from '../xml/types';
import type { OFDWarning, WarningCode } from '../warnings';
import type {
  ActionEvent,
  ActionInfo,
  ActionOwner,
  ActionPayload,
  ActionRegion,
  ActionRegionPath,
  ActionType,
  DocumentDestination,
  MovieOperator,
  ResourceId,
} from './types';
import { attr, child, childText, children } from './decode-utils';
import { isNumericResourceId, normalizeResourceId } from './ids';
import { decodeDestination } from './navigation';

/** 动作体元素名 → 动作类型。 */
const BODY_TYPES: Readonly<Record<string, ActionType>> = {
  Goto: 'goto',
  URI: 'uri',
  GotoA: 'gotoa',
  Sound: 'sound',
  Movie: 'movie',
};

/** 合法的 `Action@Event`。 */
const ACTION_EVENTS: Readonly<Record<string, ActionEvent>> = {
  DO: 'DO',
  PO: 'PO',
  CLICK: 'CLICK',
};

/** `Movie@Operator` 合法值（大小写不敏感）。 */
const MOVIE_OPERATORS: Readonly<Record<string, MovieOperator>> = {
  play: 'Play',
  stop: 'Stop',
  pause: 'Pause',
  resume: 'Resume',
};

/** 宿主标准事件：文档 `DO`、页面 `PO`、图元 `CLICK`；大纲不受限定。 */
function hostEvent(owner: ActionOwner): ActionEvent | undefined {
  if (owner.kind === 'page') return 'PO';
  if (owner.kind === 'object') return 'CLICK';
  if (owner.kind === 'outline') return undefined;
  return 'DO';
}

/** 动作解码上下文。 */
export interface ActionDecodeContext {
  /** 页 ID → 页索引映射；`Goto/Dest@PageID` 解析使用。 */
  pageIndex: ReadonlyMap<ResourceId, number>;
  /** warning 回调；缺省静默。 */
  onWarning?: (warning: OFDWarning) => void;
  /** 单节点动作条数上限，单位：个；缺省不限制。 */
  maxActionsPerNode?: number;
  /**
   * 校验动作引用的资源 ID 是否存在（不读内容）；缺省不校验。
   *
   * @param resourceId 已规范化的资源 ID。
   * @returns 资源是否存在。
   */
  hasResource?: (resourceId: ResourceId) => boolean;
}

/**
 * 解码承载 `Actions` 的节点。
 *
 * @param node 宿主节点（Document / Page / 图元 / OutlineElem）。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 按 XML 顺序排列的动作列表；无 `Actions` 节点时返回空数组且不 warning。
 */
export function decodeActions(
  node: XmlNode,
  owner: ActionOwner,
  context: ActionDecodeContext,
): ActionInfo[] {
  const actionsNode = child(node, 'Actions');
  if (!actionsNode) return [];
  const result: ActionInfo[] = [];
  const limit = context.maxActionsPerNode;
  let truncated = false;
  for (const actionNode of children(actionsNode, 'Action')) {
    if (limit !== undefined && limit >= 0 && result.length >= limit) {
      truncated = true;
      break;
    }
    const decoded = decodeAction(actionNode, owner, context);
    if (decoded) result.push(decoded);
  }
  if (truncated) {
    warn(context, 'W_ACTION_LIMIT', describeOwner(owner, `动作条数超过 ${limit ?? 0} 个，多余动作被忽略`), owner);
  }
  return result;
}

/**
 * 解码单个 `Action` 节点。
 *
 * @param node `Action` 节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 动作信息；结构非法时返回 undefined（已上报 warning）。
 */
function decodeAction(
  node: XmlNode,
  owner: ActionOwner,
  context: ActionDecodeContext,
): ActionInfo | undefined {
  const host = describeOwner(owner, '');
  const eventRaw = (attr(node, 'Event') ?? '').trim();
  if (!eventRaw) {
    warn(context, 'W_ACTION_INVALID', `Action 缺少 Event（${host}），已跳过`, owner);
    return undefined;
  }
  const event = ACTION_EVENTS[eventRaw.toUpperCase()];
  if (!event) {
    warn(context, 'W_ACTION_INVALID', `Action 的 Event 非法：${JSON.stringify(eventRaw)}（${host}），已跳过`, owner);
    return undefined;
  }
  const expected = hostEvent(owner);
  if (expected !== undefined && expected !== event) {
    warn(
      context,
      'W_ACTION_EVENT_MISMATCH',
      `Action 的 Event=${event} 与宿主 ${owner.kind} 的常用事件 ${expected} 不一致（保留该动作）`,
      owner,
    );
  }

  const bodies = collectBodyNodes(node);
  if (bodies.length === 0) {
    warn(context, 'W_ACTION_INVALID', `Action 缺少动作体（${host}），已跳过`, owner);
    return undefined;
  }
  if (bodies.length > 1) {
    warn(
      context,
      'W_ACTION_MULTIPLE_BODY',
      `Action 含多个动作体（${bodies.map((item) => item.name).join('/')}），取第一个`,
      owner,
    );
  }
  const body = bodies[0] as XmlNode;
  const payload = decodePayload(body, owner, context);
  if (!payload) return undefined;

  const info: ActionInfo = { event, type: payload.type, owner, payload };
  const regionNode = child(node, 'Region');
  if (regionNode) {
    const region = decodeRegion(regionNode, owner, context);
    if (region) info.region = region;
  }
  return info;
}

/**
 * 按动作体元素名收集 `xs:choice` 成员，保持 XML 顺序。
 *
 * @param node `Action` 节点。
 * @returns 动作体节点列表。
 */
function collectBodyNodes(node: XmlNode): XmlNode[] {
  return node.children.filter((item) => Object.prototype.hasOwnProperty.call(BODY_TYPES, item.name));
}

/**
 * 解码动作体。
 *
 * @param node 动作体节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns payload；字段非法或必需属性缺失时返回 undefined（已上报 warning）。
 */
function decodePayload(
  node: XmlNode,
  owner: ActionOwner,
  context: ActionDecodeContext,
): ActionPayload | undefined {
  const host = describeOwner(owner, '');
  switch (node.name) {
    case 'Goto': {
      const destNode = child(node, 'Dest');
      const dest = destNode ? decodeGotoDestination(destNode, context) : undefined;
      const bookmarkName = (childText(node, 'Bookmark') ?? attr(node, 'Bookmark') ?? '').trim();
      if (!destNode && !bookmarkName) {
        warn(context, 'W_ACTION_INVALID', `Goto 既无 Dest 也无 Bookmark（${host}），已跳过`, owner);
        return undefined;
      }
      if (!dest && !bookmarkName) {
        // Dest 无效：动作保留但 payload 不含 dest，由消费方决定是否忽略。
        warn(context, 'W_ACTION_TARGET', `Goto 的 Dest 无效（${host}），payload 不含 dest`, owner);
      }
      const payload: ActionPayload = { type: 'goto' };
      if (dest) payload.dest = dest;
      if (bookmarkName) payload.bookmarkName = bookmarkName;
      return payload;
    }
    case 'URI': {
      const uri = (attr(node, 'URI') ?? childText(node, 'URI') ?? '').trim();
      if (!uri) {
        warn(context, 'W_ACTION_INVALID', `URI 动作缺少 URI（${host}），已跳过`, owner);
        return undefined;
      }
      const payload: ActionPayload = { type: 'uri', uri };
      const base = (attr(node, 'Base') ?? '').trim();
      if (base) payload.base = base;
      const target = (attr(node, 'Target') ?? '').trim();
      if (target) payload.target = target;
      return payload;
    }
    case 'GotoA': {
      const attachId = (attr(node, 'AttachID') ?? childText(node, 'AttachID') ?? '').trim();
      if (!attachId) {
        warn(context, 'W_ACTION_INVALID', `GotoA 动作缺少 AttachID（${host}），保留空标识`, owner);
      }
      return { type: 'gotoa', attachId, newWindow: readBoolean(node, 'NewWindow', true, owner, context) };
    }
    case 'Sound': {
      const resourceId = readResourceId(node, owner, context);
      if (!resourceId) return undefined;
      return {
        type: 'sound',
        resourceId,
        volume: readVolume(node, owner, context),
        repeat: readBoolean(node, 'Repeat', false, owner, context),
        synchronous: readBoolean(node, 'Synchronous', false, owner, context),
      };
    }
    case 'Movie': {
      const resourceId = readResourceId(node, owner, context);
      if (!resourceId) return undefined;
      return { type: 'movie', resourceId, operator: readOperator(node, owner, context) };
    }
    default:
      return undefined;
  }
}

/**
 * 解码 `Goto/Dest`；复用 `navigation.decodeDestination`。
 *
 * @param node `Dest` 节点。
 * @param context 解码上下文。
 * @returns 跳转目标；无效时 undefined（已上报 `W_ACTION_TARGET`）。
 */
function decodeGotoDestination(node: XmlNode, context: ActionDecodeContext): DocumentDestination | undefined {
  return decodeDestination(node, context.pageIndex, warningOptions(context), 'W_ACTION_TARGET');
}

/**
 * 以 `DecodeOptions` 形式提供 warning 回调，供 `decodeDestination` 使用。
 *
 * @param context 动作解码上下文。
 * @returns 解码选项。
 */
function warningOptions(context: ActionDecodeContext): { onWarning?: (warning: OFDWarning) => void } {
  return context.onWarning ? { onWarning: context.onWarning } : {};
}

/**
 * 读取并规范化动作引用的资源 ID，并校验资源是否存在。
 *
 * @param node 动作体节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 资源 ID；缺失或非数字时 undefined（已上报 warning）。
 */
function readResourceId(
  node: XmlNode,
  owner: ActionOwner,
  context: ActionDecodeContext,
): ResourceId | undefined {
  const raw = attr(node, 'ResourceID');
  const normalized = normalizeResourceId(raw);
  const resourceId = isNumericResourceId(normalized) ? normalized : undefined;
  if (!resourceId) {
    warn(
      context,
      'W_ACTION_INVALID',
      `${node.name} 动作的 ResourceID 缺失或非数字：${JSON.stringify(raw ?? '')}（${describeOwner(owner, '')}），已跳过`,
      owner,
    );
    return undefined;
  }
  if (context.hasResource && !context.hasResource(resourceId)) {
    warn(
      context,
      'W_ACTION_RESOURCE_MISSING',
      `${node.name} 动作引用的资源 ${resourceId} 不在资源索引中（保留动作，执行期可能失败）`,
      owner,
      resourceId,
    );
  }
  return resourceId;
}

/**
 * 读取 `Sound@Volume` 并钳制到 0..100。
 *
 * @param node `Sound` 节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 音量 0..100；缺失或非法时回退 100。
 */
function readVolume(node: XmlNode, owner: ActionOwner, context: ActionDecodeContext): number {
  const raw = attr(node, 'Volume');
  if (raw === undefined || raw.trim() === '') return 100;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    warn(context, 'W_ACTION_FIELD', `Sound@Volume 非法：${JSON.stringify(raw)}，回退 100`, owner);
    return 100;
  }
  const clamped = Math.min(100, Math.max(0, value));
  if (clamped !== value) {
    warn(context, 'W_ACTION_FIELD', `Sound@Volume 越界：${value}，已钳制到 ${clamped}`, owner);
  }
  return clamped;
}

/**
 * 读取 `Movie@Operator`。
 *
 * @param node `Movie` 节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 放映参数；缺失或非法时回退 `Play`。
 */
function readOperator(node: XmlNode, owner: ActionOwner, context: ActionDecodeContext): MovieOperator {
  const raw = attr(node, 'Operator');
  if (raw === undefined || raw.trim() === '') return 'Play';
  const operator = MOVIE_OPERATORS[raw.trim().toLowerCase()];
  if (!operator) {
    warn(context, 'W_ACTION_FIELD', `Movie@Operator 非法：${JSON.stringify(raw)}，回退 Play`, owner);
    return 'Play';
  }
  return operator;
}

/**
 * 读取布尔属性。
 *
 * @param node 动作体节点。
 * @param name 属性名。
 * @param fallback 缺失或非法时的回退值。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 布尔值。
 */
function readBoolean(
  node: XmlNode,
  name: string,
  fallback: boolean,
  owner: ActionOwner,
  context: ActionDecodeContext,
): boolean {
  const raw = attr(node, name);
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  warn(context, `W_ACTION_FIELD`, `${node.name}@${name} 非法：${JSON.stringify(raw)}，回退 ${fallback}`, owner);
  return fallback;
}

/**
 * 解码 `Action/Region` 复杂启动区域。
 *
 * 只保留路径命令（坐标单位 mm），计算外接矩形；路径缺失或非法时丢弃整项区域并上报
 * `W_ACTION_REGION`，动作本体保留（几何回退宿主缺省矩形）。
 *
 * @param node `Region` 节点。
 * @param owner 宿主位置。
 * @param context 解码上下文。
 * @returns 动作区域；无有效路径时 undefined。
 */
export function decodeRegion(
  node: XmlNode,
  owner: ActionOwner,
  context: ActionDecodeContext,
): ActionRegion | undefined {
  const areas: ActionRegionPath[][][] = [];
  for (const areaNode of children(node, 'Area')) {
    const paths = decodeAreaPaths(areaNode);
    if (paths.length > 0) areas.push(paths);
  }
  if (areas.length === 0) {
    warn(context, 'W_ACTION_REGION', `Region 没有可解析的区域路径（${describeOwner(owner, '')}），已丢弃区域`, owner);
    return undefined;
  }
  const bbox = pathBounds(areas);
  if (!bbox) {
    warn(context, 'W_ACTION_REGION', `Region 路径坐标非法（${describeOwner(owner, '')}），已丢弃区域`, owner);
    return undefined;
  }
  return { areas, bbox };
}

/**
 * 把单个 `Area` 的路径命令解码为路径列表。
 *
 * 支持 `Move`/`Line`/`CubicBezier`/`QuadraticBezier`（提升为三次）/`Close`；`Arc` 按标准
 * 保留为直线近似（起点到终点），不作为错误处理。
 *
 * @param areaNode `Area` 节点。
 * @returns 路径命令列表；非法命令被跳过。
 */
function decodeAreaPaths(areaNode: XmlNode): ActionRegionPath[][] {
  const paths: ActionRegionPath[][] = [];
  let current: ActionRegionPath[] = [];
  const flush = (): void => {
    if (current.length > 0) paths.push(current);
    current = [];
  };
  for (const item of areaNode.children) {
    switch (item.name) {
      case 'Move': {
        const point = readPoint(item);
        if (!point) break;
        flush();
        current.push({ type: 'moveTo', x: point.x, y: point.y });
        break;
      }
      case 'Line': {
        const point = readPoint(item);
        if (!point) break;
        if (current.length === 0) current.push({ type: 'moveTo', x: point.x, y: point.y });
        else current.push({ type: 'lineTo', x: point.x, y: point.y });
        break;
      }
      case 'CubicBezier': {
        const points = readPoints(item, 3);
        if (!points) break;
        if (current.length === 0) current.push({ type: 'moveTo', x: points[0].x, y: points[0].y });
        current.push({
          type: 'bezierCurveTo',
          cp1x: points[0].x,
          cp1y: points[0].y,
          cp2x: points[1].x,
          cp2y: points[1].y,
          x: points[2].x,
          y: points[2].y,
        });
        break;
      }
      case 'QuadraticBezier': {
        // 标准写法为「控制点 + 终点」；三点写法（起点、控制点、终点）同样接受。
        const points = readPoints(item, 3);
        if (!points) break;
        const from = points.length >= 3 ? points[0] : (lastPoint(current) ?? points[0]);
        const control = points.length >= 3 ? (points[1] as { x: number; y: number }) : points[0];
        const to = points.length >= 3 ? (points[2] as { x: number; y: number }) : points[1];
        if (current.length === 0) current.push({ type: 'moveTo', x: control.x, y: control.y });
        current.push(quadraticToCubic(from, control, to));
        break;
      }
      case 'Arc': {
        const points = readPoints(item, 2);
        if (!points) break;
        if (current.length === 0) current.push({ type: 'moveTo', x: points[0].x, y: points[0].y });
        current.push({ type: 'lineTo', x: points[1].x, y: points[1].y });
        break;
      }
      case 'Close': {
        current.push({ type: 'closePath' });
        flush();
        break;
      }
      default:
        break;
    }
  }
  flush();
  return paths;
}

/**
 * 取当前路径最后一个落点。
 *
 * @param path 当前路径命令。
 * @returns 最后一个点；路径为空时 undefined。
 */
function lastPoint(path: readonly ActionRegionPath[]): { x: number; y: number } | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const item = path[index];
    if (!item || item.type === 'closePath') continue;
    return { x: item.x, y: item.y };
  }
  return undefined;
}

/**
 * 把二次贝塞尔提升为三次贝塞尔，便于统一离散。
 *
 * @param from 起点。
 * @param control 控制点。
 * @param to 终点。
 * @returns 三次贝塞尔命令。
 */
function quadraticToCubic(
  from: { x: number; y: number },
  control: { x: number; y: number },
  to: { x: number; y: number },
): ActionRegionPath {
  return {
    type: 'bezierCurveTo',
    cp1x: from.x + ((control.x - from.x) * 2) / 3,
    cp1y: from.y + ((control.y - from.y) * 2) / 3,
    cp2x: to.x + ((control.x - to.x) * 2) / 3,
    cp2y: to.y + ((control.y - to.y) * 2) / 3,
    x: to.x,
    y: to.y,
  };
}

/**
 * 读取 `Point` 坐标（`Point` 节点文本或 `Point`/`X`/`Y` 属性）。
 *
 * @param node 路径命令节点。
 * @returns 坐标，单位 mm；非法时 undefined。
 */
function readPoint(node: XmlNode): { x: number; y: number } | undefined {
  const fromAttr = readNumberPair(attr(node, 'Point'));
  if (fromAttr) return fromAttr;
  const x = readNumber(attr(node, 'X'));
  const y = readNumber(attr(node, 'Y'));
  if (x !== undefined && y !== undefined) return { x, y };
  return readNumberPair(childText(node, 'Point'));
}

/**
 * 读取至多 n 组 `Point` 坐标；`Point` 属性以空格分隔，可写多组。
 *
 * @param node 路径命令节点。
 * @param count 需要的最大点数。
 * @returns 坐标数组（可能少于 `count`）；不足 2 点或含非法数值时 undefined。
 */
function readPoints(node: XmlNode, count: number): Array<{ x: number; y: number }> | undefined {
  const raw = attr(node, 'Point') ?? childText(node, 'Point');
  if (raw !== undefined) {
    const values = raw.trim().split(/[\s,]+/).map((item) => Number(item));
    if (!values.every((item) => Number.isFinite(item))) return undefined;
    const available = Math.floor(values.length / 2);
    if (available < 2) return undefined;
    const total = Math.min(available, count);
    const result: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < total; index += 1) {
      result.push({ x: values[index * 2] as number, y: values[index * 2 + 1] as number });
    }
    return result;
  }
  const points = children(node, 'Point').map((item) => readNumberPair(item.text));
  const valid = points.filter((point): point is { x: number; y: number } => point !== undefined);
  if (valid.length < 2) return undefined;
  return valid.slice(0, count);
}

/**
 * 解析 `"x y"` 形式的坐标对。
 *
 * @param raw 原始文本。
 * @returns 坐标；非法时 undefined。
 */
function readNumberPair(raw: string | undefined): { x: number; y: number } | undefined {
  if (raw === undefined) return undefined;
  const values = raw.trim().split(/[\s,]+/).map((item) => Number(item));
  if (values.length < 2) return undefined;
  const x = values[0] as number;
  const y = values[1] as number;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/**
 * 解析单个数值。
 *
 * @param raw 原始文本。
 * @returns 数值；非法时 undefined。
 */
function readNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 计算区域路径的联合外接矩形（控制点参与，单位 mm）。
 *
 * @param areas 区域集合：每个 `Area` 含若干条路径，每条路径是命令列表。
 * @returns 外接矩形；没有任何坐标时 undefined。
 */
function pathBounds(areas: ReadonlyArray<ReadonlyArray<ReadonlyArray<ActionRegionPath>>>): Box | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const paths of areas) {
    for (const path of paths) {
      for (const command of path) {
        if (command.type === 'closePath') continue;
        include(command.x, command.y);
        if (command.type === 'bezierCurveTo') {
          include(command.cp1x, command.cp1y);
          include(command.cp2x, command.cp2y);
        }
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 生成包含宿主定位信息的 warning 描述。
 *
 * @param owner 宿主位置。
 * @param message 诊断信息。
 * @returns 拼接后的消息。
 */
function describeOwner(owner: ActionOwner, message: string): string {
  const prefix = ownerLabel(owner);
  return message ? `${prefix}：${message}` : prefix;
}

/**
 * 生成宿主的中文定位描述。
 *
 * @param owner 宿主位置。
 * @returns 描述文本。
 */
function ownerLabel(owner: ActionOwner): string {
  if (owner.kind === 'page') return `第 ${owner.pageIndex} 页`;
  if (owner.kind === 'object') {
    return `第 ${owner.pageIndex} 页图元 ${owner.objectId ?? '（无 ID）'}`;
  }
  if (owner.kind === 'outline') return `大纲 ${owner.path.join('.')}`;
  return '文档';
}

/**
 * 上报动作 warning，并补齐宿主页索引与对象 ID。
 *
 * @param context 解码上下文。
 * @param code warning 码。
 * @param message 诊断信息。
 * @param owner 宿主位置。
 * @param resourceId 关联资源 ID。
 */
function warn(
  context: ActionDecodeContext,
  code: WarningCode,
  message: string,
  owner: ActionOwner,
  resourceId?: ResourceId,
): void {
  const handler = context.onWarning;
  if (!handler) return;
  const warning: OFDWarning = { code, message };
  if (owner.kind === 'page' || owner.kind === 'object') warning.pageIndex = owner.pageIndex;
  if (owner.kind === 'object' && owner.objectId !== undefined) warning.objectId = owner.objectId;
  if (resourceId !== undefined) warning.resourceId = resourceId;
  handler(warning);
}