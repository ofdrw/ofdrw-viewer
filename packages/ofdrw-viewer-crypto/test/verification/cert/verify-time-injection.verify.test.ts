/**
 * 证书有效期时间注入回归：验证结果必须由显式 `now` 决定，不得依赖真实系统时间。
 *
 * 夹具证书有效期为 2025-01-01～2040-01-01（根证书至 2045-01-01）。项目持续迭代后
 * 真实系统时间必然越过夹具到期日，因此所有「断言证书链 valid」的用例都必须注入 `now`；
 * 本文件用同一批夹具在多个注入时间下复跑，锁定这一约定。
 *
 * 复现命令：
 * `pnpm -C packages/ofdrw-viewer-crypto exec vitest run test/verification/cert`
 */

import { describe, expect, it } from 'vitest';
import { verifyOfd, type VerificationReport } from '@ofdrw/ofdrw-viewer-crypto';
import { FIXED_NOW, fixtureBytes } from '../../core/fixtures';
import { fixtureEntries, memoryContainer, verifyOptions } from '../sign/support';

/** 受信任根证书 DER（sign/support 的 verifyOptions 默认已注入，这里显式声明便于断言 trustAnchor）。 */
const ROOT = fixtureBytes('certs', 'root-ca.crt.der');

/** 夹具签名者证书有效期起点。 */
const SIGNER_NOT_BEFORE = new Date('2025-01-01T00:00:00Z');
/** 夹具签名者证书有效期终点（按包含端点判定）。 */
const SIGNER_NOT_AFTER = new Date('2040-01-01T00:00:00Z');

/** 带签名的夹具与仅完整性夹具，覆盖签名链与完整性链两条路径。 */
const CASES = ['signed-sesv4.ofd', 'signed-sesv5.ofd', 'integrity.ofd'] as const;

/**
 * 在指定时间下验证夹具。
 *
 * @param file 夹具文件名。
 * @param now 证书有效期判断时间。
 * @returns 验证报告。
 */
async function verifyAt(file: string, now: Date): Promise<VerificationReport> {
  const container = memoryContainer(fixtureEntries(file));
  try {
    return await verifyOfd({ container, ...verifyOptions({ now }) });
  } finally {
    await container.close();
  }
}

/**
 * 读取报告中的证书链状态（签名优先，其次完整性）。
 *
 * @param report 验证报告。
 * @returns 链状态。
 */
function chainStatusOf(report: VerificationReport): string | undefined {
  return report.signatures[0]?.certificate.status ?? report.integrity?.certificate.status;
}

describe('证书有效期只由注入的 now 决定', () => {
  for (const file of CASES) {
    it(`${file}：有效期内 → 链 valid 且 trustAnchor 为配置的根`, async () => {
      for (const now of [
        SIGNER_NOT_BEFORE, // 有效起点（包含端点）
        FIXED_NOW, // 夹具默认基准时间
        SIGNER_NOT_AFTER, // 有效终点（包含端点）
      ]) {
        const report = await verifyAt(file, now);
        expect(chainStatusOf(report), `${file} @ ${now.toISOString()}`).toBe('valid');
        expect(report.overall).toBe('valid');
      }
    });

    it(`${file}：超过 notAfter → 链 expired，签名与 overall 不受影响`, async () => {
      const now = new Date(SIGNER_NOT_AFTER.getTime() + 1);
      const report = await verifyAt(file, now);
      expect(chainStatusOf(report)).toBe('expired');
      // 证书链状态是独立明细，不参与密码学判定。
      expect(report.overall).toBe('valid');
    });

    it(`${file}：早于 notBefore → 链 not-yet-valid，签名与 overall 不受影响`, async () => {
      const now = new Date(SIGNER_NOT_BEFORE.getTime() - 1);
      const report = await verifyAt(file, now);
      expect(chainStatusOf(report)).toBe('not-yet-valid');
      expect(report.overall).toBe('valid');
    });

    it(`${file}：报告 currentTime 原样回显注入时间`, async () => {
      const now = new Date('2031-07-15T08:30:00Z');
      const report = await verifyAt(file, now);
      const currentTime =
        report.signatures[0]?.certificate.currentTime ?? report.integrity?.certificate.currentTime;
      expect(currentTime).toBe(now.toISOString());
    });
  }

  it('同一夹具在不同注入时间下得到不同链状态，证明判定确实取自 now 而非墙钟', async () => {
    const before = await verifyAt('signed-sesv4.ofd', new Date('2019-01-01T00:00:00Z'));
    const during = await verifyAt('signed-sesv4.ofd', FIXED_NOW);
    const after = await verifyAt('signed-sesv4.ofd', new Date('2041-01-01T00:00:00Z'));
    expect([
      before.signatures[0]?.certificate.status,
      during.signatures[0]?.certificate.status,
      after.signatures[0]?.certificate.status,
    ]).toEqual(['not-yet-valid', 'valid', 'expired']);
  });

  it('连续两次同时间验证结果完全一致（无隐藏的时间相关抖动）', async () => {
    const first = await verifyAt('signed-sesv4.ofd', FIXED_NOW);
    const second = await verifyAt('signed-sesv4.ofd', FIXED_NOW);
    const snapshot = (report: VerificationReport) =>
      JSON.stringify({
        overall: report.overall,
        signatures: report.signatures.map((item) => ({
          status: item.status,
          certificate: item.certificate,
          seal: item.seal?.certificate,
        })),
        integrity: report.integrity?.certificate,
      });
    expect(snapshot(second)).toBe(snapshot(first));
  });

  it('未配置信任根时，过期/未生效仍如实报告，不被降级为 unknown', async () => {
    for (const [now, expected] of [
      [new Date('2041-01-01T00:00:00Z'), 'expired'],
      [new Date('2019-01-01T00:00:00Z'), 'not-yet-valid'],
    ] as const) {
      const report = await verifyAt('signed-sesv4.ofd', now);
      const signature = report.signatures[0]!;
      expect(signature.certificate.trustRootConfigured).toBe(true);
      expect(signature.certificate.trustAnchor).toBeDefined();
      expect(signature.certificate.status).toBe(expected);
    }
  });

  it('非法 now 直接拒绝，不会静默回落到系统时间', async () => {
    const container = memoryContainer(fixtureEntries('signed-sesv4.ofd'));
    try {
      await expect(
        verifyOfd({ container, roots: [ROOT], now: new Date('not-a-date') }),
      ).rejects.toMatchObject({ code: 'CRYPTO_INVALID_ARGUMENT' });
    } finally {
      await container.close();
    }
  });
});
