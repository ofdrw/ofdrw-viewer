/**
 * 浏览器 CDN 插件对 engine 的运行时桥接。
 *
 * crypto 的 CDN 包（global.js/min.js）不内联 engine，而是从页面已加载的
 * `globalThis.OFDRWViewer` 读取所需值。这样 engine 与 crypto 各自独立升级，
 * 页面也只下载一份 engine。
 *
 * 只列出 crypto 当前实际使用的 engine 值；新增依赖时必须同步更新本文件。
 */
'use strict';

const engine = globalThis.OFDRWViewer;
if (!engine) {
  throw new Error(
    '未找到全局 OFDRWViewer：请先加载 @ofdrw/ofdrw-viewer-engine 的 global.js 或 min.js，再加载 crypto 插件',
  );
}

module.exports = {
  OFDError: engine.OFDError,
  isOFDError: engine.isOFDError,
  openZipVirtualContainer: engine.openZipVirtualContainer,
};