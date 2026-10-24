/**
 * 时间兼容性回归：夹具证书到期（2040-01-01）后，测试断言不因墙钟推移而失效。
 *
 * 背景：原先 `verify/verify.test.ts`、`verification/sign/*`、`verification/t3-acceptance*` 等
 * 用例调用 `verifyOfd` 时不传 `now`，实现回落到 `new Date()`。夹具签名者证书 2040-01-01 到期，
 * 之后这些「断言链 status=valid」的用例会集体失败。
 *
 * 本文件不修改系统时钟，而是把「当前时间」显式设为未来（2041/2050）后复跑断言：
 * - 只要实现与测试都只依赖注入的 `now`，结果就与真实墙钟无关；
 * - 顺带校验有效期边界（含端点）与证书链状态不影响 `overall` 的既有契约。
 *
 * 复现命令：
 * `pnpm -C packages/ofdrw-viewer-crypto exec vitest run test/verification/cert/verify-time-compat.verify.test.ts`
 */

import { describe, expect, it } from 'vitest';
import { verifyOfd, type VerificationReport } from '@ofdrw/ofdrw-viewer-crypto';
import { FIXED_NOW, fixtureBytes } from '../../core/fixtures';
import { fixtureEntries, memoryContainer, verifyOptions } from '../sign/support';

/** 受信任根证书 DER。 */
const ROOT = fixtureBytes('certs', 'root-ca.crt.der');

/** 夹具签名者证书到期日（含端点仍有效）。 */
const SIGNER_EXPIRY = new Date('2040-01-01T00:00:00Z');

/** 模拟「项目持续迭代到夹具证书过期之后」的未来时间点。 */
const FUTURE_TIMES = [
  new Date('2041-01-01T00:00:00Z'),
  new Date('2045-06-30T12:00:00Z'),
  new Date('2050-12-31T23:59:59Z'),
] as const;

/**
 * 在指定时间下验证夹具。
 *
 * @param file 夹具文件名。
 * @param now 证书有效期判断时间。
 * @param roots 信任根；省略使用默认根。
 * @returns 验证报告。
 */
async function verifyAt(
  file: string,
  now: Date,
  roots: readonly Uint8Array[] = [ROOT],
): Promise<VerificationReport> {
  const container = memoryContainer(fixtureEntries(file));
  try {
    return await verifyOfd({ container, ...verifyOptions({ now, roots }) });
  } finally {
    await container.close();
  }
}

describe('证书到期后的时间兼容性', () => {
  it('注入有效期内时间：未来任一墙钟都不影响链 valid 的判定', async () => {
    for (const file of ['signed-sesv4.ofd', 'signed-sesv5.ofd', 'integrity.ofd'] as const) {
      const report = await verifyAt(file, FIXED_NOW);
      const status =
        report.signatures[0]?.certificate.status ?? report.integrity?.certificate.status;
      expect(status, file).toBe('valid');
      expect(report.overall, file).toBe('valid');
    }
  });

  it('注入过期时间：链 expired 但 overall 仍 valid（证书链不参与最终判定）', async () => {
    for (const now of FUTURE_TIMES) {
      const report = await verifyAt('signed-sesv4.ofd', now);
      const signature = report.signatures[0]!;
      expect(signature.certificate.status, now.toISOString()).toBe('expired');
      expect(signature.certificate.issues.map((item) => item.code)).toContain('CHAIN_EXPIRED');
      // 密码学判定（签名数学 / 引用 / dataHash）不因过期而降级。
      expect(signature.signature.status).toBe('valid');
      expect(signature.references.status).toBe('valid');
      expect(report.overall).toBe('valid');
    }
  });

  it('边界含端点：notAfter 当天仍 valid，次日才 expired', async () => {
    const onExpiry = await verifyAt('signed-sesv4.ofd', SIGNER_EXPIRY);
    const afterExpiry = await verifyAt(
      'signed-sesv4.ofd',
      new Date(SIGNER_EXPIRY.getTime() + 1000),
    );
    expect(onExpiry.signatures[0]?.certificate.status).toBe('valid');
    expect(afterExpiry.signatures[0]?.certificate.status).toBe('expired');
  });

  it('报告不含依赖墙钟的字段：除注入的 currentTime 外，签名结论在多次运行间一致', async () => {
    const now = FUTURE_TIMES[0];
    const first = await verifyAt('signed-sesv5.ofd', now);
    // 等待跨越可能的系统时钟秒边界，确保对比不受真实时间影响。
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await verifyAt('signed-sesv5.ofd', now);
    const pick = (report: VerificationReport) =>
      ({
        overall: report.overall,
        certificate: report.signatures[0]?.certificate,
        signingTime: report.signatures[0]?.signingTime,
      }) as const;
    expect(JSON.stringify(pick(second))).toBe(JSON.stringify(pick(first)));
    expect(first.signatures[0]?.certificate.currentTime).toBe(now.toISOString());
  });

  it('未配置信任根时，未来时间同样如实报告 expired 而非 unknown', async () => {
    const report = await verifyAt('signed-sesv4.ofd', FUTURE_TIMES[0], []);
    const signature = report.signatures[0]!;
    expect(signature.certificate.trustRootConfigured).toBe(false);
    expect(signature.certificate.status).toBe('expired');
    // 已能确定过期时不降级为 unknown，因此也不出现“信任未知”warning。
    expect(signature.certificate.issues.map((item) => item.code)).toContain('CHAIN_EXPIRED');
    expect(report.warnings.map((warning) => warning.code)).not.toContain(
      'W_CRYPTO_TRUST_UNKNOWN',
    );
  });
});
