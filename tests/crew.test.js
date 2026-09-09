import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game.js';
import { Crew, prepareCrewOrder } from '../src/crew.js';
const json=f=>JSON.parse(readFileSync(new URL(`../${f}.json`,import.meta.url)));
const ships=json('ships').ships,eq=json('equipment'),config=json('scenario');
const create=id=>new Game(ships,eq,structuredClone(config),id);
const commands=g=>Object.fromEntries(['view','order','ping','fire','fireReason','log'].map(k=>[k,g[k].bind(g)]));

test('crew can operate through a public observation and command interface alone',()=>{
 const g=create(),crew=new Crew(eq,config),api=commands(g);assert.equal(crew.step(api),true);assert.equal(g.player.order.speed,4);
 assert.ok(crew.lastDecision.stations.sonar);assert.ok(crew.lastDecision.stations.weapons);assert.ok(crew.lastDecision.stations.engineering);assert.ok(crew.lastDecision.stations.navigation);
});
test('disabled automation does not issue orders, spend ammunition or advance planning',()=>{
 const g=create(),crew=new Crew(eq,config),before=JSON.stringify(g);assert.equal(crew.step(commands(g),false),false);assert.equal(JSON.stringify(g),before);assert.equal(crew.trail.length,0);
});
test('captain decision interval prevents repeated execution in one frame',()=>{
 const g=create(),crew=new Crew(eq,config);crew.step(g);const n=crew.journal.length;for(let i=0;i<100;i++)assert.equal(crew.step(g),false);assert.equal(crew.journal.length,n);
});
test('engineering and navigation enforce speed, depth and heading limits',()=>{
 const g=create(),v=g.view(),plan=prepareCrewOrder(v,{title:'試験',report:{title:'不明',assessment:'観測中'},action:{type:'order',values:{heading:450,speed:100,depth:500}}},eq,config);
 assert.equal(plan.action.values.heading,90);assert.equal(plan.action.values.speed,18);assert.ok(plan.action.values.depth<=g.player.spec.maxDepth);assert.ok(plan.action.values.depth<v.bottom-config.bottom.clearance);
});
test('weapons officer vetoes empty ammunition',()=>{
 const g=create();g.player.ammo.torpedo_533mm=0;const plan=prepareCrewOrder(g.view(),{title:'射撃',report:{title:'不明',assessment:'観測中'},action:{type:'fire',weapon:'torpedo_533mm',depth:0}},eq,config);assert.equal(plan.action,null);assert.match(plan.veto,/保留/);
});
test('active threat triggers combined countermeasure and maneuver commands',()=>{
 const g=create(),crew=new Crew(eq,config);g.warnings=[{bearing:40,distance:1000}];crew.step(g);assert.equal(crew.lastDecision.phase,'緊急回避');assert.equal(g.player.ammo.acoustic_decoy,2);assert.equal(g.player.order.speed,18);
});
test('crew stops issuing orders after mission end',()=>{
 const g=create(),crew=new Crew(eq,config);g.enemy.health=0;g.tick(.2);const before=JSON.stringify(g);assert.equal(crew.step(g),false);assert.equal(JSON.stringify(g),before);
});
test('both autonomous crews finish the default mission without manual intervention',()=>{
 for(const ship of ships){const g=create(ship.id),crew=new Crew(eq,config),api=commands(g);
  for(let i=0;i<8000&&!g.result;i++){crew.step(api);g.tick(.2);}
  assert.equal(g.result?.won,true,ship.id);assert.ok(crew.journal.some(d=>d.action.type==='fire'));assert.ok(crew.journal.some(d=>d.action.type==='ping'));assert.ok(crew.trail.length>10);assert.ok(crew.journal.every(d=>d.reason&&d.changes));
  if(ship.type==='SUBMARINE')assert.ok(crew.journal.some(d=>d.action.intent==='withdraw'));
 }
});
