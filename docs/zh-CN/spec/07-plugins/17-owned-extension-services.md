# 17. 所属扩展服务与托管连接

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/17-owned-extension-services) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

这些附加能力用于把持久工作放在常驻插件服务中的集成。Desktop 不内置任何记忆服务协议。参见 [owner 调用 ADR](/adr/plugin-agent-extension-owner-calls) 和 [托管连接 ADR](/adr/plugin-managed-remote-connections)。

## 能力与兼容性

插件必须在扩展回调中探测 `ctx.owner?.version === 1`，并在插件进程中 await `pi.connections.getCapabilities()`。Desktop 0.22.1-beta.4 及更早版本不提供这些能力；0.22.1-beta.5 是第一个包含它们的版本。仅靠版本字符串仍不足以准入，集成必须在运行时探测能力。没有 owner bridge 成员的旧扩展和嵌入环境保持现有行为。

## Manifest 与 owner 调用

具有 `agent.extension` 的插件最多可以声明 32 个唯一的有界操作：

```json
{
  "contributes": {
    "agentExtensions": ["agent-extension.mjs"],
    "agentExtensionOperations": [
      { "name": "recall", "readOnly": true },
      { "name": "capture", "readOnly": false }
    ]
  }
}
```

在有效的扩展处理函数内，`await ctx.owner.call("recall", payload)` 会到达该插件的 `onAgentExtensionCall(operation, payload, context)`。调用方不能指定其他插件、会话、项目、turn 或模式。Main 投影 manifest，记录对外的运行时启动绑定，校验持久 Host 会话/worktree 记录，并验证注册和每一次调用。await 之后重新检查，从而拒绝过期结果。插件收到 abort signal；下游 SDK 调用属于同一次调用，并随之失效。

上下文包含持久的 `sessionId`、可选 `turnId`、独立的 `runtimeId`、持久的 `projectPath`、实际的 `workspaceRoot`、可选 `remoteWorkspace`、模式、可选父身份以及退休原因。持久的远程项目身份不同于其文件系统路径。每个运行时代次拥有自己的初始化状态；模块导入缓存不会保留该状态。

Plan/Goal 只允许已声明的只读操作。Host 侧的强制检查是对扩展侧检查的补充。payload 和结果必须是可序列化 JSON，各自不超过 256 KiB。调用的 Host 上限为 10 秒，调用方可以使用更短的取消期限。完成、Stop、退休、插件卸载、权限丢失和传输关闭之后，派生调用都不能继续使用已失效的授权。

线路路由为 `extensions.owner.call`、`.cancel`、`.registerRuntime` 和 `.retireRuntime`。它们使用现有的 sidecar 代理白名单，永远不会变成任意 Rust RPC 访问。插件进程中的回调以 `extension.owner` 身份运行在现有调用取消机制之下。

## owner 回调中的文件

owner 回调中的 `pi.fs.readPreview(relativePath, {workspacePath: context.projectPath})` 按 Host 持有的会话根目录解析，包括隔离 worktree 和远程工作区。它要求 `fs.read`、`root: "workspace"` 以及显式匹配的 `fs.read.scope`。不允许回退到可见窗口或本地 cwd。绝对路径/路径穿越、敏感路径、应用私有路径和越出范围的访问一律失败。远程读取使用现有远程 Host 插件文件能力，并校验其响应。缺少远程支持时明确失败。读取完成后会再次检查会话绑定、激活状态和取消状态。普通面板预览保持现有的工作区选择行为。

owner 预览会写入现有的 `fs.readPreview` 审计记录，包括插件、有界相对路径、成功/失败以及结果类型/大小。文件正文永远不会进入审计记录。

## 退休与关闭

`runtimeId` 与持久会话无关。退休原因为 `reconfigure`、`session-close` 和 `app-quit`。关闭回调有两秒的有界预算；应用退出时，在插件服务和 Host 持久化停止之前，先进行优雅的 sidecar 关闭。无响应的回调不能阻止应用退出。模型或模式切换后的实例退休，不代表用户任务已完成。集成不得在每次关闭时都自动创建最终 handoff。

