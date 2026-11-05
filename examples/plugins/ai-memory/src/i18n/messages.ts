export const messages = {
  en: {
    title: 'Project memory', subtitle: 'Scoped recall, explicit handoffs, durable delivery.', refresh: 'Refresh', probe: 'Check server', export: 'Export redacted diagnostics',
    recovery: 'Review retained legacy handoff response',
    settings: 'Project settings', current: 'Current Desktop project', connection: 'Host connection', workspace: 'Memory workspace', project: 'Memory project',
    connectionHelp: 'Create or change endpoints, tokens and private CAs in the native plugin connection settings. Credentials are never available here.',
    mode: 'Tool mode', coexist: 'Coexist with existing mem (default)', managed: 'Manage memory tools in this plugin', modeHelp: 'Managed tools replace no existing configuration. Reload the conversation runtime after changing this setting. Disable old mem only after verifying migration.',
    capture: 'Enable automatic capture for this project in Agent mode',
    reconcile: 'Check persisted observations', verified: 'Persistence verified', unconfirmed: 'Not yet verified; event retained',
    policy: 'Content allowed to leave this project', metadata: 'Default: lifecycle and tool outcome metadata only. No attachments, environment variables or full transcripts.',
    prompts: 'User prompts', toolArguments: 'Tool arguments', toolResults: 'Tool results', assistant: 'Assistant final replies', excludes: 'Additional excluded paths (one glob per line)',
    save: 'Save project binding', remove: 'Remove this binding', pause: 'Pause capture and recall', resume: 'Resume', diagnostics: 'Diagnostics', queue: 'Delivery queue', oldest: 'Oldest event age',
    sources: 'Recent recall sources', capability: 'Server compatibility', noProject: 'Open a Desktop project before binding memory.', noConnection: 'No authorized host connection. Configure one in native settings.',
    confirmSave: 'Save this exact target and content policy? Enabled content may be stored locally and sent to this connection.', confirmRemove: 'Remove this binding? Pending events stay retained and paused.',
    retry: 'Retry definite refusals', delivered: 'I verified delivery', discard: 'Discard local event', eventId: 'Exact event ID', confirmResolve: 'Apply this local reconciliation decision? It does not undo server writes. Uncertain events are never replayed automatically.',
    empty: 'None', unavailable: 'Unavailable', saved: 'Saved', failure: 'Operation failed; see the error code.', unknownVersion: 'Unknown server version: writes disabled',
    updateHelp: 'Server incompatibility requires a reviewed plugin adapter update. This plugin does not auto-update itself or the server.',
  },
  'zh-CN': {
    title: '项目记忆', subtitle: '按项目召回、显式交接、持久投递。', refresh: '刷新', probe: '检查服务器', export: '导出脱敏诊断',
    recovery: '查看保留的旧版交接响应',
    settings: '项目设置', current: '当前 Desktop 项目', connection: '宿主连接', workspace: '记忆工作区', project: '记忆项目',
    connectionHelp: '在原生插件连接设置中配置地址、令牌和私有 CA。此面板无法读取凭证。',
    mode: '工具模式', coexist: '与现有 mem 共存（默认）', managed: '由此插件管理记忆工具', modeHelp: '管理模式不会替换已有配置。修改后请重载会话运行时。验证迁移后再停用原 mem。',
    capture: '在 Agent 模式下为此项目启用自动采集',
    reconcile: '核对已持久化的记录', verified: '已核实持久化', unconfirmed: '尚未核实，事件仍保留',
    policy: '允许发送的内容', metadata: '默认仅采集生命周期和工具结果元数据；不包含附件、环境变量或完整聊天记录。',
    prompts: '用户提示词', toolArguments: '工具参数', toolResults: '工具结果', assistant: '助手最终回复', excludes: '额外排除路径（每行一个 glob）',
    save: '保存项目绑定', remove: '移除此绑定', pause: '暂停采集和召回', resume: '恢复', diagnostics: '诊断', queue: '投递队列', oldest: '最旧事件等待时间',
    sources: '最近召回来源', capability: '服务器兼容性', noProject: '请先打开 Desktop 项目再绑定记忆。', noConnection: '没有已授权的宿主连接，请在原生设置中配置。',
    confirmSave: '保存此目标和内容策略？启用的内容可能保存到本地并发送至此连接。', confirmRemove: '移除此绑定？待投递事件仍会保留并暂停。',
    retry: '重试明确拒绝的事件', delivered: '已核实投递成功', discard: '丢弃本地事件', eventId: '确切事件 ID', confirmResolve: '应用此本地对账结果？不会撤销服务器写入。不确定事件不会自动重放。',
    empty: '无', unavailable: '不可用', saved: '已保存', failure: '操作失败，请查看错误码。', unknownVersion: '服务器版本未知：已禁用写入',
    updateHelp: '服务器不兼容时需要经过审核的插件适配器更新。插件不会自动升级自身或服务器。',
  },
} as const;
export type Locale = keyof typeof messages;
export type MessageKey = keyof typeof messages.en;
export function localeFor(value: unknown): Locale { return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'; }

export const stateLabels: Record<Locale, Record<string, string>> = {
  en: { ready: 'Ready', 'read-only': 'Read only', 'capture-paused': 'Capture paused', 'auth-required': 'Authorization required', offline: 'Offline', unsupported: 'Unsupported host' },
  'zh-CN': { ready: '就绪', 'read-only': '只读', 'capture-paused': '采集已暂停', 'auth-required': '需要重新授权', offline: '离线', unsupported: '宿主不支持' },
};
