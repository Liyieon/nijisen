/* knob.js — instrument knob bound to a hidden <input type=range>.
   Look: knurled ring + tick collar + pointer, after industrial panel HUDs.
   Drag vertically (shift = fine), wheel, or double-click to reset. */
(function (g) {
  'use strict';
  const AM = g.AM;
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  /* deg: 0 = up, clockwise positive */
  function polar(cx, cy, r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function arc(cx, cy, r, a0, a1) {
    const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }

  const A0 = -132, A1 = 132;          // sweep of the collar

  function Knob(o) {
    this.input = o.input;
    this.label = o.label || '';
    this.fmt = o.fmt || function (v) { return String(v); };
    this.unit = o.unit || '';
    this.color = o.color || AM.PALETTE[5];
    this.onInput = o.onInput || function () { };
    this.size = o.size || 58;
    this.def = parseFloat(this.input.value);
    this.build();
    const self = this;
    this.input.addEventListener('input', function () { self.sync(); });
    this.sync(true);
  }

  Knob.prototype.build = function () {
    const S = this.size, cx = S / 2, cy = S / 2;
    const wrap = document.createElement('div');
    wrap.className = 'knob';

    const cap = document.createElement('div');
    cap.className = 'k-cap';
    cap.textContent = this.label;

    const svg = el('svg', { width: S, height: S, viewBox: '0 0 ' + S + ' ' + S, class: 'k-svg' });

    // tick collar
    const rTick = cx - 2;
    const ticks = el('g', { class: 'k-ticks' });
    const N = 21;
    for (let i = 0; i < N; i++) {
      const a = A0 + (A1 - A0) * i / (N - 1);
      const major = i % 5 === 0;
      const p0 = polar(cx, cy, rTick, a);
      const p1 = polar(cx, cy, rTick - (major ? 5 : 3), a);
      ticks.appendChild(el('line', {
        x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2),
        'stroke-width': major ? 1.2 : 0.7
      }));
    }
    svg.appendChild(ticks);

    // value arc
    const rArc = cx - 9;
    svg.appendChild(el('path', { class: 'k-track', d: arc(cx, cy, rArc, A0, A1), fill: 'none' }));
    this.arcEl = el('path', { class: 'k-fill', d: '', fill: 'none', stroke: this.color });
    svg.appendChild(this.arcEl);

    // knurled body
    const rBody = cx - 14;
    const knurl = el('g', { class: 'k-knurl' });
    for (let i = 0; i < 30; i++) {
      const a = i * 12;
      const p0 = polar(cx, cy, rBody, a), p1 = polar(cx, cy, rBody - 2.6, a);
      knurl.appendChild(el('line', { x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2) }));
    }
    svg.appendChild(el('circle', { class: 'k-body', cx: cx, cy: cy, r: rBody }));
    svg.appendChild(knurl);

    // pointer
    this.ptr = el('line', {
      class: 'k-ptr', x1: cx, y1: cy - 2, x2: cx, y2: cy - rBody + 1,
      stroke: AM.INK
    });
    this.ptrG = el('g', {});
    this.ptrG.appendChild(this.ptr);
    svg.appendChild(this.ptrG);
    svg.appendChild(el('circle', { class: 'k-hub', cx: cx, cy: cy, r: 1.6 }));

    const val = document.createElement('div');
    val.className = 'k-val';
    this.valEl = val;

    wrap.appendChild(cap); wrap.appendChild(svg); wrap.appendChild(val);
    this.root = wrap;
    this.cx = cx; this.cy = cy;

    this.bindDrag(wrap);
  };

  Knob.prototype.bindDrag = function (node) {
    const self = this, inp = this.input;
    let dragging = false, y0 = 0, v0 = 0;
    const span = function () {
      return parseFloat(inp.max) - parseFloat(inp.min);
    };
    node.addEventListener('pointerdown', function (e) {
      dragging = true; y0 = e.clientY; v0 = parseFloat(inp.value);
      try { node.setPointerCapture(e.pointerId); } catch (err) { }
      node.classList.add('active');
      e.preventDefault();
    });
    node.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const fine = e.shiftKey ? 0.22 : 1;
      const dv = (y0 - e.clientY) / 150 * span() * fine;
      self.set(v0 + dv);
    });
    const stop = function () { dragging = false; node.classList.remove('active'); };
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    node.addEventListener('wheel', function (e) {
      e.preventDefault();
      const step = parseFloat(inp.step) || span() / 100;
      self.set(parseFloat(inp.value) + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 1 : 4));
    }, { passive: false });
    node.addEventListener('dblclick', function () { self.set(self.def); });
  };

  Knob.prototype.set = function (v) {
    const inp = this.input;
    const min = parseFloat(inp.min), max = parseFloat(inp.max);
    const step = parseFloat(inp.step) || (max - min) / 100;
    v = AM.clamp(Math.round(v / step) * step, min, max);
    if (parseFloat(inp.value) === v) return;
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };

  Knob.prototype.sync = function (first) {
    const inp = this.input;
    const min = parseFloat(inp.min), max = parseFloat(inp.max), v = parseFloat(inp.value);
    const t = (v - min) / (max - min);
    const a = A0 + (A1 - A0) * t;
    this.arcEl.setAttribute('d', arc(this.cx, this.cy, this.cx - 9, A0, Math.max(A0 + 0.01, a)));
    this.ptrG.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + this.cx + ' ' + this.cy + ')');
    this.valEl.textContent = this.fmt(v) + this.unit;
    if (!first) this.onInput(v);
  };

  Knob.prototype.mount = function (parent) { parent.appendChild(this.root); return this; };

  /* ---- spirograph rosette, used as plate + panel ornament ---- */
  function rosette(ctx, cx, cy, R, opts) {
    opts = opts || {};
    const petals = opts.petals || 61;
    const r = opts.r || R * 0.62;
    const d = opts.d || R * 0.36;
    ctx.save();
    ctx.globalAlpha = opts.alpha === undefined ? 0.18 : opts.alpha;
    ctx.strokeStyle = opts.color || '#5c6b5c';
    ctx.lineWidth = opts.lineWidth || 0.5;
    for (let k = 0; k < petals; k++) {
      const th = k / petals * Math.PI * 2;
      ctx.beginPath();
      for (let i = 0; i <= 90; i++) {
        const t = i / 90 * Math.PI * 2;
        // hypotrochoid, rotated per petal
        const x = (R - r) * Math.cos(t + th) + d * Math.cos((R - r) / r * (t + th));
        const y = (R - r) * Math.sin(t + th) - d * Math.sin((R - r) / r * (t + th));
        if (i === 0) ctx.moveTo(cx + x, cy + y); else ctx.lineTo(cx + x, cy + y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* tick collar for the round rail controls — the ring lights when engaged */
  function collar(size, ticks) {
    const S = size, cx = S / 2, r = cx - 1.5;
    const svg = el('svg', { width: S, height: S, viewBox: '0 0 ' + S + ' ' + S, class: 'collar' });
    const g2 = el('g', {});
    const N = ticks || 32;
    for (let i = 0; i < N; i++) {
      const a2 = i * 360 / N;
      const major = i % 4 === 0;
      const p0 = polar(cx, cx, r, a2), p1 = polar(cx, cx, r - (major ? 4 : 2.4), a2);
      g2.appendChild(el('line', {
        class: 'tk', x1: p0[0].toFixed(2), y1: p0[1].toFixed(2),
        x2: p1[0].toFixed(2), y2: p1[1].toFixed(2)
      }));
    }
    svg.appendChild(g2);
    svg.appendChild(el('circle', { class: 'c-ring', cx: cx, cy: cx, r: (r - 6).toFixed(2) }));
    return svg;
  }

  g.AM.collar = collar;
  g.AM.Knob = Knob;
  g.AM.rosette = rosette;
})(window);
