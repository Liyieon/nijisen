/* spectro.js — the "spectrum plate".
   Every trigger paints the FFT of the moment it fired, tinted with the colour
   the threshold line actually touched in the video. Three plate modes:
     SCROLL — time runs left to right, one column per frame
     STACK  — columns land at the x of the touched cell and pile up
     RING   — polar plate, angle = position along the line
   Export as PNG. */
(function (g) {
  'use strict';
  const AM = g.AM;

  function Spectro(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    this.W = canvas.width; this.H = canvas.height;
    this.mode = 'scroll';
    this.col = this.ctx.createImageData(1, this.H);
    this.ringAngle = 0;
    this.frames = 0;
    this.clear();
  }

  Spectro.prototype.setMode = function (m) { this.mode = m; };
  /* the active scan-colour ramp, so the plate and the scan lines stay in sync */
  Spectro.prototype.setRamp = function (r) { this.ramp = r && r.length ? r.slice() : null; };
  Spectro.prototype.blend = function () { return AM.THEME === 'dark' ? 'screen' : 'multiply'; };

  Spectro.prototype.clear = function () {
    const c = this.ctx, W = this.W, H = this.H;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = AM.PAPER2; c.fillRect(0, 0, W, H);

    // 和紙 horizontal grain, so an exported plate still reads as paper
    c.strokeStyle = AM.grain(.075); c.lineWidth = 1;
    for (let y = 0; y < H; y += 5) { c.beginPath(); c.moveTo(0, y + .5); c.lineTo(W, y + .5); c.stroke(); }
    c.strokeStyle = AM.grain(.10);
    for (let y = 0; y < H; y += 41) { c.beginPath(); c.moveTo(0, y + .5); c.lineTo(W, y + .5); c.stroke(); }

    // scattered square field
    for (let i = 0; i < 140; i++) {
      const x = Math.random() * W, y = Math.random() * H, s2 = 2 + Math.random() * 3;
      c.globalAlpha = 0.05 + Math.random() * 0.13;
      if (Math.random() > 0.65) { c.fillStyle = AM.INK; c.fillRect(x, y, s2, s2); }
      else { c.strokeStyle = AM.INK; c.lineWidth = 0.7; c.strokeRect(x, y, s2, s2); }
    }
    c.globalAlpha = 1;

    // registration marks, like a print plate
    c.strokeStyle = AM.hair(.22); c.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = Math.round(W * i / 8) + .5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 7); c.moveTo(x, H); c.lineTo(x, H - 7); c.stroke();
    }
    c.beginPath(); c.moveTo(0, H - .5); c.lineTo(W, H - .5); c.stroke();
    this.frames = 0;
  };

  /* map 0..1 plate position -> fft bin (log-ish, low freq at the bottom) */
  function binAt(t, n) {
    const idx = Math.floor(Math.pow(t, 2.1) * n * 0.72);
    return idx < 0 ? 0 : (idx >= n ? n - 1 : idx);
  }

  /* per-frame background painting (SCROLL only) */
  Spectro.prototype.frame = function (spec, playing) {
    if (!spec || this.mode !== 'scroll') return;
    const c = this.ctx, W = this.W, H = this.H;
    // shift left by 1px
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.cv, -1, 0);

    const px = this.col.data, n = spec.length;
    const base = AM.hexToRgb(AM.PAPER2);
    for (let y = 0; y < H; y++) {
      const t = 1 - y / (H - 1);                 // top = high freq
      const v = spec[binAt(t, n)] / 255;
      const ramp = this.ramp && this.ramp.length ? this.ramp : AM.PALETTE;
      const acc = AM.hexToRgb(ramp[Math.floor(t * (ramp.length - 1))]);
      const k = playing ? Math.pow(v, 1.35) : 0;
      const dark = AM.THEME === 'dark';
      const tr = dark ? acc.r * 0.85 + 60 : acc.r * 0.55 + 20;
      const tg = dark ? acc.g * 0.85 + 60 : acc.g * 0.55 + 20;
      const tb = dark ? acc.b * 0.85 + 60 : acc.b * 0.55 + 20;
      const i = y * 4;
      px[i] = AM.lerp(base.r, tr, k);
      px[i + 1] = AM.lerp(base.g, tg, k);
      px[i + 2] = AM.lerp(base.b, tb, k);
      px[i + 3] = 255;
    }
    c.putImageData(this.col, W - 1, 0);
    this.frames++;
  };

  /* one trigger -> one mark on the plate
     ev : {nx, ny, vel, r,g,b, cell, cells, noteName} */
  Spectro.prototype.stamp = function (ev, spec) {
    const c = this.ctx, W = this.W, H = this.H;
    const snapped = AM.paletteSnap(ev.r, ev.g, ev.b, 0.62, ev.ramp);
    const col = AM.rgbToCss(snapped.r, snapped.g, snapped.b, 1);

    if (this.mode === 'ring') return this._stampRing(ev, spec, col);

    const x = this.mode === 'scroll'
      ? W - 1
      : Math.round(AM.clamp(ev.nx, 0, 1) * (W - 3)) + 1;

    const w = this.mode === 'scroll' ? 2 : Math.max(2, Math.round(2 + ev.vel * 7));

    c.globalCompositeOperation = this.blend();
    // FFT smear of this instant
    if (spec) {
      const n = spec.length;
      for (let y = 0; y < H; y++) {
        const t = 1 - y / (H - 1);
        const v = spec[binAt(t, n)] / 255;
        if (v < 0.06) continue;
        c.globalAlpha = AM.clamp(v * 0.85 * (0.4 + ev.vel * 0.6), 0, 1);
        c.fillStyle = col;
        c.fillRect(x - (w >> 1), y, w, 1);
      }
    }
    // the note itself: a solid block at the pitch height
    c.globalAlpha = 1;
    const py = Math.round((1 - AM.clamp(ev.pitchNorm === undefined ? ev.nx : ev.pitchNorm, 0, 1)) * (H - 10)) + 4;
    c.fillStyle = col;
    c.fillRect(x - (w >> 1) - 1, py - 2, w + 2, 5);
    // ink tick, keeps the plate graphic
    c.fillStyle = AM.hair(.55);
    c.fillRect(x - (w >> 1) - 1, py + 4, w + 2, 1);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  };

  Spectro.prototype._stampRing = function (ev, spec, col) {
    const c = this.ctx, W = this.W, H = this.H;
    const cx = W / 2, cy = H / 2;
    const rMax = Math.min(W, H) * 0.46;
    const ang = AM.clamp(ev.nx, 0, 1) * Math.PI * 2 - Math.PI / 2;
    c.save();
    c.globalCompositeOperation = this.blend();
    if (spec) {
      const n = spec.length, steps = 90;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const v = spec[binAt(t, n)] / 255;
        if (v < 0.07) continue;
        const r0 = rMax * 0.18 + t * rMax * 0.82;
        c.globalAlpha = AM.clamp(v * 0.8 * ev.vel, 0, 1);
        c.strokeStyle = col;
        c.lineWidth = 1 + ev.vel * 2;
        c.beginPath();
        c.arc(cx, cy, r0, ang - 0.012, ang + 0.012);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
    c.fillStyle = col;
    const pr = rMax * (0.18 + AM.clamp(ev.pitchNorm || 0, 0, 1) * 0.82);
    c.beginPath();
    c.arc(cx + Math.cos(ang) * pr, cy + Math.sin(ang) * pr, 1.6 + ev.vel * 2.4, 0, 6.2832);
    c.fill();
    c.restore();
  };

  /* the plate follows the layout: keep the artwork, change the sheet */
  Spectro.prototype.resize = function (w, h) {
    w = Math.max(200, Math.round(w)); h = Math.max(80, Math.round(h));
    if (w === this.W && h === this.H) return;
    const tmp = document.createElement('canvas');
    tmp.width = this.W; tmp.height = this.H;
    tmp.getContext('2d').drawImage(this.cv, 0, 0);
    this.cv.width = w; this.cv.height = h;
    this.W = w; this.H = h;
    this.col = this.ctx.createImageData(1, h);
    this.clear();
    this.ctx.drawImage(tmp, 0, 0, w, h);
  };

  Spectro.prototype.save = function (name) {
    const a = document.createElement('a');
    const d = new Date();
    const ts = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    a.download = (name || 'nijisen-plate') + '-' + ts + '.png';
    a.href = this.cv.toDataURL('image/png');
    document.body.appendChild(a); a.click(); a.remove();
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  g.AM.Spectro = Spectro;
})(window);
