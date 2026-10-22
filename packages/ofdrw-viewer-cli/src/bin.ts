#!/usr/bin/env node
/**
 * CLI 可执行入口。
 *
 * 只负责把命令行参数交给 `main` 并把返回的退出码写入 `process.exitCode`；
 * 不使用 `process.exit()`，保证 stdout/stderr 正常刷新。
 */

import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));