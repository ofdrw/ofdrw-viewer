/**
 * 裁剪区应用。
 *
 * Clip 间取交集、Clip 内 area 取并集；必须在对象 CTM 之前应用。
 * 每个 Area 的变换：`Area.CTM × T(Path.Boundary) × Path.CTM`。
 */

import type { FillRule, Matrix, PathCommand } from '../common/types';
import type { Clip, PathObject, TextObject } from '../model/types';
import type { Renderer } from '../renderer/types';
import { IDENTITY_MATRIX, multiplyMatrix, translateMatrix, transformPoint } from '../common/matrix';
import { emitPathCommands, parseAbbreviatedData } from './path';

/** 裁剪上下文。 */
export interface ClipContext {
  renderer: Renderer;
  /** warning 回调；不支持组合使用 `W_UNSUPPORTED_CLIP`。 */
  onWarning?: (code: string, message: string) => void;
  /**
   * Text 裁剪轮廓提供者。
   *
   * 文字轮廓依赖字体与文字布局，由 T4 的 `render/text.ts` 提供；缺失时 Text 裁剪
   * 降级为跳过并上报 `W_UNSUPPORTED_CLIP`。
   */
  textPath?: (text: TextObject) => readonly PathCommand[] | null;
}

/**
 * 应用对象的 Clips（对象空间，CTM 之前）。
 *
 * - 多个 Clip 依次 `clip()`，Canvas 自动求交集；
 * - 同一 Clip 的多个 Area 合并到同一条路径，一次 `clip()` 求并集；
 * - `Fill=false, Stroke=true` 的裁剪路径 v1 降级为仅 Fill 并上报 `W_UNSUPPORTED_CLIP`；
 * - 同一 Clip 内不同 FillRule 取第一个并 warning。
 *
 * @param context 渲染器、文字轮廓提供者与 warning 回调。
 * @param clips 裁剪项列表；空数组/undefined 时不做任何事。
 */
export function applyClips(context: ClipContext, clips: readonly Clip[] | undefined): void {
  if (!clips || clips.length === 0) return;
  const { renderer } = context;

  for (const clip of clips) {
    if (!clip.areas || clip.areas.length === 0) continue;

    const firstRule = getAreaRule(clip.areas[0]!);
    let rule: FillRule = firstRule;
    for (const area of clip.areas) {
      const areaRule = getAreaRule(area);
      if (areaRule !== firstRule) {
        context.onWarning?.(
          'W_UNSUPPORTED_CLIP',
          `同一 Clip 内存在不同 FillRule（${firstRule}/${areaRule}），已取第一个规则`,
        );
        break;
      }
    }

    let emitted = false;
    renderer.beginPath();
    for (const area of clip.areas) {
      if (area.kind === 'path') {
        emitted = emitPathArea(context, clip, area.path) || emitted;
      } else {
        emitted = emitTextArea(context, clip, area.text) || emitted;
      }
    }
    // 没有可用 Area 时不执行 clip，避免空路径把整个对象裁掉。
    if (emitted) renderer.clip(rule);
    else context.onWarning?.('W_UNSUPPORTED_CLIP', 'Clip 内没有可用裁剪区域，已跳过');
    void rule;
  }
}

/**
 * 取裁剪 Area 的填充规则。
 *
 * @param area 裁剪区域。
 * @returns Path 的 Rule；Text 默认 nonzero。
 */
function getAreaRule(area: Clip['areas'][number]): FillRule {
  return area.kind === 'path' ? area.path.rule : 'nonzero';
}

/**
 * 把 Path 裁剪区域输出到当前路径。
 *
 * @returns 是否输出了至少一条路径命令。
 */
