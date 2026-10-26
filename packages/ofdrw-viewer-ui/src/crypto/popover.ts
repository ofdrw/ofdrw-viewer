/**
 * 印章点击浮层（设计 §6.5）。
 *
 * 只展示 `VerificationReport` 中该签名的结果；关闭后把焦点还给印章按钮。
 */

import type { SignatureVerification } from '@ofdrw/ofdrw-viewer-crypto';
import type { SealImageInfo } from '../types';
import { createSealImageElement } from './seal-image';
import type { SealImageHandle } from './seal-image';
import { chainStatusText, verificationStatusText } from './text';
import type { CryptoText } from './text';
import { formatShanghaiDateTime } from './time';

/** 浮层选项。 */
export interface SignaturePopoverOptions {
  /** 所有者文档。 */
  readonly document: Document;
  /** 锚点：签章覆盖层按钮。 */
  readonly anchor: HTMLElement;
  /** 锚点所在容器；浮层优先 portal 到最近的 `.ofd-viewer` 根。 */
  readonly container: HTMLElement;
  /** 签名验证结果。 */
  readonly signature: SignatureVerification;
  /** 文案。 */
  readonly text: CryptoText;
  /** 印章图片；有图片字节时显示真实图片。 */
  readonly sealImage?: SealImageInfo;
  /** 印章名称/编码，用于图片 alt 与降级文案。 */
  readonly sealLabel?: string;
  /** 打开签章详情（与侧栏点击一致）。 */
  readonly onOpenDetails: () => void;
  /** 打开工具栏验证面板（文档级验证结果）；省略时不渲染该入口。 */
  readonly onOpenPanel?: () => void;
}

/** 浮层实例。 */
export interface SignaturePopoverHandle {
  /** 关闭浮层并恢复焦点。 */
  close(restoreFocus?: boolean): void;
}

/**
 * 打开签章验证浮层。
 *
 * @param options 浮层选项。
 * @returns 关闭句柄。
 */
