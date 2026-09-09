import { bearing, distance, wrap } from './game.js';

// Estimates are based exclusively on player-visible measurements and event history.
export function sonarReport(v, equipment, config) {
  const recent = v.events.filter(e => v.time - e.time < 75);
  const reasons = [];
  let level = 'unknown', title = '被探知状況は不明';
  if (config.initialDetection && v.time < 75) { level = 'caution'; title = '敵に位置を測られた状態'; reasons.push('任務開始時の状況報告で、敵の測距成功が確認されています。'); }
  if (v.cavitating) { level = 'caution'; title = '自艦の騒音が増大'; reasons.push('キャビテーション発生。敵に音を拾われやすい航行状態です。'); }
  if (recent.some(e => e.audio?.sound === 'ping')) { level = 'caution'; title = '自艦方位を暴露'; reasons.push('こちらのピンを発信済み。敵には自艦の方向が伝わります。'); }
  if (recent.some(e => e.audio?.sound === 'launch')) { level = 'caution'; title = '攻撃後・反撃を警戒'; reasons.push('兵装を発射しました。敵の反応を観測し、離脱方向を確保します。'); }
  if (recent.some(e => e.audio?.sound === 'intercept')) { level = 'caution'; title = '敵が能動捜索中'; reasons.push('敵のピンを傍受。こちらを探している可能性がありますが、探知されたと断定はできません。'); }
  if (v.warnings.length) { level = 'danger'; title = '接近兵装を探知・回避優先'; reasons.push(`高速接近音、方位 ${Math.round(v.warnings[0].bearing)}°。攻撃判断より生存を優先します。`); }
  if (!reasons.length) reasons.push('直近の明確な警戒材料はありません。ただし、敵に気づかれていないことを保証する情報でもありません。');
  const c = v.contact, fixed = c?.fixAt != null;
  const range = fixed ? distance(v.player, c) : null;
  const uncertainty = fixed ? (c.uncertainty || 0) + (v.time - c.fixAt) * 8 : null;
  const torpedo = equipment.weapons.find(w => v.player.spec.weaponSlots.includes(w.id) && w.speed > 0 && v.player.ammo[w.id] > 0);
  const eta = range != null && torpedo ? Math.round(range / (torpedo.speed * config.knotsToMeters)) : null;
  return { level, title, reasons, range, uncertainty, eta,
    assessment: range == null ? '方位だけでは、あと何km接近できるか判断できません。距離は未確定です。'
      : `推定 ${(range / 1000).toFixed(1)} km、誤差目安 ±${Math.round(uncertainty)} m。${range < 1000 ? '近距離です。これ以上の接近は慎重に。' : range <= 2000 ? '攻撃を検討する距離です。発見時の回避余裕にも注意。' : 'まだ距離があります。低速で接近するか、遠距離攻撃の不確実さを受け入れるか判断できます。'}`,
    arrival: eta == null ? '距離または使用可能な魚雷が不明のため到達時間を算出できません。' : `${torpedo.name}：直進到達の目安 約${Math.floor(eta / 60)}分${eta % 60}秒。敵の移動・旋回・追尾で変わります。`
  };
}

