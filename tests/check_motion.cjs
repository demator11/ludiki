// Exercise lifecycle and server-clock handling without a browser or real delays.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
let clock=0,reduced=false,nextId=0,draws=0;const timers=new Map();
const context={performance:{now:()=>clock},Date,matchMedia:()=>({matches:reduced}),setTimeout:(fn,ms)=>{timers.set(++nextId,{fn,due:clock+ms});return nextId;},clearTimeout:id=>timers.delete(id)};
const experience=vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../static/experience.js'),'utf8')+';Experience',context);
const state={session:'s',epoch:'e',scene:'house',phase:'running',paused:false,demo:false,server_time:100,me:{house:[{id:'coin1',at:100}],near:{},near_order:['miss','near'],near_spins:{}}};
const draw=()=>draws++;
experience.sync(state);const original=experience.playerMotion(state,draw);assert(original);assert.equal(timers.size,1);
clock=500;experience.sync({...state,server_time:100.5});assert.equal(experience.playerMotion(state,draw),original);assert.equal(timers.size,1);
clock=1600;for(const [id,t] of timers)if(t.due<=clock){timers.delete(id);t.fn();}
assert.equal(draws,1);assert.equal(experience.playerMotion(state,draw),null);
state.me.house.push({id:'coin2',at:101.6});state.server_time=101.6;experience.sync(state);assert(experience.playerMotion(state,draw));
state.paused=true;experience.sync(state);assert.equal(timers.size,0);assert.equal(experience.playerMotion(state,draw),null);
state.paused=false;state.scene='near';state.server_time=110;state.me.near_spins.miss={id:'spin1',at:100};experience.sync(state);assert.equal(experience.playerMotion(state,draw),null,'Reload does not replay an old spin');
state.me.near_spins.miss={id:'spin2',at:110};experience.sync(state);assert.equal(experience.playerMotion(state,draw).duration,2400);
state.epoch='new';experience.sync(state);assert.equal(timers.size,0);
reduced=true;assert.equal(experience.playerMotion(state,draw),null,'Reduced motion shows the result immediately');
console.log('Motion lifecycle: unrelated updates, completion, pause, reload, scene change and reduced motion passed.');
