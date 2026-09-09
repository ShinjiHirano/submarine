import { bearing, distance, delta, wrap } from './game.js';
import { sonarReport, submarineOptions } from './officer.js';

export const LESSONS = [
  { id: 'listen', title: '1. 探知', text: 'まず4 ktで静かに進みます。機関音が聞こえると方位線が現れます。方位は方向で、まだ距離はわかりません。' },
  { id: 'measure', title: '2. 測距', text: '潜水艦は低速で観測・接近し、距離の裏付けを集めます。ピンは自艦方位を明かす代わりに距離を確かめる選択です。駆逐艦は能動捜索を基本とします。' },
  { id: 'attack', title: '3. 攻撃', text: '射程に合う兵装と攻撃深度を確認して発射します。魚雷は届くまで時間がかかります。発射後すぐに連射する必要はありません。' },
  { id: 'defend', title: '4. 回避・継続', text: '接近警報が出たら攻撃より回避を優先。デコイを出し、大きく変針して離れます。警報がなければ追尾と測距更新を続けます。' }
];

// Advice uses only the same observations available to the player.
export function advise(v, equipment, config, memory = {}) {
  const p = v.player, c = v.contact;
  const choice = (id, title, why, changes, action = null, lesson = 'defend', focus = 'sonar') => ({ id, title, why, changes, action, lesson, focus });
  const safeDepth = Math.max(0, Math.min(p.spec.maxDepth, Math.floor((v.bottom - config.bottom.clearance - 25) / 5) * 5));
  const available = id => p.ammo[id] > 0 && (p.ready[id] || 0) <= v.time;
  if (v.result) return choice('ended', '任務終了。次の航海に備えましょう', v.result.reason, '「次の出撃へ」で、ガイドを最初から試せます。');
  if (p.depth > v.bottom - config.bottom.clearance - 15 || p.order.depth > v.bottom - config.bottom.clearance) {
    return choice('grounding', '海底から離れましょう', '現在または目標の深度が海底に近すぎます。接触すると船体が損傷します。', `目標深度 ${safeDepth} m、速力 4 kt。`, { type: 'order', values: { depth: safeDepth, speed: 4 } }, 'defend', 'depth');
  }
  if (v.warnings.length) {
    if (v.time < (memory.evadeUntil || 0)) return choice('evading', '回避機動を続けています', '短い間隔で何度も変針すると、その場で旋回してしまいます。今の針路でデコイから離れます。', `あと ${Math.ceil(memory.evadeUntil - v.time)} 秒は針路を維持。警報はまだ継続中です。`);
    const decoyActive = v.decoys.some(d => d.expires > v.time && distance(p, d) < d.radius);
    const useDecoy = available('acoustic_decoy') && !decoyActive;
    const heading = Math.round(wrap(v.warnings[0].bearing + 110));
    const depth = p.spec.maxDepth ? Math.min(safeDepth, config.thermocline + 80) : 0;
    return choice('evade', '魚雷接近。回避を優先してください', '音の発生源へ敵魚雷を誘い、自艦は大きく変針して離れます。生存を優先するため、一時的に高速航行します。', `${useDecoy ? 'デコイ1基を消費。' : decoyActive ? '展開済みデコイを利用。' : 'デコイは使用できません。'}針路 ${heading}°、速力 ${p.maxSpeed} kt${p.spec.maxDepth ? `、深度 ${depth} m` : ''}。`, { type: 'evade', values: { heading, speed: p.maxSpeed, depth }, decoy: useDecoy }, 'defend', 'decoy-btn');
  }
  if (v.time < (memory.evadeUntil || 0)) return choice('evading', '安全な距離まで離脱します', '接近警報は消えました。急いで元の針路へ戻らず、回避を終えてから索敵に戻ります。', `あと ${Math.ceil(memory.evadeUntil - v.time)} 秒、現在の針路を維持。`);
  const sonar = equipment.sonars.find(s => s.id === p.spec.activeSonar);
  const pingReady = p.pingReady <= v.time;
  if (!c) {
    if (p.order.speed > 4 || v.cavitating || !memory.listenOrdered) return choice('listen', 'まず減速して、敵の音を探しましょう', '自艦のエンジン音が大きいと敵の小さな音が埋もれます。低速にして自動解析を待ちます。', '目標速力を4 ktに変更。針路と深度は維持します。', { type: 'listen', values: { speed: 4 } }, 'listen', 'speed');
    if (v.time < (memory.searchAt || 0) + 12 || p.speed > 5) return choice('listening', 'ソナー員が解析しています', '減速と観測には少し時間がかかります。何も操作せず待って大丈夫です。', '方位が表示されたら、次はピンで距離を調べます。', null, 'listen');
    if (pingReady) return choice('search-ping', '能動ソナーで周囲を確認しましょう', '受動ソナーで接触が得られません。ピンで周辺を測距します。反響がなくても自艦の方位は敵へ伝わります。', `ピンを1回発信。再使用まで${sonar.cooldown}秒。`, { type: 'ping' }, 'measure', 'ping-btn');
    return choice('search-wait', '受動索敵を続けましょう', 'ピンは再充填中です。距離が遠い場合や水温躍層を挟む場合、反響が得られないことがあります。', `4 ktで観測を継続。ピン再使用まで${Math.ceil(p.pingReady - v.time)}秒。`, null, 'listen');
  }
  if (c.fixAt == null || c.depth == null || v.time - c.fixAt > 35) {
    if (pingReady) return choice('measure', 'ピンで距離と深度を確認しましょう', c.fixAt == null ? '今わかっているのは敵の方向だけです。測距すると兵装と攻撃深度を選べます。自艦の方位も敵に知られます。' : '測距情報が古い、または深度が不明です。敵は移動するため、射撃前に更新します。', `方位 約${Math.round(c.bearing)}°の接触を測距。ピンを1回発信し、再使用まで${sonar.cooldown}秒。`, { type: 'ping' }, 'measure', 'ping-btn');
    return choice('measure-wait', '方位を追尾し、ピンの再充填を待ちましょう', '距離・深度の情報が十分ではありません。今は魚雷の無駄撃ちを避けます。', `再充填まで${Math.ceil(p.pingReady - v.time)}秒。接触が遠い場合は手動で方位方向へ接近することもできます。`, null, 'measure', 'ping-btn');
  }
  const range = distance(p, c), heading = Math.round(bearing(p, c));
  const offensive = p.spec.weaponSlots.map(id => equipment.weapons.find(w => w.id === id)).filter(w => w.guidance !== 'DECOY' && p.ammo[w.id] > 0);
  const fireable = offensive.find(w => available(w.id) && range <= (w.id === 'depth_charge_mk9' ? w.radius * .65 : w.range) && (w.guidance !== 'DEPTH_CHARGE' || w.id === 'depth_charge_mk9' || Math.abs(delta(p.heading, c.bearing)) <= 60));
  if (fireable && v.time >= (memory.lastShotAt ?? -Infinity) + 25) {
    const depth = Math.round(c.depth / 10) * 10;
    return choice(`fire:${fireable.id}`, '兵装と深度を合わせて攻撃しましょう', `推定距離 ${(range / 1000).toFixed(1)} km。${fireable.name}の有効範囲内です。${fireable.id === 'depth_charge_mk9' ? '自艦位置から投下します。' : '最後に測距した位置を狙います。'}命中は保証されません。`, `${fireable.name}を1発消費。攻撃深度 ${depth} mで発射。再装填 ${fireable.cooldown}秒。`, { type: 'fire', weapon: fireable.id, depth }, 'attack', 'fire-btn');
  }
  if (!offensive.length) return choice('empty', '攻撃用の弾薬を使い切りました', 'この任務では補給できません。回避を続けるか、任務をやり直して発射間隔と射程を見直しましょう。', '「任務をやり直す」で、もう一度練習できます。');
  const desiredSpeed = p.spec.type === 'SUBMARINE' ? 8 : 30;
  if (Math.abs(delta(p.order.heading, heading)) > 15 || Math.abs(p.order.speed - Math.min(desiredSpeed, p.maxSpeed)) > 1) {
    return choice('approach', '接触方向へ進み、攻撃の機会を作りましょう', p.spec.type === 'SUBMARINE' ? '低めの速力で敵の方向へ進みます。発射した魚雷を追跡しつつ、次の測距を待ちましょう。' : '爆雷やヘッジホッグは近距離用です。敵の方向へ接近します。高速航行中は自己雑音が増えます。', `針路 ${heading}°、速力 ${Math.min(desiredSpeed, p.maxSpeed)} kt。弾薬は消費しません。`, { type: 'order', values: { heading, speed: Math.min(desiredSpeed, p.maxSpeed) } }, memory.fired ? 'defend' : 'attack', 'heading');
  }
  return choice('monitor', memory.fired ? '魚雷の到達と敵の反応を待ちましょう' : '射程内への接近と再装填を待ちましょう', memory.fired ? '発射しても即座には命中しません。敵のデコイで外れる場合もあります。接近警報が出たら回避へ切り替えます。' : '針路は設定済みです。何も操作せず航行を続けて大丈夫です。', `推定距離 ${(range / 1000).toFixed(1)} km。追尾・測距更新・回避を繰り返し、敵艦撃破を目指します。`, null, memory.fired ? 'defend' : 'attack');
}

