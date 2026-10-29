# 23. 远程镜像开发

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/23-remote-mirror-development) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 范围：本地为主副本、镜像到远程 Linux 主机的项目，随包发布的 `pi-helper`
> 服务，环境初始化，文件同步，以及远程调试。
> 状态：已实现的是 helper 服务（分帧、认证、`env.verify`、`fs.*`、
> `adapter.install/probe/start/stop`）、host-core 镜像存储与 `mirror.*` RPC、
> 带基线漂移检测的逐文件同步引擎、镜像项目创建、DAP 客户端，以及远程构建与运行。
> 尚未实现：helper 的 `watch.*` 操作、镜像初始化状态机、调试 UI，以及 `pull` 模式。
> 交叉引用：[05-remote-agent-control](../02-architecture/05-remote-agent-control.md) ·
> [02-remote-control-security](../05-security/02-remote-control-security.md) ·
> [08-error-codes](08-error-codes.md) ·
> [ADR 0338](../../adr/0338-remote-mirror-development-helper.md) ·
> [ADR 0326](../../adr/0326-verified-ssh-host-installation.md) ·
> [ADR 0108](../../adr/0108-remove-built-in-interactive-terminal.md)

---

## 1. 目的与非目标

镜像项目把**本地工作副本作为唯一事实来源**，把**远程镜像**用于在远程环境中
编译、运行与调试。本地副本是 Agent 编辑和编辑器插件保存的那一份；远程副本只是
投影。

范围内：

- 创建镜像项目并初始化其远程环境；
- 由用户模式驱动的双向逐文件同步；
- 通过运行在主机上的调试适配器进行远程调试；
- 断点与同步状态在本地持久化。

范围外（刻意排除，不是延后）：

- 远程机器上的 AI agent、模型请求、会话或工具中继；
- 交互式远程终端或通用远程命令执行器；
- 远端删除、删除传播、双向合并或 `rsync`；
- Windows 或 macOS 远程目标。

## 2. 项目模型

项目组新增一个可选的附加绑定：

```text
mirror = { hostKey: string, remotePath: string, mode: "auto" | "manual" }
```

规则：

1. `mirror` 与 `remote` 互斥。带任一绑定的项目组绝不会被转换成另一种。
2. 项目组的主根仍是普通本地目录。镜像项目不使用不透明的
   `remote-project:<groupId>` 标识。
3. `remotePath` 是展示与执行数据，绝不被解析为本地文件系统路径；本地根也绝不
   在主机上解析。
4. 缺少该绑定即普通本地项目；旧版本忽略此字段并照常工作。

## 3. helper 服务

### 3.1 产物与部署

`pi-helper` 是静态 Rust 二进制，面向 `x86_64-unknown-linux-musl` 与
`aarch64-unknown-linux-musl` 构建，随桌面应用包发布在
`resources/pi-helper/<arch>/pi-helper`，并附带记录版本与 SHA-256 的生成清单。

部署：

1. 在主机上解析架构（`uname -m`）并选择匹配的随包二进制；不支持的架构在任何
   传输之前失败。
2. `mkdir -p "$HOME/.pi-desktop-helper"` 并 `chmod 700`。
3. 用现有 SSH 文件传输上传二进制，并在主机上校验其 SHA-256。摘要不匹配会删除
   残留文件并失败关闭。
4. 原子安装：写入 helper 目录内的临时文件名，`chmod 750`，再改名就位。
5. 脱离会话启动（`setsid`，无控制终端），把输出重定向到 helper 目录内的
   `logs/helper.log`。

helper 目录固定且按用户隔离：

```text
$HOME/.pi-desktop-helper/       0700
  env.json                      environment manifest, written atomically
  token                         0600, helper authentication secret
  bin/pi-helper                 installed binary
  adapters/<kind>/<version>/    installed adapter bundle plus its receipt
  pids/<id>.pid                 adapter pid files
  logs/helper.log               helper log, no credentials
```

