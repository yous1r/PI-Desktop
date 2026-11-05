# 18. 本地与 SSH 工作区执行

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/18-workspace-execution) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

状态：已实现的候选方案；原生 Linux SSH 与挂载式 Desktop 验收仍是发布门禁。
决策：[ADR 0340](/adr/0340-workspace-plugin-execution)。

## 执行位置

视图、对话框、剪贴板、模型配置、OAuth 与会话持久化仍留在 Desktop。工作区后端运行在文件旁边：本地项目使用本地子进程，SSH 项目使用配对 `pi-host` 的 Node 子进程。插件、结构化进程或工作区 PTY 都不需要远程 Agent 会话。

```json
{"main":"main.js","execution":{"main":"workspace"}}
```

省略 `execution` 会保留旧的 Desktop 后端。双入口插件使用：

```json
{"main":"desktop.js","execution":{"main":"desktop","workspaceMain":"worker.cjs"}}
```

普通面板消息调用 Desktop 入口。`pi.workspace.invoke(channel, payload)`，或面板通道 `workspace.invoke` 携带 `{channel, payload}` 时，调用 worker 的 `onWorkspaceInvoke`。worker 不能递归调用自身。`pi.workspace.isAvailable()` 报告该调用当前能否到达后端。它从不提示，也从不启动插件代码；尚未决定的 Host 批准报告 `true`，使第一次真实调用可以询问一次。被拒绝的批准、已断开的 Host，或没有 `workspacePlugins` 的 Host，报告 `false`，直到该包被卸载。如果绑定的页面轮询 `workspace.get`，而因上述原因之一导致后端不可用，它会收到旧的 Desktop 工作区结构，使旧消费者得以保留其文档化的回退行为。页面 `workspace.get` 使用绑定的工作区入口；原生 Desktop `workspace.get` 保留 Desktop/旧远程元数据形态。工作区入口收到真实执行主机路径与 `executionContext`；`workspace.getContext()` 提供显式身份。永远不要将 `remote-project:*` 身份传给操作系统文件系统或进程 API。

Provider、设备集成、Agent 扩展、renderer 回调与 composer 变换需要 Desktop main。请把原生工作区工作拆分到伴随插件。常驻服务遵循 `execution.main`：伴随插件不重复 Desktop 服务。工作区服务状态包含 `instanceId` 与 `workspaceId`。

MCP 的 `execution: "desktop" | "workspace"` 默认跟随主入口位置。伴随插件的工作区 MCP 必须显式选择加入。stdio 解析使用执行主机的 PATH，并以包目录为 cwd，使相对路径的内置脚本仍然可用。`PI_WORKSPACE_ROOT`、`PI_WORKSPACE_ID`、`PI_PLUGIN_ROOT`，以及 argv/env 中的字面量 `${workspaceRoot}` / `${pluginRoot}` 替换，提供显式的工作区引用。只传输该服务器引用的自有设置。HTTP 出口策略覆盖重定向。

工具按发起会话分别发现，包括面板打开之前仅含 MCP 的插件。工作区目录与客户端归实例所有。同名时，工作区工具优先于同一插件的 Desktop 工具；不同插件之间仍保持命名空间隔离。分发时重新解析发起调用的会话，并验证该工具存在于该工作区已准入的目录中。

## 身份与生命周期

Host 生成 `WorkspaceExecutionContext`：工作区/项目 ID、授权、注册根目录、平台、连接状态与代次。插件不能通过提供根目录或 ID 来选择另一个 Host。保留的界面、反向调用、命令、工具与资源都会捕获其来源。切换项目只改变新的入口。项目移除、重新绑定、Host 替换，或不兼容的连接代次，都会使旧绑定失效。

安装与每个工作区实例相互独立。实例以插件安装、工作区授权/身份与代次为键；包按摘要验证。界面拥有不透明令牌、会话与标签页所有者，因此延迟的 hide/close 响应不会影响另一个界面。Host 验证父调用 ID；完成/取消之后的回调会被拒绝。绑定调用中的 `session.getActive()` 返回发起会话的快照，即使已选择了另一个会话。没有快照服务的旧 Host 返回 null，而不是另一个会话的状态。

