/**
 * 验证/签章状态配色对比度契约。
 *
 * 颜色全部来自 style.css 的 `--ofd-*` 变量；按 WCAG 相对亮度计算，正常文字
 * 要求 ≥ 4.5:1，并在 light/dark 两套主题下同时校验。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylePath = resolve(process.cwd(), 'src/style.css');

/** 解析一个 CSS 规则块内的自定义属性。 */
function variables(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--ofd-[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

/** 解析 `var(--x)`，最多递归 5 层。 */
function resolveValue(value: string, vars: Map<string, string>): string {
  let current = value.trim();
  for (let index = 0; index < 5; index += 1) {
    const match = /^var\((--ofd-[\w-]+)\)$/.exec(current);
    if (!match) return current;
    const next = vars.get(match[1]!);
    if (!next) return current;
    current = next.trim();
  }
  return current;
}

/** `#rrggbb` → 相对亮度。 */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** 两色对比度。 */
function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 提取以 selector 开头的规则块（不支持嵌套）。 */
function blockFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} 规则存在`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

const STATUS_VARS = [
  '--ofd-success',
  '--ofd-danger',
  '--ofd-status-unknown',
  '--ofd-status-unsupported',
  '--ofd-status-neutral',
  '--ofd-text-secondary',
] as const;

describe('验证状态 light/dark 对比度', () => {
  it('状态文字/徽标在工具栏/浮层背景上均 ≥ 4.5:1', async () => {
    const css = await readFile(stylePath, 'utf8');
    const light = variables(blockFor(css, '.ofd-viewer'));
    const dark = variables(blockFor(css, ".ofd-viewer[data-theme='dark']"));
    for (const [theme, vars] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const background = resolveValue('var(--ofd-surface)', vars);
      expect(background, `${theme} surface 可解析`).toMatch(/^#[0-9a-fA-F]{6}$/);
      for (const name of STATUS_VARS) {
        const color = resolveValue(`var(${name})`, vars);
        expect(color, `${theme} ${name} 可解析`).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(contrast(color, background), `${theme} ${name} 对比度`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('auto 暗色主题与显式 dark 状态变量一致', async () => {
    const css = await readFile(stylePath, 'utf8');
    const dark = variables(blockFor(css, ".ofd-viewer[data-theme='dark']"));
    const autoStart = css.indexOf("@media (prefers-color-scheme: dark)");
    const auto = variables(css.slice(autoStart, css.indexOf('prefers-contrast: more', autoStart)));
    for (const name of STATUS_VARS) {
      expect(auto.get(name), `auto ${name}`).toBe(dark.get(name));
    }
    expect(auto.get('--ofd-surface')).toBe(dark.get('--ofd-surface'));
  });

  it('状态色不是同一个颜色（文字 + 颜色双重区分）', async () => {
    const css = await readFile(stylePath, 'utf8');
    const vars = variables(blockFor(css, '.ofd-viewer'));
    const colors = ['valid', 'invalid', 'unknown', 'unsupported', 'not-applicable'].map((status) => {
      const name =
        status === 'valid'
          ? '--ofd-success'
          : status === 'invalid'
            ? '--ofd-danger'
            : status === 'unknown'
              ? '--ofd-status-unknown'
              : status === 'unsupported'
                ? '--ofd-status-unsupported'
                : '--ofd-status-neutral';
      return resolveValue(`var(${name})`, vars).toLowerCase();
    });
    expect(new Set(colors).size).toBe(5);
  });
});