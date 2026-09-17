// A chart is player knowledge, separate from the simulation's true depth field.
export class Surveyor {
  constructor(config, bottomAt) {
    this.mode = config.chartMode || 'charted';
    this.spacing = 400;
    this.radius = config.worldRadius;
    this.cells = new Map();
    this.nextSample = 0;
    this.lastScan = null;
    this.bottomAt = bottomAt;
    if (this.mode !== 'unknown') {
      for (let x = Math.ceil(-this.radius / this.spacing) * this.spacing; x <= this.radius; x += this.spacing) {
        for (let y = Math.ceil(-this.radius / this.spacing) * this.spacing; y <= this.radius; y += this.spacing) {
          if (Math.hypot(x, y) > this.radius) continue;
          // Partial charts contain genuinely missing areas, not shaded true terrain.
          if (this.mode === 'partial' && x > 800) continue;
          this.cells.set(this.key(x, y), { x, y, depth: Math.round(bottomAt({ x, y }) / 40) * 40, error: 40, source: 'chart', at: null });
        }
      }
    }
  }
  key(x, y) { return `${Math.round(x / this.spacing)},${Math.round(y / this.spacing)}`; }
  record(x, y, depth, error, source, time) {
    const key = this.key(x, y), previous = this.cells.get(key);
    if (previous && previous.error < error) return false;
    this.cells.set(key, { x: Math.round(x / this.spacing) * this.spacing, y: Math.round(y / this.spacing) * this.spacing, depth, error, source, at: time });
    return !previous || previous.source === 'chart';
  }
  scan(player, time) {
    let added = 0;
    const s = this.spacing;
    for (let x = Math.ceil((player.x - 1800) / s) * s; x <= player.x + 1800; x += s) {
      for (let y = Math.ceil((player.y - 1800) / s) * s; y <= player.y + 1800; y += s) {
        if (Math.hypot(x - player.x, y - player.y) > 1800 || Math.hypot(x, y) > this.radius) continue;
        if (this.record(x, y, Math.round(this.bottomAt({ x, y }) / 5) * 5, 10, 'scan', time)) added++;
      }
    }
    this.lastScan = { at: time, added };
    this.refresh(player, time);
    return added;
  }
  step(player, time) {
    if (time < this.nextSample) return;
    this.nextSample = time + 1;
    // Existing under-keel depth instrument: one coarse cell along our own track.
    this.record(player.x, player.y, Math.round(this.bottomAt(player) / 5) * 5, 25, 'track', time);
    this.refresh(player, time);
  }
  refresh(player, time) {
    const s = this.spacing, cx = Math.round(player.x / s) * s, cy = Math.round(player.y / s) * s;
    const cells = [];
    let known = 0, measured = 0, total = 0;
    for (let x = cx - 4000; x <= cx + 4000; x += s) {
      for (let y = cy - 4000; y <= cy + 4000; y += s) {
        if (Math.hypot(x, y) > this.radius) continue;
        const cell = this.cells.get(this.key(x, y));
        if (cell) cells.push({ ...cell });
        if (Math.hypot(x - player.x, y - player.y) <= 1800) {
          total++; if (cell) known++; if (cell && cell.source !== 'chart') measured++;
        }
      }
    }
    const heading = player.order.heading * Math.PI / 180;
    const ahead = [400, 800, 1200].map(d => this.cells.get(this.key(player.x + Math.sin(heading) * d, player.y - Math.cos(heading) * d)));
    const knownAhead = ahead.filter(Boolean);
    const clearance = knownAhead.length ? Math.min(...knownAhead.map(c => c.depth - c.error)) - Math.max(player.depth, player.order.depth) : null;
    const unknown = ahead.some(c => !c);
    let level = 'normal', report = '前方1.2 kmの海底情報を確認。表示の誤差を考慮して航行してください。';
    if (clearance !== null && clearance < 35) { level = 'danger'; report = '前方の海底余裕が小さくなっています。減速・浮上を提案します。'; }
    else if (unknown) { level = 'caution'; report = '前方に未測量区画があります。潜航を控えるか、露見リスクを伴う周辺走査を提案します。'; }
    else if (ahead.some(c => c.source === 'chart')) report = '前方は海図による概算です。浅い海底へ近づく前に周辺走査で確認できます。';
    if (this.lastScan && time - this.lastScan.at < 10 && level !== 'danger') report = `周辺走査を反映。${this.lastScan.added}区画の海底情報を更新しました。発信後の警戒を。`;
    this.snapshot = { mode: this.mode, spacing: s, cells, known: Math.round(known / Math.max(1, total) * 100), measured: Math.round(measured / Math.max(1, total) * 100), report, level, clearance, unknownAhead: unknown };
  }
  view() { return this.snapshot; }
}
