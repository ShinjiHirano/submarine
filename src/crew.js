import { Advisor } from './advisor.js';
import { wrap, clamp } from './game.js';

export function prepareCrewOrder(view, advice, equipment, config) {
  const p = view.player;
  const action = advice.action ? structuredClone(advice.action) : null;
  const stations = {
    sonar: `${advice.report.title}。${advice.report.assessment}`,
    weapons: `攻撃兵装の残数 ${p.spec.weaponSlots.filter(id => equipment.weapons.find(w => w.id === id)?.guidance !== 'DECOY').reduce((sum, id) => sum + (p.ammo[id] || 0), 0)}。測距と射撃機会を監視。`,
    engineering: `実速 ${p.speed.toFixed(1)} kt、深度 ${Math.round(p.depth)} m。${view.cavitating ? '気泡発生を確認。静粛性が低下。' : '機関状態を監視。'}`,
    navigation: `現針路 ${Math.round(p.heading)}°、指示 ${Math.round(p.order.heading)}°。海底まで ${Math.round(view.bottom - p.depth)} m。`,
    surveyor: view.survey?.report || '海底情報を確認中。',
    captain: advice.title
  };
  let veto = '';
  if (action?.type === 'fire') {
    const w = equipment.weapons.find(w => w.id === action.weapon);
    if (!w || !p.spec.weaponSlots.includes(w.id) || p.ammo[w.id] <= 0 || p.ready[w.id] > view.time) veto = '砲雷長：残弾・再装填を再確認。発射を保留します。';
    else stations.weapons = `${w.name}、1発準備。攻撃深度 ${action.depth} m、残数 ${p.ammo[w.id]}。`;
  }
  if (action?.decoy && (p.ammo.acoustic_decoy <= 0 || p.ready.acoustic_decoy > view.time)) {
    action.decoy = false;
    stations.weapons = 'デコイは使用できません。操艦による回避を継続。';
  } else if (action?.decoy) stations.weapons = 'デコイ1基を準備。回避操艦と同時に展開。';
  if (action?.values) {
    if (action.values.heading != null) action.values.heading = Math.round(wrap(action.values.heading)) % 360;
    if (action.values.speed != null) action.values.speed = clamp(action.values.speed, 0, p.maxSpeed);
    const safe = Math.max(0, Math.min(p.spec.maxDepth, Math.floor((view.bottom - config.bottom.clearance - 25) / 5) * 5));
    if (action.values.depth != null) action.values.depth = clamp(action.values.depth, 0, safe);
    stations.engineering = `機関長：速力 ${action.values.speed ?? p.order.speed} kt、深度 ${action.values.depth ?? Math.round(p.order.depth)} mを提案。${action.type === 'evade' ? '静粛性より緊急回避を優先。' : '艦の性能・海底余裕を確認。'}`;
    stations.navigation = `航海長：進路案、針路 ${action.values.heading ?? Math.round(p.order.heading)}°。${action.intent === 'withdraw' ? '接触から離れる進路。' : action.intent === 'observe' ? '接触方位を観測する進路。' : '変針と深度の安全余裕を確認。'}`;
  }
  if (veto) stations.weapons = veto;
  if (advice.report.arrival) stations.weapons += ` ${advice.report.arrival}`;
  const phase = view.result ? '任務終了' : advice.id === 'mission-escape' ? '離脱区域へ航行' : advice.id === 'mission-ambush' ? '待ち伏せ' : action?.type === 'evade' || advice.id === 'evading' ? '緊急回避'
    : action?.intent === 'withdraw' || advice.id === 'officer-withdrawing' ? '離脱'
    : action?.type === 'fire' ? '攻撃' : action?.type === 'ping' ? '測距'
    : action?.intent === 'observe' || advice.id === 'officer-observe' || advice.id === 'approach' ? (p.spec.type === 'SUBMARINE' ? '隠密接近・観測' : '接近・観測') : '索敵・監視';
  return { advice, action: veto || view.result ? null : action, stations, phase, veto };
}

// The controller reads game.view() only; game is used solely as a command interface.
export class Crew {
  constructor(equipment, config, advisor = new Advisor()) {
    this.equipment = equipment; this.config = config; this.advisor = advisor;
    this.nextDecision = 0; this.lastDecision = null; this.journal = []; this.trail = []; this.snapshot = null;
  }
  inspect(view) {
    this.snapshot = prepareCrewOrder(view, this.advisor.get(view, this.equipment, this.config), this.equipment, this.config);
    return this.snapshot;
  }
  step(game, enabled = true) {
    if (!enabled) return false;
    const view = game.view();
    if (view.result) return false;
    if (!this.trail.length || view.time - this.trail.at(-1).time >= 5) {
      this.trail.push({ x: view.player.x, y: view.player.y, time: view.time });
      if (this.trail.length > 400) this.trail.shift();
    }
    if (view.time + 1e-6 < this.nextDecision) return false;
    this.nextDecision = view.time + 2;
    const plan = this.inspect(view), action = plan.action;
    if (!action) return false;
    let success = true, reason = '';
    if (action.type === 'ping') success = game.ping();
    else if (action.type === 'fire') {
      reason = game.fireReason(action.weapon);
      success = !reason && game.fire(action.weapon, action.depth);
    } else {
      if (action.type === 'evade' && action.decoy && !game.fireReason('acoustic_decoy')) game.fire('acoustic_decoy');
      game.order(action.values);
    }
    if (!success) {
      game.log(`砲雷長：実行を保留。${reason || '装備は準備中です。'}`, 'warning'); return false;
    }
    this.advisor.acknowledge(action, view.time);
    const decision = { time: view.time, phase: plan.phase, title: plan.advice.title, reason: plan.advice.why, changes: plan.advice.changes, action, stations: plan.stations };
    this.lastDecision = decision; this.journal.unshift(decision); this.journal.length = Math.min(80, this.journal.length);
    // Weapon and sonar commands already produce their own reports. Navigation gets a bridge acknowledgement.
    const voice = action.type === 'evade' ? { sound: 'command', clip: 'evade', report: '艦長、緊急回避を命令。砲雷長、デコイ準備。航海長、変針。機関長、増速。', priority: 2 }
      : action.values ? { sound: 'command', clip: action.intent === 'withdraw' ? 'crew-withdraw' : 'crew-navigation', report: `艦長、${plan.advice.title}。航海長、針路${action.values.heading ?? Math.round(view.player.order.heading)}度。機関長、${action.values.speed ?? view.player.order.speed}ノット。` } : null;
    game.log(`艦長【${plan.phase}】：${plan.advice.title}／${plan.advice.changes}`, 'action', voice);
    return true;
  }
}
