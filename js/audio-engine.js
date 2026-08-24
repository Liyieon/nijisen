/* audio-engine.js — three synth voices + master FX bus + analyser
   voices:  BELL  = 2-op FM, glassy, long tail
            PLUCK = Karplus-Strong string (noise burst -> damped delay loop)
            GLITCH= detuned squares -> bitcrush -> swept bandpass, short
*/
(function (g) {
  'use strict';

  const AM = g.AM;

  function AudioEngine() {
    this.ctx = null;
    this.ready = false;
    this.voice = 'BELL';
    this.active = 0;
    this.maxVoices = 28;
    this.fx = { REV: true, DLY: true, LPF: false, BIT: false, SUB: false };
    this._hits = 0;
  }

  AudioEngine.prototype.init = function () {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const C = g.AudioContext || g.webkitAudioContext;
    const ctx = this.ctx = new C();

    // ---- master chain ----
    const master = ctx.createGain(); master.gain.value = 0.8;
    const crush = ctx.createWaveShaper(); crush.curve = flatCurve(); // bypass-ish by default
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 18000; lpf.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.72;

    // ---- sends ----
    const bus = ctx.createGain();               // every voice lands here
    const revSend = ctx.createGain(); revSend.gain.value = 0.30;
    const dlySend = ctx.createGain(); dlySend.gain.value = 0.22;

    const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx, 2.6, 2.4);
    const revRet = ctx.createGain(); revRet.gain.value = 0.9;

    const dly = ctx.createDelay(2.0); dly.delayTime.value = 0.375;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const dlyTone = ctx.createBiquadFilter(); dlyTone.type = 'lowpass'; dlyTone.frequency.value = 2600;
    const dlyRet = ctx.createGain(); dlyRet.gain.value = 0.8;

    bus.connect(crush);
    bus.connect(revSend); bus.connect(dlySend);

    revSend.connect(conv); conv.connect(revRet); revRet.connect(crush);
    dlySend.connect(dly); dly.connect(dlyTone); dlyTone.connect(fb); fb.connect(dly);
    dlyTone.connect(dlyRet); dlyRet.connect(crush);

    crush.connect(lpf); lpf.connect(master); master.connect(comp);
    comp.connect(analyser); analyser.connect(ctx.destination);

    this.nodes = { master, crush, lpf, comp, analyser, bus, revSend, dlySend, dly, fb, dlyTone };
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    this.timeData = new Uint8Array(analyser.fftSize);
    this.ready = true;
    this.applyFx();
  };

  AudioEngine.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  };
  AudioEngine.prototype.now = function () { return this.ctx ? this.ctx.currentTime : 0; };
  AudioEngine.prototype.setVolume = function (v) {
    if (this.ready) this.nodes.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  };
  AudioEngine.prototype.setVoice = function (v) { this.voice = v; };
  AudioEngine.prototype.setDelayTime = function (sec) {
    if (this.ready) this.nodes.dly.delayTime.setTargetAtTime(sec, this.ctx.currentTime, 0.05);
  };
  AudioEngine.prototype.toggleFx = function (k) {
    this.fx[k] = !this.fx[k];
    this.applyFx();
    return this.fx[k];
  };
  AudioEngine.prototype.applyFx = function () {
    if (!this.ready) return;
    const n = this.nodes, t = this.ctx.currentTime;
    n.revSend.gain.setTargetAtTime(this.fx.REV ? 0.30 : 0.0, t, 0.05);
    n.dlySend.gain.setTargetAtTime(this.fx.DLY ? 0.22 : 0.0, t, 0.05);
    n.lpf.frequency.setTargetAtTime(this.fx.LPF ? 900 : 18000, t, 0.05);
    n.crush.curve = this.fx.BIT ? crushCurve(6) : flatCurve();
  };

  AudioEngine.prototype.getSpectrum = function () {
    if (!this.ready) return null;
    this.nodes.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  };
  AudioEngine.prototype.getWave = function () {
    if (!this.ready) return null;
    this.nodes.analyser.getByteTimeDomainData(this.timeData);
    return this.timeData;
  };

  /* trigger one note.
     o = { freq, vel(0..1), pan(-1..1), when(absolute ctx time), voice } */
  AudioEngine.prototype.trigger = function (o) {
    if (!this.ready) return false;
    if (this.active >= this.maxVoices) return false;
    const t = Math.max(o.when || 0, this.ctx.currentTime + 0.001);
    const vel = AM.clamp(o.vel === undefined ? 0.8 : o.vel, 0.05, 1);
    const freq = AM.clamp(o.freq || 220, 20, 12000);
    const voice = o.voice || this.voice;

    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = AM.clamp(o.pan || 0, -1, 1);
    const out = this.ctx.createGain(); out.gain.value = 1;
    if (pan) { out.connect(pan); pan.connect(this.nodes.bus); }
    else out.connect(this.nodes.bus);

    let dur = 0.5;
    if (voice === 'BELL') dur = this._bell(freq, vel, t, out);
    else if (voice === 'PLUCK') dur = this._pluck(freq, vel, t, out);
    else dur = this._glitch(freq, vel, t, out);

    if (this.fx.SUB) this._sub(freq, vel, t, out);

    this.active++; this._hits++;
    const self = this;
    setTimeout(function () {
      self.active = Math.max(0, self.active - 1);
      try { out.disconnect(); if (pan) pan.disconnect(); } catch (e) { }
    }, (t - this.ctx.currentTime + dur + 0.25) * 1000);
    return true;
  };

  AudioEngine.prototype.hits = function () { return this._hits; };
  AudioEngine.prototype.resetHits = function () { this._hits = 0; };

  /* ---------------- voice 1 : BELL (FM) ---------------- */
  AudioEngine.prototype._bell = function (freq, vel, t, out) {
    const ctx = this.ctx;
    // longer tail for low notes, tighter for high ones
    const dur = AM.clamp(2.6 * Math.pow(220 / freq, 0.45), 0.45, 3.4);

    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = freq;
    const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = freq * 2.007;
    const modG = ctx.createGain();
    const idx = freq * (1.9 + vel * 3.4);
    modG.gain.setValueAtTime(idx, t);
    modG.gain.exponentialRampToValueAtTime(Math.max(idx * 0.02, 1), t + dur * 0.55);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.62 * vel, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const tone = ctx.createBiquadFilter();
    tone.type = 'highpass'; tone.frequency.value = 90;

    mod.connect(modG); modG.connect(car.frequency);
    car.connect(amp); amp.connect(tone); tone.connect(out);
    mod.start(t); car.start(t);
    mod.stop(t + dur + 0.05); car.stop(t + dur + 0.05);
    return dur;
  };

  /* ---------------- voice 2 : PLUCK (Karplus-Strong) ---------------- */
  AudioEngine.prototype._pluck = function (freq, vel, t, out) {
    const ctx = this.ctx;
    const dur = AM.clamp(1.8 * Math.pow(220 / freq, 0.35), 0.35, 2.6);
    const period = 1 / freq;

    // excitation: 1 period of filtered noise
    const len = Math.max(2, Math.ceil(ctx.sampleRate * period));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;

    const exG = ctx.createGain(); exG.gain.value = 0.85 * vel;

    const del = ctx.createDelay(0.2);
    del.delayTime.value = period;
    // Damping must never exceed unity gain anywhere or the loop runs away.
    // A lowpass biquad overshoots (~1.2x near 2kHz even at Q=0.5); a highshelf
    // with negative gain is flat at 1.0 below the corner and only cuts above it,
    // measured peak exactly 1.000 — so the loop gain is just fb.
    const damp = ctx.createBiquadFilter();
    damp.type = 'highshelf';
    damp.frequency.value = AM.clamp(freq * 4, 1200, 8000);
    damp.gain.value = -13;
    const fb = ctx.createGain();
    fb.gain.value = AM.clamp(0.993 - (freq / 12000) * 0.03, 0.6, 0.995);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(1, t);
    amp.gain.setValueAtTime(1, t + dur * 0.65);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const body = ctx.createBiquadFilter();
    body.type = 'bandpass'; body.frequency.value = freq * 1.5; body.Q.value = 0.6;

    src.connect(exG); exG.connect(del);
    del.connect(damp); damp.connect(fb); fb.connect(del);
    damp.connect(amp); exG.connect(amp);
    const lvl = ctx.createGain(); lvl.gain.value = 3.4;
    amp.connect(body); body.connect(lvl); lvl.connect(out);

    src.start(t); src.stop(t + period * 1.2);
    setTimeout(function () { try { del.disconnect(); fb.disconnect(); damp.disconnect(); } catch (e) { } },
      (t - ctx.currentTime + dur + 0.3) * 1000);
    return dur;
  };

  /* ---------------- voice 3 : GLITCH ---------------- */
  AudioEngine.prototype._glitch = function (freq, vel, t, out) {
    const ctx = this.ctx;
    const dur = AM.clamp(0.34 - vel * 0.12, 0.09, 0.34);

    const o1 = ctx.createOscillator(); o1.type = 'square'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = freq * 1.005;
    o2.detune.setValueAtTime(14, t);
    o2.detune.linearRampToValueAtTime(-38, t + dur);

    const mix = ctx.createGain(); mix.gain.value = 0.5;

    const shaper = ctx.createWaveShaper();
    shaper.curve = crushCurve(3 + Math.floor((1 - vel) * 3));

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(AM.clamp(freq * 6, 200, 9000), t);
    bp.frequency.exponentialRampToValueAtTime(AM.clamp(freq * 1.4, 120, 9000), t + dur);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(1.35 * vel, t + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // noise transient
    const nlen = Math.ceil(ctx.sampleRate * 0.02);
    const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nlen);
    const nsrc = ctx.createBufferSource(); nsrc.buffer = nbuf;
    const ng = ctx.createGain(); ng.gain.value = 0.35 * vel;

    o1.connect(mix); o2.connect(mix);
    mix.connect(shaper); shaper.connect(bp); bp.connect(amp);
    nsrc.connect(ng); ng.connect(amp);
    amp.connect(out);

    o1.start(t); o2.start(t); nsrc.start(t);
    o1.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
    return dur;
  };

  /* sub-octave layer (FX: SUB) */
  AudioEngine.prototype._sub = function (freq, vel, t, out) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.value = AM.clamp(freq / 2, 25, 400);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0.0001, t);
    a.gain.exponentialRampToValueAtTime(0.3 * vel, t + 0.01);
    a.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(a); a.connect(out);
    o.start(t); o.stop(t + 0.55);
  };

  /* ---------------- helpers ---------------- */
  function makeIR(ctx, seconds, decay) {
    const rate = ctx.sampleRate, len = Math.ceil(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < rate * 0.004 ? t * 250 : 1);
      }
    }
    return buf;
  }

  const _flat = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) _flat[i] = (i / 1023) * 2 - 1;
  function flatCurve() { return _flat; }

  const _crushCache = {};
  function crushCurve(bits) {
    if (_crushCache[bits]) return _crushCache[bits];
    const n = 1024, c = new Float32Array(n);
    const steps = Math.pow(2, bits);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.round(x * steps) / steps;
    }
    _crushCache[bits] = c;
    return c;
  }

  g.AM.AudioEngine = AudioEngine;
})(window);
