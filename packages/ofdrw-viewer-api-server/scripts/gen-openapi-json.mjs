/**
 * 把 OpenAPI 描述导出为静态文件 `docs/openapi.json`。
 *
 * 内容与运行期 `GET /api/openapi.json` 一致，`servers` 取默认监听地址，便于离线查看、
 * 与客户端代码生成工具使用时导入。构建时跟随源代码更新，产物随包发布。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../dist/openapi.js';

/** 生成 OpenAPI 时采用的监听地址，单位：端口号。 */
const DEFAULT_PORT = 7860;

/** 生效配置占位：只取 OpenAPI 描述用到的字段，避免为生成文档读取真实配置。 */
const DESCRIPTIVE_CONFIG = { server: { host: '127.0.0.1', port: DEFAULT_PORT } };

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(packageDir, 'docs', 'openapi.json');

const document = buildOpenApiDocument(DESCRIPTIVE_CONFIG);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`已生成 ${outputPath}`);