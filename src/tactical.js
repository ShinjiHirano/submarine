const radians = degrees => degrees * Math.PI / 180;

// Software projection of 3D chart geometry. Only the public observation view is accepted.
export class TacticalView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = -25;
    this.range = 3400;
    this.layer = true;
    this.reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this.reset();
  }
  reset() { this.trail = []; this.nextTrail = 0; }
  draw(v, thermocline) {
    if (!v || !this.ctx) return;
    const { canvas, ctx } = this, rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2), w = rect.width, h = rect.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#102c38'); bg.addColorStop(.55, '#081c29'); bg.addColorStop(1, '#030c15');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const p = v.player, yaw = radians(this.yaw), scale = Math.min(w / 2.6, h / 1.8) / this.range;
    const project = (x, y, depth) => {
      const dx = x - p.x, dy = y - p.y;
      const rx = dx * Math.cos(yaw) - dy * Math.sin(yaw), ry = dx * Math.sin(yaw) + dy * Math.cos(yaw);
      return { x: w / 2 + rx * scale, y: h * .43 + ry * scale * .48 + (depth - p.depth) * scale * 4, z: ry };
    };
    const line = (points, color, width = 1, dash = []) => {
      if (!points.length) return;
      ctx.beginPath(); points.forEach((a, i) => i ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y));
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };
    const polygon = (points, fill, stroke) => {
      ctx.beginPath(); points.forEach((a, i) => i ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y)); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = .7; ctx.stroke(); }
    };
    const label = (point, text, color = '#9db9c7') => { ctx.font = '11px sans-serif'; ctx.fillStyle = color; ctx.fillText(text, point.x + 9, point.y - 9); };
    const ring = (x, y, depth, radius, color, dash = []) => {
      const points = Array.from({ length: 49 }, (_, i) => { const a = i / 48 * Math.PI * 2; return project(x + Math.cos(a) * radius, y + Math.sin(a) * radius, depth); });
      line(points, color, 1.3, dash);
    };
    // Unknown areas have no depth geometry. A neutral datum grid never samples the seabed.
    const extent = this.range * 1.25;
    for (let d = -4000; d <= 4000; d += 800) {
      line([project(p.x + d, p.y - extent, 0), project(p.x + d, p.y + extent, 0)], '#63899a14');
      line([project(p.x - extent, p.y + d, 0), project(p.x + extent, p.y + d, 0)], '#63899a14');
    }
    const cells = v.survey.cells, lookup = new Map(cells.map(c => [`${c.x},${c.y}`, c])), s = v.survey.spacing;
    const tiles = [];
    for (const a of cells) {
      const b = lookup.get(`${a.x + s},${a.y}`), c = lookup.get(`${a.x + s},${a.y + s}`), d = lookup.get(`${a.x},${a.y + s}`);
      if (!b || !c || !d) continue;
      const vertices = [a, b, c, d];
      const points = vertices.map(c => project(c.x, c.y, c.depth));
      const measured = vertices.every(c => c.source !== 'chart');
      tiles.push({ vertices, points, measured, z: points.reduce((n, p) => n + p.z, 0) / 4 });
    }
    tiles.sort((a, b) => a.z - b.z);
    for (const tile of tiles) {
      const depth = tile.vertices.reduce((n, c) => n + c.depth, 0) / 4;
      const shade = Math.max(16, Math.min(30, 38 - depth / 24));
      const newest = Math.max(...tile.vertices.map(c => c.at ?? -100));
      const alpha = this.reduced ? .85 : Math.min(.88, .25 + (v.time - newest) * .2);
      polygon(tile.points, `hsla(${tile.measured ? 168 : 202}, ${tile.measured ? 39 : 24}%, ${shade}%, ${alpha})`, tile.measured ? '#63d9bb58' : '#6388a143');
    }
    for (const cell of cells) if (cell.source === 'track') { const q = project(cell.x, cell.y, cell.depth); ctx.fillStyle = '#8fc6ce'; ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill(); }
    if (this.layer) {
      polygon([project(p.x - extent, p.y - extent, thermocline), project(p.x + extent, p.y - extent, thermocline), project(p.x + extent, p.y + extent, thermocline), project(p.x - extent, p.y + extent, thermocline)], '#6aa6e00a', '#8ec3e329');
      label(project(p.x - this.range * .7, p.y, thermocline), `水温躍層 ${thermocline} m`, '#83b8d2');
    }
    if (v.time >= this.nextTrail) { this.trail.push({ x: p.x, y: p.y, depth: p.depth }); this.trail = this.trail.slice(-240); this.nextTrail = v.time + 3; }
    line(this.trail.map(t => project(t.x, t.y, t.depth)), '#6de2c777', 1.5);
    const own = project(p.x, p.y, p.depth), surface = project(p.x, p.y, 0), floor = project(p.x, p.y, v.bottom);
    line([surface, floor], '#93bcc04a', 1, [3, 5]);
    ring(p.x, p.y, v.bottom, 100, '#73dfc47a');
    label(floor, `直下 ${Math.round(v.bottom)} m`);
    if (v.mission?.objective.type === 'ESCAPE') {
      const zone = v.mission.objective.zone;
      ring(zone.x, zone.y, p.depth, zone.radius, '#8dd7fa'); label(project(zone.x, zone.y, p.depth), '離脱区域', '#8dd7fa');
    }
    const contact = v.contact;
    if (contact) {
      if (contact.fixAt == null) {
        const angle = radians(contact.bearing);
        for (const spread of [-.07, .07]) line([own, project(p.x + Math.sin(angle + spread) * extent, p.y - Math.cos(angle + spread) * extent, p.depth)], '#ecc17d88', 1.2, [6, 5]);
        label(project(p.x + Math.sin(angle) * this.range * .65, p.y - Math.cos(angle) * this.range * .65, p.depth), '接触方位 / 距離・深度不明', '#ecc17d');
      } else {
        const error = contact.uncertainty + (v.time - contact.fixAt) * 8;
        const depth = contact.depth ?? p.depth;
        ring(contact.x, contact.y, depth, error, '#ecc17dbb', [4, 4]);
        const q = project(contact.x, contact.y, depth);
        if (contact.depth == null) line([project(contact.x, contact.y, 0), project(contact.x, contact.y, 550)], '#ecc17d77', 1, [3, 5]);
        else {
          const vert = Array.from({ length: 49 }, (_, i) => { const a = i / 48 * Math.PI * 2; return project(contact.x + Math.cos(a) * error, contact.y, Math.max(0, depth + Math.sin(a) * 20)); });
          line(vert, '#ecc17d66');
        }
        label(q, `C-01 推定 ±${Math.round(error)} m${contact.depth == null ? ' / 深度不明' : ''}`, '#ecc17d');
      }
    }
    for (const threat of v.warnings) {
      const a = radians(threat.bearing);
      line([project(p.x + Math.sin(a) * 500, p.y - Math.cos(a) * 500, p.depth), project(p.x + Math.sin(a) * extent, p.y - Math.cos(a) * extent, p.depth)], '#f17e7299', 3, [8, 9]);
      label(project(p.x + Math.sin(a) * this.range * .65, p.y - Math.cos(a) * this.range * .65, p.depth), '魚雷接近 / 方位のみ', '#ffa99b');
    }
    // Exaggerated own-ship model; heading and depth follow actual helm response.
    const modelScale = Math.max(1, .23 / scale);
    const shipPoint = (forward, side, up = 0) => { forward *= modelScale; side *= modelScale; up *= modelScale; const a = radians(p.heading); return project(p.x + Math.sin(a) * forward + Math.cos(a) * side, p.y - Math.cos(a) * forward + Math.sin(a) * side, p.depth - up); };
    const hull = [shipPoint(195, 0), shipPoint(110, 45), shipPoint(-135, 40), shipPoint(-190, 0), shipPoint(-135, -40), shipPoint(110, -45)];
    polygon(hull, '#619aab', '#b8f0e6');
    polygon([shipPoint(125, 0, 10), shipPoint(-115, 25, 10), shipPoint(-165, 0, 10), shipPoint(-115, -25, 10)], '#305b6c', '#7ab3bc');
    const tower = p.spec.type === 'DESTROYER' ? 55 : 30;
    polygon([shipPoint(40, -18, 10), shipPoint(40, -18, tower), shipPoint(-40, -18, tower), shipPoint(-40, -18, 10)], '#96c6ce', '#c1e4e6');
    polygon([shipPoint(40, -18, tower), shipPoint(40, 18, tower), shipPoint(-40, 18, tower), shipPoint(-40, -18, tower)], '#466e80', '#afd6dc');
    label({ x: own.x, y: own.y + 42 }, `${p.spec.callsign} · ${Math.round(p.depth)} m · ${p.speed.toFixed(1)} kt`, '#b6eadc');
    if (v.cavitating) ring(p.x, p.y, p.depth, 230 + (this.reduced ? 0 : v.time % 2 * 65), '#acd9e17a');
    for (const decoy of v.decoys) {
      const q = project(decoy.x, decoy.y, decoy.depth);
      ring(decoy.x, decoy.y, decoy.depth, 100 + (this.reduced ? 80 : (v.time % 3) * 100), '#afd1ff88'); label(q, decoy.team === 'enemy' ? '敵デコイ' : 'デコイ', '#afd1ff');
    }
    for (const event of v.visuals) {
      const age = v.time - event.at;
      if (event.type === 'scan') ring(event.x, event.y, event.depth, Math.min(1800, this.reduced ? 1800 : age * 450), '#79ecd28a');
      if (event.type === 'launch' && age < 8 && !v.replay) {
        const a = radians(event.heading), travel = this.reduced ? 180 : 130 + age * 60;
        const q = project(event.x + Math.sin(a) * travel, event.y - Math.cos(a) * travel, event.depth);
        line([project(event.x, event.y, event.depth), q], '#e9bc8577', 2, [2, 5]);
        ctx.fillStyle = '#ffe1b3'; ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill(); label(q, '発射演出', '#e8c191');
      }
      if (event.type === 'damage' && age < 5) {
        const q = project(event.x, event.y, event.depth), glow = ctx.createRadialGradient(q.x, q.y, 3, q.x, q.y, 90);
        glow.addColorStop(0, `rgba(255,168,111,${.6 * (1 - age / 5)})`); glow.addColorStop(1, '#e0603000'); ctx.fillStyle = glow; ctx.fillRect(q.x - 90, q.y - 90, 180, 180);
      }
    }
    if (v.replay) {
      const enemy = v.replay.enemy, q = project(enemy.x, enemy.y, enemy.depth), a = radians(enemy.heading);
      const ep = (f, side) => { f *= modelScale; side *= modelScale; return project(enemy.x + Math.sin(a) * f + Math.cos(a) * side, enemy.y - Math.cos(a) * f + Math.sin(a) * side, enemy.depth); };
      polygon([ep(170, 0), ep(-110, 45), ep(-165, 0), ep(-110, -45)], enemy.health > 0 ? '#ba7770' : '#4b4145', '#ffb0a0');
      label(q, `敵艦 · ${Math.round(enemy.depth)} m · 船体 ${Math.round(enemy.health)} / ${enemy.spec.health}`, '#ffc2b5');
      for (const torpedo of v.replay.projectiles) {
        const t = project(torpedo.x, torpedo.y, torpedo.depth), dir = radians(torpedo.heading);
        line([project(torpedo.x - Math.sin(dir) * 200, torpedo.y + Math.cos(dir) * 200, torpedo.depth), t], torpedo.team === 'player' ? '#f8d59d' : '#ff7e75', 2);
        ctx.fillStyle = torpedo.team === 'player' ? '#f8d59d' : '#ff7e75'; ctx.beginPath(); ctx.arc(t.x, t.y, 3, 0, Math.PI * 2); ctx.fill();
      }
      for (const effect of v.replay.effects) ring(effect.x, effect.y, effect.depth ?? 0, 80 + (v.time - effect.at) * 45, '#ffba86');
    }
    const latest = v.visuals.filter(e => ['launch', 'decoy', 'damage', 'hit', 'evaded'].includes(e.type)).at(-1);
    if (latest) {
      const names = { launch: `${latest.weaponName || '兵装'} 発射`, decoy: 'デコイ展開 — 変針して離脱', damage: '船体損傷 — 深度・健全性を確認', hit: '爆発音を確認 — 命中を推定', evaded: 'デコイへの誘引を確認 — 回避成功' };
      ctx.fillStyle = '#07131ee8'; ctx.fillRect(12, h - 47, w - 24, 35); ctx.fillStyle = latest.type === 'damage' ? '#ffa99b' : '#e4d3b2'; ctx.font = `${w < 420 ? 11 : 13}px sans-serif`; ctx.fillText(names[latest.type], 23, h - 25);
    }
    const north = project(p.x, p.y - 1200, p.depth);
    line([own, north], '#79b5c433', 1, [3, 5]); label(north, 'N', '#a3d0dc');
  }
}
