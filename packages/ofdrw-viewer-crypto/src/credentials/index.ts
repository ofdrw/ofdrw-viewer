/**
 * 凭据处理（I-DEC）。
 */

export { normalizeCredentials, recoverLayerKey } from './credential';
export type { RecoveredLayerKey } from './credential';
export { parseSm2PrivateKeyAsync } from './pkcs8';
