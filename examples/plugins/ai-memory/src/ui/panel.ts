import { messages, localeFor, stateLabels, type Locale, type MessageKey } from '../i18n/messages.js';
import { DEFAULT_SETTINGS, record, type Settings } from '../contracts.js';
import { projectIdentity } from '../project-identity.js';
interface Bridge { invoke(channel: string, payload?: unknown): Promise<unknown>; on(event: string, handler: (payload: unknown) => void): void }
declare global { interface Window { pluginBridge?: Bridge } }
const bridge = window.pluginBridge;
let locale: Locale = 'en';
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let projectPath: string | undefined;
let connections: Array<{ id: string; label: string; revision: number }> = [];
let refreshGeneration = 0;
const t = (key: MessageKey) => messages[locale][key];
function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error('PANEL_ELEMENT_MISSING'); return value; }
function input(id: string): HTMLInputElement { return element(id) as HTMLInputElement; }
function select(id: string): HTMLSelectElement { return element(id) as HTMLSelectElement; }
function area(id: string): HTMLTextAreaElement { return element(id) as HTMLTextAreaElement; }
function notice(value: string): void { element('notice').textContent = value; }
async function invoke(channel: string, payload?: unknown): Promise<unknown> { if (!bridge) throw new Error('HOST_UPGRADE_REQUIRED'); return bridge.invoke(channel, payload); }
function appearance(value: unknown): void {
  const data = value && typeof value === 'object' ? record(value) : {};
  locale = localeFor(data.locale);
  document.documentElement.lang = locale;
  document.documentElement.style.colorScheme = data.base === 'dark' ? 'dark' : data.base === 'light' ? 'light' : 'light dark';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n as MessageKey); });
  element('pause').textContent = t(settings.paused ? 'resume' : 'pause');
}
async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  const data = record(await invoke('memory.status'));
  if (generation !== refreshGeneration) return;
  if (!data.settings) { notice(`${t('unavailable')}: ${String(data.error ?? '')}`); return; }
  settings = data.settings as Settings;
  const workspace = data.workspace && typeof data.workspace === 'object' ? record(data.workspace) : {};
  projectPath = typeof workspace.path === 'string' ? projectIdentity(workspace.path) : undefined;
  connections = Array.isArray(data.connections) ? data.connections as typeof connections : [];
  element('project-path').textContent = projectPath ?? t('noProject');
  const binding = settings.bindings.find(item => item.projectPath === projectPath);
  const connection = select('connection'); connection.replaceChildren();
  for (const item of connections) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; connection.append(option); }
  if (binding) connection.value = binding.connectionId;
  input('workspace').value = binding?.workspace ?? '';
  input('project').value = binding?.project ?? '';
  select('mode').value = settings.mode;
  input('capture').checked = binding?.capture ?? false;
  for (const field of ['prompts', 'toolArguments', 'toolResults', 'assistant'] as const) input(field).checked = settings.policy[field];
  area('excludes').value = settings.policy.ignorePaths.join('\n');
  (element('save') as HTMLButtonElement).disabled = !projectPath || !connections.length;
  (element('remove') as HTMLButtonElement).disabled = !binding;
  const queue = record(data.queue);
  element('state').textContent = `${stateLabels[locale][String(data.state)] ?? String(data.state)}${data.error ? ` · ${String(data.error)}` : ''}`;
  element('capabilities').textContent = JSON.stringify(data.capabilities, null, 2);
  element('sources').textContent = JSON.stringify(data.lastRecall, null, 2) ?? t('empty');
  element('queue-count').textContent = `${t('queue')}: ${queue.count} · ${t('oldest')}: ${Math.round(Number(queue.oldestAgeMs) / 1000)}s`;
  element('queue').textContent = JSON.stringify({ counts: queue.counts, events: Array.isArray(queue.events) ? queue.events.slice(0, 30) : [], mutations: queue.mutations }, null, 2);
  appearance({ locale, base: document.documentElement.style.colorScheme });
  if (!connections.length) notice(t('noConnection'));
}
async function save(next: Settings): Promise<void> { await invoke('memory.settings', { settings: next, confirmed: true }); await refresh(); notice(t('saved')); }
function action(id: string, callback: () => Promise<void>): void {
  element(id).addEventListener('click', () => {
    (element(id) as HTMLButtonElement).disabled = true;
    callback().catch(error => notice(`${t('failure')} ${error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : ''}`)).finally(() => { (element(id) as HTMLButtonElement).disabled = false; });
  });
}
action('refresh', refresh);
action('probe', async () => { await invoke('memory.probe'); await refresh(); });
action('pause', async () => { await save({ ...settings, paused: !settings.paused }); });
action('recovery', async () => { element('recovery-content').textContent = JSON.stringify(await invoke('memory.recovery', { id: input('event-id').value }), null, 2); });
action('remove', async () => { if (window.confirm(t('confirmRemove'))) await save({ ...settings, bindings: settings.bindings.filter(item => item.projectPath !== projectPath) }); });
action('retry', async () => { await invoke('memory.retry', { id: input('event-id').value }); await refresh(); });
action('reconcile', async () => { const result = record(await invoke('memory.reconcile', { id: input('event-id').value })); await refresh(); notice(t(result.verified ? 'verified' : 'unconfirmed')); });
for (const [id, decision] of [['delivered', 'confirmed-delivered'], ['discard', 'discard']] as const) action(id, async () => {
  if (!window.confirm(t('confirmResolve'))) return;
  await invoke('memory.resolve', { id: input('event-id').value, decision, confirmed: true }); await refresh();
});
action('export', async () => {
  const data = await invoke('memory.diagnostics');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ai-memory-diagnostics.json'; anchor.click(); URL.revokeObjectURL(url);
});
element('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const connection = connections.find(item => item.id === select('connection').value);
  if (!projectPath || !connection) return;
  const binding = { projectPath, connectionId: connection.id, workspace: input('workspace').value, project: input('project').value, capture: input('capture').checked };
  const next: Settings = { ...settings, mode: select('mode').value === 'managed' ? 'managed' : 'coexist', bindings: [...settings.bindings.filter(item => item.projectPath !== projectPath), binding], policy: { ...settings.policy, prompts: input('prompts').checked, toolArguments: input('toolArguments').checked, toolResults: input('toolResults').checked, assistant: input('assistant').checked, ignorePaths: area('excludes').value.split('\n').map(line => line.trim()).filter(Boolean) } };
  if (!window.confirm(`${t('confirmSave')}\n${connection.label} → ${binding.workspace}/${binding.project}\n${JSON.stringify(next.policy)}`)) return;
  save(next).catch(() => notice(t('failure')));
});
appearance({});
bridge?.on('appearance:changed', appearance);
invoke('app.getAppearance').then(appearance).catch(() => appearance({}));
refresh().catch(() => notice(t('unavailable')));
