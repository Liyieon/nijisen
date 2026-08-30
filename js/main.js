/* main.js — wiring: video -> threshold lines -> synth voices -> spectrum plate */
(function (g) {
  'use strict';
  const AM = g.AM;
  const $ = function (s) { return document.querySelector(s); };
  const P = AM.PALETTE;

  /* ---------------- state ---------------- */
  const S = {
    scale: 'PENT',
    quantIdx: 3,          // 16n
    root: 36,
    bpm: 96,
    vol: 0.8,
    voice: 'BELL',
    engineOn: true,
    playing: false,
    fileName: 'no media',
    lineTool: null,
    selected: null,
    layout: 'landscape',
    layoutAuto: true,
    scheme: 'SPECTRUM',       // scan-line colour scheme
    custom: '#3f8296',        // custom scan colour
    colorTarget: 'all',       // 'all' | 'sel'
    stageOnly: false,
    stagePlate: true,         // show the plate inside STAGE
    theme: 'light'
  };

  const engine = new AM.AudioEngine();
  const det = new AM.Detector();
  let spectro = null;

  /* ---------------- video + canvases ---------------- */
  const video = document.createElement('video');
  video.playsInline = true; video.muted = true; video.loop = true; video.preload = 'auto';

  const stage = $('#stageCanvas'), sctx = stage.getContext('2d');
  const over = $('#overlayCanvas'), octx = over.getContext('2d');
  const acv = document.createElement('canvas');
  const actx = acv.getContext('2d', { willReadFrequently: true });
  let aw = 0, ah = 0;
  let vrect = { x: 0, y: 0, w: 0, h: 0 };
  let dpr = Math.min(2, g.devicePixelRatio || 1);

  function sizeCanvases() {
    const vp = $('#viewport');
    const r = vp.getBoundingClientRect();
    dpr = Math.min(2, g.devicePixelRatio || 1);
    for (const cv of [stage, over]) {
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
    }
  }
  new ResizeObserver(sizeCanvases).observe($('#viewport'));
  sizeCanvases();

  function setupAnalysis() {
    const vw = video.videoWidth || 640, vh = video.videoHeight || 360;
    aw = 480; ah = Math.max(2, Math.round(480 * vh / vw));
    acv.width = aw; acv.height = ah;
    det.reset();
  }

  /* contain-fit the video inside the stage canvas */
  function computeRect() {
    const cw = stage.width, ch = stage.height;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const s = Math.min(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    vrect = { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h };
  }

  /* ---------------- file loading ---------------- */
  function loadFile(file) {
    if (!file) return;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    S.fileName = file.name.length > 26 ? file.name.slice(0, 24) + '..' : file.name;
    video.load();
    video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once);
      setupAnalysis(); computeRect(); autoLayout();
      $('#dropzone').classList.add('hide');
      det.tainted = false;
      play();
      toast('LOADED — 拖曳畫面上的線調整 threshold 位置');
    });
  }

  $('#dropzone').addEventListener('click', function () { $('#fileInput').click(); });
  $('#btnFile').addEventListener('click', function () { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', function (e) { loadFile(e.target.files[0]); });

  const vp = $('#viewport');
  ['dragenter', 'dragover'].forEach(function (t) {
    vp.addEventListener(t, function (e) { e.preventDefault(); $('#dropzone').classList.add('hot'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    vp.addEventListener(t, function (e) { e.preventDefault(); $('#dropzone').classList.remove('hot'); });
  });
  vp.addEventListener('drop', function (e) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ---------------- transport ---------------- */
  function play() {
    if (!video.src) { $('#fileInput').click(); return; }
    ensureAudio();
    video.play().then(function () {
      S.playing = true;
      $('#btnPlay').textContent = 'PAUSE';
      $('#sbPlay').textContent = 'PAUSE';
      $('#statusText').textContent = 'RUNNING'; $('#statusText').classList.add('live');
    }).catch(function (err) { toast('play blocked: ' + err.message); });
  }
  function pause() {
    video.pause(); S.playing = false;
    $('#btnPlay').textContent = 'PLAY';
    $('#sbPlay').textContent = 'PLAY';
    $('#statusText').textContent = 'HELD'; $('#statusText').classList.remove('live');
  }
  $('#btnPlay').addEventListener('click', function () { S.playing ? pause() : play(); });
  $('#btnLoop').addEventListener('click', function () {
    video.loop = !video.loop;
    this.dataset.on = video.loop ? 'true' : 'false';
  });
  /* timeline strip — a measured tape, not a slider */
  const tlWrap = $('#tlWrap'), tlCv = $('#timeline');
  const tlx = tlCv.getContext('2d');
  let scrubbing = false;

  function tlSeek(e) {
    if (!video.duration) return;
    const r = tlWrap.getBoundingClientRect();
    const t = AM.clamp((e.clientX - r.left) / r.width, 0, 1);
    video.currentTime = t * video.duration;
  }
  tlWrap.addEventListener('pointerdown', function (e) {
    scrubbing = true; tlSeek(e);
    try { tlWrap.setPointerCapture(e.pointerId); } catch (err) { }
  });
  tlWrap.addEventListener('pointermove', function (e) { if (scrubbing) tlSeek(e); });
  tlWrap.addEventListener('pointerup', function () { scrubbing = false; det.reset(); });
  tlWrap.addEventListener('pointercancel', function () { scrubbing = false; });

  function drawTimeline() {
    const r = tlWrap.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (tlCv.width !== w || tlCv.height !== h) { tlCv.width = w; tlCv.height = h; }
    const c = tlx;
    c.clearRect(0, 0, w, h);
    const mid = Math.round(h * 0.62);

    // baseline + measured ticks
    c.strokeStyle = AM.hair(.42); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, mid + .5); c.lineTo(w, mid + .5); c.stroke();
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const x = Math.round(w * i / N) + .5;
      const major = i % 5 === 0;
      c.strokeStyle = major ? AM.hair(.5) : AM.hair(.22);
      c.beginPath(); c.moveTo(x, mid); c.lineTo(x, mid - (major ? 9 : 5) * dpr); c.stroke();
    }
    if (!video.duration) return;

    // elapsed as riso tally bars
    const t = video.currentTime / video.duration;
    const px = t * w;
    c.fillStyle = AM.RISO;
    for (let x = 0; x < px; x += 5 * dpr) c.fillRect(x, mid - 4 * dpr, 2 * dpr, 4 * dpr);

    // playhead
    c.fillStyle = AM.INK;
    c.beginPath();
    c.moveTo(px, mid - 12 * dpr); c.lineTo(px + 4 * dpr, mid - 18 * dpr);
    c.lineTo(px - 4 * dpr, mid - 18 * dpr); c.closePath(); c.fill();
    c.fillRect(px - .5 * dpr, mid - 12 * dpr, dpr, 12 * dpr);
  }

  function fmt(t) {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------------- theme ---------------- */
  function setTheme(name, quiet) {
    S.theme = AM.setTheme(name);
    document.body.dataset.theme = S.theme;
    document.querySelectorAll('#segTheme button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === S.theme);
    });
    // every drawn surface carries the ground with it
    drawOrnaments();
    if (spectro) { spectro.clear(); }
    requestAnimationFrame(function () { sizeCanvases(); computeRect(); resizePlate(); });
    if (!quiet) toast('theme: ' + S.theme.toUpperCase() + ' — 圖版已重新鋪底');
  }

  /* ---------------- stage-only mode ----------------
     video + scan lines only. Lines stay draggable; everything else goes. */
  function setStageOnly(on, fromFsEvent) {
    S.stageOnly = !!on;
    document.body.classList.toggle('stage-only', S.stageOnly);
    $('#btnStage').dataset.on = S.stageOnly ? 'true' : 'false';

    if (!fromFsEvent) {
      try {
        if (S.stageOnly && !document.fullscreenElement) {
          const p = document.documentElement.requestFullscreen();
          if (p && p.catch) p.catch(function () { });
        } else if (!S.stageOnly && document.fullscreenElement) {
          const p = document.exitFullscreen();
          if (p && p.catch) p.catch(function () { });
        }
      } catch (e) { }
    }
    // the viewport changes size in both directions here
    requestAnimationFrame(function () { sizeCanvases(); computeRect(); resizePlate(); });
    setTimeout(function () { sizeCanvases(); computeRect(); resizePlate(); }, 120);
    if (S.stageOnly) toast('STAGE — 只留影片與掃描線，F 或 ESC 離開');
  }
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && S.stageOnly) setStageOnly(false, true);
  });

  function buildStageBar() {
    $('#sbExit').addEventListener('click', function () { setStageOnly(false); });
    $('#sbPlay').addEventListener('click', function () { S.playing ? pause() : play(); });
    $('#sbAddH').addEventListener('click', function () { addLine('h'); });
    $('#sbAddV').addEventListener('click', function () { addLine('v'); });
    $('#sbDel').addEventListener('click', function () { deleteSelected(); });
    $('#sbPlate').addEventListener('click', function () {
      S.stagePlate = !S.stagePlate;
      this.dataset.on = S.stagePlate ? 'true' : 'false';
      document.body.classList.toggle('stage-noplate', !S.stagePlate);
      requestAnimationFrame(function () { sizeCanvases(); computeRect(); resizePlate(); });
    });
    $('#sbPrev').addEventListener('click', function () { cycleSelect(-1); });
    $('#sbNext').addEventListener('click', function () { cycleSelect(1); });
    $('#btnStage').addEventListener('click', function () { setStageOnly(!S.stageOnly); });
  }

  function hexA(hex, a) {
    const c = AM.hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + AM.clamp(a, 0, 1).toFixed(3) + ')';
  }

  /* ---------------- scan colour ---------------- */
  function ramp() {
    const sc = AM.SCHEMES[S.scheme];
    return (sc && sc.colors.length) ? sc.colors : AM.PALETTE;
  }
  /* the plate paints with the same ramp as the scan lines */
  function syncPlateRamp() {
    if (!spectro) return;
    const sel = S.selected;
    spectro.setRamp(sel && sel.color && S.colorTarget === 'sel' ? [sel.color] : ramp());
  }
  /* colour of one cell of one line: a per-line override wins over the scheme */
  function lineColor(line, cell) {
    if (line && line.color) return line.color;
    const r = ramp();
    return r[cell % r.length];
  }
  function applyColor(hex) {
    if (S.colorTarget === 'sel' && S.selected) {
      S.selected.color = hex;
      toast('L' + S.selected.id + ' 線色 ' + hex);
    } else {
      for (const l of det.lines) l.color = hex;
      S.custom = hex;
      toast('全部線色 ' + hex);
    }
    paintColorUI(); syncPlateRamp();
  }
  function clearOverrides() {
    for (const l of det.lines) l.color = null;
    paintColorUI(); syncPlateRamp();
  }

  /* ---------------- layout ---------------- */
  function paintLayoutSeg() {
    const mark = S.layoutAuto ? 'auto' : S.layout;
    document.querySelectorAll('#segLayout button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === mark);
    });
  }

  function setLayout(mode, manual) {
    S.layout = mode;
    if (manual) S.layoutAuto = false;
    document.body.dataset.layout = mode;
    paintLayoutSeg();
    // canvases are laid out by CSS; let it settle, then resize the backing stores
    requestAnimationFrame(function () {
      sizeCanvases(); computeRect(); resizePlate();
    });
    setTimeout(function () { sizeCanvases(); computeRect(); resizePlate(); }, 60);
  }

  function resizePlate() {
    if (!spectro) return;
    const cv = $('#specCanvas');
    const r = cv.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const k = Math.min(2, dpr);
    spectro.resize(Math.round(r.width * k), Math.round(r.height * k));
    // a plate taller than it is wide runs its time axis downwards
    if (spectro.setOrient(r.height > r.width * 1.05 ? 'v' : 'h')) {
      toast('圖版轉為' + (spectro.orient === 'v' ? '直式（時間由上往下）' : '橫式（時間由左往右）'));
    }
  }

  /* the video decides the layout unless the operator has picked one */
  function autoLayout() {
    if (!S.layoutAuto) return;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    setLayout(vh > vw * 1.05 ? 'portrait' : 'landscape', false);
    paintLayoutSeg();
  }

  let resizeT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { sizeCanvases(); computeRect(); resizePlate(); }, 140);
  });

  /* ---------------- rails ---------------- */
  function buildRails() {
    const rs = $('#railScale');
    AM.SCALE_KEYS.forEach(function (k, i) {
      const d = document.createElement('div');
      d.className = 'dia'; d.innerHTML = '<span>' + AM.SCALES[k].label + '</span>';
      d.dataset.k = k; d.title = 'scale: ' + k;
      d.addEventListener('click', function () { S.scale = k; paintRails(); });
      rs.appendChild(d);
    });
    const rq = $('#railQuant');
    AM.QUANT.forEach(function (q, i) {
      const d = document.createElement('div');
      d.className = 'dia'; d.innerHTML = '<span>' + q.label + '</span>';
      d.dataset.i = i; d.title = 'quantise: ' + q.label;
      d.addEventListener('click', function () { S.quantIdx = i; paintRails(); updateFoot(); });
      rq.appendChild(d);
    });
    const rv = $('#railVoice');
    ['BELL', 'PLUCK', 'GLITCH'].forEach(function (v, i) {
      const c = document.createElement('div');
      c.className = 'cir'; c.dataset.v = v;
      c.innerHTML = '<b>' + v.slice(0, 3) + '</b><span class="tag">' + (i + 1) + '</span>';
      c.appendChild(AM.collar(40, 32));
      const sp = document.createElement('canvas');
      sp.className = 'spiro'; sp.width = 72; sp.height = 72;
      AM.rosette(sp.getContext('2d'), 36, 36, 30, {
        petals: [13, 17, 9][i], r: [11, 13, 19][i], d: [9, 7, 12][i],
        alpha: .5, lineWidth: .5, color: AM.INK
      });
      c.insertBefore(sp, c.firstChild);
      c.title = 'voice: ' + v;
      c.addEventListener('click', function () { S.voice = v; engine.setVoice(v); paintRails(); });
      rv.appendChild(c);
    });
    const rf = $('#railFx');
    ['REV', 'DLY', 'LPF', 'BIT', 'SUB'].forEach(function (k) {
      const c = document.createElement('div');
      c.className = 'cir'; c.dataset.f = k;
      c.innerHTML = '<b>' + k + '</b>';
      c.appendChild(AM.collar(40, 24));
      c.title = 'fx: ' + k;
      c.addEventListener('click', function () { engine.init(); engine.toggleFx(k); paintRails(); });
      rf.appendChild(c);
    });
    paintRails();
  }

  function paintRails() {
    document.querySelectorAll('#railScale .dia').forEach(function (d, i) {
      d.style.setProperty('--led', P[(i + 3) % P.length]);
      d.classList.toggle('on', d.dataset.k === S.scale);
    });
    document.querySelectorAll('#railQuant .dia').forEach(function (d, i) {
      d.style.setProperty('--led', P[i % P.length]);
      d.classList.toggle('on', +d.dataset.i === S.quantIdx);
    });
    document.querySelectorAll('#railVoice .cir').forEach(function (c, i) {
      c.style.setProperty('--led', P[[7, 5, 0][i]]);
      c.classList.toggle('on', c.dataset.v === S.voice);
    });
    document.querySelectorAll('#railFx .cir').forEach(function (c, i) {
      c.style.setProperty('--led', P[(i + 2) % P.length]);
      c.classList.toggle('on', !!engine.fx[c.dataset.f]);
    });
  }

  /* momentary buttons blink their LED so a press reads as an event */
  document.querySelectorAll('.sq-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.on !== undefined) return;   // latching buttons show state instead
      b.classList.remove('fired'); void b.offsetWidth; b.classList.add('fired');
      setTimeout(function () { b.classList.remove('fired'); }, 170);
    });
  });

  /* preset stepper — a selector, not a dropdown */
  function buildStepper() {
    const sel = $('#selPreset'), pips = $('#presetPips');
    for (let i = 0; i < sel.options.length; i++) pips.appendChild(document.createElement('i'));
    function paint() {
      $('#presetVal').textContent = sel.value.toUpperCase();
      pips.querySelectorAll('i').forEach(function (p, i) {
        p.classList.toggle('on', i === sel.selectedIndex);
      });
    }
    $('#presetStep').addEventListener('click', function (e) {
      const b = e.target.closest('.st-arrow'); if (!b) return;
      const n = sel.options.length;
      sel.selectedIndex = (sel.selectedIndex + (+b.dataset.d) + n) % n;
      sel.dispatchEvent(new Event('change'));
    });
    sel.addEventListener('change', paint);
    paint();
  }

  /* ---------------- params ---------------- */
  const int = function (v) { return String(v | 0); };
  const KNOBS = [
    { id: '#pSens', label: 'SENS', color: P[0], fmt: function (v) { return v.toFixed(2); },
      apply: function (v) { det.sens = v; } },
    { id: '#pCells', label: 'CELLS', color: P[5], fmt: int,
      apply: function (v) { det.cells = v | 0; det.reset(); $('#hudCells').textContent = (v | 0) + ' cells'; } },
    { id: '#pHold', label: 'HOLD', color: P[1], fmt: int, unit: 'ms',
      apply: function (v) { det.hold = v; } },
    { id: '#pBand', label: 'BAND', color: P[4], fmt: int, unit: 'px',
      apply: function (v) { det.band = v | 0; } },
    { id: '#pRoot', label: 'ROOT', color: P[7], fmt: function (v) { return AM.midiToName(v | 0); },
      apply: function (v) { S.root = v | 0; } },
    { id: '#pBpm', label: 'BPM', color: P[3], fmt: int,
      apply: function (v) { S.bpm = v; engine.setDelayTime(60 / v * 0.75); } },
    { id: '#pVol', label: 'VOL', color: P[2], fmt: function (v) { return v.toFixed(2); },
      apply: function (v) { S.vol = v; engine.setVolume(v); } }
  ];
  const knobs = {};
  function buildKnobs() {
    const bank = $('#knobBank');
    KNOBS.forEach(function (k) {
      const inp = $(k.id);
      knobs[k.id] = new AM.Knob({
        input: inp, label: k.label, fmt: k.fmt, unit: k.unit || '', color: k.color, size: 50,
        onInput: function (v) { k.apply(v); updateFoot(); }
      }).mount(bank);
      k.apply(parseFloat(inp.value));
    });
  }

  function bindSeg(id, fn) {
    const wrap = $(id);
    wrap.addEventListener('click', function (e) {
      const b = e.target.closest('button'); if (!b) return;
      if (!b.dataset.v) return;
      if (id !== '#segLines') {
        wrap.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      }
      fn(b.dataset.v, b);
    });
  }
  bindSeg('#segMode', function (v) { det.mode = v; det.reset(); });
  bindSeg('#segLayout', function (v) {
    if (v === 'auto') {
      S.layoutAuto = true;
      autoLayout();
      toast('layout: AUTO — 依影片長寬比自動切換');
    } else {
      setLayout(v, true);
      toast('layout: ' + v.toUpperCase());
    }
    paintLayoutSeg();
  });
  bindSeg('#segSpecMode', function (v) { spectro.setMode(v); });
  function select(line) {
    S.selected = line || null;
    paintLineUI();
  }
  function cycleSelect(dir) {
    if (!det.lines.length) return select(null);
    const i = det.lines.indexOf(S.selected);
    const n = det.lines.length;
    select(det.lines[((i < 0 ? 0 : i + dir) + n) % n]);
  }
  function addLine(orient) {
    const l = det.addLine(orient);
    if (!l) { toast('已達上限 8 條線'); return; }
    select(l);
    toast((orient === 'v' ? '直線' : '橫線') + ' L' + l.id + ' — ' + det.lines.length + ' 條');
  }
  function deleteSelected() {
    if (!det.lines.length) { toast('沒有線可刪'); return; }
    const target = S.selected || det.lines[det.lines.length - 1];
    const next = det.removeLine(target);
    select(next);
    toast(det.lines.length ? ('刪除 L' + target.id + ' — 剩 ' + det.lines.length + ' 條')
      : '線段已全部清空');
  }
  function paintLineUI() {
    const has = det.lines.length > 0;
    const i = det.lines.indexOf(S.selected);
    const txt = has
      ? (i >= 0 ? 'L' + S.selected.id + ' ' + (S.selected.orient === 'h' ? 'H' : 'V') +
          ' ' + (i + 1) + '/' + det.lines.length
        : '-- ' + det.lines.length + ' 條')
      : 'EMPTY';
    const a = $('#selRead'), b = $('#sbRead');
    if (a) a.textContent = txt;
    if (b) b.textContent = txt;
    paintColorUI();
  }
  bindSeg('#segLines', function (v) {
    if (v === 'add') addLine('h');
    else if (v === 'vert') addLine('v');
    else deleteSelected();
  });
  $('#selPrev').addEventListener('click', function () { cycleSelect(-1); });
  $('#selNext').addEventListener('click', function () { cycleSelect(1); });

  /* ---------------- scan colour UI ---------------- */
  function buildColorUI() {
    const box = $('#schemeSwatches');
    AM.SCHEME_KEYS.forEach(function (k) {
      const sc = AM.SCHEMES[k];
      const b = document.createElement('button');
      b.className = 'sw'; b.dataset.k = k; b.title = 'scheme: ' + sc.label;
      const strip = document.createElement('span');
      strip.className = 'sw-strip';
      strip.style.background = sc.colors.length > 1
        ? 'linear-gradient(90deg,' + sc.colors.join(',') + ')'
        : sc.colors[0];
      const cap = document.createElement('span');
      cap.className = 'sw-cap'; cap.textContent = sc.label;
      b.appendChild(strip); b.appendChild(cap);
      b.addEventListener('click', function () {
        S.scheme = k;
        if (S.colorTarget === 'sel' && S.selected) S.selected.color = null;
        else clearOverrides();
        paintColorUI(); syncPlateRamp();
        toast('scan colour: ' + sc.label);
      });
      box.appendChild(b);
    });
    $('#colCustom').addEventListener('input', function () { applyColor(this.value); });
    bindSeg('#segColTarget', function (v) { S.colorTarget = v; paintColorUI(); });
    $('#btnColReset').addEventListener('click', function () {
      clearOverrides(); toast('線色回到 ' + AM.SCHEMES[S.scheme].label);
    });
    paintColorUI();
  }
  function paintColorUI() {
    document.querySelectorAll('#schemeSwatches .sw').forEach(function (b) {
      b.classList.toggle('on', b.dataset.k === S.scheme);
    });
    const chip = $('#colChip');
    if (chip) {
      const shown = (S.colorTarget === 'sel' && S.selected && S.selected.color) || S.custom;
      chip.style.setProperty('--chip', shown);
      const inp = $('#colCustom');
      if (inp && inp.value.toLowerCase() !== shown.toLowerCase()) inp.value = shown;
    }
    const t = $('#segColTarget');
    if (t) t.classList.toggle('dim', S.colorTarget === 'sel' && !S.selected);
  }

  /* ---------------- top buttons ---------------- */
  /* AudioContext can only start from a user gesture — call this from every
     gesture we already handle so the user never has to hunt for a button */
  function ensureAudio() {
    if (!S.engineOn) return;
    engine.init();
    engine.resume();
    engine.setVolume(S.vol);
    engine.setDelayTime(60 / S.bpm * 0.75);
    paintRails();
  }
  document.addEventListener('pointerdown', ensureAudio, { capture: true });

  $('#btnPower').addEventListener('click', function () {
    S.engineOn = !S.engineOn;
    this.dataset.on = S.engineOn ? 'true' : 'false';
    this.textContent = 'AUDIO';
    if (S.engineOn) { ensureAudio(); toast('音訊啟動'); }
    else { toast('音訊靜音 — 只印圖不發聲'); }
    updateFoot();
  });
  /* audition the current voice — proves the audio path without a video */
  $('#btnTest').addEventListener('click', function () {
    ensureAudio();
    if (!engine.ready) { toast('audio init failed'); return; }
    const steps = AM.SCALES[S.scale].steps;
    for (let i = 0; i < 5; i++) {
      const midi = S.root + steps[i % steps.length] + 12 * Math.floor(i / steps.length);
      engine.trigger({
        freq: AM.midiToFreq(midi), vel: 0.85,
        pan: (i / 4) * 1.2 - 0.6,
        when: engine.now() + 0.05 + i * 0.16,
        voice: S.voice
      });
    }
    toast('TEST — ' + S.voice + ' / ' + AM.midiToName(S.root) + ' ' + S.scale +
      ' · ' + (engine.ctx.state === 'running' ? 'ctx running' : 'ctx ' + engine.ctx.state));
  });

  $('#btnSrcAudio').addEventListener('click', function () {
    video.muted = !video.muted;
    this.dataset.on = video.muted ? 'false' : 'true';
    toast(video.muted ? '影片原聲: OFF' : '影片原聲: ON');
  });
  $('#btnClear').addEventListener('click', function () {
    spectro.clear(); det.reset(); engine.resetHits(); toast('plate cleared');
  });
  $('#btnExport').addEventListener('click', function () { spectro.save(); });
  $('#btnSpecSave').addEventListener('click', function () { spectro.save(); });
  $('#btnSpecClear').addEventListener('click', function () { spectro.clear(); });
  $('#btnRandom').addEventListener('click', randomise);
  $('#selPreset').addEventListener('change', function () { applyPreset(this.value); });

  const PRESETS = {
    default: { mode: 'motion', sens: .18, cells: 16, hold: 120, band: 3, voice: 'BELL', scale: 'PENT', q: 3, root: 36 },
    rain: { mode: 'motion', sens: .10, cells: 28, hold: 70, band: 2, voice: 'PLUCK', scale: 'PENT', q: 4, root: 48 },
    glass: { mode: 'luma', sens: .58, cells: 12, hold: 220, band: 6, voice: 'BELL', scale: 'MAJ', q: 2, root: 42 },
    broken: { mode: 'edge', sens: .30, cells: 36, hold: 55, band: 2, voice: 'GLITCH', scale: 'CHRM', q: 0, root: 30 }
  };
  function applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    setRange('#pSens', p.sens); setRange('#pCells', p.cells); setRange('#pHold', p.hold);
    setRange('#pBand', p.band); setRange('#pRoot', p.root);
    det.mode = p.mode;
    $('#segMode').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === p.mode);
    });
    S.voice = p.voice; engine.setVoice(p.voice);
    S.scale = p.scale; S.quantIdx = p.q;
    det.reset(); paintRails(); updateFoot();
    toast('preset: ' + name);
  }
  function setRange(id, v) {
    const el = $(id); el.value = v; el.dispatchEvent(new Event('input'));
  }
  function randomise() {
    const modes = ['motion', 'luma', 'edge'];
    const m = modes[(Math.random() * 3) | 0];
    det.mode = m;
    $('#segMode').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === m); });
    setRange('#pSens', (m === 'luma' ? .35 + Math.random() * .4 : .08 + Math.random() * .3).toFixed(2));
    setRange('#pCells', 6 + ((Math.random() * 34) | 0));
    setRange('#pHold', 40 + ((Math.random() * 300) | 0));
    setRange('#pBand', 1 + ((Math.random() * 8) | 0));
    setRange('#pRoot', 28 + ((Math.random() * 24) | 0));
    S.scale = AM.SCALE_KEYS[(Math.random() * AM.SCALE_KEYS.length) | 0];
    S.quantIdx = (Math.random() * AM.QUANT.length) | 0;
    S.voice = ['BELL', 'PLUCK', 'GLITCH'][(Math.random() * 3) | 0]; engine.setVoice(S.voice);
    for (const l of det.lines) l.pos = .15 + Math.random() * .7;
    det.reset(); paintRails(); updateFoot();
    toast('randomised');
  }

  /* ---------------- dragging threshold lines ---------------- */
  let drag = null;
  function toNorm(e) {
    const r = vp.getBoundingClientRect();
    const cx = (e.clientX - r.left) * dpr, cy = (e.clientY - r.top) * dpr;
    return { x: (cx - vrect.x) / Math.max(1, vrect.w), y: (cy - vrect.y) / Math.max(1, vrect.h) };
  }
  vp.addEventListener('pointerdown', function (e) {
    if (!video.src) return;
    const n = toNorm(e);
    const l = det.pick(n.x, n.y, 0.035);
    select(l);
    if (l) {
      drag = l;
      try { vp.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    }
  });
  vp.addEventListener('pointermove', function (e) {
    const n = toNorm(e);
    if (drag) {
      drag.pos = AM.clamp(drag.orient === 'h' ? n.y : n.x, 0.01, 0.99);
      det.reset();
    } else if (video.src) {
      vp.style.cursor = det.pick(n.x, n.y, 0.035) ? 'grab' : 'default';
    }
  });
  vp.addEventListener('pointerup', function () { drag = null; });
  vp.addEventListener('pointercancel', function () { drag = null; });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.code === 'Digit1') { S.voice = 'BELL'; engine.setVoice('BELL'); paintRails(); }
    if (e.code === 'Digit2') { S.voice = 'PLUCK'; engine.setVoice('PLUCK'); paintRails(); }
    if (e.code === 'Digit3') { S.voice = 'GLITCH'; engine.setVoice('GLITCH'); paintRails(); }
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.code === 'Tab') { e.preventDefault(); cycleSelect(e.shiftKey ? -1 : 1); return; }
    if (e.code === 'KeyF') { e.preventDefault(); setStageOnly(!S.stageOnly); return; }
    const l = S.selected || det.lines[0];
    if (l && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault();
      l.pos = AM.clamp(l.pos + (e.code === 'ArrowUp' ? -0.005 : 0.005), 0.01, 0.99);
      det.reset();
    }
  });

  /* ---------------- trigger -> sound + plate ---------------- */
  function qTime() {
    const now = engine.now();
    const beats = AM.QUANT[S.quantIdx].beats;
    if (!beats) return now + 0.004;
    const step = (60 / S.bpm) * beats;
    return Math.ceil((now + 0.006) / step) * step;
  }

  function fire(ev) {
    const steps = AM.SCALES[S.scale].steps;
    const horiz = ev.line.orient === 'h';
    const idx = horiz ? ev.cell : (det.cells - 1 - ev.cell);  // vertical: top = high
    const oct = Math.floor(idx / steps.length);
    const midi = AM.clamp(S.root + steps[idx % steps.length] + 12 * oct + 12 * ev.line.octave, 12, 120);
    const freq = AM.midiToFreq(midi);

    let ok = false;
    if (S.engineOn) {
      if (!engine.ready) engine.init();
      else if (engine.ctx.state === 'suspended') engine.resume();
      ok = engine.trigger({
        freq: freq,
        vel: ev.vel,
        pan: AM.clamp(ev.nx * 2 - 1, -1, 1) * 0.75,
        when: qTime(),
        voice: S.voice
      });
    }

    const stampEv = {
      nx: horiz ? ev.nx : ev.ny,
      ny: ev.ny,
      vel: ev.vel,
      r: ev.r, g: ev.g, b: ev.b,
      pitchNorm: AM.clamp((midi - S.root) / 36, 0, 1)
    };
    stampEv.ramp = ev.line.color ? [ev.line.color] : ramp();
    spectro.stamp(stampEv, engine.ready ? engine.getSpectrum() : null);

    if (ok) {
      const c = document.querySelector('#railVoice .cir[data-v="' + S.voice + '"]');
      if (c) { c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse'); }
    }
  }

  /* ---------------- cell activity tally ---------------- */
  const tallyCv = $('#tally'), tly = tallyCv.getContext('2d');
  function drawTally() {
    const r = tallyCv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (tallyCv.width !== w || tallyCv.height !== h) { tallyCv.width = w; tallyCv.height = h; }
    const c = tly;
    c.clearRect(0, 0, w, h);

    const line = S.selected || det.lines[0];
    const base = h - 9 * dpr;

    // ground rule + cell ticks
    c.strokeStyle = AM.hair(.45); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, base + .5); c.lineTo(w, base + .5); c.stroke();

    if (!line || !line.prevAct) return;
    const n = det.cells, cw = w / n;
    let hot = 0, peak = 0;

    for (let i = 0; i < n; i++) {
      const act = AM.clamp(line.prevAct[i] || 0, 0, 1.2);
      if (act > peak) peak = act;
      const fl = line.flash ? line.flash[i] : 0;
      const x0 = i * cw;

      // tally bar cluster, riso blue — count rises with activity
      const bars = 1 + Math.min(3, Math.floor(act * 5));
      const bw = Math.max(1, Math.min(2.4 * dpr, cw / 6));
      const gap = Math.max(1, bw * 1.7);
      const hgt = Math.max(2 * dpr, act / 1.2 * (base - 6 * dpr));
      c.fillStyle = AM.rgbToCss.length ? hexA(AM.RISO, 0.35 + act * 0.6) : AM.RISO;
      for (let b = 0; b < bars; b++) {
        const x = x0 + cw / 2 - (bars - 1) * gap / 2 + b * gap - bw / 2;
        c.fillRect(x, base - hgt, bw, hgt);
      }
      // a fired cell prints a solid block, ref: riso plate
      if (fl > 0.02) {
        hot++;
        const s2 = Math.min(cw - 2 * dpr, 9 * dpr);
        c.fillStyle = AM.INK;
        c.globalAlpha = AM.clamp(fl, 0, 1);
        c.fillRect(x0 + cw / 2 - s2 / 2, base + 2 * dpr, s2, 5 * dpr);
        c.globalAlpha = 1;
      }
      // cell index rule every 4
      if (i % 4 === 0) {
        c.strokeStyle = AM.hair(.28);
        c.beginPath(); c.moveTo(x0 + .5, base); c.lineTo(x0 + .5, base + 6 * dpr); c.stroke();
      }
    }
    // sensitivity line across the meter
    const sy = base - det.sens / 1.2 * (base - 6 * dpr);
    c.strokeStyle = hexA(P[7], .8); c.setLineDash([4 * dpr, 3 * dpr]);
    c.beginPath(); c.moveTo(0, sy + .5); c.lineTo(w, sy + .5); c.stroke();
    c.setLineDash([]);

    $('#tallyRead').textContent = 'L' + line.id + ' PK ' + peak.toFixed(2) + ' / HOT ' + hot;
  }

  /* ---------------- overlay ---------------- */
  function drawOverlay() {
    const c = octx, W = over.width, H = over.height;
    c.clearRect(0, 0, W, H);
    if (!video.src || !vrect.w) return;
    const R = vrect;

    c.save();
    c.lineWidth = Math.max(1, dpr);

    for (const line of det.lines) {
      const horiz = line.orient === 'h';
      const n = det.cells;
      const px = horiz ? R.x : R.x + line.pos * R.w;
      const py = horiz ? R.y + line.pos * R.h : R.y;
      const len = horiz ? R.w : R.h;
      const sel = (line === S.selected);
      const lineHue = line.color || lineColor(line, 0);

      // the line itself — tinted by the scan colour, dark backing for contrast
      c.strokeStyle = sel ? lineHue : 'rgba(255,255,255,.85)';
      c.lineWidth = (sel ? 2 : 1) * Math.max(1, dpr);
      c.setLineDash([]);
      c.beginPath();
      if (horiz) { c.moveTo(R.x, py); c.lineTo(R.x + R.w, py); }
      else { c.moveTo(px, R.y); c.lineTo(px, R.y + R.h); }
      c.stroke();
      c.lineWidth = Math.max(1, dpr);
      c.strokeStyle = 'rgba(0,0,0,.55)';
      c.beginPath();
      if (horiz) { c.moveTo(R.x, py + 1.6 * dpr); c.lineTo(R.x + R.w, py + 1.6 * dpr); }
      else { c.moveTo(px + 1.6 * dpr, R.y); c.lineTo(px + 1.6 * dpr, R.y + R.h); }
      c.stroke();

      // sampled band
      const bandPx = det.band / (horiz ? ah : aw) * (horiz ? R.h : R.w);
      c.fillStyle = sel ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)';
      if (horiz) c.fillRect(R.x, py - bandPx, R.w, bandPx * 2 + 1);
      else c.fillRect(px - bandPx, R.y, bandPx * 2 + 1, R.h);

      // cells + activity
      if (line.prevAct) {
        const cw = len / n;
        for (let i = 0; i < n; i++) {
          const a0 = i * cw;
          const act = AM.clamp(line.prevAct[i] || 0, 0, 1.4);
          const fl = line.flash ? line.flash[i] : 0;
          const col = lineColor(line, i);
          const bar = act * 26 * dpr;

          if (horiz) {
            c.strokeStyle = 'rgba(255,255,255,.28)';
            c.beginPath(); c.moveTo(R.x + a0, py - 4 * dpr); c.lineTo(R.x + a0, py + 4 * dpr); c.stroke();
            c.fillStyle = col; c.globalAlpha = .8;
            c.fillRect(R.x + a0 + 1, py - bar, Math.max(1, cw - 2), bar);
            c.globalAlpha = 1;
            if (fl > 0) {
              c.fillStyle = col;
              const s = (5 + fl * 9) * dpr;
              c.fillRect(R.x + a0 + cw / 2 - s / 2, py - s / 2, s, s);
              c.strokeStyle = 'rgba(255,255,255,' + fl + ')';
              c.strokeRect(R.x + a0 + cw / 2 - s / 2, py - s / 2, s, s);
            }
          } else {
            c.strokeStyle = 'rgba(255,255,255,.28)';
            c.beginPath(); c.moveTo(px - 4 * dpr, R.y + a0); c.lineTo(px + 4 * dpr, R.y + a0); c.stroke();
            c.fillStyle = col; c.globalAlpha = .8;
            c.fillRect(px, R.y + a0 + 1, bar, Math.max(1, cw - 2));
            c.globalAlpha = 1;
            if (fl > 0) {
              c.fillStyle = col;
              const s = (5 + fl * 9) * dpr;
              c.fillRect(px - s / 2, R.y + a0 + cw / 2 - s / 2, s, s);
            }
          }
        }
      }

      // handle + label
      c.fillStyle = sel ? lineHue : AM.PAPER2;
      if (horiz) c.fillRect(R.x - 4 * dpr, py - 4 * dpr, 8 * dpr, 8 * dpr);
      else c.fillRect(px - 4 * dpr, R.y - 4 * dpr, 8 * dpr, 8 * dpr);
      c.fillStyle = 'rgba(239,233,220,.9)';
      c.font = (9 * dpr) + 'px ui-monospace,Menlo,Consolas,monospace';
      const lbl = 'L' + line.id + ' ' + det.mode.toUpperCase() + ' ' + det.sens.toFixed(2);
      if (horiz) c.fillText(lbl, R.x + 8 * dpr, py - 8 * dpr);
      else { c.save(); c.translate(px + 8 * dpr, R.y + 12 * dpr); c.fillText(lbl, 0, 0); c.restore(); }
    }

    c.restore();
  }

  /* ---------------- loop ---------------- */
  let lastFoot = 0;
  function loop(ts) {
    requestAnimationFrame(loop);

    if (video.readyState >= 2) {
      computeRect();
      sctx.fillStyle = AM.STAGE_BG;
      sctx.fillRect(0, 0, stage.width, stage.height);
      sctx.drawImage(video, vrect.x, vrect.y, vrect.w, vrect.h);

      if (aw) {
        actx.drawImage(video, 0, 0, aw, ah);
        const evs = det.analyze(actx, aw, ah, ts);
        if (det.tainted) {
          det.enabled = false;
          toast('canvas blocked — 請用本機伺服器開啟 (見 README)');
        }
        for (let i = 0; i < evs.length; i++) fire(evs[i]);
      }
      drawOverlay();
    }

    if (spectro) spectro.frame(engine.ready ? engine.getSpectrum() : null, S.playing);

    drawTimeline();
    drawTally();
    if (video.duration) {
      $('#timeRead').innerHTML = fmt(video.currentTime) + ' <b>/</b> ' + fmt(video.duration);
    }
    if (ts - lastFoot > 120) { lastFoot = ts; updateFoot(); }
  }

  const FOOT = [
    ['FILE', function () { return S.fileName; }],
    ['HIT', function () { return ('0000' + engine.hits()).slice(-4); }],
    ['VOX', function () { return ('00' + engine.active).slice(-2); }],
    ['LIN', function () {
      const i = det.lines.indexOf(S.selected);
      return '[' + det.lines.length + ']' + (i >= 0 ? ' SEL L' + S.selected.id : '');
    }],
    ['DET', function () { return det.mode.toUpperCase() + ' ' + det.sens.toFixed(2); }],
    ['SCL', function () { return S.scale + ' ' + AM.midiToName(S.root); }],
    ['CLK', function () { return ('000' + Math.round(S.bpm)).slice(-3) + ' ' + AM.QUANT[S.quantIdx].label; }],
    ['VCE', function () { return S.voice; }],
    ['AUD', function () { return audioState(); }]
  ];
  let footBuilt = null;
  function updateFoot() {
    const bar = $('#footBar');
    if (!footBuilt) {
      footBuilt = {};
      FOOT.forEach(function (f) {
        const sp = document.createElement('span');
        sp.className = 'f';
        sp.innerHTML = '<i>[</i>' + f[0] + '<i>]</i> <b></b>';
        bar.appendChild(sp);
        footBuilt[f[0]] = sp;
      });
    }
    FOOT.forEach(function (f) {
      const sp = footBuilt[f[0]];
      sp.querySelector('b').textContent = f[1]();
    });
    const a = footBuilt.AUD;
    a.classList.toggle('live', S.engineOn && engine.ready && engine.ctx.state === 'running');
    a.classList.toggle('warn', !S.engineOn);
  }

  function audioState() {
    if (!S.engineOn) return 'OFF';
    if (!engine.ready) return 'ARMED · 點畫面啟動';
    if (engine.ctx.state === 'suspended') return 'SUSPENDED · 點畫面啟動';
    return 'LIVE';
  }

  /* ---------------- toast ---------------- */
  let toastT = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    const cv = $('#specCanvas');
    const r = cv.getBoundingClientRect();
    const k = Math.min(2, dpr);
    cv.width = Math.max(600, Math.round(r.width * k));
    cv.height = Math.max(120, Math.round(r.height * k));
    spectro = new AM.Spectro(cv);
    setLayout('landscape', false);

    buildRails();
    buildKnobs();
    buildStepper();
    buildColorUI();
    buildStageBar();
    bindSeg('#segTheme', function (v) { setTheme(v); });
    setTheme('light', true);
    syncPlateRamp();
    paintLineUI();
    drawOrnaments();
    updateFoot();
    requestAnimationFrame(loop);
    toast('載入影片開始 — 按 ON 啟動音訊');
  }
  /* printed ornaments: a spirograph plate mark and a scattered square field */
  function drawOrnaments() {
    const dz = $('#dzMark');
    if (dz) {
      // survey target: crosshair, graduated ring, corner brackets
      const c = dz.getContext('2d'), M = 74;
      c.clearRect(0, 0, 148, 148);
      c.strokeStyle = AM.hair(.5); c.lineWidth = 1;
      c.beginPath(); c.arc(M, M, 48, 0, 6.2832); c.stroke();
      c.strokeStyle = AM.hair(.28);
      c.beginPath(); c.arc(M, M, 62, 0, 6.2832); c.stroke();
      for (let i = 0; i < 48; i++) {
        const a = i * Math.PI / 24, big = i % 4 === 0;
        c.strokeStyle = big ? AM.hair(.55) : AM.hair(.25);
        c.beginPath();
        c.moveTo(M + Math.cos(a) * 62, M + Math.sin(a) * 62);
        c.lineTo(M + Math.cos(a) * (62 - (big ? 9 : 5)), M + Math.sin(a) * (62 - (big ? 9 : 5)));
        c.stroke();
      }
      c.strokeStyle = hexA(AM.RISO, .85); c.lineWidth = 1;
      c.beginPath(); c.moveTo(M - 30, M); c.lineTo(M - 8, M);
      c.moveTo(M + 8, M); c.lineTo(M + 30, M);
      c.moveTo(M, M - 30); c.lineTo(M, M - 8);
      c.moveTo(M, M + 8); c.lineTo(M, M + 30); c.stroke();
      c.fillStyle = hexA(AM.RISO, .9);
      c.fillRect(M - 2, M - 2, 4, 4);
    }
    const sc = $('#scatterL');
    if (sc) {
      const c = sc.getContext('2d'), W = sc.width, H = sc.height;
      for (let i = 0; i < 190; i++) {
        const t = Math.random();
        const y = Math.pow(Math.random(), 1.6) * H;
        const x = Math.random() * W;
        const s2 = 2 + Math.random() * 3;
        c.globalAlpha = 0.16 + (1 - y / H) * 0.5;
        if (t > 0.72) { c.fillStyle = AM.INK; c.fillRect(x, y, s2, s2); }
        else { c.strokeStyle = AM.INK; c.lineWidth = 0.7; c.strokeRect(x, y, s2, s2); }
      }
      c.globalAlpha = 1;
    }
  }

  boot();

  g.AMESEN = {
    S: S, engine: engine, det: det, video: video,
    spectro: function () { return spectro; },
    draw: { timeline: drawTimeline, tally: drawTally, overlay: drawOverlay, foot: updateFoot },
    setLayout: setLayout
  };
})(window);
