// Standalone review gallery. Hotspots navigate static concepts, never live sessions.
export function reviewGallery(manifest) {
  const payload = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 指挥中心 · 设计评审 v3</title><style>
:root{color-scheme:dark;font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#141618;color:#e7eaef}
*{box-sizing:border-box}body{margin:0}button,a,select{font:inherit}button{cursor:pointer;color:inherit}
header{padding:18px 28px;border-bottom:1px solid #343a42;display:flex;justify-content:space-between;gap:20px;align-items:center}
header h1{font-size:23px;margin:0 0 7px}header p{margin:0;color:#acb5c1;font-size:14px}header label{font-size:13px;color:#acb5c1;display:grid;gap:7px}
select{color:#e7eaef;background:#23272c;border:1px solid #52677f;padding:9px 12px;border-radius:6px;max-width:100%}
main{padding:20px 28px;max-width:1740px;margin:auto}.toolbar{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:15px}
.toolbar h2{font-size:20px;margin:0 0 6px}.toolbar p{font-size:14px;color:#acb5c1;margin:0;line-height:1.6}.links{display:flex;gap:8px;flex-shrink:0}
.links a,.links button{padding:8px 11px;border:1px solid #343a42;border-radius:6px;color:#e7eaef;background:#23272c;text-decoration:none;font-size:13px}
.frame{position:relative;width:100%;aspect-ratio:16/11}.board{display:block;width:100%;height:100%;border-radius:8px}
.hotspots{position:absolute;inset:0;pointer-events:none}.hotspot{position:absolute;background:transparent;border:0;border-radius:7px;pointer-events:auto}
.hotspot:hover{background:rgba(155,183,226,.1);outline:1px solid #9bb7e2}.hotspot:focus-visible{outline:3px solid #b9d1f2;outline-offset:2px;background:rgba(155,183,226,.15)}
.hotspot .hint{position:absolute;left:50%;top:calc(100% + 7px);transform:translateX(-50%);width:max-content;max-width:220px;background:#10151c;border:1px solid #627c9d;border-radius:5px;padding:5px 9px;font-size:13px;color:#e7eaef;opacity:0;pointer-events:none;z-index:3}
.hotspot:hover .hint,.hotspot:focus .hint{opacity:1}button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid #9bb7e2;outline-offset:3px}
.revision{color:#d8b582!important;margin-top:5px!important}.notes{margin-top:16px}.notes h3{font-size:15px}.notes ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;list-style:none;padding:0}
.notes li{border-left:2px solid #52677f;padding-left:12px;color:#acb5c1;font-size:14px;line-height:1.7}.notice{font-size:12px;line-height:1.7;color:#7f8997}
dialog{background:#1c1f22;color:#e7eaef;border:1px solid #52677f;border-radius:12px;width:min(570px,90vw);padding:24px}dialog::backdrop{background:#0009}dialog h2{margin:0 0 8px;font-size:22px}dialog p{color:#acb5c1;font-size:14px;line-height:1.7}
.history-row{display:flex;justify-content:space-between;align-items:center;gap:16px;background:#23272c;border:1px solid #343a42;border-radius:7px;width:100%;padding:15px;margin:10px 0;text-align:left}.history-row small{display:block;color:#acb5c1;margin-top:5px}.close{margin-top:12px;padding:8px 16px;color:#e7eaef;background:#23272c;border:1px solid #52677f;border-radius:6px}
@media(max-width:800px){header{flex-wrap:wrap;padding:15px}main{padding:14px}.toolbar{flex-wrap:wrap}.links{flex-wrap:wrap}.notes ul{grid-template-columns:1fr}.hotspot .hint{font-size:11px}header label{width:100%}}
@media print{header label,.links,.hotspots,.notice{display:none}main{padding:0}.toolbar{margin:0}}
</style></head><body>
<header><div><h1>AI 指挥中心 · 设计评审 v3</h1><p>桌面全局导航移至顶部图标工具栏，释放左侧空间。工作区任务列表与设置分类保留。</p></div><label for="stages">选择阶段图<select id="stages"></select></label></header>
<main><div class="toolbar"><div><h2 id="heading" aria-live="polite"></h2><p id="summary"></p><p id="revision" class="revision"></p></div><div class="links"><button id="previous" type="button" aria-label="上一张阶段图">←</button><button id="next" type="button" aria-label="下一张阶段图">→</button><a id="svg" target="_blank" rel="noopener">SVG 原图</a><a id="png" target="_blank" rel="noopener">PNG 原图</a></div></div>
<div class="frame"><img class="board" id="board" alt=""><div class="hotspots" id="hotspots"></div></div>
<section class="notes"><h3>评审重点</h3><ul id="questions"></ul></section><p class="notice">顶部总览、历史、设置图标及工作区标签可点击。其他控件为静态概念；所有任务与历史为示例，不连接真实数据或修改设置。V1/V2 图片保留供对比。</p></main>
<dialog id="history-dialog" aria-labelledby="history-title"><h2 id="history-title">历史会话</h2><p>导航示例：选择最近会话进入对应工作区。这里没有读取你的实际历史。</p><div id="history-rows"></div><button class="close" id="close-history" type="button">关闭</button></dialog>
<script>
const manifest=${payload};
const all=[...manifest.stages,...manifest.auxiliary],views=new Map(all.map(v=>[v.id,v]));let active=manifest.defaultView,index=2;
const selector=document.getElementById('stages');for(const [i,v] of manifest.stages.entries()){const option=document.createElement('option');option.value=v.id;option.textContent=v.phase+' / '+v.title+(v.revision===3?' · 最新':' · 历史参考');selector.append(option)}
selector.onchange=()=>show(selector.value);
const historyDialog=document.getElementById('history-dialog');
for(const [key,title,detail] of [['a','Payment refactor','Payments · 主会话'],['b','Auth recovery','Auth · 主会话'],['c','Research brief','Research · 主会话']]){const b=document.createElement('button');b.type='button';b.className='history-row';const label=document.createElement('span');const name=document.createElement('strong');name.textContent=title;const sub=document.createElement('small');sub.textContent=detail;label.append(name,sub);const arrow=document.createElement('span');arrow.textContent='→';b.append(label,arrow);b.dataset.historyTarget='workspace-'+key+'-entry-v3';b.onclick=()=>{historyDialog.close();show(b.dataset.historyTarget)};document.getElementById('history-rows').append(b)}
document.getElementById('close-history').onclick=()=>historyDialog.close();
function show(id){if(id==='history'){if(!historyDialog.open)historyDialog.showModal();return}const v=views.get(id);if(!v)return;active=id;const i=manifest.stages.findIndex(s=>s.id===id);if(i>=0){index=i;selector.value=id}else{selector.value=manifest.defaultView}document.body.dataset.view=id;document.getElementById('heading').textContent=v.phase+' / '+v.title;document.getElementById('summary').textContent=v.summary;document.getElementById('revision').textContent=v.revision===3?'V3：顶部图标导航可点击，悬停或键盘聚焦可显示说明。':'历史概念：桌面全局左侧导航已由 V3 顶部图标工具栏取代。';const prefix='../image/command-center-review/';const img=document.getElementById('board');img.src=prefix+v.svg;img.alt=v.title+'；概念稿，未实现';document.getElementById('svg').href=prefix+v.svg;document.getElementById('png').href=prefix+v.png;document.getElementById('questions').replaceChildren(...v.questions.map(t=>{const li=document.createElement('li');li.textContent=t;return li}));document.getElementById('hotspots').replaceChildren(...(v.hotspots||[]).map(h=>{const b=document.createElement('button');b.type='button';b.className='hotspot';b.style.left=h.x/16+'%';b.style.top=h.y/11+'%';b.style.width=h.w/16+'%';b.style.height=h.h/11+'%';b.setAttribute('aria-label',h.label);b.dataset.target=h.target;const hint=document.createElement('span');hint.className='hint';hint.textContent=h.label;b.append(hint);b.onclick=()=>show(h.target);return b}));history.replaceState(null,'','#'+id)}
document.getElementById('previous').onclick=()=>show(manifest.stages[(index-1+manifest.stages.length)%manifest.stages.length].id);
document.getElementById('next').onclick=()=>show(manifest.stages[(index+1)%manifest.stages.length].id);
const hash=location.hash.slice(1).replace(/-v2$/,'-v3');show(views.has(hash)?hash:manifest.defaultView);
</script></body></html>`;
}
