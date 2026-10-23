/**
 * sm-crypto 的统一引入点。
 *
 * 上游为 CommonJS 且未提供类型；使用默认导出以兼容 ESM/CJS 与打包器。
 * 除本文件外，crypto 包不得直接 import `sm-crypto`。
 */

import smCrypto from 'sm-crypto';

export const { sm2, sm3, sm4 } = smCrypto;