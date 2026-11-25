'use strict';
const Copy = (()=>{
  let catalog=[],overrides={},exact=new Map(),patterns=[],generation=0;
  const normalize=v=>String(v??'').replace(/\s+/g,' ').trim();
  const regexEscape=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  function init(rows){
    catalog=rows; exact=new Map(); patterns=[];
    for(const row of rows){
      if(!row.tokens.length)exact.set(normalize(row.default),row);
      else{
        const parts=row.default.split(/(\{[a-z_]+\})/);
        patterns.push({row,re:new RegExp('^'+parts.map(p=>/^\{/.test(p)?'(.+?)':regexEscape(p)).join('')+'$')});
      }
    }
    patterns.sort((a,b)=>b.row.default.length-a.row.default.length);
  }
  async function load(){const r=await fetch('/static/text-catalog.json?v=0.4.0');if(!r.ok)throw new Error('Не удалось загрузить надписи. Обновите страницу.');init(await r.json());}
  function set(values){const next=values||{};if(JSON.stringify(next)!==JSON.stringify(overrides))generation++;overrides=next;}
  function match(value){
    const n=normalize(value),row=exact.get(n);
    if(row)return {row,params:{}};
    for(const p of patterns){const m=n.match(p.re);if(m)return {row:p.row,params:Object.fromEntries(p.row.tokens.map((t,i)=>[t,m[i+1]]))};}
    return null;
  }
  function text(value,values=overrides){
    const found=match(value);if(!found||!(found.row.id in values))return String(value??'');
    const v=values[found.row.id].replace(/\{([a-z_]+)\}/g,(_,k)=>found.params[k]??'{'+k+'}');
    const source=String(value),lead=source.match(/^\s*/)[0],tail=source.match(/\s*$/)[0];
    return lead+v+tail;
  }
  function html(markup,values=overrides){
    const temp=document.createElement('template');temp.innerHTML=markup;
    function walk(node){
      if(node.nodeType===3){node.data=text(node.data,values);return;}
      if(node.nodeType!==1&&node.nodeType!==11)return;
      if(node.nodeType===1){
        if(node.matches('script,style,textarea,code,[data-copy-skip],.player-name,.audience-chips,.log,.join-address'))return;
        for(const attr of ['placeholder','aria-label','title','alt'])if(node.hasAttribute(attr))node.setAttribute(attr,text(node.getAttribute(attr),values));
      }
      for(const child of [...node.childNodes])walk(child);
    }
    walk(temp.content);return temp.innerHTML;
  }
  const withTexts=(values,fn)=>{const old=overrides;overrides=values;try{return fn();}finally{overrides=old;}};
  return {load,init,set,match,text,html,withTexts,get catalog(){return catalog;},get generation(){return generation;}};
})();