固定名是 `$HOME/.pi-desktop-helper`；绝对路径在初始化时解析一次并记录进
`env.json`。应用内绝不硬编码某台主机专用的路径。

### 3.2 生命周期

| 情形 | 行为 |
|---|---|
| 初始化 | 部署（缺失或版本不符时）、启动、等待就绪行、打开转发、握手 |
| 已在运行且版本一致 | 复用运行中的实例，不重新部署 |
| 版本不符 | 原子替换二进制，停止旧进程，启动，握手 |
| SSH 断开 | helper 已脱离会话继续运行；适配器继续运行；桌面重开转发并重连 |
| 桌面升级 | 重新部署 `bin/pi-helper` 并重写 `env.json`；保留 `adapters/` |
| 卸载 | 停止适配器、停止 helper、删除 `$HOME/.pi-desktop-helper` |
| 残留 pid 文件 | 先 `kill -0` 加可执行文件路径校验；绝不对复用的 PID 执行 kill |

启动契约：helper 绑定 `127.0.0.1:0`，随后打印且仅打印一行

```text
PI_HELPER_READY {"port":<n>,"version":"<semver>","protocol":1}
```

桌面在有界超时内等待该行，然后才打开转发。就绪行不含任何机密；token 通过同一条
SSH 通道从 helper 目录读取。

### 3.3 分帧与操作

一条 TCP 连接承载三种帧。每帧由 1 字节类型、4 字节无符号大端载荷长度，以及恰好
指定长度的载荷组成；长度不包含帧头。载荷最大为 1 MiB，control 载荷最大为 64 KiB。

| 字节 | 类型 | 载荷 |
|---|---|---|
| `0x01` | control | UTF-8 JSON 对象 `{ "id": string, "op": string, ... }` |
| `0x02` | data | `streamId`（u32，大端）+ 原始字节 |
| `0x03` | end-of-stream | 仅 `streamId`（u32，大端） |

响应是 control 帧 `{ "id": string, "ok": boolean, "result"?: object,
"error"?: { "code": string } }`。第一个控制帧必须是带 token 的 `auth`；任何其他首帧、
错误 token 或第二个 `auth` 都会关闭连接。操作打开流之前，不接受任何 data 操作。

操作集（v1）：

| 操作 | 用途 |
|---|---|
| `auth` | token 认证 |
| `version` | 协议与 helper 版本握手 |
| `health` | 存活、磁盘空间、helper 根可写 |
| `env.verify` | 目录、权限、工具链、磁盘预算 |
| `fs.stat` | 批量 `{path, size, mtimeMs, mode}` |
| `fs.hash` | 单个文件的 SHA-256 |
| `fs.mkdirs` | 批量创建目录 |
| `fs.put.begin` / `fs.put.chunk` / `fs.put.end` | 逐文件上传，原子替换 |
| `fs.get.begin` / `fs.get.chunk` / `fs.get.end` | 逐文件下载 |
| `watch.start` / `watch.stop` | 项目根变更通知 |
| `adapter.install` | 安装清单固定版本的适配器 |
| `adapter.probe` | 报告已安装适配器版本 |
| `adapter.start` / `adapter.stop` | 适配器进程监管 |

目前实现：`auth`、`version`、`health`、`env.verify`、`fs.stat`、`fs.hash`、`fs.mkdirs`、`fs.put.*`、`fs.get.*`、`adapter.install`、`adapter.probe`、`adapter.start` 与 `adapter.stop`。`watch.start` 与 `watch.stop` 尚未实现，调用时报告 `HELPER_OPERATION_UNAVAILABLE`；桌面改为与自身基线比较，而不是订阅。其他任何操作均为保留。

协议中不存在：shell 执行、任意 argv、归档解包、递归删除、跨项目根移动文件，以及
任何接受白名单之外路径的操作。

每个操作都有界：单请求超时、最大帧尺寸、最大并发流数与最大请求速率。

## 4. 环境初始化

初始化是创建镜像项目时的一个阻塞步骤。它是幂等的、可续的，每一步都会留下回执。

