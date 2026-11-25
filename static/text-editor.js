'use strict';
const TextEditor=(()=>{
  let active=false,draft=null,base=null,rows=[],group='',query='',target='screen',scene='lobby',stage='running',selected=null,busy=false,discard=false,previewTimer,observer;
  const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone=v=>JSON.parse(JSON.stringify(v));
  const fieldValue=(config,path)=>path.split('.').reduce((v,k)=>v[k],config);
  function setField(config,path,value){const bits=path.split('.');let item=config;for(const key of bits.slice(0,-1))item=item[key];item[bits.at(-1)]=value;}
  const value=row=>row.path?fieldValue(draft,row.path):(draft.texts[row.id]??row.default);
  const changed=()=>JSON.stringify(draft)!==JSON.stringify(base);
  const visible=()=>rows.filter(r=>(!group||r.groups.includes(group))&&(!query||[r.label,r.default,value(r)].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  function errorFor(row){const v=value(row);if(!v.trim())return 'Введите текст.';if(v.length>row.limit)return `Максимум ${row.limit} символов.`;if(JSON.stringify([...v.matchAll(/\{([a-z_]+)\}/g)].map(m=>m[1]).sort())!==JSON.stringify([...row.tokens].sort()))return 'Сохраните переменные: '+row.tokens.map(t=>'{'+t+'}').join(', ');return '';}
  function open(){
    if(!state?.config)return;
    base=clone(state.config);draft=clone(base);draft.texts||={};base.texts||={};active=true;busy=false;discard=false;query='';group='Содержание сцен';selected=null;target='screen';scene=['house','near','finish'].includes(state.scene)?state.scene:'lobby';stage='running';
    const defaults=state.text_defaults;
    rows=[{id:'field-title',path:'title',label:'Название выступления',default:defaults.title,groups:['Содержание сцен'],tokens:[],limit:90}];
    for(const id of ['house','near'])for(const [key,label,limit] of [['title','Заголовок',80],['subtitle','Подзаголовок',180],['minutes','Длительность в пульте',40],['takeaway','Итоговый тезис',240],['note','Заметка ведущему',1200]])rows.push({id:`field-${id}-${key}`,path:`modules.${id}.${key}`,label:`${id==='house'?'Монетка':'Почти получилось'} · ${label}`,default:defaults.modules[id][key],groups:['Содержание сцен'],tokens:[],limit});
    rows.push(...Copy.catalog.map(r=>({...r,label:r.default})));
    shell();
  }
  function shell(){
    const groups=[...new Set(rows.flatMap(r=>r.groups))];
    modal.innerHTML=`<div class="text-editor-overlay"><section class="text-editor" role="dialog" aria-modal="true" aria-labelledby="text-editor-title"><header class="text-editor-header"><div><span class="eyebrow">Содержание сайта</span><h2 id="text-editor-title">Редактор надписей</h2><p>Правки появятся у всех после «Применить». Ответы и ход игры сохраняются.</p></div><button class="btn" data-editor="close">Закрыть</button></header><div class="text-editor-toolbar"><label>Найти надпись<input id="text-search" type="search" placeholder="Например, барабаны или приём ответов" value="${e(query)}"></label><label>Раздел<select id="text-group"><option value="">Все надписи</option>${groups.map(g=>`<option value="${e(g)}" ${g===group?'selected':''}>${e(g)}</option>`).join('')}</select></label></div><div class="text-editor-mobile-tabs"><button class="btn primary" data-editor="mobile-fields">Тексты</button><button class="btn" data-editor="mobile-preview">Предпросмотр</button></div><div class="text-editor-body"><div class="text-editor-fields"><div id="text-field-list"></div></div><aside class="text-editor-preview"><div class="text-preview-controls"><label>Экран<select id="text-target">${[['screen','Проектор'],['phone','Телефон участника'],['home','Главная страница'],['admin','Пульт ведущего'],['login','Вход ведущего']].map(([id,label])=>`<option value="${id}" ${target===id?'selected':''}>${label}</option>`).join('')}</select></label><label>Сцена<select id="text-scene">${[['lobby','Сбор аудитории'],['house','Монетка'],['near','Почти получилось'],['finish','Финал']].map(([id,label])=>`<option value="${id}" ${scene===id?'selected':''}>${label}</option>`).join('')}</select></label><label>Состояние<select id="text-stage">${[['running','Игра / первый исход'],['near','Почти выигрыш'],['intro','Перед началом'],['paused','Пауза'],['reveal','Результаты'],['completed','Все ответы отправлены'],['join','До подключения']].map(([id,label])=>`<option value="${id}" ${stage===id?'selected':''}>${label}</option>`).join('')}</select></label></div><p class="text-preview-note">Пример данных. Это превью не переключает настоящий экран.</p><div id="text-preview-holder"><iframe id="text-preview-frame" title="Предпросмотр надписей" sandbox="allow-same-origin" tabindex="-1"></iframe></div><div class="text-selected-preview"><span>Выбранная надпись</span><p id="text-selected-value">Выберите поле слева.</p></div></aside></div><footer class="text-editor-footer"><div><span id="text-dirty" role="status"></span><p id="text-editor-error" role="alert"></p><div id="text-discard" hidden>Есть несохранённые правки. <button class="btn small" data-editor="discard">Закрыть без сохранения</button></div></div><button class="btn primary" id="text-apply" data-editor="apply">Применить надписи</button></footer></section></div>`;
    list();preview();status();document.getElementById('text-search').focus();
  }
  function list(){
    const shown=visible();
    document.getElementById('text-field-list').innerHTML=`<div class="text-list-count">${shown.length} ${group?'в этом разделе':'надписей'} · поиск учитывает текущий и исходный текст</div>`+(shown.length?shown.map(row=>`<article class="text-field" data-row="${row.id}"><label for="text-${row.id}">${e(row.label)}</label><textarea id="text-${row.id}" data-text-id="${row.id}" rows="${value(row).length>130?4:2}" maxlength="${row.limit}">${e(value(row))}</textarea>${row.tokens.length?`<p class="text-token-hint">Значения подставятся автоматически: ${row.tokens.map(t=>`<code>{${e(t)}}</code>`).join(' ')}</p>`:''}<div class="text-field-meta"><span data-text-error="${row.id}">${e(errorFor(row))}</span><button class="btn small ghost" data-editor="reset" data-id="${row.id}">Стандартный текст</button></div></article>`).join(''):'<p class="text-empty">Ничего не найдено. Попробуйте другое слово или выберите все разделы.</p>');
  }
  function status(){
    if(!active)return;
    const count=rows.filter(r=>value(r)!==(r.path?fieldValue(base,r.path):(base.texts[r.id]??r.default))).length;
    document.getElementById('text-dirty').textContent=busy?'Сохраняем…':count?`${count} изменённых полей · ещё не опубликовано`:'Все изменения сохранены';
    const invalid=rows.find(r=>errorFor(r));
    document.getElementById('text-apply').disabled=busy||!changed()||!!invalid;
    document.getElementById('text-search').disabled=busy;document.getElementById('text-group').disabled=busy;
    modal.querySelectorAll('[data-text-id],[data-editor="reset"]').forEach(el=>el.disabled=busy);
  }
  function previewState(){
    const s=clone(state);s.config=clone(draft);s.title=draft.title;s.modules=clone(draft.modules);s.enabled=clone(draft.enabled);s.texts=clone(draft.texts);s.scene=scene;s.phase=['intro','reveal'].includes(stage)?stage:'running';s.paused=stage==='paused';s.demo=false;s.online=20;s.count=20;s.house_view='audience';s.house_sim=null;s.progress={house:8,near:6};
    s.stats={house:{turnover:580,payout:551,house_net:29,rounds:58,expected:29,positive:7,completed:8},near:{miss:3.5,near:5.2,n:6}};
    s.live_board={seats:Array.from({length:20},(_,i)=>({id:'preview-'+i,label:String(i+1).padStart(2,'0'),step:scene==='house'?(i%5)+1:i<6?2:i<12?1:0,total:scene==='house'?s.house_rounds:2,viewing:false})),done:scene==='house'?58:18,total:20*(scene==='house'?s.house_rounds:2),first:12,second:6,recent:scene==='house'?[{id:'preview-event',at:1,seat:'01',kind:'coin',outcome:'heads',payout:19}]:[]};
    s.me={name:'Участник',house:[{outcome:'heads',choice:'heads',payout:19},{outcome:'tails',choice:'heads',payout:0},{outcome:'heads',choice:'heads',payout:19}],balance:208,near_order:stage==='near'?['near','miss']:['miss','near'],near:{},near_spins:{[stage==='near'?'near':'miss']:{id:'preview-spin',at:1}}};
    if(stage==='completed'){s.me.house=Array.from({length:s.house_rounds},()=>({outcome:'heads',choice:'heads',payout:19}));s.me.balance=200+9*s.house_rounds;s.me.near={miss:3,near:5};}
    if(stage==='join')s.me=null;
    return s;
  }
  function preview(){
    if(!active)return;const saved=state,s=previewState();let content;
    try{state=s;content=target==='phone'?playerMarkup(true):target==='home'?homeMarkup():target==='login'?loginMarkup():target==='admin'?adminMarkup():screenMarkup(true);content=Copy.html(content,draft.texts);}finally{state=saved;}
    const frame=document.getElementById('text-preview-frame'),holder=document.getElementById('text-preview-holder');
    const width=target==='phone'?390:1280,height=target==='phone'?980:target==='home'?1300:target==='admin'?1100:720;
    holder.style.aspectRatio=`${width} / ${height}`;holder.classList.toggle('phone',target==='phone');frame.style.width=width+'px';frame.style.height=height+'px';
    const resize=()=>{if(active)frame.style.transform=`scale(${holder.clientWidth/width})`;};
    observer?.disconnect();observer=new ResizeObserver(resize);observer.observe(holder);resize();
    frame.srcdoc=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><base href="${e(location.origin)}/"><link rel="stylesheet" href="/static/style.css?v=0.4.0"><style>body{pointer-events:none}#projector-preview{display:none}.slide-preview:after{content:'Превью проектора доступно в списке экранов';color:#bdb4d2;display:grid;place-items:center;height:100%;font-size:18px}</style></head><body>${content}</body></html>`;
    if(selected){const row=rows.find(r=>r.id===selected);document.getElementById('text-selected-value').textContent=value(row);}
  }
  function close(force=false){
    if(busy)return;
    if(!force&&changed()){discard=true;document.getElementById('text-discard').hidden=false;return;}
    clearTimeout(previewTimer);observer?.disconnect();active=false;draft=null;base=null;modal.innerHTML='';
  }
  async function apply(){
    if(busy||!changed()||rows.some(r=>errorFor(r)))return;
    busy=true;status();document.getElementById('text-editor-error').textContent='';
    const fields=Object.fromEntries(rows.filter(r=>r.path).map(r=>[r.path,value(r)]));
    try{
      const next=await api('/api/admin/action',{action:'texts',expected_version:base.text_version||0,texts:draft.texts,fields});
      busy=false;close(true);accept(next);toast('Надписи применены на всех экранах.');
    }catch(err){busy=false;status();document.getElementById('text-editor-error').textContent=err.message;}
  }
  document.addEventListener('input',event=>{
    if(!active)return;const el=event.target;
    if(el.id==='text-search'){query=el.value;if(query){group='';document.getElementById('text-group').value='';}list();return;}
    const row=rows.find(r=>r.id===el.dataset.textId);if(!row||busy)return;
    selected=row.id;if(row.path)setField(draft,row.path,el.value);else if(el.value===row.default)delete draft.texts[row.id];else draft.texts[row.id]=el.value;
    modal.querySelector(`[data-text-error="${row.id}"]`).textContent=errorFor(row);discard=false;document.getElementById('text-discard').hidden=true;status();
    clearTimeout(previewTimer);previewTimer=setTimeout(preview,180);
  });
  document.addEventListener('change',event=>{
    if(!active)return;const el=event.target;
    if(el.id==='text-group'){group=el.value;list();}
    if(el.id==='text-target')target=el.value;
    if(el.id==='text-scene')scene=el.value;
    if(el.id==='text-stage')stage=el.value;
    if(el.id.startsWith('text-'))preview();
  });
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-editor]');if(!active||!el)return;event.preventDefault();event.stopImmediatePropagation();if(busy)return;
    const action=el.dataset.editor;
    if(action==='close')close();else if(action==='discard')close(true);else if(action==='apply')apply();
    else if(action==='reset'){const row=rows.find(r=>r.id===el.dataset.id);selected=row.id;if(row.path)setField(draft,row.path,row.default);else delete draft.texts[row.id];list();status();preview();}
    else if(action==='mobile-preview'||action==='mobile-fields')modal.querySelector('.text-editor').classList.toggle('show-preview',action==='mobile-preview');
  },true);
  document.addEventListener('keydown',event=>{
    if(!active)return;
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){const els=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea:not(:disabled)')].filter(e=>e.getClientRects().length);if(event.shiftKey&&document.activeElement===els[0]){event.preventDefault();els.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===els.at(-1)){event.preventDefault();els[0]?.focus();}}
  });
  return {open,get active(){return active;}};
})();