function emitPathArea(context: ClipContext, clip: Clip, path: PathObject): boolean {
  if (!path.fill && !path.stroke) {
    context.onWarning?.('W_UNSUPPORTED_CLIP', '裁剪 Path 的 Fill/Stroke 均为 false，已跳过');
    return false;
  }
  if (!path.fill && path.stroke) {
    // Canvas 不能把 stroke 直接转成裁剪路径；v1 降级为仅 Fill，不引入 renderer 私有掩码。
    context.onWarning?.('W_UNSUPPORTED_CLIP', '裁剪 Path 仅 Stroke，已降级为 Fill 裁剪');
  }
  const commands = parseAbbreviatedData(path.data);
  if (commands.length === 0) return false;
  const matrix = areaMatrix(clip.ctm, path.boundary.x, path.boundary.y, path.ctm);
  emitPathCommands(context.renderer, transformCommands(commands, matrix));
  return true;
}

/**
 * 把 Text 裁剪区域输出到当前路径。
 *
 * @returns 是否输出了至少一条路径命令。
 */
function emitTextArea(context: ClipContext, clip: Clip, text: TextObject): boolean {
  if (!context.textPath) {
    context.onWarning?.('W_UNSUPPORTED_CLIP', 'Text 裁剪缺少字形轮廓提供者，已跳过');
    return false;
  }
  const commands = context.textPath(text);
  if (!commands || commands.length === 0) {
    context.onWarning?.('W_UNSUPPORTED_CLIP', 'Text 裁剪未生成字形轮廓，已跳过');
    return false;
  }
  const matrix = areaMatrix(clip.ctm, text.boundary.x, text.boundary.y, text.ctm);
  emitPathCommands(context.renderer, transformCommands(commands, matrix));
  return true;
}

/**
 * 计算 Area 的完整变换：`Area.CTM × T(Boundary) × Path/Text.CTM`。
 *
 * @param ctm Clip 级 CTM。
 * @param boundaryX 子对象 Boundary 的 x，对象空间单位。
 * @param boundaryY 子对象 Boundary 的 y，对象空间单位。
 * @param objectCtm 子对象自己的 CTM。
 * @returns 组合矩阵（先应用 objectCtm，再 Boundary 平移，最后 Clip.CTM）。
 */
function areaMatrix(
  ctm: Matrix | undefined,
  boundaryX: number,
  boundaryY: number,
  objectCtm: Matrix | undefined,
): Matrix {
  const translate = translateMatrix(IDENTITY_MATRIX, boundaryX, boundaryY);
  const local = multiplyMatrix(translate, objectCtm ?? IDENTITY_MATRIX);
  return multiplyMatrix(ctm ?? IDENTITY_MATRIX, local);
}

/**
 * 用仿射矩阵变换路径命令的所有坐标。
 *
 * @param commands 原路径命令。
 * @param matrix 变换矩阵。
 * @returns 变换后的路径命令。
 */
function transformCommands(
  commands: readonly PathCommand[],
  matrix: Matrix,
): PathCommand[] {
  const transformed: PathCommand[] = [];
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo': {
        const point = transformPoint(matrix, { x: command.x, y: command.y });
        transformed.push({ type: 'moveTo', x: point.x, y: point.y });
        break;
      }
      case 'lineTo': {
        const point = transformPoint(matrix, { x: command.x, y: command.y });
        transformed.push({ type: 'lineTo', x: point.x, y: point.y });
        break;
      }
      case 'quadraticCurveTo': {
        const control = transformPoint(matrix, { x: command.cpx, y: command.cpy });
        const end = transformPoint(matrix, { x: command.x, y: command.y });
        transformed.push({
          type: 'quadraticCurveTo',
          cpx: control.x,
          cpy: control.y,
          x: end.x,
          y: end.y,
        });
        break;
      }
      case 'bezierCurveTo': {
        const control1 = transformPoint(matrix, { x: command.cp1x, y: command.cp1y });
        const control2 = transformPoint(matrix, { x: command.cp2x, y: command.cp2y });
        const end = transformPoint(matrix, { x: command.x, y: command.y });
        transformed.push({
          type: 'bezierCurveTo',
          cp1x: control1.x,
          cp1y: control1.y,
          cp2x: control2.x,
          cp2y: control2.y,
          x: end.x,
          y: end.y,
        });
        break;
      }
      case 'closePath':
        transformed.push({ type: 'closePath' });
        break;
    }
  }
  return transformed;
}