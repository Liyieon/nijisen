/* popover.js — glass panels opened from the dock.
   One open at a time. Esc, the close button, the dock button again, or a
   press outside closes it — except a press on the video, so lines can be
   dragged while a panel is being tuned. Wide screens anchor the panel beside
   its dock button; narrow screens show it as a bottom sheet (CSS). */
(function (g) {
  'use strict';
  const AM = g.AM;

  function Popover(opts) {
    opts = opts || {};
    this.keepOpenInside = opts.keepOpenInside || [];   // selectors a press may land in
    this.onchange = opts.onchange || function () { };
    this.open = null;       // the open panel element
    this.anchor = null;     // the dock button that opened it
    this.buttons = [];
    const self = this;

    document.querySelectorAll('[data-pop]').forEach(function (b) {
      self.buttons.push(b);
      b.addEventListener('click', function () { self.toggle(b.dataset.pop, b); });
    });
    document.querySelectorAll('.pop .pop-x').forEach(function (x) {
      x.addEventListener('click', function () { self.close(true); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.open) { e.stopPropagation(); self.close(true); }
    }, true);

    document.addEventListener('pointerdown', function (e) {
      if (!self.open) return;
      const t = e.target;
      if (self.open.contains(t)) return;
      if (t.closest && t.closest('[data-pop]')) return;     // the dock handles itself
      for (const sel of self.keepOpenInside) if (t.closest && t.closest(sel)) return;
      self.close(false);
    });

    window.addEventListener('resize', function () { self.place(); });
  }

  Popover.prototype.toggle = function (id, anchor) {
    if (this.open && this.open.id === id) { this.close(true); return; }
    this.show(id, anchor);
  };

  Popover.prototype.show = function (id, anchor) {
    const el = document.getElementById(id);
    if (!el) return;
    if (this.open && this.open !== el) this.close(false);
    this.open = el;
    this.anchor = anchor || document.querySelector('[data-pop="' + id + '"]');
    el.hidden = false;
    this.buttons.forEach(function (b) {
      const on = b.dataset.pop === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    this.place();
    // replay the entrance so it reads as coming from the dock
    el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
    const first = el.querySelector('.knob, button:not(.pop-x), [tabindex="0"]');
    if (first && document.activeElement && document.activeElement.closest &&
        document.activeElement.closest('[data-pop]')) {
      try { first.focus({ preventScroll: true }); } catch (e) { }
    }
    this.onchange(id);
  };

  Popover.prototype.close = function (returnFocus) {
    const el = this.open;
    if (!el) return;
    el.hidden = true;
    el.classList.remove('in');
    this.buttons.forEach(function (b) {
      b.classList.remove('on');
      b.setAttribute('aria-expanded', 'false');
    });
    if (returnFocus && this.anchor && el.contains(document.activeElement)) {
      try { this.anchor.focus({ preventScroll: true }); } catch (e) { }
    }
    this.open = null;
    this.onchange(null);
  };

  Popover.prototype.isOpen = function (id) { return !!(this.open && this.open.id === id); };

  /* beside the dock on wide screens: vertically centred on the button that
     opened it, clamped inside the window */
  Popover.prototype.place = function () {
    const el = this.open;
    if (!el) return;
    if (g.matchMedia('(max-width: 760px)').matches) {
      el.style.top = ''; el.style.left = '';
      return;
    }
    const dock = document.querySelector('.dock');
    const dr = dock ? dock.getBoundingClientRect() : { right: 16 };
    const ar = this.anchor ? this.anchor.getBoundingClientRect() : { top: 80, height: 0 };
    const h = el.offsetHeight, H = g.innerHeight, M = 14;
    const top = AM.clamp(ar.top + ar.height / 2 - h / 2, M, Math.max(M, H - h - M));
    el.style.left = Math.round(dr.right + 12) + 'px';
    el.style.top = Math.round(top) + 'px';
  };

  AM.Popover = Popover;
})(window);