由 Host 启动的常驻服务可以在 `service.start` 返回后继续调用 SDK。后台任务属于插件的服务生命周期，不属于已经完成的启动 RPC。每次调用仍检查插件是否卸载及当前权限；普通面板、工具和 owner 回调的后续调用仍受原始调用的失效约束。

对声明了 owner 能力的扩展，`agent_end` 通知处理函数的总预算为两秒。turn 收尾会等待这些处理函数，期间状态保持忙碌，因此后续 turn 或退休不会取消一次及时的本地接收。已过期的回调仍然保持取消。未声明 owner 能力的扩展保留现有的通知时序。

退休中的代次会冻结其最后一个已接纳的 turn 身份。替换启动不能重新标记这个最终事件。在两秒的退休窗口内，每个扩展只能调用一次其声明的 `retire` 操作；其他 owner 操作以及重复的终止调用都会被拒绝。实时 Host 模式和当前插件授权仍然有效，包括 Agent 到 Plan 的切换。未知 Host 模式一律拒绝；旧的 `chat` 视为只读 Plan。已卸载的插件会使旧代次失效；之后空闲时的启动会先退休过期运行时再重建。仅为重载扩展不会中断进行中的 turn。

## 托管连接 API

`net.connection` 授予对原生插件设置面板中所配置连接的访问。用户在那里审阅端点、明文 HTTP 许可、可选私有 CA 以及精确的相对路由/方法组合。原生 IPC 的 list/save/delete 通道不出现在 desktop-control 和插件面板操作中。SDK 不提供保存操作，也不提供凭据读取接口。

```ts
await pi.connections.getCapabilities(); // { version: 1 }
const connections = await pi.connections.list(); // metadata only
const response = await pi.connections.request({
  connectionId, expectedRevision, requestId,
  path: '/mcp', method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request), timeoutMs: 1500,
});
await pi.connections.cancel(requestId);
```

元数据包括 ID、所属插件、标签、规范化的 base URL、revision、凭据/CA 是否存在、HTTP 许可和路由声明。响应包括状态码、白名单响应头、有界正文文本和连接 revision。配置使用现有的 Host 加密密钥存储；不引入新的 SQLite 所有者、schema 或凭据格式。令牌永远不会进入普通插件设置。未提供凭据/CA 输入时保留原值；提供空值时清除。更改端点 origin 或 base path 需要重新输入凭据。每次保存都会递增 revision；过期 revision 会失败，轮换或删除会中止进行中的请求。

禁用或重载插件会中止其请求，并保留连接配置。原生卸载先卸载插件，然后在删除插件注册之前删除其整条加密连接记录。凭据清理失败会以可观察的错误中止卸载。以相同插件 ID 重新安装不会继承之前的凭据。不会删除任何远程数据。

只允许 GET/POST 方法以及 base URL 下精确批准的相对路径。拒绝重定向、URL 内嵌凭据、片段、路径穿越以及调用方提供的 auth/cookie/forwarding 请求头。非回环 HTTP 需要明确许可。TLS 校验始终开启；私有 CA 信任只作用于该连接，并且是对公共根证书的补充。普通请求和私有 CA 隧道都遵循应用配置的直连/系统/PAC/自定义代理及绕过规则。请求和响应正文上限为 1 MiB，单次请求上限 15 秒，并发请求上限 128。开发者下载时使用的代理不会变成连接设置。

Host 只有在检查所属关系、当前授权、revision 和目标之后，才注入存储的 bearer 凭据。返回文本会遮蔽凭据原值，传输失败只暴露固定的诊断代码。插件仍需把所有远程内容视为不可信数据。请求成功不代表服务器恰好持久化一次；领域适配器负责对账和写入兼容性。

## 独立集成

`local.ai-memory` 在独立的 `PI-AI-Memory` 仓库中开发和打包，由该仓库维护源码、上游兼容矩阵、业务测试和发布流程。Desktop 保留通用的 owner-call、托管连接、文件作用域和生命周期契约，以及相应的模拟宿主测试。插件安装和升级仍由用户显式执行；Desktop 不内置该插件，也不承诺兼容任意记忆服务器。
