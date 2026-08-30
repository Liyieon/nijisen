/* palette.js — shared colour + music constants */
(function (g) {
  'use strict';

  /* cool, cyanotype-leaning: blues and slates carry the set, the warm
     accents are desaturated so they read as prints, not stickers */
  const PALETTE = [
    '#2f5d8a', '#3f8296', '#4e7f7a', '#5b8fc9',
    '#4a4f8f', '#6b5c8f', '#8a5f77', '#a8564f',
    '#7a8496', '#3c6e5c', '#88a2c0', '#5e6b78'
  ];

  const PAPER = '#F0F0F0';   // paper ground
  const PAPER2 = '#e8e9ea';  // plate ground
  const RISO = '#3f6fa8';
  const INK = '#14181d';

  /* scan-line colour schemes. Each is a ramp used across the cells of a line;
     a one-entry ramp paints the whole line in a single colour. */
  const SCHEMES = {
    SPECTRUM: { label: 'SPECTRUM', colors: PALETTE.slice() },
    CYANO:    { label: 'CYANO',    colors: ['#0d2b45', '#1c4f7c', '#2f6f9f', '#4d90bd', '#7ab3d4', '#a8cee2'] },
    STEEL:    { label: 'STEEL',    colors: ['#3a4653', '#4d5c6b', '#647485', '#8494a5', '#a6b4c2'] },
    NEON:     { label: 'NEON',     colors: ['#00b3a4', '#2ad4c1', '#5be0ff', '#3f8cff', '#8b6cff'] },
    EMBER:    { label: 'EMBER',    colors: ['#7d3a3a', '#a8564f', '#c47a4a', '#d9a25c'] },
    MONO:     { label: 'MONO',     colors: ['#14181d'] },
    PAPERW:   { label: 'PAPER',    colors: ['#f2f4f6'] }
  };
  const SCHEME_KEYS = Object.keys(SCHEMES);

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
  function paletteSnap(r, gg, b, amount, ramp) {
    amount = amount === undefined ? 0.55 : amount;
    ramp = ramp && ramp.length ? ramp : PALETTE;
    let best = ramp[0], bestD = Infinity;
    for (let i = 0; i < ramp.length; i++) {
      const c = hexToRgb(ramp[i]);
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
  g.AM.SCHEMES = SCHEMES;
  g.AM.SCHEME_KEYS = SCHEME_KEYS;
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