| # | 步骤 | 通过条件 | 失败码 |
|---|---|---|---|
| 1 | SSH 可达与主机密钥 | 一次 `exec` 返回 0 | `REMOTE_CONNECTION_FAILED` |
| 2 | helper 根 | 目录存在、`0700`、可写、至少 500 MB 空闲 | `HELPER_DIR_UNWRITABLE` |
| 3 | helper 部署 | 二进制已安装且摘要校验通过 | `HELPER_DEPLOY_FAILED` |
| 4 | helper 启动与握手 | 收到就绪行、`version` 一致、转发已开 | `HELPER_START_FAILED` |
| 5 | `env.verify` | 目录、权限、磁盘、工具链均已报告 | `MIRROR_INIT_FAILED` |
| 6 | 适配器安装 | 固定随包的 bundle 安装成功，且其摘要与清单一致 | `DEBUG_ADAPTER_INSTALL_FAILED` |
| 7 | 适配器探测 | 已安装版本等于清单版本 | `DEBUG_ADAPTER_VERSION_MISMATCH` |
| 8 | 转发自检 | 一条 loopback 转发能连接并关闭 | `REMOTE_FORWARD_FAILED` |
| 9 | 本地环境 | 项目已注册、`workspace.get` 返回本地根、本地工具链可用 | `MIRROR_INIT_FAILED` |
| 10 | 清单与基线 | `env.json` 原子写入；基线扫描存入 host-core | `MIRROR_INIT_FAILED` |

第 9 步只检查**本地**环境。镜像项目没有远程 Agent，因此 Agent 侧没有任何远程项
可校验。

项目状态：`needs-init` → `initializing` → `ready`，另有携带失败步骤与原因的
`init-failed`。只有 `ready` 允许同步或调试。初始化失败绝不写入部分 `env.json`；
重试会跳过回执仍然有效的步骤。

## 5. 调试适配器清单

桌面应用包携带一份带版本的清单，以及清单所指名的适配器载荷。清单是适配器身份、版本、
摘要与安装资格的唯一来源。helper 是唯一决定已安装适配器如何启动的组件。

```json
{
  "schemaVersion": 2,
  "adapters": [
    {
      "id": "python-debugpy",
      "kind": "python-debugpy",
      "version": "1.8.5",
      "sha256": "<64 hex characters>",
      "bundle": "resources/pi-helper/adapters/python-debugpy-1.8.5",
      "hosts": ["x86_64-unknown-linux-musl"]
    }
  ]
}
```

规则：

1. 安装是从桌面应用包到 helper 的字节流（`adapter.install`）。绝不从 PyPI、Go 模块
   代理或任何其他网络位置获取内容，主机上也不运行任何 shell 命令。
2. 载荷是单个不透明的可执行文件。helper 绝不解包归档、绝不解释载荷内容，也绝不接受
   调用方给出的目标路径：请求路径必须恰好是 `adapters/<kind>/<version>`。
3. helper 在写入任何持久内容之前，先用清单 `sha256` 校验流式字节。不匹配会删除暂存
   文件并报告 `DEBUG_ADAPTER_INSTALL_FAILED`。校验通过的安装原子落在
   `adapters/<kind>/<version>/`，其回执最后写入。
4. 启动 argv 属于 helper 的 kind 白名单，而不属于清单。`python-debugpy` 以
   `<bundle> --listen 127.0.0.1:<port>` 启动。新增一个 kind 是一次代码变更加一条
   清单条目，绝不是一次配置编辑。
5. `adapter.probe` 报告已安装版本、摘要与安装时间；某目录没有回执时报告该适配器缺失。
   请求一个缺失的版本，或请求的版本摘要与清单不一致，即
   `DEBUG_ADAPTER_VERSION_MISMATCH`；不存在静默升级。
