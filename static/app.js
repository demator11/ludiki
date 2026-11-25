'use strict';
const app = document.getElementById('app');
const modal = document.getElementById('modal-root');
const route = location.pathname;
const role = route === '/admin' ? 'admin' : route === '/screen' || route === '/' ? 'screen' : 'participant';
let state = null, socket = null, socketGeneration = 0, retry = 0, retryTimer, pending = false, loggedIn = false;
let selectedRating = null, toastTimer, configDraft = null, confirmAction = null;
let previewObserver = null, observedPreview = null, hostTab = 'controls';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, digits = 0) => v == null ? '—' : Number(v).toLocaleString('ru-RU', {maximumFractionDigits:digits});
const signed = v => `${v > 0 ? '+' : ''}${num(v, 2)}`;
const displayTitle = title => title==='Казино под микроскопом'?'Казино под<br><span>микроскопом.</span>':esc(title);
const brand = () => '<a class="brand-text" href="/">Психология игры</a>';
const button = (label, action, extra = '', cls = '', disabled = false) => `<button type="button" class="btn ${cls}" data-action="${action}" ${extra} ${disabled ? 'disabled' : ''}>${label}</button>`;
const joinURL = () => (state.public_url || location.origin) + '/play';
const demoTag = () => state.demo ? '<span class="tag demo">Демонстрация · 20 ботов</span>' : '';
const phaseLabel = () => state.paused ? 'Пауза' : ({intro:'Перед началом',running:state.demo?'Демонстрация':'Собираем ответы',reveal:'Обсуждаем результаты'}[state.phase]);

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = Copy.text(message); node.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 5000);
}

async function api(path, payload) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(path, {method:payload === undefined ? 'GET' : 'POST', credentials:'same-origin', signal:controller.signal,
      headers:payload === undefined ? {} : {'Content-Type':'application/json'}, body:payload === undefined ? undefined : JSON.stringify(payload)});
  } catch (err) {
    throw new Error('Сервер не ответил. Проверьте связь; после подключения состояние обновится автоматически.');
  } finally { clearTimeout(timer); }
  const json = await response.json();
  if (!response.ok) { const err = new Error(json.detail || 'Не удалось выполнить запрос.'); err.status = response.status; throw err; }
  return json;
}

function accept(next) {
  if (next.type === 'pong') return;
  if (state && next.revision < state.revision) return;
  const changed = state && (next.epoch !== state.epoch || next.scene !== state.scene || next.phase !== state.phase || next.paused !== state.paused || next.demo !== state.demo);
  if (changed) { selectedRating = null; }
  Copy.set(next.texts);
  Experience.sync(next);
  state = next;
  render(!!changed, !!changed);
}

function setConnection(text = '') {
  const el = document.getElementById('connection');
  el.textContent = Copy.text(text); el.hidden = !text;
  if (text && role === 'admin' && !['localhost','127.0.0.1'].includes(location.hostname)) {
    const link = document.createElement('a');
    link.href = 'http://localhost:8000/admin'; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = Copy.text('Открыть подготовленный резерв на ноутбуке'); el.append(' ', link);
  }
}

function connect() {
  clearTimeout(retryTimer);
  const generation = ++socketGeneration;
  if (socket) socket.close();
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?role=${role}`);
  socket.onopen = () => { if (generation === socketGeneration) { retry = 0; setConnection(); } };
  socket.onmessage = event => { if (generation === socketGeneration) accept(JSON.parse(event.data)); };
  socket.onclose = event => {
    if (generation !== socketGeneration) return;
    if (event.code === 1008 && role === 'admin') { loggedIn = false; renderLogin(); return; }
    setConnection('Связь прервалась. Восстанавливаем подключение…');
    retryTimer = setTimeout(connect, Math.min(8000, 800 * 2 ** retry++));
  };
  socket.onerror = () => socket.close();
}
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('ping'); }, 20000);

async function command(action, extra = {}, participant = false) {
  if (pending) return;
  pending = true;
  document.querySelectorAll('[data-action],button[type="submit"]').forEach(el => el.disabled = true);
  if (action.startsWith('simulate')) {
    const trigger = document.querySelector(`[data-action="${action}"]`);
    if (trigger) trigger.textContent = Copy.text('Выполняется расчёт…');
  }
  try {
    const payload = participant ? {action, ...extra, epoch:state.epoch, nonce:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`} : {action,...extra};
    const next = await api(participant ? '/api/action' : '/api/admin/action', payload);
    accept(next);
    if (action === 'simulate_house') toast('Симуляция 100 000 раундов показана на проекторе. Можно переключиться обратно на результаты аудитории.');
    else if (action.startsWith('simulate')) toast(next.phase === 'reveal' ? 'Расчёт готов и показан на проекторе.' : 'Расчёт готов. Нажмите «Раскрыть результаты», чтобы показать его аудитории.');
  } catch (err) {
    toast(err.message);
    if (err.status === 401 && role === 'admin') loggedIn = false;
  } finally { pending = false; render(true); }
}

