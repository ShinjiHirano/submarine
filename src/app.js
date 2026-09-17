import { TacticalView } from './tactical.js';
import { Game, bearing, distance, clamp } from './game.js';
import { GameAudio } from './audio.js';
import { Advisor, LESSONS } from './advisor.js';
import { Crew } from './crew.js';
import { loadScenarios } from './scenarios.js';
let scenarios = [], selectedScenario;
let crew, autoCommand = false;
let replayIndex = null, replayPlaying = false, replayElapsed = 0;
let selectedOfficerOption = null, lastOfficerReport = '', lastOfficerReportAt = -Infinity;
let advisor = new Advisor(), currentAdvice = null, guideEnabled = true, advisorMessage = '', lessonAudio = false;
try { guideEnabled = localStorage.getItem('silent-depth.guide') !== 'off'; } catch { /* Optional preference. */ }
const audio = new GameAudio();
const $ = id => document.getElementById(id);
const timeLabel = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const degree = v => `${String(Math.round(v) % 360).padStart(3, '0')}°`;
let ships, equipment, config, game, selectedShip, selectedWeapon, paused = true, rate = 1, range = 10000, last = 0, uiAt = 0, logId = -1, resultShown = false, helpWasPaused = true;
const canvas = $('sonar'), ctx = canvas.getContext('2d');
const tactical = new TacticalView($('tactical'));
$('reduce-effects').checked = tactical.reduced;
$('camera-left').onclick = () => { tactical.yaw -= 20; };
$('camera-right').onclick = () => { tactical.yaw += 20; };
function wideCameraRange() { const v = replayIndex !== null ? game?.replayAt(replayIndex) : null; return v ? Math.max(3400, distance(v.player, v.replay.enemy) * 1.4) : 3400; }
$('camera-zoom').onclick = () => { tactical.range = tactical.range === 2000 ? wideCameraRange() : 2000; setText('camera-zoom', tactical.range === 2000 ? '広域' : '拡大'); };
$('camera-reset').onclick = () => { tactical.yaw = -25; tactical.range = wideCameraRange(); setText('camera-zoom', '拡大'); };
$('show-layer').onchange = e => { tactical.layer = e.target.checked; };
$('reduce-effects').onchange = e => { tactical.reduced = e.target.checked; };
const startDialog = $('start-dialog');
startDialog.showModal();
for (const dialog of [startDialog, $('result-dialog')]) dialog.addEventListener('cancel', e => e.preventDefault());
for (let i = 0; i < 17; i++) $('spectrum').append(document.createElement('i'));
const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
function renderAudioSettings() {
  const { muted, volume, voice } = audio.settings;
  setText('audio-summary', muted || volume === 0 ? '音声 OFF' : '音声 ON');
  setText('mute-btn', muted ? 'ミュート解除' : 'すべてミュート');
  $('mute-btn').setAttribute('aria-pressed', String(muted));
  $('audio-volume').value = Math.round(volume * 100);
  setText('audio-volume-output', `${Math.round(volume * 100)}%`);
  $('voice-enabled').checked = voice;
  setText('audio-status', audio.unavailable ? '音声を開始できません。「音声テスト」で再試行してください。'
    : audio.clipLoadFailed && !audio.voice ? '報告音声を読み込めません。ページを再読み込みしてください。効果音は利用できます。'
    : !voice ? '音声報告 OFF · 効果音のみ'
    : audio.speechFailed ? '端末の読み上げを利用できないため、同梱の日本語報告を再生します。'
    : audio.voice ? `日本語報告：${audio.voice.name}`
    : audio.clips?.size ? '同梱の日本語報告を使用。数値の詳細は接触情報に表示します。' : '出撃時に同梱の日本語報告を読み込みます。');
}
audio.onchange = renderAudioSettings;
$('mute-btn').onclick = () => { audio.configure({ muted: !audio.settings.muted }); if (!audio.settings.muted) audio.unlock(); };
$('audio-volume').oninput = () => { audio.configure({ volume: Number($('audio-volume').value) / 100 }); audio.unlock(); };
$('voice-enabled').onchange = () => audio.configure({ voice: $('voice-enabled').checked });
$('audio-test').onclick = async () => {
  audio.configure({ muted: false, volume: audio.settings.volume || 0.55 });
  await audio.unlock();
  if (running()) { audio.effect('ping'); audio.speak('ソナーより報告。音声テスト、正常です。', 2, 'test'); }
};
renderAudioSettings();
async function load() {
  try {
    [ships, equipment, config] = await Promise.all(['ships.json', 'equipment.json', 'scenario.json'].map(async path => {
      const response = await fetch(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.json();
    }));
    ships = ships.ships; selectedShip = ships[0].id;
    scenarios = await loadScenarios(config);
    for (const scenario of scenarios) {
      if (scenario.enemyShip && !ships.some(ship => ship.id === scenario.enemyShip)) throw new Error('シナリオの敵艦IDが艦艇データにありません');
      if (scenario.playerShip && !ships.some(ship => ship.id === scenario.playerShip)) throw new Error('シナリオの自艦IDが艦艇データにありません');
      const option = document.createElement('option'); option.value = scenario.id; option.textContent = scenario.title; $('scenario-select').append(option);
    }
    selectedScenario = scenarios[0]; config = structuredClone(selectedScenario.config); range = config.displayRange;
    for (const ship of ships) {
      const button = document.createElement('button'); button.className = `ship-choice${ship.id === selectedShip ? ' selected' : ''}`; button.dataset.id = ship.id;
      button.setAttribute('aria-pressed', String(ship.id === selectedShip));
      const type = document.createElement('span'); type.textContent = ship.type;
      const title = document.createElement('strong'); title.textContent = ship.name;
      const description = document.createElement('p'); description.textContent = ship.description;
      button.append(type, title, description);
      button.onclick = () => { selectedShip = ship.id; document.querySelectorAll('.ship-choice').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); prepare(); };
      $('ship-choices').append(button);
    }
    chooseScenario(selectedScenario.id); $('scenario-select').disabled = false; $('start-btn').disabled = false; $('auto-start-btn').disabled = false; setText('start-btn', '任務を開始する →');
    setText('load-status', '1人用 / 敵AI対戦 · 所要時間 約5〜25分 · 音声なしでプレイ可能');
  } catch (error) { setText('load-status', `読み込みに失敗しました：${error.message}。docker compose up --build で起動し、http://localhost/game/submarine/ を開いてください。`); }
}
function chooseScenario(id) {
  selectedScenario = scenarios.find(s => s.id === id);
  config = structuredClone(selectedScenario.config);
  if (selectedScenario.playerShip) selectedShip = selectedScenario.playerShip;
  for (const button of $('ship-choices').children) {
    button.disabled = !!selectedScenario.playerShip && button.dataset.id !== selectedScenario.playerShip;
    button.classList.toggle('selected', button.dataset.id === selectedShip);
    button.setAttribute('aria-pressed', String(button.dataset.id === selectedShip));
  }
  setText('scenario-category', selectedScenario.category); setText('scenario-briefing', selectedScenario.briefing);
  setText('scenario-goal', `成功条件：${selectedScenario.objective.title}`);
  setText('scenario-ship-note', selectedScenario.playerShip ? 'お手本は212A型潜水艦で実施します。手動指揮・自動観戦のどちらも選べます。' : '潜水艦・駆逐艦のどちらでも出撃できます。');
  $('scenario-lessons').replaceChildren(...selectedScenario.lessons.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  prepare();
}
$('chart-mode').onchange = () => { if (ships) prepare(); };
$('scenario-select').onchange = () => chooseScenario($('scenario-select').value);
function prepare() {
  audio.reset();
  advisor = new Advisor(); selectedOfficerOption = null; lastOfficerReport = ''; lastOfficerReportAt = -Infinity; currentAdvice = null; advisorMessage = ''; lessonAudio = false;
  config.chartMode = $('chart-mode').value;
  tactical.reset(); tactical.range = 3400; tactical.yaw = -25; setText('camera-zoom', '拡大'); replayIndex = null; replayPlaying = false;
  $('replay-controls').hidden = true; $('replay-reopen').hidden = true; $('surveyor-console').hidden = false; setText('tactical-source', '海図・観測情報から再構成'); setText('tactical-title', '3D戦術ビュー');
  game = new Game(ships, equipment, config, selectedShip); selectedWeapon = game.player.spec.weaponSlots.find(id => game.weapon(id).guidance !== 'DECOY');
  crew = new Crew(equipment, config, advisor); autoCommand = false;
  paused = true; rate = 1; resultShown = false; logId = -1;
  const p = game.player;
  range = config.displayRange;
  setText('range-btn', `${range / 1000} km ↻`); setText('radar-range', `RANGE ${(range / 1000).toFixed(1)} km`);
  document.querySelector('.bottom-right').textContent = `GRID / ${range / 4000} km`;
  setText('objective-title', config.mission?.objective.title || '海域の脅威を排除せよ');
  setText('objective-description', config.mission?.objective.description || '敵艦撃破を目指します。');
  $('speed').max = p.maxSpeed; $('depth').max = p.spec.maxDepth || 300;
  $('attack-depth').max = Math.max(...ships.map(s => s.maxDepth));
  $('attack-depth').value = p.spec.type === 'SUBMARINE' ? 0 : 100;
  $('depth').disabled = p.spec.type === 'DESTROYER';
  setText('speed-max', `${p.maxSpeed} kt`); setText('depth-max', p.spec.maxDepth ? `${p.spec.maxDepth} m` : '水上艦');
  setText('vessel-type', p.spec.type); setText('vessel-name', p.spec.name); setText('callsign', p.spec.callsign);
  setText('mission-location', `${config.mission?.title || ''} / ${config.name}`); setText('thermal-value', `${config.thermocline} m`);
  const silhouette = $('vessel-type').closest('.panel').querySelector('svg');
  silhouette.innerHTML = p.spec.type === 'DESTROYER'
    ? '<path d="M20 46 H297 L278 65 H54Z M69 45 V32 H91 V45 M123 45 V24 H171 V45 M180 45 V34 H201 V45 M220 45 V32 H246 V45 M135 24 V17 H159 V24 M150 17 V3 M129 8 H171"/><path d="M30 51 H285 M71 32 L57 25 M236 32 L258 25" class="vessel-detail"/>'
    : '<path d="M25 49 Q35 29 84 29 H219 Q254 30 281 45 L298 36 V58 L279 51 Q252 67 210 65 H81 Q40 64 25 49Z"/><path d="M139 29 V13 H170 L181 29 M150 13 V4 M157 13 V7 M64 32 V61 M247 35 V60"/><path d="M29 49 H279" class="vessel-detail"/>';
  document.querySelector('.env-row strong').textContent = `${config.current.heading}° / ${config.current.speed} kt`;
  syncOrders(); buildWeapons(); render();
}
function syncOrders() { for (const key of ['heading', 'speed', 'depth']) $(key).value = game.player.order[key]; updateOrders(); }
function updateOrders() {
  setText('heading-output', degree(Number($('heading').value))); setText('speed-output', `${$('speed').value} kt`); setText('depth-output', game?.player.spec.type === 'DESTROYER' ? '水上 / 0 m' : `${$('depth').value} m`);
  setText('attack-depth-output', `${$('attack-depth').value} m`);
}
function buildWeapons() {
  $('weapon-list').replaceChildren();
  for (const id of game.player.spec.weaponSlots) {
    const w = game.weapon(id); if (w.guidance === 'DECOY') continue;
    const button = document.createElement('button'); button.className = `weapon-card${id === selectedWeapon ? ' selected' : ''}`; button.dataset.weapon = id;
    button.setAttribute('aria-pressed', String(id === selectedWeapon));
    const icon = document.createElement('span'); icon.className = 'weapon-icon'; icon.textContent = w.guidance === 'DEPTH_CHARGE' ? '⋮' : '↗';
    const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = w.name;
    const detail = document.createElement('small'); detail.textContent = `${(w.range / 1000).toFixed(1)} km / ${w.guidance === 'DEPTH_CHARGE' ? 'DEPTH CHARGE' : `${w.speed} kt`}`;
    const ammo = document.createElement('span'); ammo.className = 'ammo'; info.append(name, detail); button.append(icon, info, ammo);
    button.onclick = () => { selectedWeapon = id; document.querySelectorAll('.weapon-card').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); render(); };
    $('weapon-list').append(button);
  }
}
const running = () => game && !paused && !game.result && !startDialog.open && !$('help-dialog').open;
$('start-btn').onclick = async () => {
  await audio.unlock();
  autoCommand = $('command-mode').value === 'auto';
  if (autoCommand) rate = 4;
  startDialog.close(); paused = guideEnabled && !autoCommand; audio.setActive(true);
  audio.effect('contact'); audio.speak('ソナー、配置完了。静粛航行で索敵を開始します。', 0, 'start');
  setText('pause-btn', 'Ⅱ'); render();
};
for (const key of ['heading', 'speed', 'depth']) $(key).addEventListener('input', () => { if (game && !autoCommand) game.order({ [key]: Number($(key).value) }); updateOrders(); });
$('attack-depth').oninput = updateOrders;
$('silent-btn').onclick = () => { if (game && !autoCommand) { game.order({ speed: 4 }); syncOrders(); game.log('静粛航行を指示。速力4 ktへ減速。', 'info', { sound: 'command', clip: 'silent', report: '微速、4ノット。静粛航行に移ります。' }); } };
$('evade-btn').onclick = () => { if (game && !autoCommand) { game.order({ heading: game.player.heading + 80, speed: game.player.maxSpeed, depth: game.player.spec.maxDepth ? Math.min(game.player.spec.maxDepth, config.thermocline + 80) : 0 }); syncOrders(); game.log('回避機動を指示。変針・増速します。', 'warning', { sound: 'command', clip: 'evade', report: '回避機動。変針、増速します。', priority: 1 }); } };
$('ping-btn').onclick = () => { if (running() && !autoCommand) { game.ping(); render(); } };
$('survey-scan').onclick = () => { if (running() && !autoCommand) { game.ping(); render(); } };
$('fire-btn').onclick = () => { if (running() && !autoCommand) { game.fire(selectedWeapon, Number($('attack-depth').value)); render(); } };
$('decoy-btn').onclick = () => { if (running() && !autoCommand) { game.fire('acoustic_decoy'); render(); } };
$('pause-btn').onclick = () => { if (!game || game.result) return; lessonAudio = false; advisorMessage = ''; paused = !paused; if (!paused) audio.unlock(); render(); };
$('rate-btn').onclick = () => { rate = rate === 8 ? 1 : rate * 2; render(); };
$('range-btn').onclick = () => { range = range === 10000 ? 5000 : range === 5000 ? 15000 : 10000; setText('range-btn', `${range / 1000} km ↻`); setText('radar-range', `RANGE ${(range / 1000).toFixed(1)} km`); document.querySelector('.bottom-right').textContent = `GRID / ${range / 4000} km`; };
function restart() { $('result-dialog').close(); prepare(); startDialog.showModal(); }
$('restart-btn').onclick = restart; $('play-again').onclick = restart;
function openReplay() {
  if (!game?.result) return;
  $('result-dialog').close(); replayIndex = 0; replayPlaying = false; replayElapsed = 0; tactical.reset(); tactical.range = wideCameraRange(); setText('camera-zoom', '拡大'); setText('tactical-source', '任務終了後・全情報公開');
  $('replay-time').max = game.replayLength() - 1; $('replay-time').value = 0;
  $('replay-controls').hidden = false; $('surveyor-console').hidden = true; setText('tactical-title', '3D戦闘リプレイ'); setText('replay-play', '▶ 再生');
  $('tactical-title').scrollIntoView({ block: 'start' });
}
$('replay-open').onclick = openReplay; $('replay-reopen').onclick = openReplay;
$('replay-close').onclick = () => { replayIndex = null; replayPlaying = false; $('replay-controls').hidden = true; tactical.range = 3400; setText('camera-zoom', '拡大'); $('surveyor-console').hidden = false; setText('tactical-source', '海図・観測情報から再構成'); setText('tactical-title', '3D戦術ビュー'); tactical.reset(); };
$('replay-play').onclick = () => { if (replayIndex >= game.replayLength() - 1) { replayIndex = 0; tactical.reset(); } replayPlaying = !replayPlaying; setText('replay-play', replayPlaying ? 'Ⅱ 停止' : '▶ 再生'); };
$('replay-time').oninput = e => { replayIndex = Number(e.target.value); tactical.reset(); };
$('review-run').onclick = () => $('result-dialog').close();
$('help-btn').onclick = () => { helpWasPaused = paused; lessonAudio = false; paused = true; $('help-dialog').showModal(); render(); };
$('close-help').onclick = () => $('help-dialog').close();
$('help-dialog').addEventListener('close', () => { paused = helpWasPaused; render(); });
document.addEventListener('keydown', e => {
  if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) || startDialog.open || $('help-dialog').open || $('result-dialog').open) return;
  if (e.code === 'Space') { e.preventDefault(); $('pause-btn').click(); }
  if (e.code === 'KeyP') $('ping-btn').click(); if (e.code === 'KeyD') $('decoy-btn').click();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { lessonAudio = false; if (running()) paused = true; render(); } });
