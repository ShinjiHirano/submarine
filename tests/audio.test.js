import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../src/audio.js';

function fixture(voices = [{ lang: 'ja-JP', name: 'Japanese', localService: true }]) {
  const spoken = [], saved = new Map(); let canceled = 0;
  const host = {
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    speechSynthesis: { getVoices: () => voices, addEventListener() {}, speak: u => spoken.push(u), cancel: () => canceled++ },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }
  };
  const audio = new GameAudio(host); audio.setActive(true);
  return { audio, host, spoken, saved, canceled: () => canceled };
}
const view = events => ({ events, player: { speed: 5 } });
test('visible events sound only once and silent updates do not accumulate a backlog', () => {
  const { audio } = fixture(); const effects = []; audio.effect = sound => effects.push(sound);
  const a = { id: 1, text: '探知', audio: { sound: 'contact' } };
  audio.update(view([a]), true); audio.update(view([a]), true);
  assert.deepEqual(effects, ['contact']);
  const b = { id: 2, text: '発射', audio: { sound: 'launch' } };
  audio.update(view([b, a]), false); audio.update(view([b, a]), true);
  assert.deepEqual(effects, ['contact']); audio.reset();
});
test('urgent reports interrupt routine speech and late callbacks cannot restart it', () => {
  const { audio, spoken, canceled } = fixture();
  audio.speak('接触を探知'); const first = spoken[0];
  audio.speak('測距を更新'); audio.speak('魚雷接近', 2);
  assert.equal(canceled(), 1); assert.equal(spoken.at(-1).text, '魚雷接近');
  assert.equal(audio.queue.length, 0); first.onend(); assert.equal(audio.currentReport.text, '魚雷接近');
  audio.reset();
});
test('fast-forward report queue stays bounded and drops stale information', () => {
  const { audio, spoken } = fixture(); audio.speak('開始');
  for (let i = 0; i < 30; i++) audio.speak(`報告${i}`);
  assert.equal(audio.queue.length, 3); audio.queue.forEach(r => r.at -= 9000);
  spoken[0].onend(); assert.equal(spoken.length, 1); audio.reset();
});
test('mute and pause stop speech and effects, and unmute never replays old reports', () => {
  const { audio, spoken } = fixture(); let stopped = 0;
  audio.sources.add({ stop() { stopped++; } }); audio.speak('通常報告');
  audio.configure({ muted: true }); assert.equal(stopped, 1); assert.equal(audio.currentReport, null);
  audio.speak('ミュート中'); assert.equal(spoken.length, 1);
  audio.configure({ muted: false }); assert.equal(audio.queue.length, 0);
  audio.speak('再開'); audio.setActive(false); assert.equal(audio.currentReport, null); audio.reset();
});
test('voice toggle, master volume and persistence are respected', () => {
  const { audio, host, spoken } = fixture(); audio.configure({ volume: 0.3 }); audio.speak('テスト');
  assert.equal(spoken[0].volume, 0.3); audio.configure({ voice: false }); audio.speak('無効'); assert.equal(spoken.length, 1);
  const restored = new GameAudio(host); assert.equal(restored.settings.volume, 0.3); assert.equal(restored.settings.voice, false);
  audio.configure({ volume: 0 }); assert.equal(audio.audible, false); audio.reset();
});
test('missing voices, storage and audio APIs degrade without breaking the game', async () => {
  const { audio, spoken } = fixture([]); audio.speak('報告'); assert.equal(spoken.length, 0);
  assert.equal(await audio.unlock(), false); assert.equal(audio.unavailable, true);
  const unsupported = new GameAudio({}); unsupported.configure({ muted: true }); unsupported.reset();
});

function addFallback(audio) {
  const sources = [];
  audio.context = { state: 'running', currentTime: 0, createBufferSource() {
    const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
    sources.push(source); return source;
  } };
  audio.clips.set('contact', { duration: 2 });
  return sources;
}
test('bundled Japanese reports play without system voices and stop on pause', () => {
  const { audio } = fixture([]); const sources = addFallback(audio);
  audio.speak('接触を探知', 0, 'contact'); assert.equal(sources[0].started, true);
  audio.setActive(false); assert.equal(sources[0].stopped, true); assert.equal(audio.currentReport, null);
});
test('system speech errors fall back to bundled audio', () => {
  const { audio, spoken } = fixture(); const sources = addFallback(audio);
  audio.speak('接触を探知'); spoken[0].onerror({ error: 'synthesis-failed' });
  assert.equal(audio.speechFailed, true); assert.equal(sources[0].started, true); audio.reset();
});
test('newest reports survive queue overflow at equal priority', () => {
  const { audio } = fixture(); audio.speak('開始');
  for (let i = 0; i < 10; i++) audio.speak(`報告${i}`);
  assert.deepEqual(audio.queue.map(r => r.text), ['報告9', '報告8', '報告7']); audio.reset();
});