断开连接绝不会把执行切换到 Desktop，也绝不会重放保存、提交、命令、终端输入或 MCP 调用。分发后丢失的响应可能意味着操作已经完成：在决定是否重复之前先刷新状态。只有显式的终端重放/重新挂接才允许替换连接。插件调用、MCP 客户端、进程句柄、资源服务器与端口转发在所有者拆除时关闭。原生授权在调用时以及每五个空闲秒重新检查。受信任扩展进程也会每五秒重新检查禁用状态与所有权。

## 授权与包准入

原生插件以 SSH 账户的操作系统权限执行。子进程与 SDK 作用域都不构成操作系统沙箱。Desktop 展示显式的原生代码许可；Rust host-core 按插件、Host 与包 SHA-256 存储批准。包内容变化需要重新批准。SDK 的文件/进程/终端/MCP 调用仍与已安装、已声明的权限取交集。模型密钥、SSH 密钥与 Desktop 环境密钥不会复制到远程子进程。

RACP 仅所有者能力为 `workspacePlugins: 1`、`workspaceProcesses: 1` 与 `workspaceTerminal: true`；操作为 `workspace/plugin`、`workspace/process`、`workspace/terminal`，并带有反向插件/终端事件。缺少能力会明确失败。共享运行器位于 `packages/host-runtime/plugin-host-process.mjs`；Desktop 通过其兼容入口打包它，pi-host 逐字复制它。

准入使用有界的 begin/chunk/commit、规范化路径、SHA-256 与原子重命名。限制：每个包 2,000 个文件、原始 50 MiB / 传输 72 MiB；每次运行 64 个缓存/保留工件与 512 MiB；每个连接一次上传，总共四次，两分钟过期。被放弃的受管运行缓存在启动时恢复。路径穿越、符号链接、凭据路径、Windows 保留/冲突路径与 `.node` 文件都会被拒绝。排除 `.git`、`.pi`、`.agents`、`.memories` 与 `node_modules`。任意原生依赖安装与特定目标包选择尚未实现；请发布可移植/自包含的 JS，或等待匹配的目标包支持。

插件消息使用有序的 64 KiB 帧，最多组装 36 MiB，组装生命周期 60 秒。字节数组具有稳定的线路表示。最多 64 个插件实例，每个设备 16 个，每个实例最多 64 个并发反向工作区 API 调用。投递确认不等待长时间 MCP 完成，从而允许取消到达而不死锁。

## SDK 进程与终端 API

权限：进程使用 `workspace.exec`；PTY 使用 `workspace.terminal`。

```js
const result = await pi.workspace.exec({
  command: "git", args: ["status", "--short"], cwd: ".", timeoutMs: 30_000,
  signal, onOutput: chunk => console.log(chunk.stream, chunk.text),
});
const process = await pi.workspace.process.start({command:"node",args:["worker.js"]});
await pi.workspace.process.end(process.processId);
const page = await pi.workspace.process.read(process.processId, 0, 1000);
await pi.workspace.process.close(process.processId);
const {shells} = await pi.workspace.terminal.list();
const terminal = await pi.workspace.terminal.create({shellId:shells[0].id,cols:100,rows:30});
await pi.workspace.terminal.write(terminal.terminalId, "pwd\r");
const replay = await pi.workspace.terminal.replay(terminal.terminalId, 65536);
await pi.workspace.terminal.close(terminal.terminalId);
```

进程 `start/read/write/end/cancel/close` 使用字面量 argv（`shell:false`）、根内规范化 cwd、过滤后的环境与连接拥有的句柄。默认超时 120 秒，最长十分钟；总计 64 个进程 / 每个设备 16 个。保留的输出/输入上限 1 MiB，读取上限 256 KiB，输入帧上限 64 KiB，轮询为每个句柄 20 秒内四次。退出并不意味着输出已排空：`more` 为真时继续读取。SDK exec 收集输出上限 8 MiB，stdin 上限 1 MiB。取消会终止进程树；即使进程准入与取消发生竞态，被取消的父调用仍会关闭 SDK 句柄。已完成的句柄在 60 秒后过期。

PTY shell 发现运行在目标 Host 上。输出带序号、有界重放与背压；已接受的数据在退出前排空。最多 64 个 PTY，每个设备 8 个。分离的终端在五分钟后过期。SDK PTY 输出使用重放/缓冲轮询，而不是订阅 API。内置终端接收实时事件并在创建前订阅。缺少 node-pty 会返回能力错误。断开的终端既不排队按键，也不以本地 shell 替代。

