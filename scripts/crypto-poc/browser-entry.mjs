/**
 * 浏览器侧 PoC 入口：打包 sm-crypto 与 DER/SM4 工具，
 * 在 Chromium 中运行与 Node 相同的标准向量和 SM2 互操作测试。
 */
import smCrypto from 'sm-crypto';
import { DEFAULTS, runVectors } from './lib/vectors.mjs';

const result = runVectors(smCrypto, DEFAULTS, true);
window.__POC_RESULT__ = result;
const pre = document.createElement('pre');
pre.id = 'poc-result';
pre.textContent = JSON.stringify({
  allPassed: result.allPassed,
  failed: result.results.filter((r) => !r.ok),
  passedCount: result.results.filter((r) => r.ok).length,
  artifacts: result.artifacts,
}, null, 2);
document.body.appendChild(pre);