6. 同一 kind 可以并存安装多个版本。未显式指定版本的请求解析到最近安装的那份回执。
7. 目标平台没有固定载荷的主机不提供该适配器。清单的 `hosts` 列表是权威依据；目标
   平台不受支持时，它是被报告的初始化缺口，而不是静默跳过。

## 6. 文件同步

### 6.1 模式

| 模式 | 行为 |
|---|---|
| `auto` | 本地变更在防抖与合并窗口后自动上传 |
| `manual` | 仅由显式用户操作触发上传 |
| `pull` | 显式用户操作把远程内容复制到本地根 |

无论上传模式如何，`pull` 都可用。不存在双向模式、自动合并，也不存在任何模式下的
远端删除。

### 6.2 基线与漂移

基线在 host-core 中按项目保存 `(relativePath, size, mtimeMs, sha256)`。上传一个
文件之前：

1. 对远程文件执行 `fs.stat`（与同批文件一起批量执行）；
2. 与基线条目比较；
3. 若远程 `(size, mtimeMs)` 自基线以来发生变化，该文件是**冲突**，而不是静默
   覆盖。

冲突一律由用户解决：保留本地、保留远端或跳过。没有任何自动解决，也没有任何冲突
决定会被记忆并套用到其他文件。

传输失败绝不自动重试。它被报告为需要人工检查的不确定结果，与远程变更既有的
`REMOTE_MUTATION_OUTCOME_UNKNOWN` 语义一致。

### 6.3 排除与上限

默认排除（每一项在 UI 中都单独可见、可关闭）：

| 组 | 路径 |
|---|---|
| Python | `.venv`、`venv`、`__pycache__`、`*.pyc`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`、`.tox`、`*.egg-info` |
| Node | `node_modules`、`dist`、`build`、`.next`、`.nuxt`、`.turbo`、`.cache`、`coverage` |
| Rust / Go | `target`、`bin`（`vendor` 保留：它是源码） |
| JVM | `build`、`.gradle`、`target` |
| 始终 | `.git`、`.DS_Store`、`*.log`、`tmp`、`temp` |

项目配置可追加 `.pi-desktopignore` 模式与按项目的 `include` 例外，因为在某些项目里
`build/` 和 `bin/` 是源码目录。首次同步预览会列出纳入与排除数量，并允许用户在任何
传输之前调整。

单文件上限：**50 MB**，两侧都强制执行。超限文件被跳过，列入「超出上限」区域，且
绝不阻塞其他文件。

### 6.4 传输保证

- 一条连接服务所有文件；一批上传按批次往返，而不是每个文件一条连接。
- 写入是原子的：内容先写入以独占方式创建的 `<name>.<nonce>.pi-part` 暂存文件，再改名
  覆盖目标。崩溃只会留下旧文件或新文件；已被其他请求占用的暂存路径不会被复用。
- 字节原样复制：不做换行转换。目标保留原有权限，因此可执行脚本仍然是可执行的。
- 若某批次的回复无法装入单个 control 帧，则在创建任何目录之前以 `INVALID_ARGUMENT` 拒绝，而不是在工作完成后再断开连接。
- 传输可取消；取消不会留下部分目标文件。

## 7. 调试会话

### 7.1 拓扑

```text
Renderer (Debug view)
   │ typed IPC events
Electron Main (DAP client)
   │ 127.0.0.1:<forwarded>
   ▼
ssh -L  ─────────────────▶  pi-helper (host)
                              └─ adapter process on 127.0.0.1:<adapterPort>
