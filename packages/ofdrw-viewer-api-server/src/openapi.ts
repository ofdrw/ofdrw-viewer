/**
 * OpenAPI 3.1 描述生成。
 *
 * 覆盖全部路由；请求体统一描述为 JSON(base64) 或 multipart 两种形态。
 */

import type { ApiServerConfig } from './config.js';
import { VERSION } from './version.js';

/** JSON 或 multipart 两种请求体的描述。 */
const UPLOAD_REQUEST_BODY = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'object',
            required: ['base64'],
            properties: {
              name: { type: 'string', description: '文件名' },
              base64: { type: 'string', description: 'OFD 文档的 base64 编码' },
            },
          },
          params: { type: 'object', additionalProperties: true, description: '接口参数' },
        },
      },
    },
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary', description: 'OFD 文档' },
        },
        additionalProperties: { type: 'string' },
      },
    },
  },
};

/** 错误响应。 */
const ERROR_RESPONSE = {
  description: '错误',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['code', 'message', 'traceId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          traceId: { type: 'string' },
        },
      },
    },
  },
};

/**
 * 生成 OpenAPI 文档。
 *
 * @param config 生效配置，用于填充服务器地址与默认值
 * @returns OpenAPI 3.1 文档对象
 */
export function buildOpenApiDocument(config: ApiServerConfig): unknown {
  const uploadPath = (summary: string, extra: Record<string, unknown> = {}) => ({
    summary,
    requestBody: UPLOAD_REQUEST_BODY,
    responses: {
      200: { description: '成功' },
      207: { description: '部分页失败' },
      400: ERROR_RESPONSE,
      413: ERROR_RESPONSE,
      415: ERROR_RESPONSE,
      422: ERROR_RESPONSE,
    },
    ...extra,
  });

  return {
    openapi: '3.1.0',
    info: {
      title: '@ofdrw/ofdrw-viewer-api-server',
      version: VERSION,
      description: 'OFD 转图片、文本提取、信息查询与签名验证',
    },
    servers: [{ url: `http://${config.server.host}:${config.server.port}/api` }],
    paths: {
      '/version': {
        get: {
          summary: '版本与平台信息',
          responses: { 200: { description: '成功' } },
        },
      },
      '/health': {
        get: {
          summary: '健康检查',
          responses: { 200: { description: '成功' } },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI 描述',
          responses: { 200: { description: '成功' } },
        },
      },
      '/convert': {
        post: uploadPath('转图片', {
          parameters: [
            { name: 'pages', in: 'query', schema: { type: 'string' }, description: '页码范围，如 1-3,5' },
          ],
        }),
      },
      '/text': {
        post: uploadPath('提取文字空间坐标'),
      },
      '/info': {
        post: uploadPath('文档信息与包级摘要'),
      },
      '/verify': {
        post: uploadPath('签名与完整性验证'),
      },
      '/outline': {
        post: uploadPath('目录与书签'),
      },
      '/pages': {
        post: uploadPath('页尺寸列表或单页图片'),
      },
      '/attachments': {
        post: uploadPath('附件列表'),
      },
      '/attachments/{id}': {
        post: uploadPath('下载单个附件', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      },
      '/media': {
        post: uploadPath('音视频列表'),
      },
      '/media/{id}': {
        post: uploadPath('下载单个媒体', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      },
      '/jobs': {
        post: uploadPath('创建作业', {
          responses: { 201: { description: '作业已创建' }, 400: ERROR_RESPONSE, 412: ERROR_RESPONSE },
        }),
        get: {
          summary: '作业列表',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string' },
              description: '逗号分隔的状态过滤',
            },
          ],
          responses: { 200: { description: '成功' } },
        },
      },
      '/jobs/{id}/meta.json': {
        get: {
          summary: '作业元信息',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '成功' },
            404: ERROR_RESPONSE,
            410: ERROR_RESPONSE,
          },
        },
      },
      '/jobs/{id}/files/{name}': {
        get: {
          summary: '单个产物文件',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: '文件字节' },
            404: ERROR_RESPONSE,
            410: ERROR_RESPONSE,
          },
        },
      },
      '/jobs/{id}/result': {
        get: {
          summary: '作业目录 ZIP',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'ZIP 字节', content: { 'application/zip': {} } },
            404: ERROR_RESPONSE,
            410: ERROR_RESPONSE,
          },
        },
      },
      '/jobs/{id}': {
        delete: {
          summary: '取消并删除作业',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            204: { description: '已删除' },
            404: ERROR_RESPONSE,
            410: ERROR_RESPONSE,
          },
        },
      },
    },
  };
}