export function submarineOptions(v, equipment, config, memory = {}, report = sonarReport(v, equipment, config)) {
  const p = v.player, c = v.contact;
  const option = (id, label, title, why, changes, action, lesson = 'measure', focus = 'heading') => ({ id, label, title, why, changes, action, lesson, focus });
  const options = [];
  const ping = option('officer-ping', 'ピンで確認', '不確かな距離を、ピンで確認しますか', '距離の裏付けを得られますが、自艦の方向が敵に伝わります。静かな観測を続ける選択もできます。', '能動ピンを1回発信。自艦方位を暴露します。', p.pingReady <= v.time ? { type: 'ping' } : null, 'measure', 'ping-btn');
  if (!c) return [option('officer-listen', '静かに探す', '音を出さず、受動索敵を続けましょう', 'まだ敵の方向がわかりません。低速を保ち、ソナー員の報告を待ちます。', '速力4 kt。針路と深度は維持。', p.order.speed !== 4 || !memory.listenOrdered ? { type: 'listen', values: { speed: 4 } } : null, 'listen', 'speed'), ping];
  const angle = c.fixAt != null ? bearing(p, c) : c.bearing;
  const safeDepth = Math.max(0, Math.min(p.spec.maxDepth, Math.floor((v.bottom - config.bottom.clearance - 25) / 5) * 5));
  const approachHeading = Math.round(wrap(angle + (c.fixAt == null ? 25 : 0)));
  const approach = option('officer-approach', '接近を続ける', c.fixAt == null ? '斜めに進みながら、静かに距離を探ります' : '低速で、攻撃距離へ接近しましょう', c.fixAt == null ? '方位線を交差させるため少し斜めに進みます。これは簡易な運動解析で、距離が得られない場合や誤差が大きい場合もあります。' : '目安は2 km前後。距離の誤差を考慮し、近づきすぎずに判断します。', `針路 ${approachHeading}°、速力6 kt。ピン・弾薬は使用しません。`, { type: 'order', intent: 'observe', values: { heading: approachHeading, speed: 6 } });
  const retreat = option('officer-retreat', '静かに離脱する', '低速で距離を取り、反撃に備えましょう', '現在の接触方位と反対へ向かいます。まだ接近警報がないため、全速ではなく静粛性を優先します。', `針路 ${Math.round(wrap(angle + 180))}°、速力6 kt、深度 ${Math.min(safeDepth, Math.max(p.depth, config.thermocline + 40))} m。40秒を離脱の目安とします。`, { type: 'order', intent: 'withdraw', values: { heading: Math.round(wrap(angle + 180)), speed: 6, depth: Math.min(safeDepth, Math.max(p.depth, config.thermocline + 40)) } }, 'defend');
  const torpedo = equipment.weapons.find(w => p.spec.weaponSlots.includes(w.id) && w.speed > 0 && p.ammo[w.id] > 0 && p.ready[w.id] <= v.time && report.range <= w.range);
  const fireReady = c.fixAt != null && c.depth != null && v.time - c.fixAt <= 35 && torpedo && v.time >= (memory.lastShotAt ?? -Infinity) + 25;
  const fire = option('officer-fire', 'ここで攻撃する', 'この距離から攻撃しますか', report.arrival + ' 発射後は離脱を提案します。命中は保証されません。', fireReady ? `${torpedo.name}を1発消費。攻撃深度 ${Math.round(c.depth / 10) * 10} m。` : '新しい距離・深度の測定と、使用可能な魚雷が必要です。発射後25秒間は状況を観測します。', fireReady ? { type: 'fire', weapon: torpedo.id, depth: Math.round(c.depth / 10) * 10 } : null, 'attack', 'fire-btn');
  const waiting = option('officer-observe', '観測を続ける', '今の針路で観測を続けましょう', '短い間隔で変針を繰り返さず、方位の変化を観測します。危険の兆候があれば報告します。', '操艦指示は設定済みです。急ぐ場合は「ピンで確認」を選べます。', null);
  if (v.time < (memory.withdrawUntil || 0)) {
    options.push(option('officer-withdrawing', '離脱を続ける', '離脱中。静かに距離を取りましょう', '接近警報がなければ、現在の低速航行を維持します。警報が出たら高速回避へ切り替えます。', `あと ${Math.ceil(memory.withdrawUntil - v.time)} 秒を目安に観測を続けます。`, null, 'defend'));
  } else if (memory.fired && (memory.withdrawAfterShot ?? -Infinity) < memory.lastShotAt) options.push(retreat);
  else if (report.range != null && report.range < 1000) options.push(fireReady ? fire : retreat);
  else if (fireReady && report.range + report.uncertainty <= 2400) options.push(fire);
  else if (c.fixAt != null && (v.time - c.fixAt > 35 || c.depth == null) && report.range < 2600) options.push(ping);
  else if (c.fixAt == null && v.time - (memory.observationStarted ?? v.time) >= 60) options.push(ping.action ? ping : waiting);
  else if (v.time < (memory.observeUntil || 0)) options.push(waiting);
  else options.push(approach);
  for (const candidate of [approach, fire, retreat, ping]) if (!options.some(o => o.id === candidate.id)) options.push(candidate);
  return options;
}
