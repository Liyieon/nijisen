/* recorder.js — capture a performance.
   AUDIO : master bus -> MediaRecorder -> decoded and re-encoded as 16-bit WAV
   VIDEO : a compositor canvas (video + scan lines [+ plate]) -> captureStream,
           muxed with the master bus audio -> mp4 or webm, whichever the
           browser can encode.
   Module-agnostic: it only needs an audio engine and a function that returns
   the canvases to composite. */
(function (g) {
  'use strict';
  const AM = g.AM;

  function pickMime(list) {
    if (!g.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (let i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  const VIDEO_MIMES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

  function extFor(mime) {
    if (/mp4/.test(mime)) return 'mp4';
    if (/ogg/.test(mime)) return 'ogg';
    return 'webm';
  }
  function stamp() {
    const d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* AudioBuffer -> 16-bit PCM WAV */
  function encodeWav(buf) {
    const ch = buf.numberOfChannels, rate = buf.sampleRate, len = buf.length;
    const bytes = 44 + len * ch * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    let o = 0;
    const str = function (s) { for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i)); };
    const u32 = function (v) { view.setUint32(o, v, true); o += 4; };
    const u16 = function (v) { view.setUint16(o, v, true); o += 2; };
    str('RIFF'); u32(bytes - 8); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(ch); u32(rate); u32(rate * ch * 2); u16(ch * 2); u16(16);
    str('data'); u32(len * ch * 2);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function Recorder(engine, sources) {
    this.engine = engine;
    this.sources = sources;       // () => { stage, overlay, plate, showLines, withPlate }
    this.rec = null;
    this.kind = null;
    this.t0 = 0;
    this.comp = null;
    this.onchange = function () { };
  }

  Recorder.supported = function () {
    return !!(g.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
  };
  Recorder.prototype.recording = function () { return !!this.rec; };
  Recorder.prototype.elapsed = function () { return this.rec ? (performance.now() - this.t0) / 1000 : 0; };

  Recorder.prototype.start = function (kind) {
    if (this.rec) return false;
    if (!g.MediaRecorder) throw new Error('MediaRecorder not supported');
    const audio = this.engine.streamTap();
    let stream, mime;

    if (kind === 'video') {
      mime = pickMime(VIDEO_MIMES);
      this.comp = document.createElement('canvas');
      this.layout();
      this.tick();
      const vtracks = this.comp.captureStream(30).getVideoTracks();
      stream = new MediaStream(vtracks.concat(audio.getAudioTracks()));
    } else {
      mime = pickMime(AUDIO_MIMES);
      stream = new MediaStream(audio.getAudioTracks());
    }

    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    const self = this;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      const type = rec.mimeType || mime || (kind === 'video' ? 'video/webm' : 'audio/webm');
      const blob = new Blob(chunks, { type: type });
      self.finish(kind, blob, type);
    };
    rec.start(1000);             // flush every second so a crash loses at most 1s
    this.rec = rec; this.kind = kind; this.t0 = performance.now(); this.mime = mime;
    this.onchange();
    return true;
  };

  Recorder.prototype.stop = function () {
    if (!this.rec) return;
    try { this.rec.stop(); } catch (e) { }
    this.rec = null;
    this.onchange();
  };

  Recorder.prototype.finish = function (kind, blob, type) {
    const base = 'nijisen-' + (kind === 'video' ? 'video' : 'audio') + '-' + stamp();
    this.comp = null;
    if (kind !== 'video') {
      // WAV is what people drop into a DAW; fall back to the raw capture if decoding fails
      const self = this;
      blob.arrayBuffer()
        .then(function (ab) { return self.engine.ctx.decodeAudioData(ab); })
        .then(function (buf) {
          download(encodeWav(buf), base + '.wav');
          self.onsaved && self.onsaved({ kind: kind, name: base + '.wav', seconds: buf.duration });
        })
        .catch(function () {
          download(blob, base + '.' + extFor(type));
          self.onsaved && self.onsaved({ kind: kind, name: base + '.' + extFor(type), fallback: true });
        });
      return;
    }
    download(blob, base + '.' + extFor(type));
    this.onsaved && this.onsaved({ kind: kind, name: base + '.' + extFor(type) });
  };

  /* size the compositor: video area, plate below (wide plate) or beside (tall plate) */
  Recorder.prototype.layout = function () {
    const s = this.sources();
    let W = s.stage.width, H = s.stage.height;
    let pw = 0, ph = 0, side = false;
    if (s.withPlate && s.plate && s.plate.width && s.plate.height) {
      side = s.plate.height > s.plate.width;
      if (side) { ph = H; pw = Math.round(H * s.plate.width / s.plate.height); }
      else { pw = W; ph = Math.round(W * s.plate.height / s.plate.width); }
    }
    let TW = side ? W + pw : W, TH = side ? H : H + ph;
    // keep the encoder happy: longest side <= 1920, even dimensions
    const k = Math.min(1, 1920 / Math.max(TW, TH));
    const even = function (v) { return Math.max(2, Math.round(v * k / 2) * 2); };
    this.geo = { k: k, W: even(W), H: even(H), pw: side || ph ? even(pw) : 0, ph: ph ? even(ph) : 0, side: side };
    this.comp.width = side ? this.geo.W + this.geo.pw : this.geo.W;
    this.comp.height = side ? this.geo.H : this.geo.H + this.geo.ph;
  };

  /* called once per animation frame while a video recording runs */
  Recorder.prototype.tick = function () {
    if (!this.comp) return;
    const s = this.sources(), c = this.comp.getContext('2d'), G = this.geo;
    if (!G || (s.stage.width && Math.abs(s.stage.width * G.k - G.W) > 4)) this.layout();
    const g2 = this.geo;
    c.fillStyle = AM.STAGE_BG || '#0c0e11';
    c.fillRect(0, 0, this.comp.width, this.comp.height);
    c.drawImage(s.stage, 0, 0, g2.W, g2.H);
    if (s.showLines && s.overlay) c.drawImage(s.overlay, 0, 0, g2.W, g2.H);
    if (s.withPlate && s.plate && (g2.pw || g2.ph)) {
      if (g2.side) c.drawImage(s.plate, g2.W, 0, g2.pw, g2.H);
      else c.drawImage(s.plate, 0, g2.H, g2.W, g2.ph);
    }
  };

  AM.Recorder = Recorder;
  AM.download = download;
  AM.fileStamp = stamp;
  AM.encodeWav = encodeWav;
})(window);
