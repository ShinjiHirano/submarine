import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game.js';
import { Advisor } from '../src/advisor.js';
import { sonarReport } from '../src/officer.js';
const json = f => JSON.parse(readFileSync(new URL(`../${f}.json`, import.meta.url)));
const ships=json('ships').ships,eq=json('equipment'),config=json('scenario');
const create=()=>new Game(ships,eq,structuredClone(config));

test('no warnings means uncertainty, not proof of being undetected',()=>{
 const report=sonarReport(create().view(),eq,config);assert.equal(report.level,'unknown');assert.match(report.reasons[0],/保証/);assert.equal(report.eta,null);
});
test('intercept reports enemy search but never asserts detection',()=>{
 const g=create();g.ping('enemy');const r=sonarReport(g.view(),eq,config);assert.equal(r.level,'caution');assert.match(r.reasons.join(''),/断定はできません/);
});
test('own ping and cavitation are evidence; obsolete events expire',()=>{
 const g=create();g.ping();assert.match(sonarReport(g.view(),eq,config).title,/暴露/);g.time=76;assert.equal(sonarReport(g.view(),eq,config).level,'unknown');g.player.depth=0;g.player.speed=18;assert.match(sonarReport(g.view(),eq,config).title,/騒音/);
});
test('arrival time comes from measured range and ammunition data',()=>{
 const g=create();g.ping();const r=sonarReport(g.view(),eq,config);assert.ok(r.eta>200);assert.equal(r.uncertainty,100);g.time+=10;assert.equal(sonarReport(g.view(),eq,config).uncertainty,180);
});
test('passive submarine contact defaults to quiet observation with optional ping',()=>{
 const g=create();g.sample();const a=new Advisor().get(g.view(),eq,config);assert.equal(a.id,'officer-approach');assert.equal(a.action.values.speed,6);assert.ok(a.options.some(o=>o.action?.type==='ping'));assert.equal(a.options.find(o=>o.id==='officer-fire').action,null);
});
test('distant submarine target offers but does not recommend immediate shooting',()=>{
 const g=create();g.ping();const a=new Advisor().get(g.view(),eq,config);assert.equal(a.id,'officer-approach');assert.equal(a.options.find(o=>o.id==='officer-fire').action.type,'fire');
});
test('nearby measured target enables attack then recommends quiet withdrawal',()=>{
 const g=create();g.enemy.x=g.player.x;g.enemy.y=g.player.y-1700;g.ping();const advisor=new Advisor();const a=advisor.get(g.view(),eq,config);assert.equal(a.action.type,'fire');g.fire(a.action.weapon,a.action.depth);const next=advisor.get(g.view(),eq,config);assert.equal(next.action.intent,'withdraw');assert.equal(next.action.values.speed,6);advisor.acknowledge(next.action,g.time);assert.equal(advisor.get(g.view(),eq,config).action,null);
});
test('urgent threats remove normal choices and override withdrawal',()=>{
 const g=create();g.ping();g.warnings=[{bearing:45,distance:500}];const a=new Advisor().get(g.view(),eq,config);assert.equal(a.id,'evade');assert.deepEqual(a.options,[]);assert.equal(a.report.level,'danger');
});
test('unobserved enemy movement cannot change an existing report',()=>{
 const g=create();g.ping();const view=g.view(),before=sonarReport(view,eq,config);g.enemy.x+=10000;g.enemy.health=1;assert.deepEqual(sonarReport(view,eq,config),before);
});
