# 配置手册

本手册说明 **ofdrw-viewer-api-server** 的配置体系：配置文件在哪、怎么找、有哪些配置项、配置内的插值语法、如何校验，以及工作区、作业目录与日志目录的落盘规则。

- 安装、启动与调用方式见 [README.md](../README.md)
- 接口、参数与状态码见 [API.md](./API.md)
- 全部配置项的可运行样例见 [api-server-config.yaml](../api-server-config.yaml)

## 1. 配置从哪里来

服务只从 YAML 文件读取配置，查找顺序如下，命中即停：

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | `--config <file>` 指定的文件 | 显式指定；文件不存在直接报错退出（退出码 1） |
| 2 | `--workdir` 指定目录下的 `api-server-config.yaml` | 指定了 `--workdir` 时优先读该目录的配置 |
| 3 | 进程当前工作目录的 `api-server-config.yaml` | 见 [§2](#2-工作区根与相对路径) |
| 4 | 可执行文件同目录的 `api-server-config.yaml` | 仅 SEA 二进制产物有效；npm 安装时无独立可执行文件，跳过此项 |
| 5 | 内置默认值 | 等价于 [api-server-config.yaml](../api-server-config.yaml) 中的取值 |

**启动时**没有命中任何文件，则以内置默认值启动，并在工作区根**生成一份 `api-server-config.yaml`**（全部为固定取值，不含预置插值）后打印路径提示。已命中配置文件（含 `--config` 指定）或工作区根已有同名文件时不生成、不覆盖。

`-t` 校验模式**不会生成**任何文件：未找到配置时按内置默认值校验，只提示启动时将生成。

```bash
cd /opt/ofd-api                                # 1. 进入服务目录
ofdrw-api-server --config ./api-server-config.yaml
```

> 随 npm 包发布的 `api-server-config.yaml` 在包的根目录，不在可执行文件同目录。想使用它时用 `--config` 指向，或把它复制到工作区根。

## 2. 工作区根与相对路径

工作区根是解析配置内相对路径的基准，按下列优先级确定，命中即停：

| 顺序 | 来源 |
| --- | --- |
| 1 | `--workdir <dir>` 命令行参数 |
| 2 | 配置文件中的 `workspace` 项 |
| 3 | 配置文件所在目录（`--config` 指定的，或自动发现的） |
| 4 | **可执行文件所在目录**（仅 SEA 二进制产物；工作区为空时的默认位置） |
| 5 | 进程当前工作目录（`process.cwd()`，npm 安装且无配置文件时的回退） |

**工作区为空时的默认位置就是可执行文件所在目录**：二进制安装后，无论从哪个目录启动 `ofdrw-api-server`，作业目录、日志目录与自动生成的 `api-server-config.yaml` 都落在可执行文件身边，不会散落到启动目录。npm 安装没有独立可执行文件，此时回退为进程当前工作目录。

`--workdir` 与 `workspace` 的相对值都相对进程当前工作目录解析。工作区根在启动时递归创建，`-t` 输出里会标明来源。

```yaml
# api-server-config.yaml
workspace: ./inst-a        # 相对进程工作目录；也可写绝对路径
```

若 `workspace` 指向的目录下有 `api-server-config.yaml`，以该文件为准（先读入本文件取得 `workspace`，再重新定位）。`workspace` 不参与接口行为，生效配置里只保留路径相关字段。

作业目录**固定**为 `<工作区根>/jobs`，不提供单独配置项；配置中的 `logging.dir`、`render.fontDir`、`verify.roots` 相对工作区根解析，绝对路径原样使用。工作区的目录布局见[设计方案 § 工作区](../../../docs/API服务器设计方案.md#6-工作区)。

> 需要多实例并行时，给每个实例指定不同的 `--workdir`（或不同的 `workspace`）即可，无需复制配置文件。

## 3. 配置项

各层级均为严格模式：**出现未知字段会校验失败**，不会静默忽略。

### 3.0 完整示例

下面的 YAML 列出了全部配置项与默认值，可直接复制为工作区根目录下的 `api-server-config.yaml`，按需改动后启动即生效。省略任一顶层段时该段取默认值，未写出的字段同样取默认值。

```yaml
workspace: null        # 工作区根；null 表示自动确定，填路径则以它为准（相对进程工作目录）

server:
  host: 127.0.0.1
  port: 7860
  maxConcurrency: 4

limits:
  maxUploadBytes: 268435456
  maxJobPages: 5000

jobs:
  workDir: ./jobs
  timeoutSec: 600
  ttlSec: 300
  maxConcurrentJobs: 0            # 0 表示不限制
  maxTotalBytes: 21474836480

output:
  format: json

render:
  format: png
  dpi: 96
  fontDir: null
  systemFonts: true

verify:
  roots: []
  sm2UserId: null

logging:
  level: info
  dir: ./logs
  keepDays: 7
  accessLog: true
```

最小可用配置只需写出要改的项，例如只改端口与日志级别：

```yaml
server:
  port: 9000
logging:
  level: debug
```

> 出厂配置见 [api-server-config.yaml](../api-server-config.yaml)，全部为固定取值；需要按环境注入时，在配置里自行写 `${}`，说明见 [§4](#4-环境变量)。

各段含义展开如下，每段附对应的 YAML 片段。

### 3.0.1 `workspace` 工作区根

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `workspace` | 字符串或 `null` | `null` | 工作区根。`null` 或省略表示按 [§2](#2-工作区根与相对路径) 的优先级自动确定；填路径时优先于“配置文件所在目录” |

`workspace` 只影响路径解析，不参与任何接口行为；优先级高于它的只有 `--workdir`。作业目录固定为其下的 `jobs`。

### 3.1 `server` 监听与并发

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `host` | 字符串 | `127.0.0.1` | 监听地址。仅本机访问请保持默认；改为 `0.0.0.0` 即对局域网开放 |
| `port` | 整数 0–65535 | `7860` | 监听端口，`0` 表示随机端口。端口被占用时启动失败（`CLI_SERVER_PORT_IN_USE`，退出码 2），不顺延 |
| `maxConcurrency` | 整数 ≥ 1 | `4` | 同步渲染的最大并发数 |

```yaml
server:
  host: 127.0.0.1
  port: 7860
  maxConcurrency: 4
```

服务端不主动因超时断开连接，请求超时由调用方控制。

### 3.2 `limits` 用量限制

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxUploadBytes` | 整数 ≥ 1 | `268435456`（256 MiB） | 单个上传文档大小上限，单位 byte。超限返回 `413 CLI_UPLOAD_TOO_LARGE` |
| `maxJobPages` | 整数 ≥ 1 | `5000` | 单个作业允许的最大页数，超限返回 `400 CLI_JOB_TOO_MANY_PAGES` |

```yaml
limits:
  maxUploadBytes: 268435456   # 256 MiB
  maxJobPages: 5000
```

### 3.3 `jobs` 作业

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `timeoutSec` | 数值 ≥ 0 | `600` | 单个作业的执行超时，单位秒；超时置为 `failed`（`CLI_JOB_TIMEOUT`） |
| `ttlSec` | 整数 ≥ -1 | `300` | 作业结束后的默认保留时长，单位秒；`-1` 表示永不过期。请求可用 `ttlSec` 覆盖 |
| `maxConcurrentJobs` | 整数 ≥ 0 | `0` | 同时执行的作业数，单位个；`0` 表示不限制，超出上限的作业排队等待 |
| `maxTotalBytes` | 整数 ≥ 0 | `21474836480`（20 GiB） | 作业目录总占用上限，单位 byte。超出时按创建时间删除旧作业，仍不足则拒绝新作业（`412 CLI_JOB_STORAGE_FULL`） |

作业目录固定为 `<工作区根>/jobs`（持久化原始文档、`meta.json` 与全部产物），不可单独配置：

```yaml
jobs:
  timeoutSec: 600
  ttlSec: 300
  maxConcurrentJobs: 0            # 0 表示不限制
  maxTotalBytes: 21474836480   # 20 GiB
```

### 3.4 `output` 响应格式

| 配置项 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `format` | `json` / `zip` / `multipart` | `json` | 默认响应格式，可被请求参数 `output` 覆盖。各格式差异见 [API.md §1.3](./API.md#13-输出格式) |

```yaml
output:
  format: json
```

### 3.5 `render` 渲染

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `format` | `png` / `jpeg` / `webp` | `png` | 默认图片格式，可被请求参数 `format` 覆盖 |
| `dpi` | 整数 ≥ 1 | `96` | 默认输出 DPI，可被请求参数 `dpi` 覆盖；同时决定文字坐标的像素换算 |
| `fontDir` | 路径或 `null` | `null` | 补充字体目录，递归扫描 `.ttf/.otf/.ttc/.otc`（最多 2000 个）；`null` 表示不加载 |
| `systemFonts` | 布尔 | `true` | 是否自动发现系统字体。服务只读平台白名单字体目录，不调用外部命令、不访问网络 |

```yaml
render:
  format: png
  dpi: 96
  fontDir: null          # 或 ./fonts，相对工作区根
  systemFonts: true
```

字体缺失会导致文字替换或显示为空，中文文档建议至少满足一项：开启 `systemFonts`，或用 `fontDir` 指向含中文字体的目录。

### 3.6 `verify` 签名验证

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `roots` | 路径数组 | `[]` | 信任根证书文件（PEM），相对路径相对工作区根。启动校验时检查文件可读性 |
| `sm2UserId` | 字符串或 `null` | `null` | 默认 SM2 签名 userId；`null` 使用标准值 |

```yaml
verify:
  roots:
    - ./certs/root-ca.pem
    - ./certs/another-ca.pem
  sm2UserId: null
```

`roots` 为空时，签名数学上通过但无法判定信任链，`overall` 为 `unknown`。

> 当前版本 `roots` 仅做路径存在性与可读性校验，`/api/verify` 尚未加载其中的证书用于信任链判定，服务端不会输出 `valid`。需要严格判定信任链时，请使用 [ofdrw-viewer-cli](../../ofdrw-viewer-cli/README.md) 并在调用方显式提供根证书。

### 3.7 `logging` 日志

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `level` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` | `info` | 日志级别 |
| `dir` | 字符串 | `./logs` | 日志目录，按天轮转，文件名为 `api-server.<YYYY-MM-DD>.<序号>.log` |
| `keepDays` | 整数 ≥ 1 | `7` | 日志保留天数，单位天。启动时清理超期文件 |
| `accessLog` | 布尔 | `true` | 是否为每个请求记录一行访问日志 |

```yaml
logging:
  level: info
  dir: ./logs
  keepDays: 7
  accessLog: true
```

日志目录不可写时不会阻断启动：服务告警 `W_LOG_FILE` 后只向标准输出打日志。

## 4. 环境变量

服务**不预置任何环境变量**：出厂配置与自动生成的默认配置全部是固定取值，不能通过环境变量覆盖任何配置项。

配置文件本身的字符串值支持插值语法，需要时自行在配置里写：

| 写法 | 行为 |
| --- | --- |
| `${VAR}` | 取环境变量 `VAR`；未设置或为空串时替换为空串 |
| `${VAR:-默认值}` | 取环境变量 `VAR`；未设置或为空串时使用默认值 |

- 只对字符串标量插值，结果按字段类型转换（如 `port: ${MY_PORT}` 配 `MY_PORT=9000` 得到整数 9000）；
- 一条配置可以引用多个变量；
- 配置里没有出现的变量名不会被读取；
- 变量缺失不会单独报错，而是按上表替换后继续校验；空串不会当作 `0`，因此数值字段（如 `port`）替换为空串时报 `CLI_CONFIG_INVALID`。

示例：

```yaml
server:
  port: ${MY_PORT:-7860}
logging:
  level: ${MY_LOG_LEVEL:-info}
jobs:
  ttlSec: ${MY_JOB_TTL:-300}
```

```bash
MY_PORT=9000 MY_LOG_LEVEL=debug ofdrw-api-server --config ./api-server-config.yaml
```

## 5. 校验配置

不启动服务，只校验配置与目录可用性：

```bash
ofdrw-api-server -t
```

输出示例（二进制安装、工作区为空、在任何目录启动）：

```text
配置来源: (内置默认)
工作区: /opt/ofd-api（来源 可执行文件所在目录，相对路径基准）
服务器: http://127.0.0.1:7860（并发 4，请求不设服务端超时）
上传上限: 256 MiB
作业目录: /opt/ofd-api/jobs（超时 600s，默认有效期 300s，并发 不限，上限 20 GiB）
输出: json
日志目录: /opt/ofd-api/logs（级别 info，保留 7 天，访问日志开）
校验结果: 通过
提示: 启动时将在 /opt/ofd-api/api-server-config.yaml 生成默认配置（校验模式不生成）
```

`工作区` 一行会注明来源（`命令行 --workdir`、`配置文件 workspace`、`配置文件所在目录`、`可执行文件所在目录`、`进程工作目录`），可据此确认工作区根是否符合预期。

校验内容包括：YAML 语法、未知字段、字段类型、取值范围、工作区根与日志目录可写性、`render.fontDir` 是否为目录、`verify.roots` 是否可读。

校验失败时逐条输出错误并退出码 1，错误码含义：

| 错误码 | 含义 |
| --- | --- |
| `CLI_CONFIG_INVALID` | YAML 语法、未知字段、类型或取值不合法；字体目录或根证书路径无效 |
| `CLI_CONFIG_WORKDIR` | 工作区根或日志目录不存在、不是目录或不可写 |

目录与配置文件不会在校验阶段（`-t`）创建，实际启动时递归创建。

## 6. 作业目录与日志

### 6.1 作业目录

作业目录固定为 `<工作区根>/jobs`，是唯一持久化作业数据的位置，单实例独占（以 `.lock` 文件加锁，被活跃进程占用时拒绝启动，`CLI_SERVER_LOCKED`）：

```text
jobs/
├── .lock                  单实例锁
├── .tmp/                  写入中转，首次用到时创建（如 /api/verify），启动时清空
├── .trash/                待删除的作业目录，启动时清空
└── <作业ID>/
    ├── meta.json          作业信息、状态与进度
    ├── source.ofd         上传的原始文档
    ├── p001.png           图片产物（ops 含 images）
    ├── p001.json          该页文本坐标（ops 含 text）
    ├── media-12.mp4       音视频产物（ops 含 media）
    ├── attachment-3.xml   附件产物（ops 含 attachments）
    └── result.zip         首次下载整包时生成
```

- 作业结束后按 `ttlSec` 计算过期时间，运行期每 10 秒巡检删除过期作业；
- 文件名只由服务端生成，字符集为 `[A-Za-z0-9._-]`，不使用客户端文件名；
- 作业目录与日志目录不得互相包含；多实例部署须使用不同的工作区根。

### 6.2 日志目录

日志目录由 `logging.dir` 指定：

- 文件名为 `api-server.<YYYY-MM-DD>.<序号>.log`，按天切换，不按大小切分；序号用于同一天内多次滚动时区分；
- 启动时删除修改时间早于 `keepDays` 天的 `api-server.*.log`，其他文件不动；
- 文件内容为 JSON 行，含 `time`/`level`/`traceId` 与结构化字段；标准输出为人类可读文本；
- POSIX 下目录权限 `0700`、文件权限 `0640`；
- 不记录文档内容、产物内容与任何凭据。

错误响应中的 `traceId` 与日志中的 `traceId` 对应，可据此定位单次请求。

## 7. 常见部署场景

### 7.1 仅本机使用（默认）

无需任何配置，工作区为空时自动用**可执行文件所在目录**作为工作区根：

```bash
/opt/ofd-api/ofdrw-api-server
```

`jobs/`、`logs/` 与自动生成的 `api-server-config.yaml` 都落在 `/opt/ofd-api`，与启动时所在目录无关。想把工作区放到别处，用 `--workdir` 或配置 `workspace` 覆盖即可。

### 7.2 对局域网开放

服务不内建鉴权，开放监听地址前必须由外层网关、反向代理或防火墙控制访问：

```yaml
server:
  host: 0.0.0.0
  port: 7860
```

### 7.3 作业数据与日志分离到大容量磁盘

把工作区根整体放到大容量磁盘，日志再单独指到系统日志盘：

```bash
ofdrw-api-server --workdir /data/ofd-api
```

```yaml
jobs:
  maxTotalBytes: 107374182400   # 100 GiB
  ttlSec: 86400                 # 保留 1 天
logging:
  dir: /var/log/ofd-api
  keepDays: 30
```

### 7.4 固定的字体与信任根

```yaml
render:
  fontDir: ./fonts
  systemFonts: false     # 只使用 fontDir 提供的字体，渲染结果可复现
verify:
  roots:
    - ./certs/root-ca.pem
```

### 7.5 多个实例

每个实例指定独立的工作区根，作业目录、锁与日志随之隔离。端口仍需各不相同，可用各自工作区里的配置文件指定：

```bash
mkdir -p /srv/ofd-a /srv/ofd-b
printf 'server:\n  port: 7861\n' > /srv/ofd-a/api-server-config.yaml
printf 'server:\n  port: 7862\n' > /srv/ofd-b/api-server-config.yaml

ofdrw-api-server --workdir /srv/ofd-a
ofdrw-api-server --workdir /srv/ofd-b
```

`jobs/`、`logs/` 在首次启动时自动创建；工作区内没有配置文件时会自动生成一份默认配置，改完端口重启即可。若希望共用同一份配置文件，可把 `workspace` 写进该文件的不同副本，或直接用 `--config` 指向不同文件（此时工作区根取配置文件所在目录）。