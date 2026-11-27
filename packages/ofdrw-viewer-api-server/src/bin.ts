#!/usr/bin/env node
/**
 * api-server 可执行入口。
 *
 * SEA 产物在启动前先准备 canvas 资源（第三方依赖由 SEA 入口在更早阶段解压），
 * 普通 Node 下为空操作。
 *
 * 子命令参数交给 `runCli`，返回值写入 `process.exitCode`；不使用
 * `process.exit()`，保证日志与响应流正常刷新。
 */

import { prepareSeaAssets } from './sea.js';
import { runCli } from './cli.js';

/**
 * 入口主流程：准备资源后运行命令。
 *
 * @returns 运行完成的 Promise
 */
async function main(): Promise<void> {
  await prepareSeaAssets();
  process.exitCode = await runCli(process.argv.slice(2));
}

// 顶层调用而不 await：SEA 产物以 IIFE 脚本执行，不能出现顶层 await；
// 主流程内部的错误由 runCli 统一转换，未捕获异常由 Node 按退出码 1 处理。
void main();