```

helper 分配适配器端口、启动适配器并报告 `{port, pid}`。桌面为该端口打开转发，并把
DAP 客户端连接到本地一端。适配器在主机上只绑 loopback，绝不对外暴露。

### 7.2 路径映射与断点

- 会话携带 `pathMappings: [{localRoot, remoteRoot}]`。栈帧的 `source.path` 会被
  翻译回本地路径，用于展示与打开文件。
- 没有映射的栈帧以只读方式显示为远程源码。
- 断点按 `(projectId, relativePath, line, column, condition, enabled)` 存在
  host-core。编辑器插件从这些记录渲染边栏并经由宿主切换，绝不持有权威集合。
- 会话启动时，桌面把断点集翻译成远程路径后发送。会话期间的断点增删以增量更新
  发送。

### 7.3 失败处理

| 失败 | 行为 |
|---|---|
| 适配器缺失或版本不符 | 会话拒绝启动；返回带安装命令的类型化错误 |
| 转发失败 | `REMOTE_FORWARD_FAILED`；会话不启动 |
| SSH 断开 | 适配器继续运行；桌面重开转发并重连；若适配器已退出，会话被报告为已终止，绝不静默重启 |
| 适配器崩溃 | 连同退出状态与其日志尾部一并报告；不自动重启 |
| 取消 | 桌面经 helper 停止适配器并关闭转发 |

## 8. 持久化

由 Rust host-core 拥有的新增持久状态：

| 数据 | 形态 |
|---|---|
| 镜像绑定 | 项目组记录上的可选附加字段 |
| 同步基线 | 按项目与相对路径：size、mtime、sha256、syncedAt |
| 断点 | 按项目、文件、行：condition、enabled |
| 初始化回执 | 按项目与步骤：version、completedAt |
| 适配器安装回执 | 按主机与适配器：version、installedAt |

schema v28 新增基线与断点存储，含升级兼容与迁移测试。项目组绑定是附加且向后
兼容的；不支持镜像的版本会忽略它。

## 9. 错误码

| 错误码 | 可重试 | 含义 |
|---|---|---|
| `HELPER_DEPLOY_FAILED` | 是 | helper 二进制无法安装，或其摘要不匹配 |
| `HELPER_DIR_UNWRITABLE` | 否 | helper 目录缺失、不可写，或低于磁盘预算 |
| `HELPER_START_FAILED` | 是 | helper 未打印就绪行，或握手失败 |
| `HELPER_VERSION_MISMATCH` | 是 | 运行中的 helper 版本与桌面不一致；需要重新部署 |
| `HELPER_PROTOCOL_ERROR` | 否 | 无效帧、未认证请求，或未知操作 |
| `HELPER_OPERATION_UNAVAILABLE` | 否 | 当前 helper 构建尚未实现请求的协议操作 |
| `HELPER_AUTH_FAILED` | 否 | helper 拒绝了 token 或收到未认证操作 |
| `HELPER_INTERNAL_ERROR` | 是 | helper 文件系统或运行时发生意外错误；不会返回敏感诊断信息 |
| `MIRROR_INIT_FAILED` | 是 | 某个非传输初始化步骤失败；`details.step` 指明步骤 |
| `MIRROR_CONFLICT` | 否 | 远程文件自基线以来已变更；需要用户决定 |
| `MIRROR_FILE_TOO_LARGE` | 否 | 文件超过 50 MB 上限并被跳过 |
| `REMOTE_TRANSFER_FAILED` | 是 | 逐文件传输失败；目标文件未变 |
| `REMOTE_PATH_ESCAPE` | 否 | 路径解析到允许根之外 |
| `DEBUG_ADAPTER_INSTALL_FAILED` | 是 | 随包适配器载荷未通过摘要校验，或安装无法完成 |
| `DEBUG_ADAPTER_VERSION_MISMATCH` | 否 | 已安装适配器版本与固定清单不一致 |
| `DEBUG_SESSION_DISCONNECTED` | 是 | 调试传输断开；会话状态被保留以便重连 |

既有错误码在语义已适配处复用：`REMOTE_CONNECTION_FAILED`、
`REMOTE_AUTH_FAILED`、`REMOTE_FORWARD_FAILED`、`REMOTE_PATH_NOT_FOUND`。

## 10. 安全边界

1. helper 二进制是发布内容：随包分发、执行前校验摘要、与桌面版本绑定。模型生成的
   或用户提供的代码绝不通过这条路径在主机上执行。
2. 仅 loopback 监听、`0600` token、无公共绑定、无 stdio RPC、无 systemd 单元、
   无提权。
3. 路径白名单：已注册的镜像根加 helper 根。与 helper 目录重叠的项目根在启动时被拒绝，且从其他根解析到 helper 目录内的路径同样被拒绝，因此 token 与已安装二进制即便经由符号链接也无法触达。`..`、符号链接与 junction 逃逸在
   `realpath` 之后一律拒绝。
4. 凭据类路径（`.env`、`.env.*`、`.ssh/`、`*.pem`、`*.key`）在两个方向上都被拒绝。
5. 无 shell、无任意 argv：适配器命令只来自随包清单；其他所有操作只接受结构化数据。
6. 协议中不存在删除操作，因此被误导的客户端也无法删除远程文件。上传只能删除它自己创建的暂存文件；该文件名带随机 nonce 且以独占方式创建，因此暂存路径上已存在的文件或符号链接既不会被截断，也不会被写入穿透。
7. token、SSH 诊断与远程 stderr 绝不进入渲染进程、日志或错误载荷。
8. 远程命令与任何其他远程操作一样受本地权限策略约束；身处远程绝不扩大权限。

## 11. 验证

| 层级 | 覆盖 |
|---|---|
| Rust 单元 | 分帧、token 认证、路径围栏（含符号链接逃逸）、原子写、50 MB 边界、pid 文件校验、清单摘要与 kind 白名单拒绝 |
| Rust 契约 | 进程内客户端对全操作集，含畸形帧、半帧与取消 |
| Electron 单元 | 针对 fake helper 的 helper 客户端重连、超时与错误映射 |
| Electron 单元（远程运行） | 路径与命令校验、有序 stdout 与 stderr、带截断标记的 1 MiB 输出上限、单次结算的取消、每项目单次运行的规则，以及不泄漏任何内容的传输错误 |
| 集成 | 无真实 SSH 情况下经 loopback 完成部署、握手、上传、下载与适配器启动 |
| 资格门 | 经 SSH 连接的真实 Linux x64 与 aarch64 主机：部署、SSH 断开后的脱离存活、适配器安装、调试会话、基线准确性。被 mock 的边界不满足此门 |

## 12. 远程构建与运行

镜像项目可以在主机上、远程镜像目录内运行一条显式的构建或运行命令。这不是通用远程
shell：命令与其工作目录是仅有的输入，且两者都先被校验。

1. 工作目录始终是项目的 `remotePath`。不是绝对 POSIX 路径，或包含 `..`、`//`、反斜杠
   或控制字符的值，以 `REMOTE_PATH_ESCAPE` 拒绝。
