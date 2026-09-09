const SETTINGS_KEY = 'silent-depth.audio.v1';
const bounded = value => Math.max(0, Math.min(1, value));

// Only player-visible log events enter the audio system. No enemy state is read.
export class GameAudio {
  constructor(host = globalThis) {
    this.host = host;
    this.context = null;
    this.active = false;
    this.lastEventId = 0;
    this.sources = new Set();
    this.queue = [];
    this.clips = new Map();
    this.currentReport = null;
    this.generation = 0;
    this.reportSequence = 0;
    this.settings = { muted: false, volume: 0.55, voice: true };
    try {
      const saved = JSON.parse(host.localStorage?.getItem(SETTINGS_KEY) || 'null');
      if (saved) {
        if (typeof saved.muted === 'boolean') this.settings.muted = saved.muted;
        if (typeof saved.voice === 'boolean') this.settings.voice = saved.voice;
        if (Number.isFinite(saved.volume)) this.settings.volume = bounded(saved.volume);
      }
    } catch { /* Storage may be disabled; audio still works for this session. */ }
    this.chooseVoice();
    host.speechSynthesis?.addEventListener('voiceschanged', () => this.chooseVoice());
  }

  chooseVoice() {
    const voices = this.host.speechSynthesis?.getVoices() || [];
    this.voice = voices.find(v => /^ja(?:-|_)/i.test(v.lang) && v.localService)
      || voices.find(v => /^ja(?:-|_)/i.test(v.lang));
    this.onchange?.();
  }

  get audible() { return this.active && !this.settings.muted && this.settings.volume > 0; }

  async unlock() {
    try {
      if (!this.context) {
        const AudioContext = this.host.AudioContext || this.host.webkitAudioContext;
        if (!AudioContext) { this.unavailable = true; this.onchange?.(); return false; }
        this.context = new AudioContext();
        this.master = this.context.createGain();
        const limiter = this.context.createDynamicsCompressor();
        limiter.threshold.value = -12; limiter.ratio.value = 8;
        this.master.connect(limiter); limiter.connect(this.context.destination);
        this.ambient = this.context.createGain(); this.ambient.gain.value = 0; this.ambient.connect(this.master);
        this.hum = this.context.createOscillator(); this.hum.type = 'sine'; this.hum.frequency.value = 48;
        this.hum.connect(this.ambient); this.hum.start();
        this.master.gain.value = this.audible ? this.settings.volume : 0;
      }
      // Called from start/unmute/test buttons so autoplay restrictions are respected.
      await this.context.resume();
      this.unavailable = this.context.state !== 'running';
      await this.loadClips();
      this.chooseVoice(); this.onchange?.();
      return !this.unavailable;
    } catch {
      this.unavailable = true; this.onchange?.(); return false;
    }
  }

  async loadClips() {
    if (!this.host.fetch || this.clips.size || this.loadingClips) return this.loadingClips;
    this.loadingClips = (async () => {
      try {
        const base = new URL('../assets/voice/', import.meta.url);
        const response = await this.host.fetch(new URL('reports.json', base));
        if (!response.ok) throw new Error('Voice manifest unavailable');
        const scripts = await response.json();
        await Promise.all(Object.keys(scripts).map(async name => {
          const response = await this.host.fetch(new URL(`${name}.wav`, base));
          if (!response.ok) throw new Error(`Voice clip ${name} unavailable`);
          const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
          this.clips.set(name, buffer);
        }));
      } catch { this.clipLoadFailed = true; }
      finally { this.loadingClips = null; this.onchange?.(); }
    })();
    return this.loadingClips;
  }

  configure(values) {
    Object.assign(this.settings, values);
    this.settings.volume = bounded(this.settings.volume);
    try { this.host.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* Optional persistence. */ }
    this.applyVolume();
    // Cancel rather than leave queued speech to resume unexpectedly after unmuting.
    this.cancelSpeech();
    if (!this.audible) this.stopEffects();
    this.onchange?.();
  }

  applyVolume() {
    if (this.master) this.master.gain.setTargetAtTime(this.audible ? this.settings.volume : 0, this.context.currentTime, 0.025);
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active; this.applyVolume();
    if (!active) { this.cancelSpeech(); this.stopEffects(); }
  }

  reset() {
    this.setActive(false); this.cancelSpeech(); this.stopEffects(); this.lastEventId = 0;
  }

