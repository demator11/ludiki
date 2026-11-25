'use strict';
const Experience = (() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let serverTime=0, receivedAt=0, motion=null, timer=null, context='', completed=new Set();
  let displayEvent=null, displayUntil=0, displayTimer=null;
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function sync(s) {
    serverTime=s.server_time||Date.now()/1000; receivedAt=performance.now();
    const next=[s.session,s.epoch,s.scene,s.phase,s.paused,s.demo].join(':');
    if(next!==context){clearTimeout(timer);clearTimeout(displayTimer);displayEvent=null;displayUntil=0;motion=null;completed.clear();context=next;}
  }
  const now=()=>serverTime+(performance.now()-receivedAt)/1000;
  function playerMotion(s, redraw) {
    if(!s.me||s.demo||s.phase!=='running'||s.paused)return null;
    const kind=s.me.near_order?.find(k=>!(k in s.me.near));
    const event=s.scene==='house'?s.me.house.at(-1):s.me.near_spins?.[kind];
    if(!event?.id)return null;
    if(motion?.id===event.id)return motion;
    if(completed.has(event.id))return null;
    completed.add(event.id);
    const duration=s.scene==='house'?1500:2400, elapsed=Math.max(0,(now()-event.at)*1000);
    if(elapsed>=duration||reduced())return null;
    clearTimeout(timer);
    motion={id:event.id,elapsed,duration,type:s.scene};
    timer=setTimeout(()=>{motion=null;redraw();},duration-elapsed);
    return motion;
  }
  function copyText(old,fresh){
    if(old.nodeType===3&&fresh.nodeType===3){old.data=fresh.data;return;}
    if(old.nodeType!==1||fresh.nodeType!==1)return;
    for(const key of ['aria-label','title','alt','data-copy-generation'])if(fresh.hasAttribute(key))old.setAttribute(key,fresh.getAttribute(key));
    for(let i=0;i<fresh.childNodes.length;i++)if(old.childNodes[i])copyText(old.childNodes[i],fresh.childNodes[i]);
  }
  // Update in place so another participant's message never restarts a local animation.
  function patch(old, fresh) {
    if(old.nodeType!==fresh.nodeType||old.nodeName!==fresh.nodeName){old.replaceWith(fresh);return;}
    if(old.nodeType===3){if(old.data!==fresh.data)old.data=fresh.data;return;}
    if(old.nodeType!==1)return;
    if(old.id==='projector-preview'&&fresh.id===old.id)return;
    if(old.dataset.motionKey||fresh.dataset.motionKey){
      if(old.dataset.motionKey===fresh.dataset.motionKey){if(old.dataset.copyGeneration!==fresh.dataset.copyGeneration)copyText(old,fresh);return;}
      old.replaceWith(fresh);return;
    }
    for(const attr of [...old.attributes])if(!fresh.hasAttribute(attr.name))old.removeAttribute(attr.name);
    for(const attr of fresh.attributes)if(old.getAttribute(attr.name)!==attr.value)old.setAttribute(attr.name,attr.value);
    const children=[...fresh.childNodes];
    for(let i=0;i<children.length;i++)old.childNodes[i]?patch(old.childNodes[i],children[i]):old.append(children[i]);
    while(old.childNodes.length>children.length)old.lastChild.remove();
  }
  function mount(root, html) {
    const temp=root.ownerDocument.createElement('template'); temp.innerHTML=Copy.html(html);
    const children=[...temp.content.childNodes];
    for(let i=0;i<children.length;i++)root.childNodes[i]?patch(root.childNodes[i],children[i]):root.append(children[i]);
    while(root.childNodes.length>children.length)root.lastChild.remove();
  }
  function coin(outcome='heads', key='idle', spinning=false, elapsed=0) {
    const side=outcome==='tails'?180:0;
    return `<div class="coin-stage ${spinning?'is-tossing':'is-landed'}" data-copy-generation="${Copy.generation}" data-motion-key="coin-${escape(key)}-${spinning}" style="--side:${side}deg;--turn:${1440+side}deg;--elapsed:-${Math.max(0,elapsed)}ms"><div class="coin-halo"></div><div class="coin-shadow"></div><div class="coin-flight"><div class="coin-object"><div class="coin-face coin-front"><i></i><b>О</b><span>ОРЁЛ</span></div><div class="coin-face coin-back"><i></i><b>Р</b><span>РЕШКА</span></div></div></div></div>`;
  }
  function reels(kind, key='idle', spinning=false, elapsed=0) {
    const opened=!!kind;
    return `<div class="slot-machine ${spinning?'is-spinning':''} ${opened?'is-open':'is-idle'}" data-copy-generation="${Copy.generation}" data-motion-key="reels-${escape(key)}-${spinning}" style="--elapsed:-${Math.max(0,elapsed)}ms" role="img" aria-label="${spinning?'Барабаны вращаются':!opened?'Барабаны готовы к запуску':kind==='near'?'Две семёрки на линии, третья выше линии. Выплата ноль.':'Разные символы на линии. Выплата ноль.'}"><div class="slot-lights"><i></i><i></i><i></i></div><div class="slot-windows">${[0,1,2].map(i=>{
      const symbols=['◇','7','○','7','◇','○','7','◇','7','○','◇'];
      if(kind==='miss'&&i===1)symbols[8]='◇'; if(kind==='miss'&&i===2)symbols[8]='○';
      const stop=kind==='near'&&i===2?8.45:8;
      return `<div class="slot-window" style="--stop:${stop};--duration:${1250+i*400}ms;--stagger:${i*80}ms">${opened?`<div class="slot-strip">${symbols.map(x=>`<span>${x}</span>`).join('')}</div>`:'<span class="slot-question">?</span>'}</div>`;
    }).join('')}<div class="slot-payline"><i></i><i></i></div></div><div class="slot-base"><span>ЛИНИЯ ВЫПЛАТЫ</span><span>${opened&&!spinning?'0 очков':'2 исхода'}</span></div></div>`;
  }
  function audience(s, redraw, preview=false) {
    const demo=s.demo, source=demo?s.demo_board:s.live_board;
    const seats=demo?source.bots.map((p,i)=>({id:`bot-${i}`,label:String(i+1).padStart(2,'0'),...p})):source.seats;
    const shown=seats.slice(0,40), total=source.total, done=source.done;
    let event=source.recent[0];
    // Let the featured action land even when a whole room responds at once.
    if(!preview&&(s.scene==='house'||demo)){
      const candidate=s.scene==='house'?source.recent.find(e=>e.outcome):event;
      const duration=s.scene==='house'?1.5:2.4;
      if(!displayEvent||now()>=displayUntil){
        displayEvent=candidate; displayUntil=(candidate?.at||0)+duration;
        clearTimeout(displayTimer);
        if(redraw&&displayUntil>now())displayTimer=setTimeout(redraw,(displayUntil-now())*1000+20);
      }
      event=displayEvent;
    }
    const pulse=event?.id||'idle';
    let visual;
    if(s.scene==='house'){
      const coinEvent=event;
      const elapsed=coinEvent?Math.max(0,(now()-coinEvent.at)*1000):2000;
      const animate=s.phase==='running'&&!s.paused&&coinEvent&&elapsed<1500;
      visual=`<div class="room-spotlight house-spotlight">${coin(coinEvent?.outcome||'heads',coinEvent?.id||'room-idle',animate,elapsed)}<div class="room-outcome"><span>${coinEvent?(demo?escape(coinEvent.name):'Участник '+escape(coinEvent.seat)):'Выберите свою сторону'}</span><strong>${coinEvent?(coinEvent.outcome==='heads'?'Орёл':'Решка'):'50 / 50'}</strong><p>Ставка 10 · успех +9 · неудача −10</p></div></div>`;
    } else if(demo){
      visual=`<div class="room-spotlight">${reels(event?.kind||null,event?.id||'demo-idle',!!event&&!s.paused&&s.phase==='running'&&(now()-event.at)<2.4,event?Math.max(0,(now()-event.at)*1000):0)}<div class="room-outcome"><span>Два подготовленных исхода</span><strong>Одинаковая выплата: 0</strong><p>Оценки ботов — вымышленные примеры.</p></div></div>`;
    } else {
      const first=source.first, second=source.second, count=seats.length||1;
      visual=`<div class="room-spotlight near-spotlight"><div class="response-orbits" data-copy-generation="${Copy.generation}" data-motion-key="pulse-${escape(pulse)}-${first}-${second}-${count}"><div class="response-ring" style="--progress:${100*first/count}%"><div><b>${first}</b><span>первый исход</span></div></div><div class="response-ring second" style="--progress:${100*second/count}%"><div><b>${second}</b><span>второй исход</span></div></div><i class="response-ripple"></i></div><div class="room-outcome"><span>Сейчас важно ваше впечатление</span><strong>Как ощущается результат?</strong><p>Оценки откроем вместе после двух исходов.</p></div></div>`;
    }
    const status=s.paused?'Пауза':s.phase==='intro'?'Перед началом':total&&done===total?'Можно переходить к разбору':demo?'Демонстрация':'Аудитория в игре';
    const instructions=demo?(s.scene==='house'?'Наблюдайте за бросками. Каким будет общий результат?':'Сравните два исхода и обсудите своё впечатление вслух.'):(s.scene==='house'?`На телефоне выберите орла или решку. Всего ${s.house_rounds} бросков.`:'Запустите барабаны на телефоне, затем оцените своё впечатление.');
    return `<section class="room-stage"><div class="room-heading"><div><span class="eyebrow">${status}</span><h1 data-copy-skip>${escape(s.modules[s.scene].title)}</h1></div><div class="room-count"><b>${done}</b><span>из ${total} ${s.scene==='house'?'бросков':'оценок'}</span></div></div><div class="room-layout">${visual}<div class="room-audience"><div class="row between"><strong>${demo?'Виртуальная аудитория':'Играем вместе'}</strong><span>${seats.length} ${demo?'ботов':'участников'}</span></div><div class="seat-grid ${shown.length>25?'dense':''}">${shown.length?shown.map(p=>`<div class="seat ${p.step===p.total?'done':p.step||p.viewing?'active':''}" data-seat="${escape(p.id)}"><b>${escape(p.label)}</b><span>${p.step===p.total?'Готово':p.viewing?'Смотрит':`${p.step} / ${p.total}`}</span><i style="width:${100*p.step/p.total}%"></i></div>`).join(''):'<div class="empty-audience">Участники появятся здесь<br>после подключения по QR-коду.</div>'}</div>${seats.length>40?`<small>И ещё ${seats.length-40} участников · общий счёт учитывает всех</small>`:''}<div class="room-progress"><i style="width:${total?100*done/total:0}%"></i></div><p class="room-instruction">${instructions}</p></div></div><p class="room-caption">${demo?'Учебная демонстрация. Оценки ботов вымышлены.':s.scene==='house'?'Считаем все броски. Общий результат раскроет ведущий.':'На общем экране — только прогресс. Ваши личные оценки не показываются.'}</p></section>`;
  }
  return {sync,playerMotion,mount,coin,reels,audience};
})();