function setGuide(enabled) {
  guideEnabled = enabled;
  $('guided-mode').checked = enabled; $('guide-pauses').checked = enabled;
  try { localStorage.setItem('silent-depth.guide', enabled ? 'on' : 'off'); } catch { /* Optional preference. */ }
}
$('guided-mode').checked = guideEnabled; $('guide-pauses').checked = guideEnabled;
$('guided-mode').onchange = () => setGuide($('guided-mode').checked);
$('guide-pauses').onchange = () => { setGuide($('guide-pauses').checked); render(); };
for (const lesson of LESSONS) {
  const item = document.createElement('li'); item.dataset.lesson = lesson.id; item.textContent = lesson.title; $('lesson-steps').append(item);
}
function renderAdvisor(v) {
  const assessment = advisor.get(v, equipment, config);
  const selected = assessment.options?.find(o => o.id === selectedOfficerOption);
  if (!selected) selectedOfficerOption = null;
  const advice = selected ? { ...selected, report: assessment.report, options: assessment.options } : assessment;
  const report = assessment.report;
  setText('officer-status', report.title); setText('officer-evidence', report.reasons.join(' '));
  setText('officer-distance', report.assessment); setText('officer-arrival', report.arrival);
  document.querySelector('.officer-report').dataset.level = report.level;
  const signature = JSON.stringify((assessment.options || []).map(o => [o.id, !!o.action, o.id === advice.id]));
  if ($('officer-options').dataset.signature !== signature) {
    $('officer-options').dataset.signature = signature;
    $('officer-options').replaceChildren(...(assessment.options || []).map((o, i) => {
      const button = document.createElement('button'); button.textContent = `${i === 0 ? '推奨 · ' : ''}${o.label}`;
      button.dataset.option = o.id; button.setAttribute('aria-pressed', String(o.id === advice.id));
      button.disabled = autoCommand || startDialog.open || !!v.result;
      button.onclick = () => {
        selectedOfficerOption = o.id; paused = true; lessonAudio = false;
        advisorMessage = '方針を選択しました。下の実行内容を確認して承認してください。まだ実行していません。'; render();
      };
      return button;
    }));
  }
  for (const button of $('officer-options').children) button.disabled = autoCommand || startDialog.open || !!v.result;
  const session = !startDialog.open && !$('help-dialog').open && !v.result;
  const checkpoint = ['evade', 'grounding'].includes(advice.id) ? advice.id : advice.lesson;
  const teachable = advice.lesson !== 'defend' || ['evade', 'grounding'].includes(advice.id);
  if (session && !autoCommand && guideEnabled && teachable && advice.action && !advisor.seenLessons.has(checkpoint)) {
    advisor.seenLessons.add(checkpoint); paused = true; lessonAudio = true;
    advisorMessage = '学習の節目で一時停止しました。実行内容を確認し、承認して進めてください。';
  }
  currentAdvice = advice;
  const lesson = LESSONS.find(l => l.id === advice.lesson);
  setText('advisor-stage', `${lesson.title} / NEXT ACTION`);
  setText('advisor-title', advice.title); setText('advisor-reason', advice.why); setText('advisor-changes', advice.changes);
  setText('lesson-explanation', lesson.text);
  setText('advisor-state', v.result ? '任務終了' : startDialog.open ? '出撃すると提案が始まります' : paused ? advisorMessage || '一時停止中。提案を承認すると実行して時間を再開します。' : advice.action ? '承認待ち · 戦況に応じて提案を更新します' : '進行中 · 今は待って大丈夫です');
  $('advisor-approve').disabled = autoCommand || !session || !advice.action;
  setText('advisor-approve', advice.action?.type === 'fire' ? '確認して1発発射 →' : advice.action?.type === 'evade' ? 'この回避案を実行 →' : '提案を承認して実行 →');
  $('advisor-manual').disabled = autoCommand || !session;
  $('advisor-locate').disabled = startDialog.open;
  for (const item of $('lesson-steps').children) {
    item.classList.toggle('complete', advisor.completed.has(item.dataset.lesson));
    item.classList.toggle('current', item.dataset.lesson === advice.lesson);
    if (item.dataset.lesson === advice.lesson) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    const title = LESSONS.find(l => l.id === item.dataset.lesson).title;
    item.textContent = `${advisor.completed.has(item.dataset.lesson) ? '✓ ' : ''}${title}`;
  }
}
$('advisor-approve').onclick = () => {
  if (autoCommand || !game || game.result || startDialog.open || $('help-dialog').open || !currentAdvice?.action) return;
  const reviewed = currentAdvice;
  const assessment = advisor.get(game.view(), equipment, config);
  const fresh = assessment.options?.find(o => o.id === selectedOfficerOption) || assessment;
  if (fresh.id !== reviewed.id || JSON.stringify(fresh.action) !== JSON.stringify(reviewed.action)) {
    paused = true; lessonAudio = false; advisorMessage = '戦況が変化したため、提案を更新しました。内容をもう一度確認してください。'; render(); return;
  }
  const action = fresh.action; let success = true;
  if (action.type === 'ping') success = game.ping();
  else if (action.type === 'fire') {
    const reason = game.fireReason(action.weapon);
    if (reason) { paused = true; advisorMessage = reason; render(); return; }
    selectedWeapon = action.weapon; $('attack-depth').value = action.depth; buildWeapons(); updateOrders();
    success = game.fire(action.weapon, action.depth);
  } else {
    if (action.type === 'evade' && action.decoy) {
      const reason = game.fireReason('acoustic_decoy');
      if (reason) { paused = true; advisorMessage = reason; render(); return; }
      game.fire('acoustic_decoy');
    }
    game.order(action.values); syncOrders();
    game.log(`提案を承認：${fresh.title}`, 'action', action.type === 'evade' ? { sound: 'command', clip: 'evade', report: '回避機動。変針、増速します。', priority: 1 } : null);
  }
  if (success) { advisor.acknowledge(action, game.time); selectedOfficerOption = null; lessonAudio = false; paused = false; advisorMessage = ''; audio.unlock(); }
  render();
};
$('advisor-manual').onclick = () => {
  if (autoCommand || !game || game.result || startDialog.open || $('help-dialog').open) return;
  if (currentAdvice) advisor.seenLessons.add(currentAdvice.lesson);
  selectedOfficerOption = null; lessonAudio = false; paused = false; advisorMessage = ''; audio.unlock(); render();
};
$('advisor-locate').onclick = () => {
  const target = $(currentAdvice?.focus || 'sonar');
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  target.classList.add('guide-highlight'); setTimeout(() => target.classList.remove('guide-highlight'), 2200);
};
$('auto-start-btn').onclick = () => {
  const submarine = ships.find(s => s.type === 'SUBMARINE');
  document.querySelector(`[data-id="${submarine.id}"]`).click();
  $('command-mode').value = 'auto'; $('command-mode').dispatchEvent(new Event('change')); $('start-btn').click();
};
$('command-mode').onchange = () => { $('guided-mode').disabled = $('command-mode').value === 'auto'; };
$('crew-toggle').onclick = () => {
  if (!game || game.result || startDialog.open || $('help-dialog').open) return;
  autoCommand = !autoCommand; selectedOfficerOption = null; lessonAudio = false; advisorMessage = '';
  paused = !autoCommand;
  if (autoCommand) { crew.nextDecision = game.time; audio.unlock(); }
  else rate = 1;
  game.log(autoCommand ? '艦長：指揮を引き受けます。各部署、配置につけ。' : '艦長：指揮を返します。一時停止して引き継ぎます。', 'info');
  render();
};
function renderCrew(v) {
  document.body.classList.toggle('observing', autoCommand);
  const plan = crew.inspect(v);
  setText('crew-mode', autoCommand ? '全自動観戦' : '手動指揮');
  setText('crew-toggle', autoCommand ? '自分で操艦を引き継ぐ' : '艦長に任せて観戦する');
  $('crew-toggle').disabled = startDialog.open || $('help-dialog').open || !!v.result;
  $('guide-pauses').disabled = autoCommand;
  setText('crew-phase', `${plan.phase}${autoCommand && paused ? ' / 一時停止' : ''}`);
  setText('crew-decision', v.result ? v.result.reason : plan.stations.captain);
  setText('crew-reason', plan.advice.why);
  for (const role of ['sonar','weapons','engineering','navigation']) setText(`crew-${role}`, plan.stations[role]);
  setText('advice-authorization', autoCommand ? '全自動観戦中：艦長が判断し、操艦・ピン・兵装を実行します。手動操作は指揮を引き継いでから行えます。' : '手動指揮では、提案の実行に承認が必要です。');
  if (autoCommand) setText('advisor-state', paused ? '観戦を一時停止中。▶で再開します。' : '艦長が指揮中 · この提案をもとに自動判断します');
  document.querySelectorAll('.weapon-card').forEach(b => b.disabled = autoCommand || !!v.result);
  const journal = $('crew-journal');
  const key = crew.lastDecision ? `${crew.lastDecision.time}:${crew.journal.length}` : 'empty';
  if (journal.dataset.key !== key) {
    journal.dataset.key = key;
    journal.replaceChildren(...crew.journal.slice(0, 12).map(d => {
      const row = document.createElement('div'); row.className = 'crew-log-entry';
      const title = document.createElement('strong'); title.textContent = `${timeLabel(d.time)} · ${d.phase} / ${d.title}`;
      const reason = document.createElement('p'); reason.textContent = d.reason;
      const command = document.createElement('p'); command.textContent = `実行：${d.changes}`;
      row.append(title, reason, command); return row;
    }));
    if (!crew.journal.length) journal.textContent = 'まだ自動指揮の記録はありません。観戦を開始すると判断と実行内容が残ります。';
  }
}
function render() {
  if (!game) return;
  const v = game.view(), p = v.player, c = v.contact;
  setText('crew-surveyor', v.survey.report);
  setText('surveyor-report', v.survey.report);
  $('surveyor-report').dataset.level = v.survey.level;
  setText('chart-coverage', `周辺1.8 km：既知 ${v.survey.known}% / 測深済 ${v.survey.measured}%`);
  $('survey-meter').style.width = `${v.survey.measured}%`;
  const scanCooldown = Math.max(0, Math.ceil(p.pingReady - v.time));
  $('survey-scan').disabled = autoCommand || !running() || scanCooldown > 0;
  setText('survey-scan-status', autoCommand ? '発信は艦長の判断に従います' : scanCooldown ? `次の発信まで ${scanCooldown}秒` : '敵に自艦方位が伝わります');
  renderAdvisor(v);
  renderCrew(v);
  const soundAllowed = !startDialog.open && !$('help-dialog').open && !document.hidden;
  audio.update(v, soundAllowed && (!paused || (lessonAudio && guideEnabled)), soundAllowed && !paused);
  const report = currentAdvice?.report;
  if (report && soundAllowed && (!paused || lessonAudio) && v.time > 3 && report.title !== lastOfficerReport && performance.now() - lastOfficerReportAt > 15000) {
    audio.speak(`ソナーより報告。${report.title}。${report.reasons[0]}`, report.level === 'danger' ? 2 : 1, report.level === 'danger' ? 'alarm' : report.level === 'caution' ? 'officer-caution' : 'officer-unknown');
    lastOfficerReport = report.title; lastOfficerReportAt = performance.now();
  }
  $('replay-reopen').hidden = !v.result;
  $('audio-test').disabled = !running();
  const objective = config.mission?.objective;
  setText('objective-progress', objective?.type === 'ESCAPE' ? `離脱区域まで ${(Math.max(0, distance(p, objective.zone) - objective.zone.radius) / 1000).toFixed(2)} km` : config.mission?.policy.mode === 'AMBUSH' && v.time < config.mission.policy.holdSeconds ? `待機終了まで ${Math.ceil(config.mission.policy.holdSeconds - v.time)}秒` : '成功条件：敵艦撃破');
  setText('clock', timeLabel(v.time)); setText('remaining', timeLabel(Math.max(0, config.timeLimit - v.time)));
  setText('pause-btn', paused ? '▶' : 'Ⅱ'); $('pause-btn').setAttribute('aria-label', paused ? '再開' : '一時停止'); setText('rate-btn', `${rate}×`);
  $('pause-btn').disabled = !!v.result || startDialog.open; $('rate-btn').disabled = !!v.result || startDialog.open;
  const health = Math.max(0, Math.round(p.health / p.spec.health * 100)); setText('hull-value', `${health}%`); $('hull-meter').style.width = `${health}%`; $('hull-meter').style.background = health < 40 ? 'var(--red)' : 'var(--teal)';
  setText('noise-value', `${Math.round(v.noise)} dB`); setText('stealth-status', v.cavitating ? '気泡発生' : p.speed <= 6 ? '静粛航行' : '通常航行'); $('stealth-status').classList.toggle('cavitating', v.cavitating);
  setText('actual-course', `実測 ${degree(p.heading)} / ${p.speed.toFixed(1)} kt / ${Math.round(p.depth)} m`);
  setText('bottom-value', `${Math.round(v.bottom)} m`); $('depth-marker').style.top = `${clamp(p.depth / v.bottom * 100, 4, 95)}%`; document.querySelector('.thermal-line').style.top = `${config.thermocline / v.bottom * 100}%`;
  setText('layer-status', p.spec.type === 'DESTROYER' ? '水上航行 · 深度は変更できません' : p.depth > config.thermocline ? '躍層の下側 · 水上からの音波を減衰' : '躍層の上側 · 浅海のキャビテーションに注意');
  const pingRemaining = Math.max(0, Math.ceil(p.pingReady - v.time));
  $('ping-btn').disabled = autoCommand || !running() || pingRemaining > 0; setText('ping-btn', pingRemaining ? `◎ 再充填 ${pingRemaining}s` : '◎ アクティブ・ピン  [P]');
  setText('sonar-mode', paused ? 'PAUSED' : c?.source === 'ACTIVE' ? 'ACTIVE FIX' : 'PASSIVE');
  document.body.classList.toggle('danger', v.warnings.length > 0);
  setText('radar-state', v.warnings.length ? `接近する兵装 ${v.warnings.length}\n回避を推奨` : c?.fixAt != null ? '測距データ追尾中\nLAST KNOWN POSITION' : '受動監視中\nBEARING ONLY'); $('radar-state').style.whiteSpace = 'pre-line';
  setText('contact-count', c ? '01' : '00'); setText('contact-name', c ? 'C-01' : '未探知'); setText('contact-source', c?.source || 'SEARCHING');
  setText('contact-bearing', c ? degree(c.bearing) : '— °'); setText('contact-range', c?.fixAt != null ? `${(distance(p, c) / 1000).toFixed(1)} km` : '— km');
  setText('contact-depth', c?.depth != null ? `${c.depth} m` : '— m');
  const age = c ? v.time - c.observedAt : 0; const confidence = c ? Math.round(c.confidence * clamp(1 - age / 60, 0.2, 1)) : 0;
  setText('contact-confidence', c ? `${confidence}%` : '— %'); $('confidence-meter').style.width = `${confidence}%`;
  setText('contact-note', c?.fixAt != null ? `${c.source === 'TMA' ? '運動解析による概算' : '反響による測距'} · ${Math.floor(v.time - c.fixAt)}秒前の位置。誤差 ±${Math.round(c.uncertainty + (v.time - c.fixAt) * 8)} m。時間経過で精度が低下します。` : '受動探知では方位のみ判明します。ピン、または変針を伴う継続観測で測距してください。');
  setText('analysis-title', v.warnings.length ? '高速接近音を検出 — 回避を推奨' : c ? `${c.classification}の信号を検出` : '海中音を監視しています');
  setText('analysis-text', v.warnings.length ? `方位 ${degree(v.warnings[0].bearing)}。デコイを展開し、大きく変針してください。` : c ? `${degree(c.bearing)}から周期的な機関音。${c.fixAt != null ? '測距解を取得。攻撃深度を確認して兵装を選択してください。' : p.spec.type === 'SUBMARINE' ? '距離は未確定。低速で観測・接近し、必要ならピンで確認してください。' : '距離は未確定。能動ピンで測距、または変針してTMAを続けてください。'}` : '信号を分離しています。速力を落とすと自艦の雑音が減り、探知しやすくなります。');
  setText('signal-chip', `S/N ${c ? c.signal.toFixed(1) : '—'} dB`); setText('class-chip', `艦種 ${c?.classification || '未識別'}`); setText('tma-chip', `TMA ${v.samples} / ${config.sonar.tmaSamples} 観測`);
  setText('sonar-hint', paused ? '一時停止中 · ▶ で再開' : v.cavitating ? 'キャビテーション発生。減速または深度変更を推奨' : c ? 'ピンは自艦方位を暴露します。発信後は移動を' : '減速すると微弱な信号を検知しやすくなります');
  [...$('spectrum').children].forEach((bar, i) => { const amp = c ? 55 : 14; bar.style.height = `${8 + Math.abs(Math.sin(i * 1.7 + v.time * .2) * Math.cos(i * .6)) * amp}px`; });
  document.querySelectorAll('.weapon-card').forEach(b => { const id = b.dataset.weapon; b.querySelector('.ammo').textContent = String(p.ammo[id]).padStart(2, '0'); });
  const reason = game.fireReason(selectedWeapon); $('fire-btn').disabled = autoCommand || !running() || !!reason;
  setText('weapon-hint', reason || (game.weapon(selectedWeapon).guidance === 'DEPTH_CHARGE' ? '指定深度で炸裂します。投下位置と攻撃深度を確認。' : '発射可能。接触方位へ発射し、近距離で追尾を開始。'));
  $('decoy-btn').disabled = autoCommand || !running() || !!game.fireReason('acoustic_decoy'); setText('decoy-count', p.ready.acoustic_decoy > v.time ? `${Math.ceil(p.ready.acoustic_decoy - v.time)}s` : String(p.ammo.acoustic_decoy));
  for (const id of ['heading', 'speed', 'depth', 'attack-depth', 'silent-btn', 'evade-btn']) $(id).disabled = autoCommand || !!v.result || (id === 'depth' && p.spec.type === 'DESTROYER');
  if (v.events[0]?.id !== logId) {
    logId = v.events[0]?.id; $('event-log').replaceChildren(...v.events.map(e => { const row = document.createElement('div'); row.className = `log-entry ${e.type}`; const t = document.createElement('time'); t.textContent = timeLabel(e.time); const text = document.createElement('span'); text.textContent = e.text; row.append(t, text); return row; }));
  }
  if (v.result && !resultShown) { resultShown = true; setText('result-title', v.result.won ? (config.mission?.objective.type === 'ESCAPE' ? '離脱成功。帰還航路へ。' : '任務成功。海に静寂を。') : '任務終了。次の航海へ。'); setText('result-text', v.result.reason); $('result-stats').replaceChildren(...[`作戦時間 ${timeLabel(v.time)}`, `発射数 ${game.shots}`, `能動ピン ${game.pings}`, `船体 ${health}%`, ...(autoCommand ? [`自動判断 ${crew.journal.length}回`] : [])].map(t => { const s = document.createElement('span'); s.textContent = t; return s; })); $('result-dialog').showModal(); }
}
function draw(now) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
  const w = rect.width, h = rect.height, cx = w / 2, cy = h / 2, radius = Math.min(w, h) * .405;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const v = game?.view(), p = v?.player;
  const plot = pos => ({ x: cx + (pos.x - p.x) / range * radius, y: cy + (pos.y - p.y) / range * radius });
  const point = (angle, r) => ({ x: cx + Math.sin(angle * Math.PI / 180) * r, y: cy - Math.cos(angle * Math.PI / 180) * r });
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius); gradient.addColorStop(0, '#10352f'); gradient.addColorStop(1, '#0b2021'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  // Muted seabed contours convey the environment, not hidden tactical objects.
  ctx.strokeStyle = '#2c4c442f'; ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) { ctx.beginPath(); for (let x = 0; x <= w; x += 5) { const y = h * .65 + i * 17 + Math.sin(x / 90 + i * .2 + (p?.x || 0) / 10000) * 45; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
  if (v && !paused) {
    const angle = v.time * .08;
    for (let i = 0; i < 36; i++) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, radius, angle - i * .014, angle - (i + 1) * .014, true); ctx.fillStyle = `rgba(94,210,172,${.045 * (1 - i / 36)})`; ctx.fill(); }
  }
  ctx.restore();
  for (let ring = 1; ring <= 4; ring++) { ctx.beginPath(); ctx.arc(cx, cy, radius * ring / 4, 0, Math.PI * 2); ctx.strokeStyle = ring === 4 ? '#467b6d' : '#2c514a'; ctx.lineWidth = ring === 4 ? 1.2 : .7; ctx.stroke(); }
  ctx.setLineDash([2, 5]); ctx.strokeStyle = '#31534c'; ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 5) { const major = a % 30 === 0, p1 = point(a, radius + 4), p2 = point(a, radius + (major ? 11 : 7)); ctx.strokeStyle = major ? '#668f82' : '#38574f'; ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); if (major) { const t = point(a, radius + 23); ctx.fillStyle = a === 0 ? '#a0e8c8' : '#789b91'; ctx.fillText(a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a).padStart(3, '0'), t.x, t.y); } }
  for (let ring = 1; ring < 4; ring++) { ctx.fillStyle = '#668e80'; ctx.font = '8px monospace'; ctx.fillText(`${(range * ring / 4000).toFixed(1)}`, cx + 12, cy - radius * ring / 4 + 9); }
  if (!v) return;
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2); ctx.clip();
  if (config.mission?.objective.type === 'ESCAPE') {
    const zone = config.mission.objective.zone, a = plot(zone);
    ctx.strokeStyle = '#8cd5f0'; ctx.fillStyle = '#8cd5f01a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(a.x, a.y, zone.radius / range * radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const label = distance(p, zone) > range ? point(bearing(p, zone), radius * .7) : a;
    ctx.fillStyle = '#9bdded'; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText('離脱区域', label.x, label.y - 16);
  }
  if (crew?.trail.length > 1) {
    ctx.strokeStyle = '#6cc6a64d'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.beginPath();
    crew.trail.forEach((t, i) => { const a = plot(t); i ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (v.contact) {
    const c = v.contact, fix = c.fixAt != null, loc = fix ? plot(c) : point(c.bearing, radius * .87);
    const endpoint = point(c.bearing, radius);
    ctx.strokeStyle = '#d9b26b'; ctx.lineWidth = 1; ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(fix ? loc.x : endpoint.x, fix ? loc.y : endpoint.y); ctx.stroke(); ctx.setLineDash([]);
    if (fix) {
      const uncertainty = (c.uncertainty + (v.time - c.fixAt) * 8) / range * radius;
      ctx.fillStyle = '#e5b76d0c'; ctx.strokeStyle = '#cfa76660'; ctx.beginPath(); ctx.arc(loc.x, loc.y, uncertainty, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#e5b76d'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(loc.x, loc.y - 7); ctx.lineTo(loc.x + 6, loc.y); ctx.lineTo(loc.x, loc.y + 7); ctx.lineTo(loc.x - 6, loc.y); ctx.closePath(); ctx.stroke();
    }
    const label = fix && distance(p, c) > range ? point(bearing(p, c), radius * .72) : loc;
    ctx.fillStyle = '#e5bf80'; ctx.font = '10px monospace'; ctx.textAlign = label.x > cx + radius * .5 ? 'right' : 'left';
    const ox = ctx.textAlign === 'right' ? -12 : 12;
    ctx.fillText('C-01', label.x + ox, label.y - 10); ctx.font = '8px monospace'; ctx.fillText(fix ? `${(distance(p, c) / 1000).toFixed(1)} km${distance(p,c) > range ? ' / OUT' : ''}` : `${degree(c.bearing)} / RANGE ?`, label.x + ox, label.y + 4);
  }
  for (const projectile of v.projectiles) { const a = plot(projectile); ctx.fillStyle = '#f19781'; ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(projectile.heading * Math.PI / 180); ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(3, 4); ctx.lineTo(-3, 4); ctx.closePath(); ctx.fill(); ctx.restore(); }
  for (const d of v.decoys) { const a = plot(d); ctx.strokeStyle = '#9bb9d2'; ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, Math.PI * 2); ctx.stroke(); }
  for (const e of v.effects) { const a = plot(e), age = v.time - e.at; ctx.strokeStyle = e.type === 'ping' ? `rgba(112,239,199,${Math.max(0, 1 - age / 12)})` : `rgba(247,164,102,${Math.max(0, 1 - age / 12)})`; ctx.lineWidth = e.type === 'ping' ? 2 : 1; ctx.beginPath(); ctx.arc(a.x, a.y, age * (e.type === 'ping' ? 1500 : 80) / range * radius, 0, Math.PI * 2); ctx.stroke(); }
  for (const warning of v.warnings) { const a = point(warning.bearing, radius * .92); ctx.fillStyle = '#ed847d'; ctx.font = '17px monospace'; ctx.textAlign = 'center'; ctx.fillText('!', a.x, a.y); }
  const headingTip = point(p.heading, radius * .22); ctx.strokeStyle = '#72d7b966'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(headingTip.x, headingTip.y); ctx.stroke(); ctx.setLineDash([]);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(p.heading * Math.PI / 180); ctx.shadowColor = '#66e1b4'; ctx.shadowBlur = 12; ctx.fillStyle = '#8be9c9'; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#8cb8a7'; ctx.font = '8px monospace'; ctx.textAlign = 'center'; ctx.fillText(p.spec.callsign, cx, cy + 23); ctx.restore();
}
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .25) : 0; last = now;
  if (running()) {
    let remaining = dt * rate;
    while (remaining > 0 && !game.result) {
      if (autoCommand && crew.step(game)) {
        syncOrders();
        if (crew.lastDecision.action.type === 'fire') {
          selectedWeapon = crew.lastDecision.action.weapon;
          $('attack-depth').value = crew.lastDecision.action.depth; buildWeapons(); updateOrders();
        }
      }
      const step = Math.min(remaining, 0.2); game.tick(step); remaining -= step;
    }
  }
  if (now - uiAt > 150) { render(); uiAt = now; }
  draw(now);
  if (game) {
    if (replayIndex !== null) {
      if (replayPlaying && !document.hidden && !$('help-dialog').open) {
        replayElapsed += dt * 4;
        if (replayElapsed >= 1) { replayIndex = Math.min(game.replayLength() - 1, replayIndex + Math.floor(replayElapsed)); replayElapsed %= 1; }
        if (replayIndex >= game.replayLength() - 1) { replayPlaying = false; setText('replay-play', '▶ 再生'); }
      }
      const replay = game.replayAt(replayIndex);
      if (replay) { tactical.draw(replay, config.thermocline); $('replay-time').value = replayIndex; setText('replay-clock', timeLabel(replay.time)); }
    } else tactical.draw(game.view(), config.thermocline);
  }
  requestAnimationFrame(frame);
}
load(); requestAnimationFrame(frame);
