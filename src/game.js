import { Surveyor } from './survey.js';
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrap = v => (v % 360 + 360) % 360;
export const delta = (a, b) => (b - a + 540) % 360 - 180;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const bearing = (a, b) => wrap(Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI);
const vector = angle => ({ x: Math.sin(angle * Math.PI / 180), y: -Math.cos(angle * Math.PI / 180) });
const toward = (v, target, step) => v + clamp(target - v, -step, step);

export class Game {
  constructor(ships, equipment, config, shipId = ships[0].id) {
    this.config = config; this.equipment = equipment; this.time = 0; this.result = null;
    this.seed = config.seed; this.events = []; this.projectiles = []; this.decoys = []; this.effects = [];
    this.shots = 0; this.pings = 0; this.nextId = 1; this.sampleAt = 0;
    const selected = ships.find(s => s.id === (config.mission?.playerShip || shipId));
    if (!selected) throw new Error('艦艇データに選択した艦がありません');
    this.player = this.makeShip(selected, config.start.player, 'player');
    const opponent = config.mission?.enemyShip ? ships.find(s => s.id === config.mission.enemyShip) : ships.find(s => s.type !== selected.type);
    this.enemy = this.makeShip(opponent, config.start.enemy, 'enemy');
    this.enemy.nextPing = config.ai.firstPing ?? 18; this.enemy.nextAttack = config.ai.firstAttack;
    this.visuals = [];
    this.replayFrames = []; this.nextReplay = 0;
    this.surveyor = new Surveyor(config, point => this.bottomAt(point));
    this.surveyor.step(this.player, 0);
    this.contact = null; this.enemyContact = null; this.samples = []; this.warnings = [];
    if (config.initialDetection) {
      this.enemyContact = { x: this.player.x, y: this.player.y, depth: this.player.depth, bearing: bearing(this.enemy, this.player), observedAt: 0, fixAt: 0, confidence: 98, source: 'ACTIVE', uncertainty: 100 };
      this.log('任務開始時点で敵に位置を測られています。離脱区域を目指し、反撃より生存を優先してください。', 'warning', { sound: 'alarm', clip: 'officer-caution' });
    }
    this.recordReplay();
    this.log(config.mission?.objective.type === 'ESCAPE' ? '離脱任務開始。南西の指定区域へ向かいます。接近警報時は回避を優先してください。' : selected.type === 'SUBMARINE' ? '作戦開始。低速で索敵・接近し、方位の変化を観測。ピンを使うかはソナー員の提案から判断してください。' : '作戦開始。低速で索敵し、接触を得たら能動ピンで測距してください。');
  }
  random() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296; }
  makeShip(spec, start, team) {
    if (!spec) throw new Error('対戦相手の艦艇データがありません');
    const engine = this.equipment.engines.find(e => e.id === spec.engine);
    const ship = { ...start, spec, team, health: spec.health, maxSpeed: spec.maxSpeed + (engine?.maxSpeedBonus || 0), engine, ammo: {}, ready: {}, pingReady: 0 };
    ship.depth = spec.type === 'SUBMARINE' ? start.depth : 0;
    ship.order = { heading: ship.heading, speed: ship.speed, depth: ship.depth };
    for (const id of spec.weaponSlots) {
      const weapon = this.weapon(id);
      if (!weapon) throw new Error(`装備 ${id} が見つかりません`);
      ship.ammo[id] = weapon.ammo; ship.ready[id] = 0;
    }
    return ship;
  }
  weapon(id) { return this.equipment.weapons.find(w => w.id === id); }
  log(text, type = 'info', audio = null) { this.events.unshift({ time: this.time, text, type, audio, id: this.nextId++ }); this.events.length = Math.min(60, this.events.length); }
  visual(type, extra = {}) { this.visuals.push({ id: this.nextId++, type, at: this.time, x: this.player.x, y: this.player.y, depth: this.player.depth, heading: this.player.heading, ...extra }); this.visuals = this.visuals.slice(-24); }
  bottomAt(ship) { const b = this.config.bottom; return b.base + b.amplitude * Math.sin(ship.x / b.scale) * Math.cos(ship.y / b.scale); }
  cavitating(ship) { const n = this.config.noise; return ship.speed > n.cavitationSpeed + ship.depth * n.depthFactor; }
  noise(ship) {
    const n = this.config.noise;
    return ship.spec.baseNoise * (1 - (ship.engine?.noiseReduction || 0)) + ship.speed * n.speedFactor + (this.cavitating(ship) ? n.cavitation : 0) - (ship.speed < 1 && this.bottomAt(ship) - ship.depth < 22 ? n.bottomReduction : 0);
  }
  acrossLayer(a, b) { return (a.depth < this.config.thermocline) !== (b.depth < this.config.thermocline); }
  signal(observer, target) {
    const sonar = this.equipment.sonars.find(s => s.id === observer.spec.sonarSlots[0]);
    const loss = this.config.sonar.lossFactor * Math.log10(Math.max(1, distance(observer, target) / this.config.sonar.referenceRange));
    return this.noise(target) - loss - Math.max(0, this.noise(observer) - sonar.selfNoiseTolerance) + (sonar.sensitivity - 60) - (this.acrossLayer(observer, target) ? this.config.layerLoss : 0);
  }
  order(values) {
    if (this.result) return;
    const p = this.player;
    if (Number.isFinite(values.heading)) p.order.heading = wrap(values.heading);
    if (Number.isFinite(values.speed)) p.order.speed = clamp(values.speed, 0, p.maxSpeed);
    if (Number.isFinite(values.depth)) p.order.depth = clamp(values.depth, 0, p.spec.maxDepth);
  }
  detect(observer, target, previous) {
    if (target.health <= 0) return null;
    const snr = this.signal(observer, target);
    if (snr < this.config.sonar.minimumSignal) return previous;
    const confidence = clamp(40 + snr * 1.8, 20, 95);
    const angle = wrap(bearing(observer, target) + (this.random() - 0.5) * this.config.sonar.bearingError * (1 - confidence / 110));
    const recentFix = previous?.fixAt != null && this.time - previous.fixAt < this.config.sonar.fixLifetime;
    return { ...previous, bearing: angle, observedAt: this.time, signal: snr, confidence,
      classification: confidence > 65 ? (target.spec.type === 'SUBMARINE' ? '潜水艦' : '水上戦闘艦') : '機関音・艦種未識別',
      source: recentFix ? previous.source : 'PASSIVE',
      fixAt: recentFix ? previous.fixAt : null, x: recentFix ? previous.x : null, y: recentFix ? previous.y : null,
      depth: recentFix ? previous.depth : null, uncertainty: recentFix ? previous.uncertainty : null };
  }
  sample() {
    const before = this.contact;
    this.contact = this.detect(this.player, this.enemy, this.contact);
    this.enemyContact = this.detect(this.enemy, this.player, this.enemyContact);
    if (this.contact && this.contact.observedAt === this.time) {
      if (!before || this.time - before.observedAt > this.config.sonar.bearingLifetime) this.log('接触 C-01。機関音を検知、方位を追尾します。', 'contact', { sound: 'contact', report: `ソナーより報告。機関音を探知。方位、${Math.round(this.contact.bearing)}度。距離、不明。` });
      const p = this.player;
      this.samples.push({ x: p.x, y: p.y, bearing: this.contact.bearing, heading: p.heading, time: this.time });
      this.samples = this.samples.filter(s => this.time - s.time < 180).slice(-40);
      this.tryTMA();
    }
    for (const key of ['contact', 'enemyContact']) {
      const c = this[key];
      if (c?.fixAt != null && this.time - c.fixAt >= this.config.sonar.fixLifetime) Object.assign(c, { source: 'PASSIVE', fixAt: null, x: null, y: null, depth: null });
      if (c && this.time - c.observedAt > this.config.sonar.bearingLifetime && c.fixAt == null) {
        this[key] = null;
        if (key === 'contact') { this.samples = []; this.log('接触を喪失。減速して再探知してください。', 'warning', { sound: 'contact', clip: 'lost', report: 'ソナー、接触を喪失。減速して再探知を推奨。' }); }
      }
    }
  }
  tryTMA() {
    const s = this.samples, c = this.contact, cfg = this.config.sonar;
    if (s.length < cfg.tmaSamples || c.fixAt != null) return;
    const first = s[0], last = s.at(-1);
    if (distance(first, last) < 150 || !s.some(a => Math.abs(delta(first.heading, a.heading)) >= cfg.tmaCourseChange)) return;
    // Fit the intersection of observed bearing lines; never read the target's position.
    let aa = 0, ab = 0, bb = 0, ac = 0, bc = 0;
    for (const a of s) {
      const v = vector(a.bearing), nx = -v.y, ny = v.x, d = nx * a.x + ny * a.y;
      aa += nx * nx; ab += nx * ny; bb += ny * ny; ac += nx * d; bc += ny * d;
    }
    const determinant = aa * bb - ab * ab;
    if (determinant < 0.15) return;
    const point = { x: (ac * bb - bc * ab) / determinant, y: (bc * aa - ac * ab) / determinant };
    const range = distance(this.player, point);
    if (range < 400 || range > this.config.displayRange * 1.5 || Math.abs(delta(c.bearing, bearing(this.player, point))) > 12) return;
    Object.assign(c, point, { fixAt: this.time, source: 'TMA', uncertainty: Math.max(800, range * cfg.tmaError), confidence: Math.min(c.confidence, 65), depth: null });
    this.log('TMA推定解を取得。移動目標のため距離誤差に注意、ピンでの検証を推奨。', 'contact', { sound: 'contact', clip: 'tma', report: `運動解析の推定解を取得。推定距離、${(range / 1000).toFixed(1)}キロ。誤差に注意。` });
  }
  ping(team = 'player') {
    if (this.result) return false;
    const observer = this[team], target = team === 'player' ? this.enemy : this.player;
    const sonar = this.equipment.sonars.find(s => s.id === observer.spec.activeSonar);
    if (this.time < observer.pingReady) return false;
    observer.pingReady = this.time + sonar.cooldown;
    this.effects.push({ x: observer.x, y: observer.y, at: this.time, type: 'ping', team });
    const ownKey = team === 'player' ? 'contact' : 'enemyContact';
    const otherKey = team === 'player' ? 'enemyContact' : 'contact';
    this[otherKey] = { ...this[otherKey], bearing: bearing(target, observer), observedAt: this.time, confidence: 98, signal: 50, classification: '能動ソナー発信源', source: this[otherKey]?.fixAt != null ? this[otherKey].source : 'INTERCEPT' };
    const hit = target.health > 0 && distance(observer, target) <= sonar.range * (this.acrossLayer(observer, target) ? sonar.layerPenalty : 1);
    if (hit) this[ownKey] = { bearing: bearing(observer, target), observedAt: this.time, fixAt: this.time, x: target.x, y: target.y, depth: Math.round(target.depth / 10) * 10, uncertainty: 100, confidence: 98, source: 'ACTIVE', signal: 45, classification: target.spec.type === 'SUBMARINE' ? '潜水艦' : '水上戦闘艦' };
    if (team === 'player') {
      const added = this.surveyor.scan(this.player, this.time);
      this.visual('scan');
      this.log(`測量士：周辺1.8 kmを走査、${added}区画を更新。自艦方位を暴露しました。`, 'info');
      this.pings++; this.log(hit ? '反響を受信。C-01の距離・深度を更新。自艦方位が暴露されました。' : '反響なし。有効範囲外または躍層による減衰。自艦方位が暴露されました。', hit ? 'contact' : 'warning', { sound: 'ping', clip: hit ? 'fix' : 'no_echo', report: hit ? `ソナー、反響あり。方位、${Math.round(this.contact.bearing)}度。距離、${(distance(observer, this.contact) / 1000).toFixed(1)}キロ。深度、${this.contact.depth}メートル。` : 'ソナー、反響なし。自艦方位が暴露されました。' }); }
    else this.log('敵の能動ピンを傍受！ 発信方位を取得。自艦を探知された可能性。', 'warning', { sound: 'intercept', report: `敵のピンを傍受。方位、${Math.round(this.contact.bearing)}度。警戒してください。`, priority: 1 });
    return true;
  }
  fireReason(id, team = 'player') {
    const s = this[team], w = this.weapon(id), c = team === 'player' ? this.contact : this.enemyContact;
    if (this.result) return '任務は終了しています';
    if (!w || !s.spec.weaponSlots.includes(id)) return '搭載されていない装備です';
    if (team === 'player' && this.config.mission?.rules?.noAttack && w.guidance !== 'DECOY') return '交戦規定：攻撃禁止。デコイは使用できます';
    if (s.ammo[id] <= 0) return '残弾なし';
    if (s.ready[id] > this.time) return `再装填中 ${Math.ceil(s.ready[id] - this.time)}秒`;
    if (w.guidance === 'DECOY' || id === 'depth_charge_mk9') return '';
    if (!c) return '接触を探知してください';
    if (['DEPTH_CHARGE', 'ROCKET_TORPEDO'].includes(w.guidance) && c.fixAt == null) return '能動ピンまたはTMAで測距してください';
    if (c.fixAt != null && distance(s, c) > w.range) return '射程外：接近してください';
    if (w.guidance === 'DEPTH_CHARGE' && Math.abs(delta(s.heading, c.bearing)) > 60) return '目標を艦首の左右60°以内に捉えてください';
    return '';
  }
  fire(id, depth = 100, team = 'player') {
    const reason = this.fireReason(id, team);
    if (reason) { if (team === 'player') this.log(reason, 'warning'); return false; }
    const s = this[team], w = this.weapon(id), c = team === 'player' ? this.contact : this.enemyContact;
    s.ammo[id]--; s.ready[id] = this.time + w.cooldown;
    if (w.guidance === 'DECOY') {
      if (team === 'player') this.visual('decoy');
      this.decoys.push({ x: s.x, y: s.y, depth: s.depth, team, expires: this.time + w.duration, radius: w.radius, id: this.nextId++ });
      this.log(team === 'player' ? 'デコイ展開。変針して発生源から離脱してください。' : '音響解析：新たな雑音源。敵がデコイを展開した模様。', 'warning', { sound: team === 'player' ? 'decoy' : 'contact', clip: team === 'player' ? 'decoy' : 'enemy_decoy', report: team === 'player' ? 'デコイ展開。変針して離脱してください。' : 'ソナー、新たな雑音源。敵のデコイと推定。' });
      return true;
    }
    let x = s.x, y = s.y;
    if (w.guidance === 'ROCKET_TORPEDO') { x = c.x; y = c.y; }
    if (w.guidance === 'DEPTH_CHARGE' && id !== 'depth_charge_mk9') { x = c.x; y = c.y; }
    const heading = c?.bearing ?? s.heading;
    const v = vector(heading);
    this.projectiles.push({ id: this.nextId++, team, weapon: w, x, y, depth: w.guidance === 'DEPTH_CHARGE' || w.guidance === 'ROCKET_TORPEDO' ? 0 : s.depth, targetDepth: clamp(depth, 0, 500), heading, traveled: 0, aim: c?.fixAt != null ? { x: c.x, y: c.y } : { x: x + v.x * w.range, y: y + v.y * w.range }, age: 0 });
    if (team === 'player') { this.visual('launch', { heading, weaponName: w.name }); this.shots++; this.log(`${w.name} 発射。攻撃深度 ${depth} m。`, 'action', { sound: 'launch', report: `${w.name}、発射。攻撃深度、${depth}メートル。` }); }
    return true;
  }
  moveShip(ship, dt) {
    const s = ship.spec;
    ship.heading = wrap(ship.heading + clamp(delta(ship.heading, ship.order.heading), -s.turnRate * dt, s.turnRate * dt));
    ship.speed = toward(ship.speed, ship.order.speed, s.acceleration * dt);
    ship.depth = toward(ship.depth, ship.order.depth, s.diveRate * dt);
    const dir = vector(ship.heading), current = vector(this.config.current.heading), k = this.config.knotsToMeters;
    ship.x += (dir.x * ship.speed + current.x * this.config.current.speed) * k * dt;
    ship.y += (dir.y * ship.speed + current.y * this.config.current.speed) * k * dt;
    const bottom = this.bottomAt(ship) - this.config.bottom.clearance;
    if (ship.depth > bottom) {
      ship.depth = bottom; ship.health -= this.config.bottom.collisionDamage * dt;
      if (ship.team === 'player' && this.time > (this.nextGroundWarning || 0)) { this.visual('damage'); this.log('海底接触！ 浮上し、深度を浅くしてください。', 'warning', { sound: 'damage', clip: 'grounding', priority: 2 }); this.nextGroundWarning = this.time + 15; }
    }
    const radius = Math.hypot(ship.x, ship.y);
    if (radius > this.config.worldRadius) {
      ship.x *= this.config.worldRadius / radius; ship.y *= this.config.worldRadius / radius;
      ship.order.heading = bearing(ship, { x: 0, y: 0 });
      if (ship.team === 'player' && this.time > (this.nextBoundaryWarning || 0)) { this.log('作戦海域の境界。中央へ自動変針します。', 'warning'); this.nextBoundaryWarning = this.time + 30; }
    }
  }
  ai() {
    const e = this.enemy, c = this.enemyContact, cfg = this.config.ai;
    const threat = this.projectiles.find(p => p.team === 'player' && distance(p, e) < 2300);
    if (threat) {
      e.order.heading = wrap(bearing(threat, e) + 35); e.order.speed = Math.min(e.maxSpeed, cfg.evasionSpeed);
      if (e.spec.type === 'SUBMARINE') e.order.depth = Math.min(e.spec.maxDepth, this.config.thermocline + 65);
      if (!this.fireReason('acoustic_decoy', 'enemy')) this.fire('acoustic_decoy', e.depth, 'enemy');
    } else if (c) {
      e.order.heading = c.fixAt != null ? bearing(e, c) : c.bearing;
      e.order.speed = e.spec.type === 'SUBMARINE' ? cfg.subSpeed : cfg.destroyerSpeed;
    }
    if (this.time >= e.nextPing && (e.spec.type === 'DESTROYER' || c)) { this.ping('enemy'); e.nextPing = this.time + cfg.pingInterval; }
    if (this.time >= e.nextAttack && this.enemyContact) {
      const ids = e.spec.weaponSlots.filter(id => this.weapon(id).guidance !== 'DECOY');
      const available = ids.find(id => !this.fireReason(id, 'enemy') && (id !== 'depth_charge_mk9' || (this.enemyContact.fixAt != null && distance(e, this.enemyContact) < this.weapon(id).radius)));
      if (available) { this.fire(available, this.enemyContact.depth ?? 130, 'enemy'); e.nextAttack = this.time + cfg.attackInterval; }
    }
  }
  stepWeapons(dt) {
    for (const p of this.projectiles) {
      p.age += dt;
      const w = p.weapon, target = p.team === 'player' ? this.enemy : this.player;
      if (w.guidance === 'DEPTH_CHARGE') {
        p.depth += w.sinkRate * dt;
        if (p.depth >= p.targetDepth) { p.depth = p.targetDepth; this.explode(p, target); }
        continue;
      }
      let aim = p.aim, aimDepth = p.targetDepth;
      const decoy = this.decoys.find(d => d.team !== p.team && distance(d, p) < d.radius);
      if (decoy) { aim = decoy; aimDepth = decoy.depth; p.lured = true; }
      else if (distance(p, target) < w.seekerRange && Math.abs(p.depth - target.depth) < 160) { aim = target; aimDepth = target.depth; }
      else if (w.guidance === 'WIRE_GUIDED') {
        const c = p.team === 'player' ? this.contact : this.enemyContact;
        if (c?.fixAt != null) { aim = c; p.aim = { x: c.x, y: c.y }; }
      }
      p.heading = wrap(p.heading + clamp(delta(p.heading, bearing(p, aim)), -w.turnRate * dt, w.turnRate * dt));
      p.depth = toward(p.depth, aimDepth, w.diveRate * dt);
      const v = vector(p.heading), current = vector(this.config.current.heading), k = this.config.knotsToMeters;
      p.x += (v.x * w.speed + current.x * this.config.current.speed) * k * dt;
      p.y += (v.y * w.speed + current.y * this.config.current.speed) * k * dt;
      p.traveled += w.speed * k * dt;
      if (decoy && distance(p, decoy) < w.radius && Math.abs(p.depth - decoy.depth) < w.radius) { p.dead = true; if (p.team === 'enemy') this.visual('evaded'); this.log(p.team === 'enemy' ? 'デコイが敵魚雷を誘引。脅威を回避しました。' : '魚雷の追尾信号が雑音源に逸れました。', 'action', { sound: 'contact', clip: p.team === 'enemy' ? 'evaded' : 'lured', report: p.team === 'enemy' ? '敵魚雷、デコイに誘引。回避成功。' : '魚雷の追尾が雑音源に逸れました。' }); }
      else if (Math.hypot(distance(p, target), p.depth - target.depth) < w.radius) this.explode(p, target);
      if (p.traveled >= w.range || p.depth >= this.bottomAt(p)) p.dead = true;
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);
    this.decoys = this.decoys.filter(d => d.expires > this.time);
    this.effects = this.effects.filter(e => this.time - e.at < 12);
    const threats = this.projectiles.filter(p => p.team === 'enemy' && distance(p, this.player) < 2600);
    for (const p of threats) if (!p.announced) { p.announced = true; this.log(`高速接近音！ 方位 ${Math.round(bearing(this.player, p))}°。デコイと回避機動を推奨。`, 'warning', { sound: 'alarm', report: `ソナー、魚雷接近！ 方位、${Math.round(bearing(this.player, p))}度。デコイ展開、回避を！`, priority: 2 }); }
    this.warnings = threats.map(p => ({ bearing: bearing(this.player, p), distance: distance(this.player, p) }));
  }
  explode(p, target) {
    p.dead = true; this.effects.push({ x: p.x, y: p.y, depth: p.depth, at: this.time, type: 'explosion', team: p.team });
    const d = Math.hypot(distance(p, target), p.depth - target.depth);
    if (d <= p.weapon.radius) {
      const damage = p.weapon.damage * (p.weapon.guidance === 'DEPTH_CHARGE' ? Math.max(0.3, 1 - d / p.weapon.radius) : 1);
      target.health = Math.max(0, target.health - damage);
      this.visual(p.team === 'player' ? 'hit' : 'damage');
      this.log(p.team === 'player' ? '爆発音を確認。敵艦への命中を推定。' : `被弾！ 船体損傷 ${Math.round(damage)}。`, p.team === 'player' ? 'action' : 'warning', { sound: p.team === 'player' ? 'explosion' : 'damage', report: p.team === 'player' ? '爆発音を確認。敵艦への命中を推定。' : `被弾！ 船体損傷、${Math.round(damage)}。`, priority: p.team === 'player' ? 1 : 2 });
    } else if (p.team === 'player') this.log('爆雷が設定深度で炸裂。命中反応なし。', 'info', { sound: 'explosion', clip: 'miss' });
  }
  tick(dt) {
    if (this.result || !Number.isFinite(dt) || dt <= 0) return;
    // Substeps keep fast-forward collision and AI behavior stable.
    let left = Math.min(dt, 10);
    while (left > 0 && !this.result) {
      const step = Math.min(left, 0.2); left -= step; this.time += step;
      this.moveShip(this.player, step); if (this.enemy.health > 0) this.moveShip(this.enemy, step);
      if (this.time >= this.sampleAt) { this.sample(); this.sampleAt = this.time + this.config.sonar.interval; }
      if (this.enemy.health > 0) this.ai(); this.stepWeapons(step);
      this.surveyor.step(this.player, this.time);
      if (this.player.health <= 0) this.result = { won: false, reason: '自艦の船体が限界に達しました。' };
      else if (this.config.mission?.objective.type === 'ESCAPE' && distance(this.player, this.config.mission.objective.zone) <= this.config.mission.objective.zone.radius) this.result = { won: true, reason: '離脱区域に到達。自艦を生還させ、離脱任務を完了しました。' };
      else if (this.config.mission?.objective.type !== 'ESCAPE' && this.enemy.health <= 0) this.result = { won: true, reason: '敵艦の沈没を確認。作戦海域の安全を確保しました。' };
      else if (this.time >= this.config.timeLimit) this.result = { won: false, reason: this.config.mission?.objective.type === 'ESCAPE' ? '作戦時間を超過。離脱区域に到達できませんでした。' : '作戦時間を超過。敵艦を排除できず、海域から撤退しました。' };
      this.recordReplay();
      if (this.result) this.log(this.result.reason, this.result.won ? 'action' : 'warning', { sound: this.result.won ? 'success' : 'failure', clip: this.result.won && this.config.mission?.objective.type === 'ESCAPE' ? 'escape-success' : this.result.won ? 'success' : 'failure', priority: 3 });
    }
  }
  recordReplay() {
    if (this.time < this.nextReplay && !this.result) return;
    this.nextReplay = this.time + 1;
    const ship = s => ({ x: s.x, y: s.y, depth: s.depth, heading: s.heading, speed: s.speed, health: s.health, spec: s.spec, order: { ...s.order } });
    this.replayFrames.push({ time: this.time, player: ship(this.player), enemy: ship(this.enemy),
      projectiles: this.projectiles.map(p => ({ x: p.x, y: p.y, depth: p.depth, heading: p.heading, team: p.team })),
      decoys: this.decoys.map(d => ({ ...d })),
      effects: this.effects.filter(e => e.type === 'explosion').map(e => ({ ...e })),
      visuals: this.visuals.filter(e => this.time - e.at < 12).map(e => ({ ...e })) });
  }
  replayLength() { return this.result ? this.replayFrames.length : 0; }
  replayAt(index) {
    // Truth is available exclusively after the mission has ended.
    if (!this.result || !Number.isFinite(index)) return null;
    const frame = this.replayFrames[clamp(Math.floor(index), 0, this.replayFrames.length - 1)];
    if (!frame) return null;
    if (!this.replayChart) this.replayChart = new Surveyor({ ...this.config, chartMode: 'charted' }, point => this.bottomAt(point));
    this.replayChart.refresh(frame.player, frame.time);
    return { mission: this.config.mission, time: frame.time, player: frame.player, contact: null, warnings: [],
      visuals: frame.visuals, decoys: frame.decoys, survey: this.replayChart.view(), bottom: this.bottomAt(frame.player),
      cavitating: this.cavitating(frame.player), replay: { enemy: frame.enemy, projectiles: frame.projectiles, effects: frame.effects } };
  }
  view() {
    // The UI receives only measurements, never an unseen enemy position or health.
    return {
      mission: this.config.mission,
      time: this.time, player: this.player, contact: this.contact, samples: this.samples.length,
      events: this.events, warnings: this.warnings, result: this.result,
      // Launch cues never expose seeker turns, hidden targets or exact detonation positions.
      projectiles: [],
      visuals: this.visuals.filter(e => this.time - e.at < 12),
      survey: this.surveyor.view(),
      decoys: this.decoys.filter(d => d.team === 'player'),
      effects: this.effects.filter(e => e.team === 'player' && e.type === 'ping'),
      noise: this.noise(this.player), cavitating: this.cavitating(this.player), bottom: this.bottomAt(this.player)
    };
  }
}