  stopEffects() {
    for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } }
    this.sources.clear();
  }

  cancelSpeech() {
    this.generation++;
    if (this.reportSource) { try { this.reportSource.stop(); } catch { /* Ended. */ } this.reportSource = null; }
    if (this.currentReport) this.host.speechSynthesis?.cancel();
    this.currentReport = null; this.queue = [];
    clearTimeout(this.speechTimer);
  }

  tone(frequency, duration, volume = 0.2, delay = 0, endFrequency = frequency, type = 'sine') {
    const c = this.context, at = c.currentTime + delay;
    const source = c.createOscillator(), gain = c.createGain();
    source.type = type; source.frequency.setValueAtTime(frequency, at);
    source.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(gain); gain.connect(this.master);
    this.track(source, gain); source.start(at); source.stop(at + duration + 0.02);
  }

  noise(duration, volume, cutoff, delay = 0) {
    const c = this.context, at = c.currentTime + delay;
    const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * duration), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter); filter.connect(gain); gain.connect(this.master);
    this.track(source, gain, filter); source.start(at); source.stop(at + duration);
  }

  track(source, ...nodes) {
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); nodes.forEach(n => n.disconnect()); };
  }

  effect(kind) {
    if (!this.audible || this.context?.state !== 'running') return;
    switch (kind) {
      case 'ping':
        this.tone(1450, 1.3, 0.32, 0, 1250);
        this.tone(1450, 0.8, 0.09, 0.35, 1250); break;
      case 'intercept': this.tone(740, 1.2, 0.18, 0, 620); break;
      case 'contact': this.tone(880, 0.22); this.tone(1320, 0.35, 0.18, 0.25); break;
      case 'launch': this.noise(1.4, 0.55, 1600); this.tone(110, 0.8, 0.3, 0, 48); break;
      case 'decoy': this.noise(0.8, 0.3, 2600); this.tone(1500, 0.5, 0.12, 0.1, 500); break;
      case 'explosion': this.noise(2.3, 0.8, 650); this.tone(85, 1.8, 0.55, 0, 28); break;
      case 'damage': this.effect('explosion'); this.effect('alarm'); break;
      case 'alarm':
        for (let i = 0; i < 3; i++) this.tone(660, 0.22, 0.22, i * 0.3, 930, 'triangle'); break;
      case 'success': [440, 554, 659, 880].forEach((f, i) => this.tone(f, 0.7, 0.2, i * 0.2)); break;
      case 'failure': [440, 330, 220].forEach((f, i) => this.tone(f, 0.9, 0.2, i * 0.3)); break;
      default: this.tone(600, 0.15, 0.12);
    }
  }

  speak(text, priority = 0, clip = 'contact') {
    if (!text || !this.audible || !this.settings.voice) return;
    if ((!this.voice || !this.host.SpeechSynthesisUtterance || this.speechFailed) && !this.clips.has(clip)) return;
    if (priority > (this.currentReport?.priority ?? -1) && this.currentReport) this.cancelSpeech();
    // Fast-forward must not build a long backlog of stale tactical reports.
    this.queue = this.queue.filter(r => r.text !== text);
    this.queue.push({ text, priority, clip, at: Date.now(), sequence: this.reportSequence++ });
    this.queue.sort((a, b) => b.priority - a.priority || b.sequence - a.sequence);
    this.queue = this.queue.slice(0, 3);
    this.nextReport();
  }

  nextReport() {
    if (this.currentReport || !this.audible) return;
    this.queue = this.queue.filter(r => Date.now() - r.at < 8000);
    const report = this.queue.shift();
    if (!report) return;
    this.currentReport = report;
    const generation = this.generation;
    const done = () => {
      if (this.generation !== generation || this.currentReport !== report) return;
      clearTimeout(this.speechTimer); this.currentReport = null; this.nextReport();
    };
    let usingFallback = false;
    const fallback = () => {
      if (usingFallback) return;
      usingFallback = true; clearTimeout(this.speechTimer);
      const buffer = this.clips.get(report.clip);
      if (!buffer || this.context?.state !== 'running') { done(); return; }
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.master); this.reportSource = source;
      source.onended = () => {
        source.disconnect();
        if (this.reportSource === source) this.reportSource = null;
        done();
      };
      source.start();
    };
    if (!this.voice || !this.host.SpeechSynthesisUtterance || this.speechFailed) { fallback(); return; }
    const utterance = new this.host.SpeechSynthesisUtterance(report.text);
    utterance.lang = 'ja-JP'; utterance.voice = this.voice; utterance.rate = 1.12;
    utterance.volume = this.settings.volume;
    utterance.onend = () => { if (!usingFallback) done(); };
    utterance.onerror = event => {
      if (this.generation !== generation || usingFallback) return;
      clearTimeout(this.speechTimer);
      if (!['canceled', 'interrupted'].includes(event.error)) {
        this.speechFailed = true; this.onchange?.(); fallback();
      } else done();
    };
    const failover = () => {
      if (this.generation !== generation || this.currentReport !== report || usingFallback) return;
      this.speechFailed = true; this.onchange?.();
      fallback(); this.host.speechSynthesis.cancel();
    };
    // Some engines expose a voice but never start (for example when offline).
    this.speechTimer = setTimeout(failover, 2500);
    utterance.onstart = () => {
      if (this.generation !== generation || usingFallback) return;
      clearTimeout(this.speechTimer); this.speechTimer = setTimeout(failover, 12000);
    };
    this.host.speechSynthesis.speak(utterance);
  }

  update(view, active, ambientActive = active) {
    this.setActive(active);
    if (this.ambient) {
      const gain = ambientActive && !view.result ? 0.018 + view.player.speed * 0.0015 : 0;
      this.ambient.gain.setTargetAtTime(gain, this.context.currentTime, 0.3);
      this.hum.frequency.setTargetAtTime(45 + view.player.speed * 1.4, this.context.currentTime, 0.5);
    }
    const fresh = view.events.filter(e => e.id > this.lastEventId).reverse();
    this.lastEventId = Math.max(this.lastEventId, ...fresh.map(e => e.id));
    if (!active) return;
    for (const event of fresh) {
      if (!event.audio) continue;
      this.effect(event.audio.sound);
      this.speak(event.audio.report || event.text, event.audio.priority || 0, event.audio.clip || event.audio.sound);
    }
  }
}