2. 命令是一条用户配置的字符串，最长 4096 个字符，且不含控制字符。它通过应用已用于
   主机命令的同一种远程执行模式运行，因此引号处理只有一份实现。
3. 每个项目最多一个进行中的运行。第二次启动以 `CONFLICT` 拒绝而不是排队，因此两个
   构建绝不会在同一个镜像目录内交错。
4. 输出以有序的 stdout 与 stderr 分块流式传输，并按流分别解码，因此被分块切断的
   多字节字符仍能完整还原。未被消费的输出上限为 1 MiB；超过上限后运行继续执行，但
   其余输出被丢弃且结果标记为已截断，而字节计数仍报告主机写入的全部内容。
5. 取消会终止远程进程，并恰好结算句柄一次。关闭时的销毁会取消所有进行中的运行，并
   以 `HOST_SHUTTING_DOWN` 拒绝新的启动。
6. 传输失败会浮出类型化错误，其消息固定：命令行与任何凭据都不会进入错误文本。
7. 本地根不写入任何内容。本地副本始终是唯一事实来源，构建绝不改动它。
8. 构建在主机上写出的文件——`dist`、`build`、`target` 以及本地排除规则本就忽略的
   其他内容——绝不会被拉回本地，应用也绝不删除它们。主机侧构建产物归用户所有，
   因此镜像目录中可以存在本地副本没有的产物。
