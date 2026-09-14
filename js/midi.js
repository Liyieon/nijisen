/* midi.js — Web MIDI output.
   Every trigger becomes a note-on/note-off pair scheduled on the MIDI clock, so
   a DAW or hardware synth plays exactly what the scan lines hit, quantised the
   same way as the internal voices. Module-agnostic. */
(function (g) {
  'use strict';

  function Midi() {
    this.access = null;
    this.outId = null;
    this.enabled = false;
    this.channel = 0;          // 0..15
    this.route = 'all';        // 'all' = one channel, 'line' = channel per scan line
    this.gate = 140;           // ms
    this.sent = 0;
    this.onchange = function () { };
  }

  Midi.supported = function () { return !!(g.navigator && navigator.requestMIDIAccess); };

  Midi.prototype.enable = function () {
    const self = this;
    if (!Midi.supported()) return Promise.reject(new Error('Web MIDI is not available in this browser'));
    if (this.access) { this.enabled = true; this.onchange(); return Promise.resolve(this); }
    return navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      self.access = access;
      self.enabled = true;
      access.onstatechange = function () { self.pickDefault(); self.onchange(); };
      self.pickDefault();
      self.onchange();
      return self;
    });
  };

  Midi.prototype.disable = function () {
    this.panic();
    this.enabled = false;
    this.onchange();
  };

  Midi.prototype.outputs = function () {
    return this.access ? Array.from(this.access.outputs.values()) : [];
  };
  Midi.prototype.output = function () {
    if (!this.access || !this.outId) return null;
    const o = this.access.outputs.get(this.outId);
    return o && o.state !== 'disconnected' ? o : null;
  };
  Midi.prototype.pickDefault = function () {
    const outs = this.outputs();
    if (!outs.length) { this.outId = null; return; }
    if (!this.outId || !outs.some(function (o) { return o.id === this.outId; }, this)) this.outId = outs[0].id;
  };
  Midi.prototype.cycleOutput = function (dir) {
    const outs = this.outputs();
    if (!outs.length) return null;
    let i = outs.findIndex(function (o) { return o.id === this.outId; }, this);
    i = ((i < 0 ? 0 : i + dir) + outs.length) % outs.length;
    this.panic();
    this.outId = outs[i].id;
    this.onchange();
    return outs[i];
  };
  Midi.prototype.setChannel = function (ch) {
    this.panic();
    this.channel = ((ch % 16) + 16) % 16;
    this.onchange();
  };

  /* note: MIDI note number; vel 0..1; delaySec: how far in the future the
     internal voice is scheduled (quantise), so both land together */
  Midi.prototype.note = function (note, vel, delaySec, lineIndex) {
    if (!this.enabled) return false;
    const out = this.output();
    if (!out) return false;
    const ch = this.route === 'line' ? ((lineIndex | 0) % 16) : this.channel;
    const n = Math.max(0, Math.min(127, note | 0));
    const v = Math.max(1, Math.min(127, Math.round(vel * 127)));
    const t = performance.now() + Math.max(0, delaySec * 1000);
    try {
      out.send([0x90 | ch, n, v], t);
      out.send([0x80 | ch, n, 0], t + this.gate);
      this.sent++;
      return true;
    } catch (e) {
      return false;
    }
  };

  /* all notes off + all sound off on every channel */
  Midi.prototype.panic = function () {
    const out = this.output();
    if (!out) return;
    try {
      for (let ch = 0; ch < 16; ch++) {
        out.send([0xB0 | ch, 123, 0]);
        out.send([0xB0 | ch, 120, 0]);
      }
    } catch (e) { }
  };

  g.AM.Midi = Midi;
})(window);
