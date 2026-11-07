import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reviewGallery } from './command-center-review-gallery.mjs';

// Review-only revision. Existing v1/v2 image assets remain historical references.
export function renderReviewV3(root, legacyStages, draw) {
  const { C, rect, line, text, dot, pill, button, panel, block, begin, finish } = draw;
  const assets = resolve(root, 'docs/image/command-center-review');
  const views = [];
  let hotspots = [];
  const overviewId = 'p2-overview-v3';
  const settingsId = 'settings-command-center-v3';
  const workspaces = [
    { key: 'a', name: 'Payments', count: 8, task: 'Payment refactor', goal: 'Keep the public payment API unchanged.', reply: 'I am updating the adapter and checking its callers.', child: 'API compatibility', file: 'src/payments/adapter.ts' },
    { key: 'b', name: 'Auth', count: 10, task: 'Auth recovery', goal: 'Verify the callback path and cover the failure cases.', reply: 'I am checking the callback contract and the regression tests.', child: 'Contract check', file: 'src/auth/callback.ts' },
    { key: 'c', name: 'Research', count: 6, task: 'Research brief', goal: 'Compare the platform constraints and record unresolved questions.', reply: 'I am collecting evidence and separating confirmed facts from assumptions.', child: 'Platform comparison', file: 'docs/research/platforms.md' },
  ];

  function hot(x, y, w, h, label, target) {
    hotspots.push({ x, y, w, h, label, target });
  }
  function start(phase, title, subtitle, index) {
    hotspots = [];
    begin(phase, title, subtitle, index, 3, 10);
  }
  function save(id, phase, title, summary, questions, slot = null) {
    finish(id);
    const view = { id, phase, title, summary, questions, revision: 3, svg: `${id}.svg`, png: `${id}.png`, hotspots: [...hotspots] };
    views.push(view);
    if (slot !== null) view.slot = slot;
    return view;
  }
  function shell(title, active = 'overview') {
    const x = 42, y = 184, w = 1516, h = 760;
    rect(x, y, w, h, C.surface, C.border, 12);
    text(x + 22, y + 30, 'PI-Desktop', 17, C.text, 600);
    const tools = [
      ['overview', '总览', overviewId],
      ['history', '历史会话', 'history'],
      ['settings', '设置', settingsId],
    ];
    tools.forEach(([kind, label, target], i) => {
      const tx = x + 180 + i * 46, ty = y + 8;
      const selected = active === kind;
      const ink = selected ? C.blue : C.secondary;
      rect(tx, ty, 36, 34, selected ? C.blueBg : C.surface, selected ? '#52677f' : 'none', 6);
      const cx = tx + 18, cy = ty + 17;
      if (kind === 'overview') {
        for (let n = 0; n < 4; n++) rect(cx - 9 + (n % 2) * 11, cy - 9 + Math.floor(n / 2) * 11, 7, 7, 'none', ink, 1);
      } else if (kind === 'history') {
        dot(cx, cy, ink, 10); dot(cx, cy, selected ? C.blueBg : C.surface, 8);
        line(cx, cy - 5, cx, cy, ink); line(cx, cy, cx + 5, cy + 3, ink);
      } else {
        for (let n = 0; n < 8; n++) {
          const angle = n * Math.PI / 4;
          line(cx + Math.cos(angle) * 8, cy + Math.sin(angle) * 8, cx + Math.cos(angle) * 12, cy + Math.sin(angle) * 12, ink);
        }
        dot(cx, cy, ink, 8); dot(cx, cy, selected ? C.blueBg : C.surface, 6);
        dot(cx, cy, ink, 3); dot(cx, cy, selected ? C.blueBg : C.surface, 1.5);
      }
      hot(tx, ty, 36, 34, label, target);
    });
    line(x + 326, y + 14, x + 326, y + 36);
    text(x + 346, y + 30, title, 16, C.secondary);
    dot(x + w - 240, y + 25, C.green, 3);
    text(x + w - 228, y + 30, 'Local Host', 13, C.secondary);
    line(x + w - 114, y + 14, x + w - 114, y + 36);
    line(x + w - 88, y + 26, x + w - 74, y + 26, C.muted);
    rect(x + w - 57, y + 18, 14, 14, 'none', C.muted, 2);
    text(x + w - 26, y + 31, '×', 20, C.muted);
    line(x, y + 49, x + w, y + 49);
    return { x: 60, y: 258, w: 1480, h: 630 };
  }
  function workspaceTabs(x, y, width, selected = null, tall = false) {
    const gap = 10, tabWidth = (width - 2 * gap) / 3, height = tall ? 66 : 38;
    workspaces.forEach((ws, i) => {
      const xx = x + i * (tabWidth + gap);
      const on = selected === ws.key;
      rect(xx, y, tabWidth, height, on ? C.blueBg : C.surface, on ? '#627c9d' : C.border, 7);
      text(xx + 14, y + (tall ? 26 : 25), `${ws.key.toUpperCase()} / ${ws.name}`, 16, on ? C.blue : C.text, 600);
      if (tall) text(xx + 14, y + 49, `${ws.count} / 12 agents  →`, 13, C.secondary);
      hot(xx, y, tabWidth, height, `进入工作区 ${ws.key.toUpperCase()}：${ws.name}`, `workspace-${ws.key}-entry-v3`);
    });
  }
  function placeholder(x, y, w, h) {
    rect(x, y, w, h, '#1a1d20', C.border, 9, 'stroke-dasharray="6 6"');
    text(x + 20, y + 31, 'Reserved', 16, C.muted, 500);
    text(x + w / 2, y + h / 2 + 4, 'To be decided', 22, C.secondary, 500, 'text-anchor="middle"');
    text(x + w / 2, y + h / 2 + 36, 'No function assigned', 14, C.muted, 400, 'text-anchor="middle"');
  }

  start('P2 · V3', 'OVERVIEW & TOP TOOLBAR', 'Global navigation stays in the toolbar. Content gets the full desktop width.', 3);
  let a = shell('Monitoring overview');
  const gap = 16, half = (a.w - gap) / 2, topHeight = 310;
  let p = panel(a.x, a.y, half, topHeight, 'Overview', '24 active');
  pill(p.x, p.y - 4, 'Needs input 3', 'amber', 132);
  pill(p.x + 146, p.y - 4, 'All tasks', 'neutral', 90);
  const rows = [
    ['Payment refactor', 'Edit adapter / updated 2s ago', 'Running'],
    ['Regression tests', 'Command approval required', 'Needs approval'],
    ['Research brief', 'Waiting for provider capacity', 'Waiting'],
  ];
  rows.forEach(([title, detail, status], i) => {
    const yy = p.y + 57 + i * 56;
    dot(p.x + 4, yy - 5, i === 1 ? C.amber : C.blue, 3);
    text(p.x + 17, yy, title, 17, C.text, 600);
    text(p.x + 17, yy + 23, detail, 14, C.secondary);
    text(p.x + p.w, yy, status, 13, i === 1 ? C.amber : C.secondary, 400, 'text-anchor="end"');
    if (i < 2) line(p.x, yy + 36, p.x + p.w, yy + 36);
  });
  const rx = a.x + half + gap;
  rect(rx, a.y, half, topHeight, C.raised, C.border, 8);
  text(rx + 20, a.y + 31, 'Workspaces', 18, C.text, 600);
  text(rx + half - 20, a.y + 30, 'Click a tab to enter', 13, C.secondary, 400, 'text-anchor="end"');
  workspaceTabs(rx + 20, a.y + 58, half - 40, null, true);
  text(rx + 22, a.y + 186, 'Choose where to work', 24, C.text, 500);
  block(rx + 22, a.y + 220, 'A selected workspace opens as a focused page. The overview keeps only its entry tabs.', 65, 16, C.secondary, 27);
  placeholder(a.x, a.y + topHeight + gap, half, 285);
  placeholder(rx, a.y + topHeight + gap, half, 285);
  text(45, 987, '01  Monitor first', 18, C.text, 600);
  text(526, 987, '02  Enter through workspace tabs', 18, C.text, 600);
  text(1110, 987, '03  Two lower regions remain open', 18, C.text, 600);
  save(overviewId, 'P2 · V3', '总览与顶部工具栏', '移除桌面全局左栏；工作区入口和下方两块待定区域保持原意。', ['顶部图标分别打开总览、历史和设置。', '内容区增加 160px 宽度，左侧不再预留全局导航。', '下方两块依旧待定，不分配新功能。'], 2);

  for (const ws of workspaces) {
    start(`Workspace ${ws.key.toUpperCase()} · V3`, 'FOCUSED WORKSPACE', 'More room for the conversation. Global navigation lives in the top toolbar.', 3);
    a = shell(`Workspace ${ws.key.toUpperCase()} / ${ws.name}`, 'workspace');
    text(a.x, a.y + 26, ws.name, 23, C.text, 600);
    pill(a.x + 170, a.y + 4, '3 need input', 'amber', 124);
    workspaceTabs(a.x + a.w - 624, a.y, 624, ws.key);
    const py = a.y + 61;
    rect(a.x, py, 270, 544, C.raised);
    text(a.x + 20, py + 34, ws.name, 24, C.text, 600);
    text(a.x + 20, py + 64, `${ws.count} / 12 live agents`, 15, C.secondary);
    line(a.x, py + 86, a.x + 270, py + 86);
    rect(a.x + 12, py + 104, 246, 66, C.blueBg, '#4e6380', 7);
    text(a.x + 26, py + 131, ws.task, 17, C.text, 600);
    text(a.x + 26, py + 154, 'Main session / selected', 13, C.blue);
    text(a.x + 26, py + 211, ws.child, 16, C.text, 500);
    text(a.x + 26, py + 235, 'Child / running', 13, C.secondary);
    text(a.x + 26, py + 285, 'Validation', 16, C.text, 500);
    text(a.x + 26, py + 309, 'Child / needs input', 13, C.amber);
    text(a.x + 20, py + 505, 'Background execution continues', 13, C.secondary);
    const cx = a.x + 286, cw = a.w - 286;
    rect(cx, py, cw, 544, C.raised, '#50657f', 9);
    text(cx + 24, py + 34, `${ws.task} / live conversation`, 22, C.text, 600);
    text(cx + cw - 24, py + 34, 'Load older messages', 14, C.blue, 400, 'text-anchor="end"');
    line(cx, py + 58, cx + cw, py + 58);
    text(cx + 24, py + 94, 'YOU', 12, C.muted, 600);
    text(cx + 24, py + 128, ws.goal, 18, C.text);
    text(cx + 24, py + 188, 'PI', 12, C.blue, 600);
    block(cx + 24, py + 220, ws.reply, 94, 18, C.secondary, 29);
    rect(cx + 24, py + 287, cw - 48, 70, C.surface, 'none', 7);
    text(cx + 42, py + 315, 'CURRENT ACTIVITY', 12, C.muted, 600);
    text(cx + 42, py + 341, `Read  ${ws.file}`, 15, C.secondary, 400, 'font-family="Consolas, monospace"');
    rect(cx + 24, py + 393, cw - 48, 117, C.surface, C.border, 9);
    text(cx + 42, py + 426, `Add guidance to ${ws.name}…`, 18, C.muted);
    pill(cx + 42, py + 460, `Target: ${ws.task}`, 'blue', 260);
    button(cx + cw - 153, py + 458, 110, 'Send', true);
    text(45, 987, 'Navigation prototype / switching a workspace does not start a new Agent.', 18, C.secondary);
    save(`workspace-${ws.key}-entry-v3`, `Workspace ${ws.key.toUpperCase()}`, `${ws.name} 工作区`, '顶部图标负责全局导航；工作区任务列表保留，主要宽度交还对话。', ['点击网格图标返回总览，齿轮图标进入设置。', '时钟图标打开示例历史会话，不读取真实数据。', '工作区内的任务列表仍用于主会话和子智能体切换。']);
  }

  start('Settings · V3', 'SETTINGS & TOP TOOLBAR', 'Global sidebar removed. Settings categories remain local to this page.', 4);
  a = shell('Settings', 'settings');
  text(a.x, a.y + 26, 'Settings', 23, C.text, 600);
  pill(a.x + a.w - 203, a.y + 4, 'Proposed controls', 'blue', 203);
  const sy = a.y + 61;
  rect(a.x, sy, 220, 544, C.raised);
  const menu = ['General', 'AI', 'Shortcuts', 'Instructions', 'Models', 'Skills', 'MCP', 'Subagents', 'Projects', 'Command center', 'Cloud sync', 'Remote Hosts', 'Info'];
  menu.forEach((label, i) => {
    const yy = sy + 15 + i * 39;
    if (label === 'Command center') rect(a.x + 10, yy, 200, 33, C.blueBg, 'none', 6);
    text(a.x + 24, yy + 23, label, 15, label === 'Command center' ? C.blue : C.secondary, label === 'Command center' ? 600 : 400);
  });
  const gx = a.x + 240, gw = a.w - 240, cardGap = 16, cardW = (gw - cardGap) / 2;
  function card(x, y, title, rows, note) {
    rect(x, y, cardW, 260, C.raised);
    text(x + 20, y + 34, title, 21, C.text, 600);
    line(x, y + 54, x + cardW, y + 54);
    rows.forEach(([label, value], i) => {
      const yy = y + 87 + i * 43;
      text(x + 20, yy, label, 15, C.secondary);
      text(x + cardW - 20, yy, value, 15, C.text, 500, 'text-anchor="end"');
      if (i < rows.length - 1) line(x + 20, yy + 16, x + cardW - 20, yy + 16);
    });
    block(x + 20, y + 222, note, 58, 13, C.muted, 21);
  }
  card(gx, sy, 'Appearance & navigation', [['Theme', 'Dark'], ['Language', 'System'], ['Workspace entry', 'Top-right tabs']], 'General and Shortcuts remain available.');
  card(gx + cardW + cardGap, sy, 'Remote desktop', [['Rendering profile', 'Software'], ['Decorative motion', 'Reduced'], ['Changes apply', 'After restart']], 'Profile shown for review; no running setting changed.');
  card(gx, sy + 278, 'Resource limits', [['Agents per workspace', '12 maximum'], ['Agents per Host', '36 maximum'], ['Owned-process budget', '4 GB target']], 'Capacity target only. Qualification is still pending.');
  card(gx + cardW + cardGap, sy + 278, 'Host, devices & applications', [['Execution Host', 'Local Host'], ['Paired devices', 'Manage devices →'], ['Native programs', 'Association settings →']], 'Proposed entries; ordinary settings categories stay intact.');
  text(45, 987, 'Settings overview concept / navigation works; configuration controls are not connected.', 18, C.secondary);
  save(settingsId, 'Settings · V3', '设置总览', '顶部齿轮打开设置；本页分类目录保留，内容区使用腾出的全局边栏空间。', ['全局导航位于顶部，不再重复显示左侧总览与历史。', '设置内部的 Models、Shortcuts、MCP 等分类保留。', '这些是评审控件，不修改实际设置或模型配置。'], 3);

  const stages = legacyStages.map(([id, phase, title, weeks, summary, questions]) => ({ id, phase, title, weeks, summary, questions, revision: 1, svg: `${id}.svg`, png: `${id}.png`, hotspots: [] }));
  const latestOverview = views.find(view => view.id === overviewId);
  latestOverview.weeks = 'W3–W6 / revised';
  stages[2] = latestOverview;
  const latestSettings = views.find(view => view.id === settingsId);
  latestSettings.weeks = 'New review page';
  stages.splice(3, 0, latestSettings);
  const auxiliary = views.filter(view => view.slot === undefined);
  const manifest = { status: 'proposed', revision: 3, method: 'deterministic SVG drawing', width: 1600, height: 1100, defaultView: overviewId, stages, auxiliary };
  writeFileSync(resolve(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(root, 'docs/project/ai-command-center-review.html'), reviewGallery(manifest));
}
