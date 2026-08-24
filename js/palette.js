/* palette.js — shared colour + music constants */
(function (g) {
  'use strict';

  const PALETTE = [
    '#c4453b', '#d97b2b', '#dfae35', '#4f7f4f',
    '#3c8b94', '#3f6fa8', '#4a4f8f', '#6b4c8f',
    '#bd7f92', '#7d5a3c', '#5b8fc9', '#7fa892'
  ];

  const PAPER = '#FCFAF2';   // washi ground
  const PAPER2 = '#f5f2e7';  // plate ground
  const RISO = '#5b8fc9';
  const INK = '#16160f';

  // scale = semitone offsets inside one octave
  const SCALES = {
    'PENT': { label: 'PENT', steps: [0, 3, 5, 7, 10] },       // minor pentatonic
    'MAJ': { label: 'MAJ', steps: [0, 2, 4, 7, 9] },          // major pentatonic
    'DOR': { label: 'DOR', steps: [0, 2, 3, 5, 7, 9, 10] },   // dorian
    'WHOLE': { label: 'WHOLE', steps: [0, 2, 4, 6, 8, 10] },  // whole tone
    'CHRM': { label: 'CHRM', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  };
  const SCALE_KEYS = Object.keys(SCALES);

  // quantise grid, in beat fractions (1 = quarter note)
  const QUANT = [
    { label: 'FREE', beats: 0 },
    { label: '4n', beats: 1 },
    { label: '8n', beats: 0.5 },
    { label: '16n', beats: 0.25 },
    { label: '32n', beats: 0.125 }
  ];

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function midiToName(m) { return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function rgbToCss(r, gg, b, a) {
    return 'rgba(' + (r | 0) + ',' + (gg | 0) + ',' + (b | 0) + ',' + (a === undefined ? 1 : a) + ')';
  }

  // mix a video-sampled colour toward the nearest palette hue so the plate
  // always reads as one printed system rather than raw video mush
  function paletteSnap(r, gg, b, amount) {
    amount = amount === undefined ? 0.55 : amount;
    let best = PALETTE[0], bestD = Infinity;
    for (let i = 0; i < PALETTE.length; i++) {
      const c = hexToRgb(PALETTE[i]);
      const d = (c.r - r) * (c.r - r) + (c.g - gg) * (c.g - gg) + (c.b - b) * (c.b - b);
      if (d < bestD) { bestD = d; best = PALETTE[i]; }
    }
    const t = hexToRgb(best);
    return { r: lerp(r, t.r, amount), g: lerp(gg, t.g, amount), b: lerp(b, t.b, amount) };
  }

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  g.AM = g.AM || {};
  g.AM.PALETTE = PALETTE;
  g.AM.PAPER = PAPER;
  g.AM.PAPER2 = PAPER2;
  g.AM.RISO = RISO;
  g.AM.INK = INK;
  g.AM.SCALES = SCALES;
  g.AM.SCALE_KEYS = SCALE_KEYS;
  g.AM.QUANT = QUANT;
  g.AM.midiToFreq = midiToFreq;
  g.AM.midiToName = midiToName;
  g.AM.clamp = clamp;
  g.AM.lerp = lerp;
  g.AM.rgbToCss = rgbToCss;
  g.AM.hexToRgb = hexToRgb;
  g.AM.paletteSnap = paletteSnap;
})(window);