export function openSignaturePopover(
  options: SignaturePopoverOptions,
): SignaturePopoverHandle {
  const { document: doc, anchor, container, signature, text } = options;
  const popover = doc.createElement('div');
  popover.className = 'ofd-signature-popover';
  popover.dataset.signatureId = signature.id;
  popover.dataset.status = signature.status;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', `${text.signatureCard} ${signature.id}`);

  const header = doc.createElement('div');
  header.className = 'ofd-signature-popover__header';
  const title = doc.createElement('h3');
  title.className = 'ofd-signature-popover__title';
  title.textContent = `${text.signatureCard} ${signature.id}`;
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ofd-button ofd-signature-popover__close';
  closeButton.dataset.ofdControl = 'signature-popover-close';
  closeButton.setAttribute('aria-label', text.close);
  closeButton.textContent = '×';
  // 复用签章列表/详情的彩色徽标，浮层状态不只靠正文文字区分。
  const badge = doc.createElement('span');
  badge.className = 'ofd-signature-badge';
  badge.dataset.status = signature.status;
  badge.textContent = verificationStatusText(text, signature.status);
  header.append(title, badge, closeButton);

  const body = doc.createElement('dl');
  body.className = 'ofd-signature-popover__pairs';
  const pairs: (readonly [string, string])[] = [
    [text.overall, verificationStatusText(text, signature.status)],
    [text.math, verificationStatusText(text, signature.signature.status)],
    [
      text.references,
      `${verificationStatusText(text, signature.references.status)} ${signature.references.checked}/${signature.references.total}`,
    ],
    [text.chainIndependent, chainStatusText(text, signature.certificate.status)],
    [
      text.seal,
      signature.seal
        ? `${signature.seal.name ?? signature.seal.esId ?? text.none}（${verificationStatusText(text, signature.seal.status)}）`
        : text.none,
    ],
    [text.timestamp, timestampText(signature, text)],
  ];
  if (signature.timestamp.status === 'parsed-not-verified') {
    const timestamp = signature.timestamp;
    pairs.push(
      [
        text.timestampGenTime,
        formatShanghaiDateTime(timestamp.genTime) ?? text.timestampUnparsable,
      ],
      [text.timestampTsa, timestamp.tsa?.subject ?? text.none],
      [text.timestampSerial, timestamp.serialNumber ?? text.none],
    );
    if (timestamp.policy) pairs.push([text.timestampPolicy, timestamp.policy]);
  }
  for (const [label, value] of pairs) {
    const term = doc.createElement('dt');
    term.textContent = label;
    const description = doc.createElement('dd');
    description.textContent = value;
    body.append(term, description);
  }

  const full = doc.createElement('button');
  full.type = 'button';
  full.className = 'ofd-button ofd-signature-popover__full';
  full.dataset.ofdControl = 'signature-popover-details';
  full.textContent = text.viewDetails;

  // 印章点击浮层与侧栏列表点击打开同一份详情；详情本身已合并验证结果，
  // 这里额外保留“完整验证结果”入口，方便直接查看文档级验证面板。
  const actions = doc.createElement('div');
  actions.className = 'ofd-signature-popover__actions';
  let panelButton: HTMLButtonElement | null = null;
  if (options.onOpenPanel) {
    panelButton = doc.createElement('button');
    panelButton.type = 'button';
    panelButton.className = 'ofd-button ofd-signature-popover__panel';
    panelButton.dataset.ofdControl = 'signature-popover-panel';
    panelButton.textContent = text.panelTitle;
  }

  let sealBox: HTMLElement | null = null;
  const sealImageHandle: SealImageHandle | null = options.sealImage
    ? createSealImageElement(doc, options.sealImage, {
        label:
          options.sealLabel ??
          signature.seal?.name ??
          signature.seal?.esId ??
          signature.id,
      })
    : null;
  if (sealImageHandle) {
    sealBox = doc.createElement('div');
    sealBox.className = 'ofd-signature-popover__seal';
    sealBox.dataset.ofdControl = 'signature-popover-seal-image';
    sealBox.appendChild(sealImageHandle.element);
    popover.append(header, sealBox, body, actions);
  } else {
    popover.append(header, body, actions);
  }
  actions.append(full);
  if (panelButton) actions.appendChild(panelButton);

  // 浮层必须脱离页面栈：签章按钮位于页面的 signature-layer 内，后续页会
  // 覆盖浮层，阅读器滚动容器也会裁切它。portal 到 .ofd-viewer 根后使用
  // fixed 定位，坐标始终取覆盖层按钮的视口矩形。
  const portalRoot = anchor.closest<HTMLElement>('.ofd-viewer') ?? container;
  popover.style.position = 'fixed';
  popover.style.zIndex = '35';
  popover.style.display = 'flex';
  popover.style.flexDirection = 'column';
  popover.style.boxSizing = 'border-box';
  popover.style.overflow = 'hidden';
  popover.style.left = '0px';
  popover.style.top = '0px';
  popover.style.visibility = 'hidden';

  // 标题与操作区固定，只有内容区滚动，避免小视口下按钮被滚出可视区。
  header.style.flex = '0 0 auto';
  actions.style.flex = '0 0 auto';
  if (sealBox) sealBox.style.flex = '0 0 auto';
  body.style.flex = '1 1 auto';
  body.style.minHeight = '0';
  body.style.overflowY = 'auto';

  const margin = 8;
  const view = doc.defaultView;
  const positionPopover = (): void => {
    const main = portalRoot.querySelector<HTMLElement>('.ofd-viewer__main');
    const mainRect = main?.getBoundingClientRect();
    const hasMain = mainRect !== undefined && mainRect.width > 0 && mainRect.height > 0;
    const bounds = hasMain
      ? {
          left: mainRect.left,
          top: mainRect.top,
          right: mainRect.right,
          bottom: mainRect.bottom,
        }
      : {
          left: 0,
          top: 0,
          right: view?.innerWidth ?? 1024,
          bottom: view?.innerHeight ?? 768,
        };
    const availableWidth = Math.max(1, bounds.right - bounds.left - margin * 2);
    const width = Math.min(320, availableWidth);
    popover.style.width = `${width}px`;
    const mainMaxHeight = Math.max(120, bounds.bottom - bounds.top - margin * 2);
    popover.style.maxHeight = `${mainMaxHeight}px`;

    const anchorRect = anchor.getBoundingClientRect();
    const height = popover.getBoundingClientRect().height;
    const topLimit = bounds.top + margin;
    const bottomLimit = bounds.bottom - margin;
    const rightLimit = bounds.right - margin;
    let left = anchorRect.left;
    left = Math.max(bounds.left + margin, Math.min(left, rightLimit - width));

    const gap = 4;
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - gap;
    let top: number;
    if (below + height <= bottomLimit) {
      top = below;
    } else if (above - height >= topLimit) {
      top = above - height;
    } else {
      // 上下都放不下时优先并排到锚点右侧，再尝试左侧；这样全部字段
      // 仍可读，完整面板按钮也不会被裁切。
      const sideTop = Math.max(topLimit, Math.min(anchorRect.top, bottomLimit - height));
      const rightLeft = anchorRect.right + gap;
      const leftLeft = anchorRect.left - gap - width;
      if (rightLeft + width <= rightLimit) {
        left = rightLeft;
        top = sideTop;
      } else if (leftLeft >= bounds.left + margin) {
        left = leftLeft;
        top = sideTop;
      } else {
        // 极窄视口没有并排空间时，把浮层整体夹在阅读器可视区内；
        // max-height 由上方统一下发，内容区自行滚动。
        top = Math.max(topLimit, Math.min(anchorRect.top, bottomLimit - height));
      }
    }
    top = Math.max(topLimit, Math.min(top, bottomLimit - height));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && popover.contains(event.target)) return;
    positionPopover();
  };

  // 印章图片加载后浮层高度会变化；重新定位，避免底部字段或完整面板按钮
  // 越过阅读器可视区。ResizeObserver 在无布局的测试 DOM 中可能不存在。
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (popover.isConnected) positionPopover();
        })
      : null;
  resizeObserver?.observe(popover);
  const mainElement = portalRoot.querySelector<HTMLElement>('.ofd-viewer__main');
  if (mainElement) resizeObserver?.observe(mainElement);
  sealImageHandle?.element.addEventListener('load', positionPopover, true);

  portalRoot.appendChild(popover);
  positionPopover();
  popover.style.visibility = '';
  // 定位与尺寸测量完成后再启用入场动画，避免 transform 影响锚点对齐；
  // 浮层只创建一次，内部内容重渲染不会重播该动画。
  popover.classList.add('ofd-signature-popover--in');

  let closed = false;
  const close = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    sealImageHandle?.revoke();
    popover.remove();
    anchor.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKeydown, true);
    doc.removeEventListener('scroll', onScroll, true);
    view?.removeEventListener('resize', positionPopover);
    resizeObserver?.disconnect();
    sealImageHandle?.element.removeEventListener('load', positionPopover, true);
    if (restoreFocus) {
      anchor.focus();
      // 点外关闭时浏览器随后可能把焦点交给被点击元素；下一帧再确认焦点
      // 回到锚点，但若锚点已重新打开浮层则不要抢焦点。
      view?.requestAnimationFrame(() => {
        if (!popover.isConnected && anchor.getAttribute('aria-expanded') !== 'true') {
          anchor.focus();
        }
      });
    }
  };
  const onOutside = (event: Event): void => {
    if (event.target instanceof Node && popover.contains(event.target)) return;
    close();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  closeButton.addEventListener('click', () => close());
  full.addEventListener('click', () => {
    close(false);
    options.onOpenDetails();
  });
  panelButton?.addEventListener('click', () => {
    close(false);
    options.onOpenPanel?.();
  });
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKeydown, true);
  doc.addEventListener('scroll', onScroll, true);
  view?.addEventListener('resize', positionPopover);
  anchor.setAttribute('aria-expanded', 'true');
  closeButton.focus();

  return { close };
}

/** 时间戳文案；固定“已解析，未验证”，并说明不参与总体状态。 */
function timestampText(signature: SignatureVerification, text: CryptoText): string {
  if (signature.timestamp.status === 'parsed-not-verified') {
    return `${text.timestampParsedNotVerified}（${text.timestampNotInOverall}）`;
  }
  if (signature.timestamp.status === 'parse-error') return text.timestampUnparsable;
  return text.none;
}