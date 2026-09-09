import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game.js';
import { Advisor, advise } from '../src/advisor.js';
const json = f => JSON.parse(readFileSync(new URL(`../${f}.json`, import.meta.url)));
const ships = json('ships').ships, eq = json('equipment'), config = json('scenario');
const create = id => new Game(ships, eq, structuredClone(config), id);

test('advice is read-only and begins with quiet listening', () => {
  const g=create(),before=JSON.stringify(g), a=advise(g.view(),eq,config);
  assert.equal(a.action.type,'listen');assert.equal(a.action.values.speed,4);assert.equal(JSON.stringify(g),before);
});
test('passive bearings lead to ranging without assuming hidden position or depth', () => {
  const g=create();g.sample();const a=advise(g.view(),eq,config);
  assert.equal(a.action.type,'ping');assert.equal(a.lesson,'measure');assert.match(a.why,/方向だけ/);
});
test('measured surface target gets a surface torpedo attack with explicit ammunition cost', () => {
  const g=create();g.ping();const a=advise(g.view(),eq,config);
  assert.equal(a.action.type,'fire');assert.equal(a.action.depth,0);assert.match(a.changes,/1発消費/);
});
test('destroyer selects long-range weapon and observed attack depth', () => {
  const g=create('fletcher_class');g.ping();const a=advise(g.view(),eq,config);
  assert.equal(a.action.weapon,'asroc');assert.equal(a.action.depth,g.contact.depth);
});
test('threats override attacks; ongoing evasion does not repeatedly turn or spend decoys', () => {
  const g=create();g.ping();g.warnings=[{bearing:35,distance:1000}];const advisor=new Advisor();
  const a=advisor.get(g.view(),eq,config);assert.equal(a.action.type,'evade');assert.equal(a.action.decoy,true);
  advisor.acknowledge(a.action,g.time);const next=advisor.get(g.view(),eq,config);assert.equal(next.id,'evading');assert.equal(next.action,null);
});
test('depleted or already deployed decoys are not offered again', () => {
  const g=create();g.warnings=[{bearing:35}];g.player.ammo.acoustic_decoy=0;
  assert.equal(advise(g.view(),eq,config).action.decoy,false);
  g.player.ammo.acoustic_decoy=3;g.fire('acoustic_decoy');g.time=40;
  assert.equal(advise(g.view(),eq,config).action.decoy,false);
});
test('unsafe target depth prompts a safe ascent before combat advice', () => {
  const g=create();g.player.order.depth=500;const a=advise(g.view(),eq,config);
  assert.equal(a.id,'grounding');assert.ok(a.action.values.depth<g.bottomAt(g.player)-config.bottom.clearance);
});
test('manual firing advances lessons and prevents immediate recommended repeat firing', () => {
  const g=create();g.ping();g.fire('torpedo_533mm',0);const advisor=new Advisor();const a=advisor.get(g.view(),eq,config);
  assert.equal(advisor.completed.has('attack'),true);assert.notEqual(a.action?.type,'fire');
});
test('both roles can win by approving only the proposed actions', () => {
  for(const ship of ships){const g=create(ship.id),advisor=new Advisor();
    for(let t=0;t<config.timeLimit&&!g.result;t++){
      const a=advisor.get(g.view(),eq,config).action;
      if(a&&t%2===0){let ok=true;
        if(a.type==='ping')ok=g.ping();else if(a.type==='fire')ok=g.fire(a.weapon,a.depth);
        else {if(a.decoy)g.fire('acoustic_decoy');g.order(a.values);}
        if(ok)advisor.acknowledge(a,g.time);
      }
      g.tick(1);
    }
    assert.equal(g.result?.won,true,ship.id);
  }
});