function render(force = false, resetForm = false) {
  if (!state || pending) return;
  if (!force && app.contains(document.activeElement) && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const oldForm = app.querySelector('#join-form');
  const draft = !resetForm && oldForm ? {id:oldForm.id, entries:[...new FormData(oldForm).entries()]} : null;
  if (route === '/') renderHome();
  else if (role === 'admin') loggedIn ? renderAdmin() : renderLogin();
  else if (role === 'screen') renderScreen();
  else renderPlayer();
  if (draft) {
    const form = document.getElementById(draft.id);
    if (form) for (const [name,value] of draft.entries) { const field=form.elements.namedItem(name); if(field) field.value=value; }
  }
}

function homeMarkup() {
  return `<header class="topbar">${brand()}<div class="row"><span class="muted">Интерактивная лаборатория</span><span class="tag">Два эксперимента</span></div></header>
  <main class="home"><section class="hero"><div class="hero-copy"><div class="eyebrow">Психология × вероятность × интерфейс</div><h1 data-copy-skip>${displayTitle(state.title)}</h1><p>Два эксперимента о случайности, ощущении выигрыша и правилах игры. У каждого — свой экран. У всех — общая история.</p><div class="row"><a class="btn primary" href="/admin">Открыть пульт ведущего</a><a class="btn" href="/screen" target="_blank" rel="noopener">Экран аудитории</a></div></div>
  <div class="hero-art" aria-label="При честной монетке выигрыш плюс 9, проигрыш минус 10"><span class="art-note">ВЕРОЯТНОСТЬ ОДИНАКОВАЯ. РЕЗУЛЬТАТ — НЕТ.</span><div class="coin">+9</div><div class="coin second">−10</div><span class="art-bottom">50 / 50 · заглянем внутрь</span></div></section>
  <section><div class="section-line"><h2>Одна комната. Три точки зрения.</h2><span class="muted">Без регистрации участников</span></div><div class="entry-grid">
  <a class="entry" href="/play"><div class="entry-icon">◉</div><h3>Участник</h3><p>Сделать выбор, оценить результат и отправить свой ответ с телефона.</p><span class="entry-label">Мобильный экран</span></a>
  <a class="entry" href="/screen" target="_blank" rel="noopener"><div class="entry-icon">▣</div><h3>Аудитория</h3><p>Общий вопрос, QR-код и результаты, которые открывает ведущий.</p><span class="entry-label">Проектор / большой экран</span></a>
  <a class="entry" href="/admin"><div class="entry-icon">☷</div><h3>Ведущий</h3><p>Управлять темпом, редактировать тексты и менять программу по ходу.</p><span class="entry-label">Пульт управления</span></a></div></section>
  <section><div class="section-line"><h2>Программа-конструктор</h2><span class="muted">Можно оставить только нужные модули</span></div><div class="module-grid">${Object.entries(state.modules).map(([id,m])=>`<article class="module-card"><small data-copy-skip>${esc(m.minutes)}</small><h3 data-copy-skip>${esc(m.title)}</h3><p data-copy-skip>${esc(m.subtitle)}</p></article>`).join('')}</div></section>
  <footer class="home-footer"><span>Учебный проект о механиках азартных игр</span><span>Только условные очки · результаты не являются диагностикой</span></footer></main>`;
}

function renderHome(){document.title=state.title;app.innerHTML=Copy.html(homeMarkup());}

function loginMarkup(error = '') {
  return `<main class="auth-wrap"><section class="auth">${brand()}<div class="stack"><span class="eyebrow">За сценой</span><h1>Пульт ведущего</h1><p>Здесь начинается интерактив: сцены, ответы аудитории и быстрые правки.</p></div><form id="login-form"><label class="form-field"><span>Пароль ведущего</span><input name="password" type="password" required autocomplete="current-password" placeholder="Введите пароль"></label>${error ? `<p class="error-inline" role="alert">${esc(error)}</p>` : ''}<button class="btn primary" type="submit">Войти в пульт</button></form><p class="help">При первом запуске пароль создаётся в <code>data/admin-key.txt</code>.<br>Docker: <code>docker compose exec ludiki cat /app/data/admin-key.txt</code></p><a class="btn ghost" href="/">На главную</a></section></main>`;
}

function renderLogin(error=''){app.innerHTML=Copy.html(loginMarkup(error));}

function adminMarkup() {
  const s=state, scene=s.scene, m=s.modules[scene], isModule=!!m, progress=s.progress[scene]||0;
  const names={lobby:'Сбор',house:'Монетка',near:'Почти',finish:'Итог'};
  const sceneButton=(id,index)=>`<button class="scene-btn ${scene===id?'active':''}" data-action="scene" data-scene="${id}" aria-current="${scene===id?'step':'false'}"><span class="scene-index">${index}</span><span class="scene-full" ${s.modules[id]?'data-copy-skip':''}>${esc(s.modules[id]?.title||({lobby:'Сбор аудитории',finish:'Обсуждение'}[id]))}</span><span class="scene-short">${names[id]}</span></button>`;
  const markup=`<div class="admin-shell host-tab-${hostTab}"><aside class="sidebar">${brand()}<div class="side-caption">Ход выступления</div><nav class="scene-list" aria-label="Сцены">${sceneButton('lobby','◎')}${s.enabled.map((id,i)=>sceneButton(id,String(i+1).padStart(2,'0'))).join('')}${sceneButton('finish','✓')}</nav><div class="sidebar-bottom">${button('Редактор надписей','edit-texts','','primary wide')}${button('Настроить программу','settings','','wide')}${button('Выйти из пульта','logout','','ghost wide')}<p class="sidebar-note">Два интерактива · до 80 участников.<br>Изменения сохраняются автоматически.</p></div></aside>
  <main class="admin-main"><header class="admin-header"><div><h1>Пульт ведущего</h1><p data-copy-skip>${esc(s.title)}</p></div><div class="row">${demoTag()}<span class="tag">${phaseLabel()}</span><a class="btn small desktop-link" href="/screen" target="_blank" rel="noopener">Открыть проектор</a></div></header>
  <div class="host-layout"><section class="host-preview"><div class="panel preview-panel"><div class="panel-title"><span>Сейчас на проекторе</span><span class="muted">Точное превью</span></div><div class="slide-preview" id="slide-preview"><iframe id="projector-preview" title="Точный экран проектора" sandbox="allow-same-origin" tabindex="-1"></iframe></div><div class="phase-strip"><div class="phase-steps"><span class="${s.phase==='intro'?'active':''}">Вступление</span><span class="${s.phase==='running'?'active':''}">Ответы</span><span class="${s.phase==='reveal'?'active':''}">Разбор</span></div><span class="muted">${esc(m?.minutes||'Без таймера')}</span></div></div><a class="btn wide mobile-projector" href="/screen" target="_blank" rel="noopener">Открыть экран аудитории</a></section>
  <section class="host-controls stack"><div class="panel"><div class="panel-title" ${m?'data-copy-skip':''}>${esc(m?.title||({lobby:'Сбор аудитории',finish:'Обсуждение'}[scene]))}</div><div class="control-buttons">${button(s.phase==='running'?'Сцена запущена':s.demo?'Запустить ботов':'Начать эксперимент','start','','primary wide',!isModule||s.phase==='running')}<div class="two">${button(s.paused?'Продолжить':'Пауза','pause','','',s.phase!=='running')}${button('Следующая сцена','next','','',scene==='finish')}</div>${button('Раскрыть результаты','reveal','','dark wide',!isModule||s.phase==='reveal')}
  ${scene==='house'?button('Симуляция · 100 000 бросков','simulate_house','','wide'):''}${scene==='house'&&s.phase==='reveal'&&s.house_sim?`<div class="house-source-controls"><span>На слайде</span>${button(s.demo?'Результаты ботов':'Результаты аудитории','house_view','data-view="audience"',s.house_view!=='simulation'?'primary wide small':'wide small',s.house_view!=='simulation')}${button('Симуляция · 100 000','house_view','data-view="simulation"',s.house_view==='simulation'?'primary wide small':'wide small',s.house_view==='simulation')}</div>`:''}</div>
  <div class="host-note">${isModule?`<strong>Подсказка ведущему</strong><br><span data-copy-skip>${esc(s.config.modules[scene].note)}</span>`:'Выберите эксперимент вверху. Участники увидят его на своих телефонах.'}</div></div>
  <div class="panel"><div class="panel-title"><span>${s.demo?'Виртуальная аудитория':'Аудитория'}</span><span class="muted">${s.demo?'20 ботов':s.online+' онлайн'}</span></div><div class="progress-meta"><b>${isModule?progress:s.count}<span>${isModule?' / '+s.count:''}</span></b><span>${isModule?'завершили сцену':'участников в комнате'}</span></div><div class="progress-track"><i style="width:${s.count?100*(isModule?progress:s.count)/s.count:0}%"></i></div><div class="audience-chips">${s.people.filter(p=>p.demo===s.demo).slice(0,25).map(p=>`<span>${esc(p.name)}</span>`).join('')||'<span>Пока никого нет</span>'}</div>${s.demo?`<div class="divider"></div>${demoControls()}`:'<p class="host-fallback-hint">Резерв с ботами доступен во вкладке «Ещё».</p>'}</div></section>
  <section class="host-tools"><div class="panel text-editor-entry"><div class="panel-title">Надписи на всех экранах</div><p class="panel-description">Тексты, кнопки и подсказки. Изменения можно проверить до публикации.</p>${button('Редактор надписей','edit-texts','','primary wide')}</div><div class="panel"><div class="panel-title">Подключение аудитории</div><img class="qr-mini" src="/api/qr?v=${encodeURIComponent(s.public_url)}" alt="QR-код подключения"><p class="panel-description">Ссылка для телефона</p><div class="join-address">${esc(joinURL())}</div><div class="row">${button('Скопировать ссылку','copy-link','','small')}${button('Настройки','settings','','small')}</div>${!s.public_url&&['localhost','127.0.0.1'].includes(location.hostname)?'<p class="panel-description">Для телефонов укажите в настройках публичный адрес или IP ноутбука.</p>':''}</div>
  <div class="panel">${!s.demo?demoControls():'<div class="panel-title">Демонстрация включена</div><p class="panel-description">Темп и возврат к аудитории — на вкладке «Управление».</p>'}<div class="divider"></div><div class="panel-title">Программа и резерв</div><p class="panel-description">Скачайте программу и загрузите в локальную копию до выступления.</p><div class="row">${button('Скачать программу','download-program','','small')}${button('Загрузить программу','import-program','','small')}</div></div>
  <div class="panel"><div class="panel-title">Сервисные действия</div><div class="stack"><a class="btn" href="/api/admin/export" download>Скачать результаты</a>${button('Повторить эту сцену','confirm-reset-module','','',!isModule)}${button('Новая сессия','confirm-reset-session','','ghost')}${button('Выйти из пульта','logout','','ghost')}</div></div><div class="panel"><div class="panel-title">Последние действия</div><ul class="log">${s.events.slice(0,5).map(e=>`<li><time>${esc(e.at)}</time><span>${esc(e.text)}</span></li>`).join('')||'<li>Комната готова к выступлению.</li>'}</ul></div></section></div></main>
  <nav class="host-tabs" aria-label="Разделы пульта">${[['controls','Управление'],['preview','Экран'],['tools','Ещё']].map(([id,label])=>`<button data-action="host-tab" data-tab="${id}" aria-pressed="${hostTab===id}" class="${hostTab===id?'active':''}">${label}</button>`).join('')}</nav></div>`;
  return markup;
}

function renderAdmin(){document.title=Copy.text('Пульт ведущего')+' — '+Copy.text('Психология игры');Experience.mount(app,adminMarkup());updateProjectorPreview();}

function updateProjectorPreview() {
  const holder = document.getElementById('slide-preview');
  const frame = document.getElementById('projector-preview');
  const slide = screenMarkup();
  if (frame._slideMarkup !== slide || frame._textGeneration !== Copy.generation) {
    frame._textGeneration = Copy.generation;
    frame._slideMarkup = slide;
    // Same renderer and stylesheet as /screen, isolated at a real 1280×720 viewport.
    // No scripts, independent state, socket or admin-only data inside this frame.
    if (frame.contentDocument?.querySelector('.screen-shell')) { Experience.mount(frame.contentDocument.body,slide); }
    else frame.srcdoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><base href="${esc(location.origin)}/"><link rel="stylesheet" href="/static/style.css?v=0.4.0"></head><body>${Copy.html(slide)}</body></html>`;
  }
  if (observedPreview !== holder) {
    previewObserver?.disconnect();
    observedPreview = holder;
    const resize = () => { frame.style.transform = `scale(${holder.clientWidth / 1280})`; };
    previewObserver = new ResizeObserver(resize);
    previewObserver.observe(holder);
    resize();
  }
}

function meter(label, value, max, note = '', alt = false) {
  return `<div class="compare-row ${alt?'alt':''}"><div class="label-row"><span>${esc(label)}</span><strong>${num(value,2)}</strong></div><div class="bar-track"><span style="width:${value==null?0:Math.max(0,Math.min(100,value/max*100))}%"></span></div>${note?`<span class="bar-note">${esc(note)}</span>`:''}</div>`;
}
function metric(label,value,suffix='') {return `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div><div class="suffix">${suffix}</div></div>`;}

function houseChart(sim) {
  if (!sim) return '';
  const points=sim.points, min=Math.min(0,...points.map(p=>p.y)), max=Math.max(sim.expected,...points.map(p=>p.y),1), height=180;
  const x = v=>55+v/sim.rounds*580, y=v=>20+height-(v-min)/(max-min)*height;
  const path=points.map((p,i)=>`${i?'L':'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 660 244" role="img" aria-label="Симуляция: накопленный результат казино по числу раундов. Итог ${num(sim.net)} очков, ожидание ${num(sim.expected)}."><line class="axis" x1="55" x2="635" y1="${y(0)}" y2="${y(0)}"/><path class="expect" fill="none" d="M${x(0)},${y(0)} L${x(sim.rounds)},${y(sim.expected)}"/><path class="plot" d="${path}"/><text x="44" y="${y(0)+4}" text-anchor="end">0</text><text x="44" y="28" text-anchor="end">${num(max/1000,1)}k</text><text x="55" y="226">0</text><text x="635" y="226" text-anchor="end">${num(sim.rounds)} раундов</text><text x="55" y="12">Очки казино</text></svg><div class="chart-caption"><span>Одна случайная симуляция</span><span>Математическое ожидание</span></div>`;
}

function resultsContent(mobile=false) {
  const s=state, stats=s.stats;
  if (!stats) return '';
  if (s.scene==='house') {
    const sim=s.house_view==='simulation'?s.house_sim:null;
    const h=sim?{turnover:sim.turnover,payout:sim.turnover-sim.net,house_net:sim.net}:stats.house;
    return `<p class="result-source" data-testid="house-source">${sim?`Симуляция · ${num(sim.rounds)} раундов · отдельно от аудитории`:`Результаты ${s.demo?'демо-аудитории':'аудитории'} · ${num(stats.house.rounds)} раундов`}</p><div class="metric-grid" data-testid="house-metrics">${metric('Оборот ставок',num(h.turnover),'условных очков')}${metric('Вернулось игрокам',num(h.payout),'включая ставки')}${metric('Результат казино',signed(h.house_net),sim?'за 100 000 раундов':'за эту сессию')}</div><div class="${mobile?'stack':'screen-result-cols'}"><div class="stack"><p class="${mobile?'muted':'screen-rule'}">Ставка 10. При успехе возвращается 19: чистый результат +9. При неудаче: −10.</p><div class="equation">½ × 9 + ½ × (−10) = <b>−0,5</b></div><p class="${mobile?'muted':'screen-rule'}">В среднем игрок теряет 5% оборота. Короткая сессия может закончиться иначе.</p></div>${sim?`<div>${houseChart(sim)}<p class="muted" style="margin-top:12px;font-size:.9rem">${num(sim.rounds)} раундов · итог казино ${signed(sim.net)} · ожидание +${num(sim.expected)}</p></div>`:`<div class="screen-visual"><div class="giant">95%</div><p class="screen-rule">Средняя отдача от оборота ставок.<br>Не обещание вернуть 95% депозита.</p></div>`}</div>`;
  }
  if (s.scene==='near') {
    const n=stats.near;
    return `<div class="${mobile?'stack':'screen-result-cols'}"><div>${meter('Обычный проигрыш',n.miss,10,'Желание попробовать ещё раз, от 0 до 10')}${meter('«Почти выигрыш»',n.near,10,'Желание попробовать ещё раз, от 0 до 10',true)}</div><div class="stack"><div class="screen-visual"><div class="giant">0 = 0</div><p class="screen-rule">Выплата в обоих случаях — ноль.<br>Близость символов не меняет следующий независимый исход.</p></div><p class="muted">${n.n} полных пар оценок. Каждый видел оба исхода; порядок чередовался. Мы сравниваем впечатления, а не диагностируем зависимость.</p></div></div>`;
  }
  return '';
}

function demoControls() {
  if (!state.demo) return `<div class="fallback-card"><strong>Если телефоны или сеть подведут</strong><p>Продолжите выступление с виртуальной аудиторией. Ответы участников сохранятся.</p>${button('Перейти к демонстрации','demo','','wide')}</div>`;
  const board = state.demo_board, complete = board.done === board.total;
  return `<div class="fallback-card"><strong>${complete?'Боты завершили сцену':'Виртуальная аудитория'}</strong><p>Темп показа</p><div class="demo-speed" role="group" aria-label="Скорость ботов">${[1,2,4].map(n=>button(`×${n}`,'demo_speed',`data-speed="${n}"`,board.speed===n?'primary small':'small',board.speed===n)).join('')}</div>${state.modules[state.scene]?button('Завершить действия ботов','demo_finish','','small wide',state.phase==='reveal'||complete):''}<p>Оценки восприятия придуманы для примера. Они не показывают реакцию реальных людей.</p>${button('Вернуться к аудитории','clear_demo','','wide small')}</div>`;
}

function screenMarkup(preview=false) {
  const s=state, m=s.modules[s.scene], progress=s.progress[s.scene]||0;
  let content;
  if (s.scene==='lobby') content=`<div class="screen-lobby"><div class="left"><div class="eyebrow">Интерактивная лаборатория</div><h1 data-copy-skip>${displayTitle(s.title)}</h1><p class="screen-subtitle">Сегодня исследуем, как устроена игра<br>и почему её результат ощущается по-разному.</p><div class="screen-big-count">${s.count}<span>${s.demo?'демо-участников':'участников подключилось'}</span></div></div><div class="${s.demo?'demo-lobby-card':'qr-block'}">${s.demo?'<span class="demo-symbol">20</span><h2>Виртуальная аудитория</h2><p>Наблюдайте за ходом игры.<br>Обсуждайте и делайте прогнозы вслух.</p><small>Примеры ответов вымышлены</small>':`<img src="/api/qr?v=${encodeURIComponent(s.public_url)}" alt="Отсканируйте QR-код для подключения"><strong>Ваш телефон — часть эксперимента</strong><small>${esc(joinURL())}</small>`}</div></div>`;
  else if (s.scene==='finish') content=`<div class="screen-heading"><span class="eyebrow">Время обсудить</span><h1>Что изменилось,<br>когда мы увидели<br><span style="color:var(--lime)">всю картину?</span></h1><p class="screen-subtitle">Где заканчивается случайность и начинается дизайн?<br>Как ощущения соотносятся с реальным результатом?</p></div><div class="takeaway">Эти эксперименты показывают отдельные механизмы. Они не объясняют всю зависимость и не являются диагностикой.</div>`;
  else if (s.phase==='reveal') content=`<div class="screen-heading"><span class="eyebrow">Разбор эксперимента</span><h1 class="result-heading" data-copy-skip>${esc(m.title)}</h1></div>${resultsContent()}<div class="takeaway" data-copy-skip>${esc(m.takeaway)}</div>`;
  else content=Experience.audience(s,preview?null:()=>render(true),preview);
  return `<main class="screen-shell" data-scene="${esc(s.scene)}" data-phase="${esc(s.phase)}" data-house-view="${esc(s.house_view||'audience')}"><header class="screen-top">${brand()}<div class="row">${demoTag()}<span class="muted">${s.demo?'Участие с телефонов приостановлено':s.online+' онлайн'}</span>${button('На весь экран','fullscreen','','ghost')}</div></header><div class="screen-content">${content}</div><footer class="screen-bottom"><span data-copy-skip>${esc(s.title)}</span><span>${s.demo?'Учебная модель · оценки ботов вымышлены':'Только условные очки · можно просто наблюдать'}</span></footer></main>`;
}

function renderScreen() {
  document.title=Copy.text('Экран аудитории')+' — '+Copy.text('Психология игры');
  Experience.mount(app,screenMarkup());
}

function waiting(title, text, symbol='◎') { return `<div class="player-card waiting"><div class="waiting-symbol">${symbol}</div><h2>${title}</h2><p>${text}</p></div>`; }
function playerMarkup(preview=false) {
  const s=state, p=s.me, m=s.modules[s.scene];

  let content;
  if (!p) content=`<div class="player-heading"><span class="eyebrow">Рады видеть вас</span><h1>Всё начинается<br>с вашего выбора.</h1><p>Подключитесь к комнате. Ведущий будет переключать эксперименты, а вы — участвовать с телефона.</p></div><div class="player-card"><form id="join-form" class="stack"><label class="form-field"><span>Как к вам обращаться?</span><input name="name" maxlength="28" autocomplete="off" placeholder="Имя или псевдоним"></label><button class="btn primary wide" type="submit">Присоединиться</button><p class="muted" style="font-size:.82rem">Можно оставить поле пустым. Личные истории и контакты не нужны.</p></form></div>`;
  else if (s.scene==='finish') content=`<div class="player-heading"><span class="eyebrow">Эксперименты завершены</span><h1>Спасибо за<br>ваш взгляд.</h1><p>Теперь обсудим то, что произошло.</p></div>${waiting('Что удивило больше всего?','Подумайте, совпало ли первое впечатление с результатами.','✓')}`;
  else if (s.scene==='lobby') content=`<div class="player-heading"><span class="eyebrow">Вы в комнате</span><h1 data-copy-skip>${esc(s.title)}</h1><p>Можно участвовать во всех экспериментах или просто наблюдать.</p></div>${waiting('Скоро начнём','Экран обновится сам, когда ведущий запустит первый эксперимент.')}`;
  else {
    content=`<div class="player-heading"><span class="eyebrow">${s.phase==='reveal'?'Разбор эксперимента':'Эксперимент'}</span><h1 data-copy-skip>${esc(m.title)}</h1><p data-copy-skip>${esc(m.subtitle)}</p></div>`;
    if (s.phase==='reveal') content+=`<div class="player-card">${resultsContent(true)}<div class="takeaway" data-copy-skip>${esc(m.takeaway)}</div></div>`;
    else if (s.demo) content+=waiting('Наблюдаем вместе','Сейчас на проекторе демонстрация с ботами. Ваши ответы сохранены; можно обсуждать результаты вслух.');
    else if (s.paused) content+=waiting('Небольшая пауза','Ваши ответы сохранены. Послушайте ведущего — скоро продолжим.','Ⅱ');
    else if (s.phase==='intro') content+=waiting('Послушайте ведущего','Кнопки появятся, когда откроется приём ответов.');
    else if (s.scene==='house') content+=housePlayer(p,preview);
    else if (s.scene==='near') content+=nearPlayer(p,preview);
  }
  return `<main class="player-shell"><header class="player-header">${brand()}<span class="player-name">${p?esc(p.name):'Участник'}</span></header>${demoTag()}<div class="player-main">${content}</div><footer class="player-footer">Учебная демонстрация · только условные очки<br>Вы можете пропустить любой эксперимент</footer></main>`;
}

function renderPlayer(){document.title=Copy.text('Участник')+' — '+Copy.text('Психология игры');Experience.mount(app,playerMarkup());}

function housePlayer(p,preview=false) {
  const count=p.house.length, max=state.house_rounds, last=p.house.at(-1), motion=preview?null:Experience.playerMotion(state,()=>render(true)), spinning=!!motion, complete=count>=max&&!spinning;
  const balance=spinning?p.balance-(last.payout-10):p.balance;
  return `<div class="player-card coin-card"><div class="balance-row"><div><small>Ваш баланс</small><br><strong>${num(balance)}</strong> <small>очков</small></div><span class="tag">${count} / ${max}</span></div><div class="coin-arena">${Experience.coin(last?.outcome||'heads',last?.id||'idle',spinning,motion?.elapsed||0)}<div class="coin-status" aria-live="polite"><strong>${spinning?'Монетка в воздухе…':last?(last.outcome==='heads'?'Орёл':'Решка'):'Ваш следующий бросок'}</strong><span>${spinning?'Каждый бросок независим':last?`Результат ${last.payout?'+9':'−10'} очков`:'Выберите сторону ниже'}</span></div></div><div class="mini-rounds">${Array.from({length:max},(_,i)=>`<i class="${i<count-(spinning?1:0)?'done':''}"></i>`).join('')}</div>${complete?'<div class="game-complete"><h2>Все броски сыграны</h2><p>Сравним личное впечатление с общей картиной.</p></div>':`<div class="choice-grid"><button class="coin-choice" data-action="play" data-choice="heads" ${spinning?'disabled':''}><span class="choice-letter">О</span>Орёл</button><button class="coin-choice" data-action="play" data-choice="tails" ${spinning?'disabled':''}><span class="choice-letter">Р</span>Решка</button></div>`}<p class="game-rule">Ставка 10 · возврат при успехе 19 вместе со ставкой. При неудаче — 0.</p></div>`;
}

function nearPlayer(p,preview=false) {
  const remaining=p.near_order.filter(k=>!(k in p.near));
  if(!remaining.length)return waiting('Обе оценки приняты','Послушаем другие впечатления и сравним результаты.','✓');
  const kind=remaining[0], event=p.near_spins[kind], motion=preview?null:Experience.playerMotion(state,()=>render(true)), spinning=!!motion;
  return `<div class="player-card near-card"><div class="row between"><span class="muted">Ставка: 10 очков</span><span class="tag">Исход ${3-remaining.length} из 2</span></div>${Experience.reels(event?kind:null,event?.id||kind+'-idle',spinning,motion?.elapsed||0)}${!event?`<p class="game-rule">Посмотрите, где остановятся символы. После этого оцените своё впечатление.</p>${button('Запустить барабаны','near_spin',`data-kind="${kind}"`,'primary wide')}`:spinning?'<div class="spin-status" aria-live="polite"><strong>Барабаны останавливаются…</strong><p>Сначала посмотрите на результат</p></div>':`<div class="slot-result"><span>Выплата <b>0</b></span><span>Итог <b>−10</b></span></div><p class="rating-label">Насколько хочется попробовать ещё раз?</p><div class="rating-grid" role="group" aria-label="Оценка от нуля до десяти">${Array.from({length:11},(_,i)=>`<button type="button" class="${selectedRating===i?'selected':''}" aria-pressed="${selectedRating===i}" data-action="rating" data-rating="${i}">${i}</button>`).join('')}</div><div class="rating-ends"><span>0 — совсем не хочется</span><span>10 — очень хочется</span></div>${button('Отправить оценку','near_answer',`data-kind="${kind}"`,'primary wide',selectedRating===null)}`}</div>`;
}

function openSettings() {
  configDraft=JSON.parse(JSON.stringify(state.config));
  drawSettings();
}
function drawSettings() {
  const c=configDraft;
  modal.innerHTML=Copy.html(`<div class="settings-overlay"><section class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header class="settings-header row between"><h2 id="settings-title">Настройки выступления</h2>${button('Закрыть','close-modal','','small ghost')}</header><form id="settings-form"><label class="form-field"><span>Название</span><input data-config="title" value="${esc(c.title)}" maxlength="90" required></label><label class="form-field"><span>Адрес для телефонов и QR-кода</span><input data-config="public_url" type="url" value="${esc(c.public_url)}" placeholder="https://example.ngrok-free.app"></label><p class="hint">Укажите базовый адрес без /play. Для Wi-Fi подойдёт http://192.168.1.10:8000. Без настройки QR ведёт на адрес, с которого открыт проектор.</p><label class="form-field"><span>Раундов в эксперименте с монеткой</span><input data-config="house_rounds" type="number" min="4" max="20" value="${c.house_rounds}" required></label><div><h3>Состав и порядок программы</h3><p class="hint" style="margin:8px 0">Отключённый модуль исчезнет из последовательности. Порядок можно поменять.</p>${[...c.enabled,...Object.keys(c.modules).filter(k=>!c.enabled.includes(k))].map(id=>`<div class="check-row"><label><input type="checkbox" data-enabled="${id}" ${c.enabled.includes(id)?'checked':''}>${esc(c.modules[id].title)}</label><div class="row" style="gap:3px">${button('Выше','move-module',`data-module="${id}" data-direction="-1"`,'small ghost',c.enabled.indexOf(id)<=0)}${button('Ниже','move-module',`data-module="${id}" data-direction="1"`,'small ghost',!c.enabled.includes(id)||c.enabled.indexOf(id)===c.enabled.length-1)}</div></div>`).join('')}</div><h3>Тексты и заметки</h3>${Object.entries(c.modules).map(([id,m])=>`<details class="settings-module"><summary>${esc(m.title)}</summary><div class="stack"><label class="form-field"><span>Заголовок</span><input data-module-field="${id}.title" value="${esc(m.title)}" maxlength="80" required></label><label class="form-field"><span>Подзаголовок</span><textarea data-module-field="${id}.subtitle" maxlength="180" required>${esc(m.subtitle)}</textarea></label><label class="form-field"><span>Итоговый тезис</span><textarea data-module-field="${id}.takeaway" maxlength="240" required>${esc(m.takeaway)}</textarea></label><label class="form-field"><span>Заметка ведущему (аудитория её не видит)</span><textarea data-module-field="${id}.note" maxlength="1200" required>${esc(m.note)}</textarea></label></div></details>`).join('')}<p class="hint">Изменения текстов применятся сразу после сохранения. Настройки управляют содержанием; ошибки в коде исправляются в файлах проекта.</p><div class="settings-actions">${button('Отмена','close-modal','','')}<button class="btn primary" type="submit">Сохранить изменения</button></div></form></section></div>`);
}
function confirmDialog(title,text,action) {
  confirmAction=action;
  modal.innerHTML=Copy.html(`<div class="confirm-wrap"><section class="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">${title}</h2><p>${text}</p><div class="row">${button('Отмена','close-modal','','')}${button('Подтвердить','confirm-action','','danger')}</div></section></div>`);
}

document.addEventListener('input',event=>{
  const el=event.target;
  if (!configDraft) return;
  if (el.dataset.config) configDraft[el.dataset.config]=el.dataset.config==='house_rounds'?Number(el.value):el.value;
  if (el.dataset.moduleField) {const [id,key]=el.dataset.moduleField.split('.'); configDraft.modules[id][key]=el.value;}
});
document.addEventListener('change',async event=>{
  if(event.target.id==='program-file'){
    const file=event.target.files[0]; if(!file||pending)return;
    try {
      if(file.size>200000)throw new Error('Файл программы слишком большой.');
      const saved=JSON.parse(await file.text());
      if(saved.format!=='ludiki-program-v1'||!saved.config)throw new Error('Выберите файл «Скачать программу» из пульта ведущего.');
      await command('config',{config:saved.config});
    } catch(err){toast(err.message);}
    return;
  }
  const id=event.target.dataset.enabled;
  if (!id || !configDraft) return;
  if (event.target.checked) {if(!configDraft.enabled.includes(id)) configDraft.enabled.push(id);}
  else configDraft.enabled=configDraft.enabled.filter(x=>x!==id);
  drawSettings();
});
document.addEventListener('keydown',event=>{
  if(TextEditor.active)return;
  if(event.key==='Escape' && modal.innerHTML) {modal.innerHTML='';configDraft=null;confirmAction=null;}
  if(event.key==='Tab' && modal.innerHTML) {
    const elements=[...modal.querySelectorAll('button:not(:disabled),input,select,textarea,summary')].filter(e=>e.getClientRects().length);
    if(event.shiftKey && document.activeElement===elements[0]){event.preventDefault();elements.at(-1)?.focus();}
    else if(!event.shiftKey && document.activeElement===elements.at(-1)){event.preventDefault();elements[0]?.focus();}
  }
});

document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');
  if(!el || el.disabled) return;
  const a=el.dataset.action;
  if(a==='host-tab'){hostTab=el.dataset.tab;render(true);return;}
  if(a==='near_spin'){await command(a,{kind:el.dataset.kind},true);return;}
  if(a==='edit-texts'){configDraft=null;TextEditor.open();return;}
  if(a==='settings'){openSettings();modal.querySelector('button')?.focus();return;}
  if(a==='close-modal'){modal.innerHTML='';configDraft=null;confirmAction=null;return;}
  if(a==='move-module'){
    const i=configDraft.enabled.indexOf(el.dataset.module), j=i+Number(el.dataset.direction);
    if(i>=0&&j>=0&&j<configDraft.enabled.length) [configDraft.enabled[i],configDraft.enabled[j]]=[configDraft.enabled[j],configDraft.enabled[i]];
    drawSettings();return;
  }
  if(a==='confirm-reset-module'){confirmDialog('Начать сцену заново?',state.demo?'Будут сброшены только боты текущей сцены. Реальные ответы сохранятся.':'Ответы только этого модуля будут удалены. Ответы остальных модулей сохранятся.','reset_module');return;}
  if(a==='confirm-reset-session'){confirmDialog('Создать новую сессию?','Будут удалены все ответы и список участников. Тексты и состав программы сохранятся.','reset_session');return;}
  if(a==='confirm-action'){const action=confirmAction;modal.innerHTML='';confirmAction=null;await command(action);return;}
  if(a==='copy-link'){
    try {await navigator.clipboard.writeText(joinURL());toast('Ссылка скопирована');}
    catch {toast('Ссылка для подключения: '+joinURL());}return;
  }
  if(a==='fullscreen'){
    try {document.fullscreenElement?await document.exitFullscreen():await document.documentElement.requestFullscreen();}
    catch {toast('Полный экран недоступен в этом окне. Откройте проектор в обычном браузере.');}return;
  }
  if(a==='logout'){
    try {await api('/api/admin/logout',{});++socketGeneration;socket?.close();loggedIn=false;renderLogin();} catch(err){toast(err.message);}return;
  }
  if(a==='next'){
    const scenes=['lobby',...state.enabled,'finish'];
    await command('scene',{scene:scenes[Math.min(scenes.indexOf(state.scene)+1,scenes.length-1)]});return;
  }
  if(a==='scene'){await command(a,{scene:el.dataset.scene});return;}
  if(a==='house_view'){await command(a,{view:el.dataset.view});return;}
  if(a==='demo_speed'){await command(a,{speed:Number(el.dataset.speed)});return;}
  if(a==='download-program'){
    const url=URL.createObjectURL(new Blob([JSON.stringify({format:'ludiki-program-v1',config:state.config},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='ludiki-program.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(a==='import-program'){document.getElementById('program-file').click();return;}
  if(a==='rating'){selectedRating=Number(el.dataset.rating);render(true);return;}
  if(a==='near_answer'){await command(a,{kind:el.dataset.kind,rating:selectedRating},true);selectedRating=null;render(true);return;}
  if(a==='play'){await command(a,{choice:el.dataset.choice},true);return;}
  await command(a);
});

document.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target;
  if(pending) return;
  if(form.id==='login-form'){
    const submit=form.querySelector('button[type=submit]');submit.disabled=true;
    try {await api('/api/admin/login',{password:new FormData(form).get('password')});loggedIn=true;state=await api('/api/state?role=admin');Copy.set(state.texts);Experience.sync(state);render(true);connect();}
    catch(err){renderLogin(err.message);}return;
  }
  if(form.id==='join-form'){
    form.querySelector('button[type=submit]').disabled=true;
    try {const next=await api('/api/join',{name:new FormData(form).get('name')});document.activeElement?.blur();accept(next);render(true);connect();}
    catch(err){toast(err.message);form.querySelector('button[type=submit]').disabled=false;}return;
  }
  if(form.id==='settings-form'){
    const submit=form.querySelector('button[type=submit]');submit.disabled=true;
    try {const next=await api('/api/admin/action',{action:'config',expected_version:configDraft.text_version||0,config:configDraft});modal.innerHTML='';configDraft=null;accept(next);toast('Изменения сохранены');}
    catch(err){toast(err.message);submit.disabled=false;}return;
  }
});

async function boot() {
  try {await Copy.load();state=await api(`/api/state?role=${role}`);loggedIn=role==='admin';Copy.set(state.texts);Experience.sync(state);render(true);connect();}
  catch(err){if(err.status===401&&role==='admin'){state=await api('/api/state?role=screen');Copy.set(state.texts);renderLogin();}else{app.innerHTML=Copy.html('<div class="loading">Не удалось подключиться. Проверьте запуск сервера и обновите страницу.</div>');setConnection(err.message);}}
}
boot();
