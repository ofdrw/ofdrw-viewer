/**
 * 证书链：KeyUsage、pathLen、缺 issuer、DN 编码差异与中间证书补链。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRYPTO_LIMITS,
  parseX509Certificate,
  type X509Certificate,
} from '@ofdrw/ofdrw-viewer-crypto';
import { verifyCertificateChain } from '../../src/verify/chain';
import { fixtureBytes } from '../core/fixtures';
import { makeCertificate, testKeyPair, type CertificateOptions } from './certs';

const ROOT_CN = 'OFDRW Viewer Crypto Fixtures Root CA';
const INT_CN = 'OFDRW Viewer Crypto Fixtures Intermediate CA';
const SUB_CN = 'OFDRW Viewer Crypto Fixtures Sub CA';
const LEAF_CN = 'OFDRW Viewer Crypto Fixtures Chain Leaf';

const keys = {
  root: testKeyPair('root-ca'),
  intermediate: testKeyPair('signer'),
  sub: testKeyPair('seal'),
  leaf: testKeyPair('encrypt'),
  leaf2: testKeyPair('tsa'),
};
const root = parseX509Certificate(fixtureBytes('certs', 'root-ca.crt.der'));

/**
 * 生成证书。
 *
 * @param options 证书选项。
 * @param subject 主体密钥名。
 * @param issuer 颁发者密钥名。
 * @returns 解析后的证书。
 */
function cert(
  options: Partial<CertificateOptions> & { cn: string },
  subject: keyof typeof keys,
  issuer: keyof typeof keys,
): X509Certificate {
  return parseX509Certificate(
    makeCertificate(
      { serial: BigInt(Math.floor(Math.random() * 100000) + 1), ...options },
      keys[subject],
      keys[issuer],
    ).der,
  );
}

/**
 * 构造默认中间 CA。
 *
 * @param overrides 覆盖字段。
 * @returns 中间 CA 证书。
 */
function intermediate(overrides: Partial<CertificateOptions> = {}): X509Certificate {
  return cert(
    {
      cn: INT_CN,
      issuerCn: ROOT_CN,
      isCA: true,
      keyUsage: ['digitalSignature', 'keyCertSign', 'cRLSign'],
      ...overrides,
    },
    'intermediate',
    'root',
  );
}

/**
 * 执行链校验。
 *
 * @param signer 签名者。
 * @param intermediates 候选中间证书。
 * @param roots 信任根。
 * @returns 链结果。
 */
function verify(
  signer: X509Certificate,
  intermediates: readonly X509Certificate[],
  roots: readonly X509Certificate[],
) {
  return verifyCertificateChain(signer, intermediates, {
    now: new Date('2026-10-23T00:00:00Z'),
    roots,
    sm2UserId: '1234567812345678',
    limits: DEFAULT_CRYPTO_LIMITS,
  });
}

describe('verifyCertificateChain', () => {
  it('根—中间 CA—签名者三级链 valid', () => {
    const int = intermediate();
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: ['digitalSignature', 'nonRepudiation'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [int], [root]);
    expect(result.status).toBe('valid');
    expect(result.chain).toHaveLength(3);
    expect(result.trustAnchor?.subject).toContain(ROOT_CN);
  });

  it('未配置 roots 且缺中间证书 → unknown（不是 incomplete）', () => {
    const int = intermediate();
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [], []);
    expect(result.status).toBe('unknown');
    expect(result.issues.map((item) => item.code)).not.toContain('CHAIN_INCOMPLETE');
  });

  it('无 roots 的 9 跳链 → unknown，不因最大链长判 incomplete', () => {
    const chainCas: X509Certificate[] = [];
    let issuerCn = ROOT_CN;
    for (let index = 1; index <= 8; index += 1) {
      const ca = cert(
        {
          cn: `Chain CA ${index}`,
          issuerCn,
          isCA: true,
          keyUsage: ['keyCertSign', 'cRLSign'],
        },
        'intermediate',
        index === 1 ? 'root' : 'intermediate',
      );
      chainCas.push(ca);
      issuerCn = `Chain CA ${index}`;
    }
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, chainCas, []);
    expect(result.chain).toHaveLength(9);
    expect(result.status).toBe('unknown');
    expect(result.issues.map((item) => item.code)).not.toContain('CHAIN_INCOMPLETE');
  });

  it('配置 roots 但缺中间证书 → incomplete', () => {
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [], [root]);
    expect(result.status).toBe('incomplete');
    expect(result.issues.map((item) => item.code)).toContain('CHAIN_INCOMPLETE');
  });

  it('中间 CA KeyUsage 缺 keyCertSign → invalid', () => {
    const int = intermediate({ keyUsage: ['digitalSignature'] });
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [int], [root]);
    expect(result.status).toBe('invalid');
    expect(result.issues.map((item) => item.code)).toContain('CHAIN_KEY_USAGE_INVALID');
  });

  it('签名者 KeyUsage 不允许签名 → invalid', () => {
    const int = intermediate();
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: ['keyAgreement'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [int], [root]);
    expect(result.status).toBe('invalid');
    expect(result.issues.map((item) => item.code)).toContain('CHAIN_KEY_USAGE_INVALID');
  });

  it('KeyUsage 缺失 → valid 但记录 warning', () => {
    const int = intermediate({ keyUsage: undefined });
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        isCA: false,
        keyUsage: undefined,
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [int], [root]);
    expect(result.status).toBe('valid');
    expect(result.issues.filter((item) => item.code === 'CHAIN_KEY_USAGE_MISSING')).toHaveLength(2);
  });

  it('pathLenConstraint 越界 → invalid', () => {
    const int = intermediate({ pathLen: 0 });
    const sub = cert(
      {
        cn: SUB_CN,
        issuerCn: INT_CN,
        isCA: true,
        keyUsage: ['keyCertSign'],
      },
      'sub',
      'intermediate',
    );
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: SUB_CN,
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'sub',
    );
    const result = verify(leaf, [sub, int], [root]);
    expect(result.status).toBe('invalid');
    expect(result.issues.map((item) => item.code)).toContain('CHAIN_PATH_LEN_EXCEEDED');
  });

  it('DN 编码差异（PrintableString/UTF8String）仍可补链', () => {
    const int = intermediate();
    const leaf = cert(
      {
        cn: LEAF_CN,
        issuerCn: INT_CN,
        issuerEncoding: 'printable',
        isCA: false,
        keyUsage: ['digitalSignature'],
      },
      'leaf',
      'intermediate',
    );
    const result = verify(leaf, [int], [root]);
    expect(result.status).toBe('valid');
    expect(result.chain).toHaveLength(3);
  });
});
