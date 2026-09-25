/* knob.js — a labelled knob bound to a hidden <input type=range>.
   A glass disc inside a coloured value arc; the name, the reading and a
   one-line hint sit with it so it is always clear what is being turned.
   Drag vertically (shift = fine), wheel, arrow keys, or double-click / Home
   to reset. */
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

  const A0 = -135, A1 = 135;          // sweep of the arc

  function Knob(o) {
    this.input = o.input;
    this.label = o.label || '';        // short code, e.g. SENS
    this.name = o.name || this.label;  // what it is, in words
    this.hint = o.hint || '';
    this.fmt = o.fmt || function (v) { return String(v); };
    this.unit = o.unit || '';
    this.color = o.color || AM.PALETTE[0];
    this.onInput = o.onInput || function () { };
    this.size = o.size || 60;
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
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', this.name);
    wrap.setAttribute('aria-valuemin', this.input.min);
    wrap.setAttribute('aria-valuemax', this.input.max);
    wrap.style.setProperty('--k', this.color);
    if (this.hint) wrap.title = this.name + '：' + this.hint + '（上下拖曳，雙擊回預設）';

    const cap = document.createElement('div');
    cap.className = 'k-cap';
    const nm = document.createElement('b'); nm.textContent = this.name;
    const code = document.createElement('span'); code.textContent = this.label;
    cap.appendChild(nm); cap.appendChild(code);

    const svg = el('svg', { width: S, height: S, viewBox: '0 0 ' + S + ' ' + S, class: 'k-svg', 'aria-hidden': 'true' });
    const rArc = cx - 3.5;
    svg.appendChild(el('path', { class: 'k-track', d: arc(cx, cy, rArc, A0, A1), fill: 'none' }));
    this.arcEl = el('path', { class: 'k-fill', d: '', fill: 'none' });
    svg.appendChild(this.arcEl);

    const rBody = cx - 10;
    svg.appendChild(el('circle', { class: 'k-body', cx: cx, cy: cy, r: rBody }));
    svg.appendChild(el('circle', { class: 'k-sheen', cx: cx, cy: cy - 1, r: rBody - 1.5 }));
    this.ptrG = el('g', {});
    this.ptrG.appendChild(el('circle', { class: 'k-ptr', cx: cx, cy: cy - rBody + 6, r: 2.4 }));
    svg.appendChild(this.ptrG);

    const val = document.createElement('div');
    val.className = 'k-val';
    this.valNum = document.createElement('span');
    val.appendChild(this.valNum);
    if (this.unit) {
      const u = document.createElement('small'); u.textContent = this.unit;
      val.appendChild(u);
    }

    wrap.appendChild(cap); wrap.appendChild(svg); wrap.appendChild(val);
    if (this.hint) {
      const h = document.createElement('div');
      h.className = 'k-hint'; h.textContent = this.hint;
      wrap.appendChild(h);
    }
    this.root = wrap;
    this.cx = cx; this.cy = cy; this.rArc = rArc;

    this.bindDrag(wrap);
    this.bindKeys(wrap);
  };

  Knob.prototype.step = function () {
    const inp = this.input;
    return parseFloat(inp.step) || (parseFloat(inp.max) - parseFloat(inp.min)) / 100;
  };

  Knob.prototype.bindDrag = function (node) {
    const self = this, inp = this.input;
    let dragging = false, y0 = 0, v0 = 0;
    const span = function () { return parseFloat(inp.max) - parseFloat(inp.min); };
    node.addEventListener('pointerdown', function (e) {
      dragging = true; y0 = e.clientY; v0 = parseFloat(inp.value);
      try { node.setPointerCapture(e.pointerId); } catch (err) { }
      node.classList.add('active');
      node.focus({ preventScroll: true });
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
      self.set(parseFloat(inp.value) + (e.deltaY < 0 ? 1 : -1) * self.step() * (e.shiftKey ? 1 : 4));
    }, { passive: false });
    node.addEventListener('dblclick', function () { self.set(self.def); });
  };

  Knob.prototype.bindKeys = function (node) {
    const self = this, inp = this.input;
    node.addEventListener('keydown', function (e) {
      const v = parseFloat(inp.value), s = self.step();
      let nv = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nv = v + s * (e.shiftKey ? 1 : 2);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nv = v - s * (e.shiftKey ? 1 : 2);
      else if (e.key === 'PageUp') nv = v + s * 10;
      else if (e.key === 'PageDown') nv = v - s * 10;
      else if (e.key === 'Home') nv = self.def;
      if (nv === null) return;
      e.preventDefault(); e.stopPropagation();
      self.set(nv);
    });
  };

  Knob.prototype.set = function (v) {
    const inp = this.input;
    const min = parseFloat(inp.min), max = parseFloat(inp.max);
    const step = this.step();
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
    this.arcEl.setAttribute('d', arc(this.cx, this.cy, this.rArc, A0, Math.max(A0 + 0.01, a)));
    this.ptrG.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + this.cx + ' ' + this.cy + ')');
    const txt = this.fmt(v);
    this.valNum.textContent = txt;
    this.root.setAttribute('aria-valuenow', String(v));
    this.root.setAttribute('aria-valuetext', txt + (this.unit ? ' ' + this.unit : ''));
    if (!first) this.onInput(v);
  };

  Knob.prototype.mount = function (parent) { parent.appendChild(this.root); return this; };

  g.AM.Knob = Knob;
})(window);