受信任 Agent 扩展的 `pi.exec` 将默认/相对/工作区 cwd 路由到会话的远程工作区。`target:"local"` 与旧的显式根外绝对辅助 cwd 保持本地；`target:"workspace"` 强制工作区约束。Agent 扩展中的原生 Node fs 仍为本地，不会被拦截。

## 文件、资源与 localhost

SDK 读写经凭据/受保护根检查、manifest 作用域与显式的范围外许可，在已准入的主机上解析。文本/范围上限 8 MiB；列表上限 1,000 条结果，扫描上限 20,000 条目/深度 32。写入使用临时同级文件与重命名。SDK 自有删除跟踪为实例本地、非递归，并在每分钟 20 次删除后设有确认刹车。文件选择器或拖入文件获得的 Desktop 授权，不能被重新解释为远程绝对路径。

- 对远程文件调用 `fs.openDefault` 会请求下载并打开本地副本。原生保存对话框选择新文件名；独占创建永不覆盖已存在的 Desktop 文件。读取使用 1 MiB 分块，带大小/mtime 校验与部分副本清理。完整副本属于用户，并在卸载后保留；更改绝不自动写回。最大文件大小为 64 MiB。
- `fs.reveal` 验证文件，并在发起会话的文件管理器中打开其位置。它不会在 SSH Host 上启动图形化文件管理器。
- `fs.openInBrowser` 通过随机的仅回环 URL 提供 HTML 与同级资源。每次读取都会重新校验授权、权限与实例。Host/请求头/路径检查、no-store/no-referrer、有界读取与限制性 CSP 均生效。预览仅限于 HTML 目录及其后代、八个租约、每个租约四次读取、每个资源 64 MiB 以及 30 分钟。不支持父目录资源、外部网络依赖、自动实时重载与 HTTP 范围流式传输。
- `workspace.openPort({port,path})` 显式预览工作区 HTTP 服务。它同时需要 `workspace.exec` 与 `browser.cdp`、发起会话、1024–65535 端口，以及转发源上的路径。SSH 转发目标远程 `127.0.0.1`，复用配对元数据，绝不暴露配对 Host 控制端口。直接的非 SSH 对端会明确失败。最多八个 30 分钟转发；断开连接立即关闭，并每五秒重新检查所有权。该 API 不会重写任意 HTML localhost URL，也不会启动 Web 服务器。

内置文件管理器使用 Desktop main 加工作区伴随插件。原生项目操作保留其包含性检查、凭据拒绝列表、乐观保存冲突、原子写入与审计行为。远程图形化编辑器启动不可用。当 `isAvailable()` 为 false（旧 Host 或原生批准被拒绝）时，Desktop 入口使用现有的受限只读远程网关，且不再提示。Host 打开的会话临时/附件文件保持本地，处于 Host 创建、30 分钟的单文件授权之下。`external:true` 本身不是授权。视图仍是未改动的上游生成产物；后端热修复来源与校验和记录在内置 `UPSTREAM.md` 中。

## 验证与发布门禁

`apps/desktop/test/workspace-plugin-files-git.test.mjs` 运行真实的打包文件管理器与候选 Git 插件子进程、本地与远程服务传输、真实文件系统效果、Git hunk 暂存/提交、资源打开以及不重放。将 `PI_GIT_PLUGIN_PATH` 设为候选插件；省略会显式跳过 Git 用例。`workspace-plugin-mcp.test.mjs` 用真实 MCP、SDK 子进程、PTY 与取消覆盖四种放置组合。RACP 套件使用真实授权与协议处理器；直接/内存传输不构成 SSH 证据。

发布之前，在 Linux x64 与 arm64 SSH 主机上，用相同的候选 Desktop 与完整 pi-host 包，配合两个同名但不同的项目运行。验证编辑 → hunk 暂存 → 提交 → 终端日志、裸远程 fetch/pull/push、媒体、大小写/符号链接边界、每个变更阶段的断开、撤销、重连与清理。只有在任务授权时才运行挂载式 Desktop 视图/终端旅程。记录基线/头部、包摘要、Node ABI、node-pty 存在情况、目标平台与结果。Windows 构建不能生成或接受原生 Linux pi-host 发布包。
