/**
 * 签章模块公共出口（模块内部使用）。
 *
 * `src/views/signatures.ts` 只负责在模块顶层注册扩展；测试可直接引用这里的
 * `SignatureService` 与解析入口。
 */

export { groupEntries, SIGNATURE_NOT_VERIFIED_NOTE, SignatureService } from './service';
export { parseSubject, subjectCN, toAlgorithm, toCertificateInfo, toSealInfo, toSignerInfo } from './mapping';
