/* detector.js — threshold lines over a video frame.
   A line is split into N cells. Every frame each cell reports an activity
   value; a rising cross of SENS fires an event (with a per-cell hold time so
   one gesture is one note, not a machine gun). */
(function (g) {
  'use strict';
  const AM = g.AM;

  let _uid = 1;

  function makeLine(orient, pos) {
    return {
      id: _uid++,
      orient: orient || 'h',      // 'h' = horizontal line, scans across x
      pos: pos === undefined ? 0.5 : pos,   // 0..1 across the other axis
      octave: 0,                  // transpose in octaves
      prev: null,                 // Float32Array previous luma per cell
      prevAct: null,              // Float32Array previous activity per cell
      gate: null,                 // Uint8Array armed flags
      last: null,                 // Float64Array last trigger ms per cell
      flash: null                 // Float32Array 0..1 visual flash per cell
    };
  }

  function Detector() {
    this.lines = [makeLine('h', 0.55)];
    this.mode = 'motion';         // motion | luma | edge
    this.sens = 0.18;
    this.cells = 16;
    this.hold = 120;              // ms per cell
    this.band = 3;                // half-height of the sampled strip, px
    this.enabled = true;
  }

  Detector.prototype.addLine = function (orient) {
    if (this.lines.length >= 6) return null;
    const l = makeLine(orient || 'h', 0.2 + Math.random() * 0.6);
    this.lines.push(l);
    return l;
  };
  Detector.prototype.removeLine = function () {
    if (this.lines.length <= 1) return false;
    this.lines.pop();
    return true;
  };
  Detector.prototype.reset = function () {
    for (const l of this.lines) { l.prev = null; l.prevAct = null; l.gate = null; l.last = null; l.flash = null; }
  };

  function ensure(l, n) {
    if (!l.prev || l.prev.length !== n) {
      l.prev = new Float32Array(n);
      l.prevAct = new Float32Array(n);
      l.gate = new Uint8Array(n);
      l.last = new Float64Array(n);
      l.flash = new Float32Array(n);
      l.colors = new Float32Array(n * 3);
      l.warm = 2;   // skip the first frames: prev[] is empty, everything would fire at once
    }
  }

  /* actx : 2d context of the small analysis canvas holding the current frame
     returns [{line, cell, act, vel, nx, ny, r, g, b}] */
  Detector.prototype.analyze = function (actx, aw, ah, tms) {
    const events = [];
    if (!this.enabled) return events;
    const n = this.cells, mode = this.mode, sens = this.sens;
    const relSens = sens * 0.6;  // hysteresis floor to re-arm a cell

    for (const line of this.lines) {
      ensure(line, n);

      const horiz = line.orient === 'h';
      const axisLen = horiz ? aw : ah;
      const cross = Math.round((horiz ? ah : aw) * line.pos);
      const b = this.band;
      const s0 = AM.clamp(cross - b, 0, (horiz ? ah : aw) - 1);
      const s1 = AM.clamp(cross + b, 0, (horiz ? ah : aw) - 1);
      const thick = Math.max(1, s1 - s0 + 1);

      let data;
      try {
        data = horiz ? actx.getImageData(0, s0, aw, thick).data
          : actx.getImageData(s0, 0, thick, ah).data;
      } catch (e) {
        this.tainted = true;
        return events;
      }

      const cellLen = axisLen / n;
      const stride = horiz ? aw : thick;   // pixels per row of the read block

      for (let c = 0; c < n; c++) {
        const a0 = Math.floor(c * cellLen);
        const a1 = Math.max(a0 + 1, Math.floor((c + 1) * cellLen));
        let sum = 0, sr = 0, sg = 0, sb = 0, cnt = 0, edge = 0, prevL = -1;

        for (let a = a0; a < a1; a++) {
          for (let t = 0; t < thick; t++) {
            // index inside the read block
            const px = horiz ? (t * stride + a) : (a * stride + t);
            const i = px * 4;
            const r = data[i], gg = data[i + 1], bl = data[i + 2];
            const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * bl;
            sum += lum; sr += r; sg += gg; sb += bl; cnt++;
            if (t === (thick >> 1)) {
              if (prevL >= 0) edge += Math.abs(lum - prevL);
              prevL = lum;
            }
          }
        }
        if (!cnt) continue;

        const mean = sum / cnt;
        const er = sr / cnt, eg = sg / cnt, eb = sb / cnt;
        line.colors[c * 3] = er; line.colors[c * 3 + 1] = eg; line.colors[c * 3 + 2] = eb;

        let act;
        if (mode === 'motion') act = Math.abs(mean - line.prev[c]) / 255 * 3.2;
        else if (mode === 'luma') act = mean / 255;
        else act = (edge / Math.max(1, (a1 - a0))) / 255 * 6;

        line.prev[c] = mean;

        // rising-edge trigger with hold + hysteresis re-arm
        const armed = line.gate[c] === 0 && line.warm <= 0;
        if (armed && act >= sens && (tms - line.last[c]) > this.hold) {
          line.gate[c] = 1;
          line.last[c] = tms;
          const vel = AM.clamp((act - sens) / Math.max(0.05, 1 - sens) * 0.85 + 0.25, 0.15, 1);
          const nAxis = (c + 0.5) / n;
          events.push({
            line: line,
            cell: c,
            act: act,
            vel: vel,
            nx: horiz ? nAxis : line.pos,
            ny: horiz ? line.pos : nAxis,
            r: er, g: eg, b: eb
          });
          line.flash[c] = 1;
        } else if (!armed && act < relSens) {
          line.gate[c] = 0;
        }
        line.prevAct[c] = act;
        if (line.flash[c] > 0) line.flash[c] = Math.max(0, line.flash[c] - 0.055);
      }
      if (line.warm > 0) line.warm--;
    }
    return events;
  };

  /* hit-test a normalised point against the lines, for dragging */
  Detector.prototype.pick = function (nx, ny, tol) {
    tol = tol || 0.03;
    let best = null, bestD = tol;
    for (const l of this.lines) {
      const d = Math.abs((l.orient === 'h' ? ny : nx) - l.pos);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  };

  g.AM.Detector = Detector;
  g.AM.makeLine = makeLine;
})(window);
