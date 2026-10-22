/**
 * 签章视图入口（side-effect 模块）。
 *
 * 在模块顶层把 `SignatureService` 注册为阅读器扩展；t9 的公共入口只需
 * `import './views/signatures'` 即可获得签章列表、页覆盖层与详情能力。
 * 本文件不修改 `viewer.ts`，也不读取 `Seal.esl`。
 */

import { registerViewerExtension, type OFDViewer } from '../viewer';
import { SignatureService } from '../signature/service';

/**
 * 挂载签章服务。
 *
 * @param viewer 阅读器实例。
 * @returns 清理函数。
 */
function attachSignature(viewer: OFDViewer): () => void {
  const service = new SignatureService(viewer);
  const detach = viewer.attachSignatureService(service);
  return () => {
    detach();
    service.destroy();
  };
}

registerViewerExtension(attachSignature);

export { attachSignature };
export { SignatureService } from '../signature/service';