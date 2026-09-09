import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game, distance } from '../src/game.js';
import { Crew } from '../src/crew.js';
import { Advisor } from '../src/advisor.js';
import { resolveScenario, loadScenarios } from '../src/scenarios.js';
const json = f => JSON.parse(readFileSync(new URL(`../${f}.json`,import.meta.url)));
const base=json('scenario'),eq=json('equipment'),ships=json('ships').ships;
const cfg=id=>resolveScenario(base,json(`scenarios/${id}`));
const create=id=>new Game(ships,eq,cfg(id));
const fetcher=async path=>({ok:true,json:async()=>json(path.replace(/\.json$/,''))});

test('catalog resolves five example missions and preserves original encounter',async()=>{
 const all=await loadScenarios(base,fetcher);assert.deepEqual(all.map(s=>s.id),['stealth','ambush','escape','duel','silent_escape','original']);assert.equal(all.at(-1).config.start.enemy.x,base.start.enemy.x);assert.equal(all.at(-1).config.seed,base.seed);
});
test('nested overrides inherit defaults without sharing mutable data',()=>{
 const original=JSON.stringify(base),a=cfg('ambush'),b=cfg('ambush');assert.equal(a.start.player.depth,160);assert.equal(a.start.player.speed,0);a.start.player.depth=20;assert.equal(b.start.player.depth,160);assert.equal(JSON.stringify(base),original);
});
test('invalid escape regions are rejected',()=>{
 const data=json('scenarios/escape');data.objective.zone.radius=-1;assert.throws(()=>resolveScenario(base,data),/離脱区域/);data.objective.zone.radius=10;data.objective.zone.x=100000;assert.throws(()=>resolveScenario(base,data),/離脱区域/);
});
test('missing catalog data fails with an actionable load error',async()=>{
 await assert.rejects(loadScenarios(base,async()=>({ok:false,status:404})),/404/);
});
test('example missions enforce their specified player ship',()=>{
 const g=new Game(ships,eq,cfg('escape'),'fletcher_class');assert.equal(g.player.spec.id,'type_212a');assert.equal(g.enemy.spec.type,'DESTROYER');
});
test('escape starts with a private enemy fix and a public briefing, not enemy coordinates',()=>{
 const g=create('escape');assert.equal(g.enemyContact.x,g.player.x);assert.equal(g.view().enemyContact,undefined);assert.equal(g.view().contact,null);assert.ok(g.events.some(e=>/敵に位置を測られ/.test(e.text)));
});
test('escape success requires entry into zone and uses the correct spoken report',()=>{
 const g=create('escape');const zone=g.config.mission.objective.zone;g.player.x=zone.x;g.player.y=zone.y;g.tick(.2);assert.equal(g.result.won,true);assert.match(g.result.reason,/離脱区域/);assert.equal(g.events[0].audio.clip,'escape-success');
});
test('destroying the pursuer alone does not complete escape and dead pursuers stop moving',()=>{
 const g=create('escape');g.enemy.health=0;const pos={x:g.enemy.x,y:g.enemy.y};g.tick(1);assert.equal(g.result,null);assert.equal(distance(g.enemy,pos),0);g.time=g.config.timeLimit;g.tick(.2);assert.equal(g.result.won,false);assert.match(g.result.reason,/離脱区域/);
});
test('hull loss takes precedence over entering the escape zone',()=>{
 const g=create('escape');Object.assign(g.player,g.config.mission.objective.zone,{health:0});g.tick(.2);assert.equal(g.result.won,false);
});
test('ambush crew waits without pinging or firing before the planned time',()=>{
 const g=create('ambush'),crew=new Crew(eq,g.config);for(let i=0;i<400;i++){crew.step(g);g.tick(.2);}assert.equal(g.pings,0);assert.equal(g.shots,0);assert.equal(g.player.order.speed,0);assert.equal(crew.journal[0].phase,'待ち伏せ');
});
test('threats override ambush and escape plans',()=>{
 for(const id of ['ambush','escape']){const g=create(id);g.warnings=[{bearing:45,distance:1000}];assert.equal(new Advisor().get(g.view(),eq,g.config).id,'evade');}
});
test('all example missions complete autonomously and teach different behaviors',()=>{
 for(const id of ['stealth','ambush','escape','duel']){const g=create(id),crew=new Crew(eq,g.config);
  for(let i=0;i<8000&&!g.result;i++){crew.step(g);g.tick(.2);}
  assert.equal(g.result?.won,true,id);
  if(id==='escape'){assert.equal(g.shots,0);assert.ok(crew.journal.some(d=>d.phase==='緊急回避'));assert.ok(crew.journal.some(d=>d.action.intent==='escape'));}
  else assert.ok(g.shots>0);
  if(id==='ambush')assert.ok(crew.journal.filter(d=>d.action.type==='fire').every(d=>d.time>=90));
 }
});

test('submarine duel has independent submerged opponents and private enemy state',()=>{
 const g=create('duel');assert.equal(g.player.spec.type,'SUBMARINE');assert.equal(g.enemy.spec.type,'SUBMARINE');assert.equal(g.enemy.depth,180);assert.notEqual(g.player.ammo,g.enemy.ammo);assert.notEqual(g.player.order,g.enemy.order);assert.equal(g.view().enemy,undefined);assert.equal(g.view().contact,null);
 const bad=cfg('duel');bad.mission.enemyShip='missing';assert.throws(()=>new Game(ships,eq,bad),/対戦相手/);
});
test('duel crew targets measured underwater depths and responds to enemy torpedoes',()=>{
 const g=create('duel'),crew=new Crew(eq,g.config);let fired=0,threat=false;
 for(let i=0;i<8000&&!g.result;i++){
  const before=g.shots,depth=g.view().contact?.depth;crew.step(g);
  if(g.shots>before){fired++;const shot=g.projectiles.filter(p=>p.team==='player').at(-1);assert.equal(shot.targetDepth,Math.round(depth/10)*10);assert.ok(shot.targetDepth>0);}
  g.tick(.2);threat ||= g.warnings.length>0;
 }
 assert.ok(fired>0);assert.ok(threat);assert.ok(g.enemy.ammo.torpedo_533mm<4);assert.ok(crew.journal.some(d=>d.phase==='緊急回避'));assert.equal(g.result?.won,true);
});

test('noncombat escape forbids attacks without spending ammo but allows decoys and enemy fire',()=>{
 const g=create('silent_escape');const ammo=g.player.ammo.torpedo_533mm;
 assert.match(g.fireReason('torpedo_533mm'),/攻撃禁止/);assert.equal(g.fire('torpedo_533mm'),false);assert.equal(g.player.ammo.torpedo_533mm,ammo);assert.equal(g.shots,0);
 assert.equal(g.fireReason('acoustic_decoy'),'');assert.equal(g.fire('acoustic_decoy'),true);
 assert.equal(g.fireReason('torpedo_533mm','enemy'),'');assert.equal(g.fire('torpedo_533mm',160,'enemy'),true);
});
test('noncombat escape crew evades, slows down and returns without attacking',()=>{
 const g=create('silent_escape'),crew=new Crew(eq,g.config);let threat=false,quiet=false;
 for(let i=0;i<8000&&!g.result;i++){crew.step(g);quiet ||= g.player.order.speed===6;g.tick(.2);threat ||= g.warnings.length>0;}
 assert.equal(g.enemy.spec.type,'SUBMARINE');assert.equal(g.result?.won,true);assert.equal(g.shots,0);assert.ok(threat);assert.ok(quiet);assert.ok(g.player.ammo.acoustic_decoy<3);assert.ok(g.enemy.health>0);
});
