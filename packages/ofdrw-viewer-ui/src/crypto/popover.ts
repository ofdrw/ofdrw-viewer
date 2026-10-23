/**
 * 印章点击浮层（设计 §6.5）。
 *
 * 只展示 `VerificationReport` 中该签名的结果；关闭后把焦点还给印章按钮。
 */

import type {
  CertificateChainVerification,
  SignatureVerification,
  VerificationStatus,
} from '@ofdrw/ofdrw-viewer-crypto';
import type { SealImageInfo } from '../types';
import { createSealImageElement } from './seal-image';
import type { SealImageHandle } from './seal-image';
import type { CryptoText } from './text';
import { formatShanghaiDateTime } from './time';

/** 浮层选项。 */
export interface SignaturePopoverOptions {
  /** 所有者文档。 */
  readonly document: Document;
  /** 锚点：签章覆盖层按钮。 */
  readonly anchor: HTMLElement;
  /** 浮层挂载容器（通常为签章层）。 */
  readonly container: HTMLElement;
  /** 签名验证结果。 */
  readonly signature: SignatureVerification;
  /** 文案。 */
  readonly text: CryptoText;
  /** 印章图片；有图片字节时显示真实图片。 */
  readonly sealImage?: SealImageInfo;
  /** 印章名称/编码，用于图片 alt 与降级文案。 */
  readonly sealLabel?: string;
  /** 打开完整验证面板。 */
  readonly onOpenPanel: () => void;
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
  header.append(title, closeButton);

  const body = doc.createElement('dl');
  body.className = 'ofd-signature-popover__pairs';
  const pairs: (readonly [string, string])[] = [
    [text.overall, statusText(signature.status, text)],
    [text.math, statusText(signature.signature.status, text)],
    [
      text.references,
      `${statusText(signature.references.status, text)} ${signature.references.checked}/${signature.references.total}`,
    ],
    [text.chain, chainText(signature.certificate.status, text)],
    [
      text.seal,
      signature.seal
        ? `${signature.seal.name ?? signature.seal.esId ?? text.none}（${statusText(signature.seal.status, text)}）`
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
  full.dataset.ofdControl = 'signature-popover-full';
  full.textContent = text.fullPanel;

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
    const sealBox = doc.createElement('div');
    sealBox.className = 'ofd-signature-popover__seal';
    sealBox.dataset.ofdControl = 'signature-popover-seal-image';
    sealBox.appendChild(sealImageHandle.element);
    popover.append(header, sealBox, body, full);
  } else {
    popover.append(header, body, full);
  }
  container.appendChild(popover);

  // 以覆盖层按钮的当前样式定位；覆盖层使用绝对定位（mm→px 已由签章服务计算）。
  const left = Number.parseFloat(anchor.style.left) || 0;
  const top = Number.parseFloat(anchor.style.top) || 0;
  const height = Number.parseFloat(anchor.style.height) || anchor.offsetHeight;
  popover.style.left = `${Math.max(0, left)}px`;
  popover.style.top = `${top + height + 4}px`;

  let closed = false;
  const close = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    sealImageHandle?.revoke();
    popover.remove();
    anchor.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKeydown, true);
    if (restoreFocus) anchor.focus();
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
    options.onOpenPanel();
  });
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKeydown, true);
  anchor.setAttribute('aria-expanded', 'true');
  closeButton.focus();

  return { close };
}

/** 状态文案。 */
function statusText(status: VerificationStatus, text: CryptoText): string {
  switch (status) {
    case 'valid':
      return text.overallValid;
    case 'invalid':
      return text.overallInvalid;
    case 'unknown':
      return text.overallUnknown;
    case 'not-applicable':
      return text.overallNotApplicable;
    case 'unsupported':
      return text.overallUnsupported;
    default:
      return String(status);
  }
}

/** 证书链状态文案。 */
function chainText(
  status: CertificateChainVerification['status'],
  text: CryptoText,
): string {
  switch (status) {
    case 'valid':
      return text.overallValid;
    case 'invalid':
      return text.overallInvalid;
    case 'unknown':
      return text.overallUnknown;
    case 'untrusted':
      return text.chainUntrusted;
    case 'incomplete':
      return text.chainIncomplete;
    case 'expired':
      return text.chainExpired;
    case 'not-yet-valid':
      return text.chainNotYetValid;
    case 'not-present':
      return text.chainNotPresent;
    case 'unsupported':
      return text.overallUnsupported;
    default:
      return String(status);
  }
}

/** 时间戳文案；固定“已解析，未验证”，并说明不参与总体状态。 */
function timestampText(signature: SignatureVerification, text: CryptoText): string {
  if (signature.timestamp.status === 'parsed-not-verified') {
    return `${text.timestampParsedNotVerified}（${text.timestampNotInOverall}）`;
  }
  if (signature.timestamp.status === 'parse-error') return text.timestampUnparsable;
  return text.none;
}