# ofdrw-view

OFD 页面渲染引擎。

## 目录结构

```
ofdrw-view/
  package.json                      # 项目配置
  docs/
    OFD渲染引擎设计方案.md
  packages/
    ofdrw-viewer-engine/            # 引擎包
      package.json
      tsconfig.json
      src/
        index.ts                    # 公共 API 出口
        api/                        # OFDDocument / OFDPage / RenderTask
        common/                     # 无 OFD 语义的公共类型
        model/                      # 页面/图元/资源数据模型
        resource/                   # 资源作用域与缓存
        style/                      # DrawParam 结算
        render/                     # 页面渲染管线
        renderer/                   # Renderer 抽象与默认实现
        font/                       # 字体解析与字形轮廓
        image/                      # JBIG2/TIFF 等图片解码
        platform/                   # 宿主注入的平台接口
```

## 约定

- 根目录只放项目配置、脚本与文档，不放引擎实现。
- 引擎公共 API 只从 `packages/ofdrw-viewer-engine/src/index.ts` 导出。
- `docs/`、`references/`、`ofd_pdf_match/` 不进入 engine 包。