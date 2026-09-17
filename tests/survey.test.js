import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../src/game.js';
import { Surveyor } from '../src/survey.js';
const json = name => JSON.parse(readFileSync(new URL(`../${name}.json`, import.meta.url)));
const ships = json('ships').ships, equipment = json('equipment'), base = json('scenario');
const game = mode => new Game(ships, equipment, { ...structuredClone(base), chartMode: mode });

test('unknown charts query only the own-ship depth, never distant hidden terrain', () => {
  const calls = [], p = { x: 0, y: 0, depth: 100, order: { heading: 0, depth: 100 } };
  const survey = new Surveyor({ worldRadius: 14000, chartMode: 'unknown' }, point => { calls.push({ x: point.x, y: point.y }); return 360; });
  assert.equal(calls.length, 0);
  survey.step(p, 0);
  assert.deepEqual(calls, [{ x: 0, y: 0 }]);
  assert.equal(survey.view().cells.length, 1);
  assert.equal(survey.view().unknownAhead, true);
  survey.refresh(p, 4);
  assert.equal(calls.length, 1);
});
test('charts have distinct initial coverage; surveying improves precision without losing it', () => {
  const known = game('charted'), partial = game('partial'), unknown = game('unknown');
  assert.equal(known.view().survey.known, 100);
  assert.ok(partial.view().survey.known < 100);
  assert.ok(partial.view().survey.known > unknown.view().survey.known);
  unknown.ping();
  assert.equal(unknown.view().survey.known, 100);
  assert.equal(unknown.view().survey.measured, 100);
  const key = unknown.surveyor.key(unknown.player.x, unknown.player.y);
  const precision = unknown.surveyor.cells.get(key).error;
  unknown.surveyor.step(unknown.player, 2);
  assert.equal(unknown.surveyor.cells.get(key).error, precision);
});
test('survey scan uses the actual ping risk and cooldown; enemy ping does not survey for player', () => {
  const g = game('unknown');
  assert.equal(g.ping('enemy'), true);
  assert.equal(g.view().survey.cells.length, 1);
  assert.equal(g.ping(), true);
  assert.ok(g.enemyContact);
  assert.equal(g.enemyContact.bearing !== undefined, true);
  const state = JSON.stringify(g.view().survey);
  assert.equal(g.ping(), false);
  assert.equal(JSON.stringify(g.view().survey), state);
});
test('moving accumulates observations and a new mission resets knowledge', () => {
  const g = game('unknown');
  g.player.x += 800; g.surveyor.step(g.player, 2);
  assert.equal(g.surveyor.cells.size, 2);
  assert.equal(game('unknown').surveyor.cells.size, 1);
});
test('surveyor warns using conservative depth including chart error and ordered depth', () => {
  const g = game('charted'); g.player.order.depth = 350;
  g.surveyor.refresh(g.player, 0);
  assert.equal(g.view().survey.level, 'danger');
  assert.ok(g.view().survey.clearance < 35);
});
test('live visuals cannot disclose seeker turns, aim coordinates or exact explosion positions', () => {
  const g = game('unknown'); g.ping(); g.fire('torpedo_533mm', 0);
  const before = JSON.stringify(g.view().visuals);
  g.projectiles[0].x = 12345; g.projectiles[0].aim = g.enemy; g.projectiles[0].lured = true;
  assert.deepEqual(g.view().projectiles, []);
  assert.equal(JSON.stringify(g.view().visuals), before);
  g.explode(g.projectiles[0], g.enemy);
  assert.equal(g.view().effects.some(e => e.type === 'explosion'), false);
});
test('launch, decoy, damage and hit cues are available without enemy coordinates', () => {
  const g = game('unknown'); g.ping(); g.fire('torpedo_533mm', 0); g.fire('acoustic_decoy');
  g.explode({ ...g.projectiles[0], x: g.enemy.x, y: g.enemy.y, depth: g.enemy.depth }, g.enemy);
  g.explode({ team: 'enemy', weapon: g.weapon('torpedo_533mm'), x: g.player.x, y: g.player.y, depth: g.player.depth }, g.player);
  for (const type of ['launch', 'decoy', 'damage', 'hit']) assert.ok(g.view().visuals.some(e => e.type === type), type);
  const hit = g.view().visuals.find(e => e.type === 'hit');
  assert.equal(hit.x, g.player.x); assert.equal(hit.y, g.player.y);
});
test('replay truth is gated until mission end and snapshots do not follow live objects', () => {
  const g = game('unknown'), originalX = g.enemy.x;
  assert.equal(g.replayLength(), 0); assert.equal(g.replayAt(0), null);
  g.enemy.x += 300; g.player.health = 0; g.tick(.2);
  assert.ok(g.replayLength() >= 2);
  assert.equal(g.replayAt(0).replay.enemy.x, originalX);
  assert.equal(g.replayAt(g.replayLength() - 1).replay.enemy.x, g.enemy.x);
  assert.equal(g.view().replay, undefined);
  assert.equal(g.replayAt(NaN), null);
});

test('captain and advisor act on known forward shallows without an unauthorized ping', async () => {
  const { Advisor } = await import('../src/advisor.js');
  const { Crew } = await import('../src/crew.js');
  const g = game('charted'); g.player.order.depth = 310; g.player.depth = 310;
  g.surveyor.refresh(g.player, 0);
  const advice = new Advisor().get(g.view(), equipment, g.config);
  assert.equal(advice.id, 'survey-grounding');
  assert.ok(advice.action.values.depth < 310);
  const crew = new Crew(equipment, g.config); crew.step(g);
  assert.equal(g.pings, 0);
  assert.ok(g.player.order.depth < 310);
  assert.match(crew.lastDecision.stations.surveyor, /余裕/);
});
