#!/usr/bin/env node
/**
 * SEA 自包含可执行文件构建入口（占位）。
 *
 * 本阶段只提供脚本名以冻结包接口；真正的 bundle、资产收集与
 * `node --build-sea` 流程由后续 SEA 打包任务实现。
 */

console.error('build:sea 尚未实现：SEA 打包将在后续任务中提供。');
process.exitCode = 1;