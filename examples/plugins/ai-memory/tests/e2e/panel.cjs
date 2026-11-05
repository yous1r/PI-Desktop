const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '../..');
const scratch = process.env.AI_MEMORY_PANEL_PROFILE || fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'ai-memory-panel-'));
app.setPath('userData', scratch);
const locale = process.env.AI_MEMORY_PANEL_LOCALE === 'en' ? 'en' : 'zh-CN';
const labels = locale === 'en' ? { title: 'Project memory', saved: 'Saved', resume: 'Resume' } : { title: '项目记忆', saved: '已保存', resume: '恢复' };
let settings = { schemaVersion: 1, mode: 'coexist', paused: false, bindings: [], policy: { prompts: false, toolArguments: false, toolResults: false, assistant: false, maxChars: 8000, ignorePaths: [] }, recall: { deadlineMs: 1500, maxChars: 6000 } };
let saves = 0;
const calls = [];
ipcMain.handle('ai-memory-panel-fixture', (_event, channel, payload) => {
  calls.push(channel);
  if (channel === 'app.getAppearance') return { base: 'light', locale };
  if (channel === 'memory.settings') { assert.equal(payload.confirmed, true); settings = payload.settings; saves++; return { saved: true }; }
  if (channel === 'memory.status') return { state: 'read-only', settings, connections: [{ id: 'c', label: 'Synthetic connection', revision: 3 }], workspace: { path: '/synthetic-project', name: 'Project' }, queue: { count: 1, oldestAgeMs: 1000, counts: { 'delivery-uncertain': 1 }, events: [{ id: 'e1', state: 'delivery-uncertain' }], mutations: [] }, capabilities: [], lastRecall: [] };
  if (channel === 'memory.probe') return { version: '3.3.3' };
  if (channel === 'memory.diagnostics') return { plugin: 'local.ai-memory', queue: { count: 1 } };
  if (channel === 'memory.reconcile') { assert.equal(payload.id, 'e1'); return { verified: false }; }
  if (channel === 'memory.resolve') { assert.equal(payload.id, 'e1'); assert.equal(payload.confirmed, true); return { resolved: true }; }
  throw new Error('UNEXPECTED_CHANNEL');
});
let win;
const run = async expression => win.webContents.executeJavaScript(expression, true);
async function waitFor(expression) {
  await run(`new Promise((resolve,reject)=>{const check=()=>{if(${expression}){observer.disconnect();clearTimeout(timer);resolve(true)}};const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('condition timeout'))},5000);check()})`);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 800, height: 900, webPreferences: { preload: path.join(__dirname, 'panel-preload.cjs'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(root, 'dist/ui/index.html'));
  await waitFor("document.getElementById('project-path').textContent === '/synthetic-project'");
  assert.equal(await run("document.documentElement.lang"), locale);
  assert.equal(await run("document.querySelector('h1').textContent"), labels.title);
  assert.equal(await run("document.querySelectorAll('input[type=password]').length"), 0);
  await run("window.confirm=()=>false;document.getElementById('workspace').value='team';document.getElementById('project').value='project-a';document.getElementById('capture').checked=true;document.getElementById('settings-form').requestSubmit()");
  assert.equal(saves, 0);
  await run("window.confirm=()=>true;document.getElementById('settings-form').requestSubmit()");
  await waitFor(`document.getElementById('notice').textContent === ${JSON.stringify(labels.saved)}`);
  assert.equal(saves, 1); assert.equal(settings.bindings[0].capture, true); assert.deepEqual(Object.keys(settings.bindings[0]).sort(), ['capture', 'connectionId', 'project', 'projectPath', 'workspace']);
  assert.equal(settings.policy.prompts, false);
  await run("document.getElementById('pause').click()");
  await waitFor(`document.getElementById('pause').textContent === ${JSON.stringify(labels.resume)}`);
  assert.equal(settings.paused, true);
  await run("document.getElementById('event-id').value='e1';document.getElementById('reconcile').click()");
  await waitFor("document.getElementById('reconcile').disabled === false");
  assert.ok(calls.includes('memory.reconcile'));
  await run("document.getElementById('event-id').value='e1';document.getElementById('discard').click()");
  await waitFor("document.getElementById('discard').disabled === false");
  assert.ok(calls.includes('memory.resolve'));
  console.log(`PASS: isolated Electron panel binding/confirmation/privacy/pause/reconciliation/${locale} interaction`);
}).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => { win?.destroy(); app.quit(); });
// Chromium still holds profile files during will-quit on Windows. The Node launcher
// owns cleanup after this process has exited; direct runs retain their scratch profile.
app.on('will-quit', () => { ipcMain.removeHandler('ai-memory-panel-fixture'); });