export class Advisor {
  constructor() { this.memory = {}; this.completed = new Set(); this.seenLessons = new Set(); this.eventId = 0; }
  observe(view) {
    if (view.contact) this.completed.add('listen');
    if (view.contact?.fixAt != null) this.completed.add('measure');
    for (const e of view.events.filter(e => e.id > this.eventId).reverse()) {
      if (e.audio?.sound === 'launch') { this.memory.fired = true; this.memory.lastShotAt = e.time; this.completed.add('attack'); }
      if (e.audio?.clip === 'evade') { this.memory.evadeUntil = e.time + 25; this.completed.add('defend'); }
    }
    this.eventId = Math.max(this.eventId, ...view.events.map(e => e.id));
  }
  get(view, equipment, config) {
    this.observe(view);
    const base = advise(view, equipment, config, this.memory);
    const report = sonarReport(view, equipment, config);
    if (view.contact && this.memory.observationStarted == null) this.memory.observationStarted = view.time;
    if (view.contact?.source === 'ACTIVE') this.memory.observationStarted = view.time;
    const mission = config.mission;
    const option = (id, title, why, changes, action, lesson = 'defend') => ({ id, title, why, changes, action, lesson, focus: 'heading', report, options: [] });
    if (!['ended', 'grounding', 'evade', 'evading'].includes(base.id)) {
      if (mission?.objective.type === 'ESCAPE') {
        const goal = mission.objective.zone, p = view.player, heading = Math.round(bearing(p, goal));
        const depth = Math.max(0, Math.min(p.spec.maxDepth, config.thermocline + 80, Math.floor((view.bottom - config.bottom.clearance - 25) / 5) * 5));
        const remaining = Math.max(0, distance(p, goal) - goal.radius);
        const quiet = mission.policy.quietWithin != null && remaining <= mission.policy.quietWithin;
        const speed = quiet ? Math.min(p.maxSpeed, mission.policy.quietSpeed || 6) : p.maxSpeed;
        const change = Math.abs(delta(p.order.heading, heading)) > 8 || p.order.speed !== speed || p.order.depth !== depth;
        const why = quiet ? '離脱区域が近づきました。減速して自己雑音を抑え、周囲を聴きながら進みます。敵が追跡を失ったと断定はできません。接近警報時は回避を優先します。' : 'この任務の目的は生還です。既に位置を測られたため、速力を使って離脱し、接近警報時だけ回避を優先します。';
        return option('mission-escape', quiet ? '減速して、離脱区域へ進みます' : '攻撃を避け、離脱区域へ向かいます', (mission.rules?.noAttack ? '攻撃は禁止、デコイは使用できます。' : '') + why, `離脱区域まで ${remaining.toFixed(0)} m。針路 ${heading}°、速力 ${speed} kt、深度 ${depth} m。`, change ? { type: 'order', intent: 'escape', values: { heading, speed, depth } } : null);
      }
      if (mission?.policy.mode === 'AMBUSH' && view.time < mission.policy.holdSeconds) {
        return option('mission-ambush', '推進を止めて、敵の接近を待ちます', '敵の通過が予想される海域です。追いかけず、受動ソナーで観測します。海流による漂流は続きます。警報時は待機を中断して回避します。', `待機終了まで ${Math.ceil(mission.policy.holdSeconds - view.time)}秒。指示速力0 kt。ピン・兵装は使いません。`, view.player.order.speed !== 0 || !this.memory.ambushOrdered ? { type: 'order', intent: 'ambush', values: { speed: 0 } } : null, 'listen');
      }
    }
    if (view.player.spec.type !== 'SUBMARINE' || ['ended', 'grounding', 'evade', 'evading', 'empty'].includes(base.id)) return { ...base, report, options: [] };
    const options = submarineOptions(view, equipment, config, this.memory, report);
    return { ...options[0], report, options };
  }
  acknowledge(action, time) {
    if (action.intent === 'ambush') this.memory.ambushOrdered = true;
    if (action.intent === 'observe') this.memory.observeUntil = time + 45;
    if (action.intent === 'withdraw') { this.memory.withdrawUntil = time + 40; this.memory.withdrawAfterShot = this.memory.lastShotAt ?? time; }
    if (action.type === 'listen') { this.memory.listenOrdered = true; this.memory.searchAt = time; }
    if (action.type === 'evade') { this.memory.evadeUntil = time + 25; this.completed.add('defend'); }
  }
}
