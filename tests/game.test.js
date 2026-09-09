import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game, distance, bearing } from '../src/game.js';
const json = name => JSON.parse(readFileSync(new URL(`../${name}.json`, import.meta.url)));
const ships = json('ships').ships, equipment = json('equipment'), config = json('scenario');
function game(id) { const g = new Game(ships, equipment, structuredClone(config), id); g.enemy.nextPing = Infinity; g.enemy.nextAttack = Infinity; return g; }
function advance(g, seconds) { for (let t = 0; t < seconds; t++) g.tick(Math.min(1, seconds - t)); }
test('all external ship equipment references resolve and engine modifies speed/noise', () => {
  for (const ship of ships) { const g = game(ship.id); for (const id of [...ship.sonarSlots, ship.activeSonar]) assert.ok(equipment.sonars.find(s => s.id === id)); for (const id of ship.weaponSlots) assert.ok(g.weapon(id)); }
  const g = game(); assert.equal(g.player.maxSpeed, 18); assert.ok(g.noise(g.player) < g.player.spec.baseNoise + g.player.speed * config.noise.speedFactor);
});
test('passive contact reports bearing but never target coordinates or depth', () => {
  const g = game(); g.sample(); assert.ok(g.contact); assert.equal(g.contact.source, 'PASSIVE'); assert.equal(g.contact.x, null); assert.equal(g.contact.depth, null);
  const v = g.view(); assert.equal(v.enemy, undefined); assert.equal(v.enemyContact, undefined);
});
test('active ping provides a fix, exposes only bearing to adversary and has cooldown', () => {
  const g = game(); assert.ok(g.ping()); assert.equal(g.contact.x, g.enemy.x); assert.equal(g.contact.source, 'ACTIVE'); assert.equal(g.enemyContact.x, undefined); assert.equal(g.enemyContact.bearing, bearing(g.enemy, g.player)); assert.equal(g.ping(), false);
});
test('out-of-range ping still exposes source bearing', () => { const g = game(); g.enemy.x = 13000; assert.ok(g.ping()); assert.equal(g.contact, null); assert.ok(g.enemyContact); });
test('old fixes expire without revealing live target position', () => { const g = game(); g.ping(); const x = g.contact.x; g.enemy.x += 200; assert.equal(g.contact.x, x); g.time = config.sonar.fixLifetime + 1; g.sample(); assert.equal(g.contact.fixAt, null); assert.equal(g.contact.x, null); });
test('lost bearings expire', () => { const g = game(); g.sample(); g.enemy.x = 1e8; g.time += config.sonar.bearingLifetime + 1; g.sample(); assert.equal(g.contact, null); });
test('self noise and thermocline affect detection', () => { const g = game(); g.player.depth = 0; const quiet = g.signal(g.player, g.enemy); g.player.speed = 18; assert.ok(g.cavitating(g.player)); assert.ok(g.signal(g.player, g.enemy) < quiet); g.player.speed = 5; g.player.depth = 160; assert.ok(g.signal(g.player, g.enemy) < quiet); });
test('TMA cannot conjure range without enough baseline and course change', () => { const g = game(); g.sample(); g.samples = Array.from({length:20}, () => ({ x:0,y:1000,heading:15,bearing:g.contact.bearing,time:0 })); g.tryTMA(); assert.equal(g.contact.fixAt, null); });
test('TMA solves measured bearing lines without using target coordinates', () => {
  const g = game(); g.sample(); const measuredTarget = {x:2000,y:-3000};
  g.samples = Array.from({length:20}, (_,i) => {const p = {x:i*30,y:1000+i*i}; return {...p, heading:i*3, bearing:bearing(p, measuredTarget),time:i*3};});
  g.contact.bearing = bearing(g.player, measuredTarget); g.enemy.x = 9000; g.tryTMA(); assert.equal(g.contact.source, 'TMA'); assert.ok(distance(g.contact, measuredTarget) < 1); assert.equal(g.contact.depth, null);
});
test('ship orders respect limits, turn gradually and destroyer remains on surface', () => { const g = game('fletcher_class'); g.order({depth:300,speed:100,heading:370}); assert.equal(g.player.order.depth, 0); assert.equal(g.player.order.speed, 38); assert.equal(g.player.order.heading, 10); g.tick(.2); assert.equal(g.player.depth, 0); assert.ok(g.player.speed < 38); });
test('weapons require contact, inventory and loading time', () => { const g = game(); assert.equal(g.fire('torpedo_533mm'), false); g.ping(); assert.ok(g.fire('torpedo_533mm', 0)); assert.equal(g.player.ammo.torpedo_533mm, 3); assert.equal(g.fire('torpedo_533mm', 0), false); assert.equal(g.fire('asroc'), false); });
test('torpedoes hit and damage targets', () => { const g = game(); Object.assign(g.enemy, {x:g.player.x,y:g.player.y-150,depth:0}); g.player.depth = 0; g.player.heading = 0; g.ping(); g.fire('torpedo_533mm', 0); for (let i=0;i<10;i++) g.stepWeapons(1); assert.equal(g.enemy.health, 50); assert.equal(g.projectiles.length, 0); });
test('depth charges detonate at requested depth, not immediately', () => { const g = game('fletcher_class'); g.enemy.x = g.player.x; g.enemy.y = g.player.y; g.enemy.depth = 120; assert.ok(g.fire('depth_charge_mk9',120)); g.stepWeapons(1); assert.equal(g.enemy.health,100); for(let i=0;i<9;i++)g.stepWeapons(1); assert.equal(g.enemy.health,15); });
test('decoy intercepts nearby hostile torpedo', () => { const g = game(); g.fire('acoustic_decoy'); g.projectiles.push({id:100,team:'enemy',weapon:g.weapon('homing_torpedo'),x:g.player.x+60,y:g.player.y,depth:g.player.depth,targetDepth:g.player.depth,heading:270,traveled:0,aim:g.player,age:0}); g.stepWeapons(.1); assert.equal(g.projectiles.length,0); assert.equal(g.player.health,100); });
test('enemy weapons remain hidden even when bearing warning is available', () => { const g=game();g.enemyContact={bearing:180};g.fire('torpedo_533mm',100,'enemy'); const weapon=g.weapon('homing_torpedo');g.projectiles.push({team:'enemy',weapon,x:g.player.x+1000,y:g.player.y,depth:100,aim:g.player,heading:270,age:0,traveled:0,targetDepth:100});g.stepWeapons(.1);assert.ok(g.warnings.length);assert.equal(g.view().projectiles.length,0); });
test('seabed grounding damages hull and current causes drift', () => { const g=game();g.player.speed=0;g.player.order.speed=0;const x=g.player.x;g.moveShip(g.player,1);assert.notEqual(g.player.x,x);g.player.depth=500;g.player.order.depth=500;g.moveShip(g.player,1);assert.ok(g.player.health<100);assert.ok(g.player.depth<g.bottomAt(g.player)); });
test('success, hull loss and timeout terminate simulation', () => { const victory=game();victory.enemy.health=0;victory.tick(1);assert.equal(victory.result.won,true);const t=victory.time;victory.tick(1);assert.equal(victory.time,t);const loss=game();loss.player.health=0;loss.tick(1);assert.equal(loss.result.won,false);const timeout=game();timeout.time=config.timeLimit-0.1;timeout.tick(1);assert.match(timeout.result.reason,/作戦時間/); });
test('both roles run through a full mission without invalid numeric state', () => {for(const s of ships){const g=new Game(ships,equipment,structuredClone(config),s.id);advance(g,1501);assert.ok(g.result);for(const p of [g.player,g.enemy])for(const key of ['x','y','depth','health','speed'])assert.ok(Number.isFinite(p[key]),key);}});
test('both roles can win using measured contacts, navigation, weapons and countermeasures', () => {
  for (const ship of ships) {
    const g = new Game(ships, equipment, structuredClone(config), ship.id);
    let nextShot = 0, evadeUntil = 0;
    for (let t = 0; t < config.timeLimit && !g.result; t++) {
      const v = g.view(), c = v.contact;
      if (t % 40 === 0) g.ping();
      if (c && t > evadeUntil) g.order({ heading: c.fixAt != null ? bearing(v.player, c) : c.bearing, speed: ship.type === 'SUBMARINE' ? 8 : 30 });
      if (v.warnings.length && t > evadeUntil) {
        if (!g.fireReason('acoustic_decoy')) g.fire('acoustic_decoy');
        g.order({ heading: v.player.heading + 80, speed: v.player.maxSpeed }); evadeUntil = t + 25;
      }
      if (t >= nextShot && c) {
        const id = ship.weaponSlots.find(id => g.weapon(id).guidance !== 'DECOY' && !g.fireReason(id) && (id !== 'depth_charge_mk9' || c.fixAt != null && distance(v.player, c) < 300));
        if (id) { g.fire(id, c.depth ?? 100); nextShot = t + 25; }
      }
      g.tick(1);
    }
    assert.equal(g.result?.won, true, ship.id);
  }
});
