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
    fileName: '還沒有畫面',
    lineTool: null,
    selected: null,
    layout: 'landscape',
    layoutAuto: true,
    scheme: 'SPECTRUM',       // scan-line colour scheme
    custom: '#3f8296',        // custom scan colour
    colorTarget: 'all',       // 'all' | 'sel'
    stageOnly: false,
    stagePlate: true,         // show the plate inside STAGE
    stageLines: true,         // draw the scan lines over the video inside STAGE
    recKind: 'audio',         // 'audio' | 'video'
    recPlate: true,           // composite the plate into video recordings
    source: 'none',           // 'none' | 'file' | 'cam'
    camMirror: true,          // mirror the live camera, preview and detection alike
    autosave: true,
    theme: 'light'
  };

  const engine = new AM.AudioEngine();
  const det = new AM.Detector();
  const midi = new AM.Midi();
  let spectro = null;
  let recorder = null;

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

  /* ---------------- sources: video file or live camera ---------------- */
  function hasSource() { return !!(video.src || video.srcObject); }
  function isCam() { return S.source === 'cam'; }
  /* the camera image is mirrored on the way in, so the preview, the detection
     canvas and the recording all agree with what the player sees of themselves */
  function mirrored() { return isCam() && S.camMirror; }

  function drawSource(ctx, x, y, w, h) {
    if (!mirrored()) { ctx.drawImage(video, x, y, w, h); return; }
    ctx.save();
    ctx.translate(x + w, y); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  }

  function loadFile(file) {
    if (!file) return;
    stopCam();
    S.source = 'file';
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
      toast('已載入 — 拖曳畫面上的白線，影像碰到線就會發聲');
    });
  }

  $('#dropzone').addEventListener('click', function (e) {
    if (e.target.closest('#dzCam')) return;
    $('#fileInput').click();
  });
  $('#ioFile').addEventListener('click', function () { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', function (e) { loadFile(e.target.files[0]); });

  /* ---------------- camera ---------------- */
  let camStream = null;
  let camList = [];          // videoinput devices, only labelled after the first grant
  let camId = null;          // deviceId of the running camera
  let camT0 = 0;             // wall clock when the live feed started

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function stopCam() {
    if (!camStream) return;
    camStream.getTracks().forEach(function (t) { t.stop(); });
    camStream = null;
    video.srcObject = null;
    if (S.source === 'cam') {
      S.source = 'none'; S.playing = false;
      S.fileName = '還沒有畫面';
      paintTransport();
      // nothing left to show: offer the loader again
      if (!video.src) {
        $('#dropzone').classList.remove('hide');
        sctx.clearRect(0, 0, stage.width, stage.height);
        octx.clearRect(0, 0, over.width, over.height);
      }
    }
    paintCamUI();
  }

  function listCams() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      camList = ds.filter(function (d) { return d.kind === 'videoinput'; });
      paintCamUI();
      return camList;
    }).catch(function () { return []; });
  }

  function startCam(deviceId) {
    if (!camSupported()) { toast('這個瀏覽器不支援攝影機'); return; }
    if (!g.isSecureContext) {
      toast('攝影機需要 https 或 localhost — 請用 start.bat 開啟本機伺服器');
      return;
    }
    const want = { video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }, audio: false };
    want.video.width = { ideal: 1280 };
    want.video.height = { ideal: 720 };
    $('#camStatus').textContent = '請求授權中';
    navigator.mediaDevices.getUserMedia(want).then(function (stream) {
      stopCam();
      camStream = stream;
      camId = (stream.getVideoTracks()[0].getSettings() || {}).deviceId || deviceId || null;
      if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
      video.srcObject = stream;
      S.source = 'cam';
      S.fileName = '攝影機';
      camT0 = performance.now();
      // a live stream has no timeline to loop over
      video.loop = false;
      $('#btnLoop').dataset.on = 'false';
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        setupAnalysis(); computeRect(); autoLayout();
        $('#dropzone').classList.add('hide');
        det.tainted = false;
        play();
        listCams();
        toast('攝影機已開啟 — 動作碰到線就發聲，按錄製鍵可以錄下來');
      });
      // a track the user revokes or a camera unplugged mid-take
      stream.getVideoTracks()[0].addEventListener('ended', function () {
        stopCam();
        toast('攝影機已中斷');
      });
      paintCamUI();
    }).catch(function (err) {
      const n = err && err.name;
      if (n === 'NotAllowedError') toast('攝影機被拒絕 — 請在網址列左邊的鎖頭圖示允許');
      else if (n === 'NotFoundError') toast('找不到攝影機');
      else if (n === 'NotReadableError') toast('攝影機被別的程式佔用了');
      else toast('攝影機開啟失敗：' + (err && err.message ? err.message : n));
      paintCamUI();
    });
  }

  function toggleCam() { isCam() ? stopCam() : startCam(camId); }
  function camElapsed() { return isCam() ? (performance.now() - camT0) / 1000 : 0; }

  function cycleCam(dir) {
    if (camList.length < 2) { listCams(); return; }
    let i = camList.findIndex(function (d) { return d.deviceId === camId; });
    if (i < 0) i = 0;
    i = (i + dir + camList.length) % camList.length;
    startCam(camList[i].deviceId);
  }

  function camLabel() {
    if (!camList.length) return camSupported() ? '沒有攝影機' : '不支援';
    const d = camList.find(function (x) { return x.deviceId === camId; }) || camList[0];
    const name = d.label || ('鏡頭 ' + (camList.indexOf(d) + 1));
    return name.length > 22 ? name.slice(0, 20) + '..' : name;
  }

  function paintCamUI() {
    const on = isCam();
    $('#ioCam').dataset.on = on ? 'true' : 'false';
    $('#ioCam').textContent = on ? '關閉攝影機' : '攝影機';
    $('#camStatus').textContent = on ? '使用中' : '關閉';
    $('#camRead').textContent = camLabel();
    document.body.classList.toggle('is-live', on);
    paintSeg('#segCamMirror', S.camMirror ? 'on' : 'off');
    if (!camSupported()) $('#camNote').textContent = '這個瀏覽器不支援攝影機輸入。';
  }

  $('#ioCam').addEventListener('click', toggleCam);
  $('#dzCam').addEventListener('click', function (e) { e.stopPropagation(); startCam(null); });
  $('#camPrev').addEventListener('click', function () { cycleCam(-1); });
  $('#camNext').addEventListener('click', function () { cycleCam(1); });
  $('#segCamMirror').addEventListener('click', function (e) {
    const b = e.target.closest('button'); if (!b) return;
    S.camMirror = b.dataset.v === 'on';
    det.reset();
    paintCamUI();
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', listCams);
  }

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
    if (!hasSource()) { $('#fileInput').click(); return; }
    ensureAudio();
    video.play().then(function () {
      S.playing = true;
      paintTransport();
    }).catch(function (err) { toast('無法播放：' + err.message); });
  }
  function pause() {
    video.pause(); S.playing = false;
    paintTransport();
  }
  /* the play button, the source name and the state chip in the top capsule */
  function paintTransport() {
    const b = $('#btnPlay');
    b.classList.toggle('playing', S.playing);
    b.dataset.live = S.playing ? 'true' : 'false';
    b.setAttribute('aria-label', S.playing ? '暫停' : '播放');
    $('#srcName').textContent = S.fileName;
    if (recorder && recorder.recording()) return;   // the rec clock owns the chip
    const st = $('#statusText');
    st.textContent = S.playing ? (isCam() ? '即時' : '播放中') : (hasSource() ? '暫停' : '待機');
    st.classList.toggle('live', S.playing);
  }
  $('#btnPlay').addEventListener('click', function () { S.playing ? pause() : play(); });
  $('#btnLoop').addEventListener('click', function () {
    video.loop = !video.loop;
    this.dataset.on = video.loop ? 'true' : 'false';
    toast(video.loop ? '重複播放：開' : '重複播放：關');
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
    if (!video.duration || isCam()) return;

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
    $('#btnTheme').dataset.on = S.theme === 'dark' ? 'true' : 'false';
    // every drawn surface carries the ground with it
    if (spectro) { spectro.clear(); }
    drawOrnaments();
    requestAnimationFrame(function () { sizeCanvases(); computeRect(); resizePlate(); });
    if (!quiet) toast((S.theme === 'dark' ? '深色' : '淺色') + ' — 圖版已重新鋪底');
  }

  /* ---------------- stage-only mode ----------------
     video, scan lines and plate only: every control is hidden. Keys still work. */
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
    relayout();
    if (S.stageOnly) {
      pop.close(false);
      toast('演出模式 — Space 播放 · L 偵測線 · P 圖版 · R 錄製 · F 或 Esc 離開');
    } else if (!S.stageLines) {
      S.stageLines = true;     // outside STAGE the lines always show
    }
  }
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && S.stageOnly) setStageOnly(false, true);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.stageOnly && !pop.open) setStageOnly(false);
  });

  /* the plate strip: shown or folded away (S.stagePlate keeps its old name so
     share links made before the redesign still restore it) */
  function setPlate(on, quiet) {
    S.stagePlate = !!on;
    $('#btnPlate').dataset.on = S.stagePlate ? 'true' : 'false';
    document.body.classList.toggle('plate-off', !S.stagePlate);
    relayout();
    if (!quiet) toast(S.stagePlate ? '頻譜圖版：顯示' : '頻譜圖版：收起（仍持續記錄）');
  }

  /* canvases are laid out by CSS; let it settle, then resize the backing stores */
  function relayout() {
    requestAnimationFrame(function () { sizeCanvases(); computeRect(); resizePlate(); pop.place(); });
    setTimeout(function () { sizeCanvases(); computeRect(); resizePlate(); pop.place(); }, 140);
  }

  function buildChrome() {
    $('#btnStage').addEventListener('click', function () { setStageOnly(!S.stageOnly); });
    $('#btnPlate').addEventListener('click', function () { setPlate(!S.stagePlate); });
    $('#btnTheme').addEventListener('click', function () { setTheme(S.theme === 'dark' ? 'light' : 'dark'); });
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
    relayout();
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
      if (hasSource()) toast('圖版轉為' + (spectro.orient === 'v' ? '直式（時間由上往下）' : '橫式（時間由左往右）'));
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

  /* ---------------- sound choices: labelled chips ---------------- */
  const SCALE_NAMES = { PENT: '小調五聲', MAJ: '大調五聲', DOR: '多利安', WHOLE: '全音', CHRM: '半音' };
  const QUANT_NAMES = { FREE: '不對齊', '4n': '4 分音符', '8n': '8 分音符', '16n': '16 分音符', '32n': '32 分音符' };
  const VOICES = [
    { k: 'BELL', name: '鐘聲', hint: 'FM 玻璃質感，長尾音', key: '1' },
    { k: 'PLUCK', name: '撥弦', hint: '像吉他弦，短而清脆', key: '2' },
    { k: 'GLITCH', name: '故障', hint: '破音方波，短促', key: '3' }
  ];
  const FX_NAMES = { REV: '殘響', DLY: '延遲', LPF: '低通', BIT: '位元破壞', SUB: '低八度' };

  /* one option = the original glyph (diamond or ringed dial) + its plain name */
  function opt(glyph, name, title, hint) {
    const b = document.createElement('button');
    b.className = 'opt';
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(glyph);
    const cap = document.createElement('span');
    cap.className = 'opt-cap';
    if (hint) {
      const n = document.createElement('b'); n.textContent = name;
      const h = document.createElement('small'); h.textContent = hint;
      cap.appendChild(n); cap.appendChild(h);
    } else cap.textContent = name;
    b.appendChild(cap);
    if (title) b.title = title;
    return b;
  }
  function dia(code) {
    const d = document.createElement('span');
    d.className = 'dia';
    const t = document.createElement('span'); t.textContent = code;
    d.appendChild(t);
    return d;
  }
  function cir(code, ticks, rose) {
    const c = document.createElement('span');
    c.className = 'cir';
    if (rose) {
      const sp = document.createElement('canvas');
      sp.className = 'spiro'; sp.width = 72; sp.height = 72;
      AM.rosette(sp.getContext('2d'), 36, 36, 30, {
        petals: rose[0], r: rose[1], d: rose[2], alpha: .5, lineWidth: .5, color: AM.INK
      });
      c.appendChild(sp);
    }
    const t = document.createElement('b'); t.textContent = code;
    c.appendChild(t);
    c.appendChild(AM.collar(46, ticks));
    return c;
  }

  function buildRails() {
    AM.SCALE_KEYS.forEach(function (k) {
      const b = opt(dia(AM.SCALES[k].label), SCALE_NAMES[k] || k, '音階：' + (SCALE_NAMES[k] || k));
      b.dataset.k = k;
      b.addEventListener('click', function () { S.scale = k; paintRails(); updateStatus(); });
      $('#railScale').appendChild(b);
    });
    AM.QUANT.forEach(function (q, i) {
      const b = opt(dia(q.label), QUANT_NAMES[q.label] || q.label,
        q.beats ? '觸發會對齊到 BPM 的 ' + (QUANT_NAMES[q.label] || q.label) + ' 格線' : '觸發立刻發聲，不對齊節拍');
      b.dataset.i = i;
      b.addEventListener('click', function () { S.quantIdx = i; paintRails(); updateStatus(); });
      $('#railQuant').appendChild(b);
    });
    VOICES.forEach(function (v, i) {
      const b = opt(cir(v.k.slice(0, 3), 32, [[13, 11, 9], [17, 13, 7], [9, 19, 12]][i]), v.name,
        v.name + '（快捷鍵 ' + v.key + '）', v.hint);
      b.classList.add('voice');
      b.dataset.v = v.k;
      b.addEventListener('click', function () { S.voice = v.k; engine.setVoice(v.k); paintRails(); });
      $('#railVoice').appendChild(b);
    });
    ['REV', 'DLY', 'LPF', 'BIT', 'SUB'].forEach(function (k) {
      const b = opt(cir(k, 24, null), FX_NAMES[k], '效果：' + FX_NAMES[k]);
      b.dataset.f = k;
      b.addEventListener('click', function () { engine.init(); engine.toggleFx(k); paintRails(); });
      $('#railFx').appendChild(b);
    });
    paintRails();
  }

  function paintRails() {
    const mark = function (b, on, led) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.style.setProperty('--led', led);
    };
    document.querySelectorAll('#railScale .opt').forEach(function (b, i) { mark(b, b.dataset.k === S.scale, P[(i + 3) % P.length]); });
    document.querySelectorAll('#railQuant .opt').forEach(function (b, i) { mark(b, +b.dataset.i === S.quantIdx, P[i % P.length]); });
    document.querySelectorAll('#railVoice .opt').forEach(function (b, i) { mark(b, b.dataset.v === S.voice, P[[7, 5, 0][i]]); });
    document.querySelectorAll('#railFx .opt').forEach(function (b, i) { mark(b, !!engine.fx[b.dataset.f], P[(i + 2) % P.length]); });
  }

  /* momentary buttons blink their LED so a press reads as an event */
  document.querySelectorAll('.sq-btn, .ib').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.on !== undefined) return;   // latching buttons show state instead
      b.classList.remove('fired'); void b.offsetWidth; b.classList.add('fired');
      setTimeout(function () { b.classList.remove('fired'); }, 170);
    });
  });

  /* preset stepper — a selector, not a dropdown */
  const PRESET_NAMES = { default: '標準', rain: '細雨', glass: '玻璃', broken: '碎裂' };
  function buildStepper() {
    const sel = $('#selPreset'), pips = $('#presetPips');
    for (let i = 0; i < sel.options.length; i++) pips.appendChild(document.createElement('i'));
    function paint() {
      $('#presetVal').textContent = PRESET_NAMES[sel.value] || sel.value;
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
    { id: '#pSens', group: '#knobsDetect', label: 'SENS', name: '靈敏度', hint: '越低越容易觸發', color: P[0],
      fmt: function (v) { return v.toFixed(2); },
      apply: function (v) { det.sens = v; } },
    { id: '#pCells', group: '#knobsDetect', label: 'CELLS', name: '格數', hint: '每條線切成幾個音', color: P[5], fmt: int,
      apply: function (v) { det.cells = v | 0; det.reset(); } },
    { id: '#pHold', group: '#knobsDetect', label: 'HOLD', name: '間隔', hint: '同一格再次觸發的最短時間', color: P[1], fmt: int, unit: 'ms',
      apply: function (v) { det.hold = v; } },
    { id: '#pBand', group: '#knobsDetect', label: 'BAND', name: '取樣寬度', hint: '線上下各看幾個像素', color: P[4], fmt: int, unit: 'px',
      apply: function (v) { det.band = v | 0; } },
    { id: '#pRoot', group: '#knobsPitch', label: 'ROOT', name: '根音', hint: '最低的那個音', color: P[7],
      fmt: function (v) { return AM.midiToName(v | 0); },
      apply: function (v) { S.root = v | 0; } },
    { id: '#pBpm', group: '#knobsPitch', label: 'BPM', name: '速度', hint: '節拍格線與延遲的快慢', color: P[3], fmt: int,
      apply: function (v) { S.bpm = v; engine.setDelayTime(60 / v * 0.75); } },
    { id: '#pVol', group: '#knobsPitch', label: 'VOL', name: '音量', hint: '主輸出音量', color: P[2],
      fmt: function (v) { return Math.round(v * 100) + ''; }, unit: '%',
      apply: function (v) { S.vol = v; engine.setVolume(v); } }
  ];
  const knobs = {};
  function buildKnobs() {
    KNOBS.forEach(function (k) {
      const inp = $(k.id);
      knobs[k.id] = new AM.Knob({
        input: inp, label: k.label, name: k.name, hint: k.hint, fmt: k.fmt, unit: k.unit || '',
        color: k.color, size: 60,
        onInput: function (v) { k.apply(v); updateStatus(); }
      }).mount($(k.group));
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
    if (!l) { toast('最多 8 條線'); return; }
    select(l);
    toast('加了一條' + (orient === 'v' ? '直線' : '橫線') + ' L' + l.id + '，共 ' + det.lines.length + ' 條');
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
      ? (i >= 0 ? 'L' + S.selected.id + (S.selected.orient === 'h' ? ' 橫線 ' : ' 直線 ') +
          (i + 1) + '/' + det.lines.length
        : '未選取 · 共 ' + det.lines.length + ' 條')
      : '沒有線';
    $('#selRead').textContent = txt;
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
        toast('掃描線顏色：' + sc.label);
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
    this.title = S.engineOn ? '音訊：開（關掉時只印圖不發聲）' : '音訊：關（只印圖不發聲）';
    if (S.engineOn) { ensureAudio(); toast('音訊開啟'); }
    else { toast('音訊關閉 — 只印圖不發聲'); }
    updateStatus();
  });
  /* audition the current voice — proves the audio path without a video */
  $('#btnTest').addEventListener('click', function () {
    ensureAudio();
    if (!engine.ready) { toast('音訊無法啟動'); return; }
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
    toast('試聽：' + S.voice + ' · ' + AM.midiToName(S.root) + ' ' + (SCALE_NAMES[S.scale] || S.scale) +
      (engine.ctx.state === 'running' ? '' : ' · 音訊狀態 ' + engine.ctx.state));
  });

  $('#btnSrcAudio').addEventListener('click', function () {
    video.muted = !video.muted;
    this.dataset.on = video.muted ? 'false' : 'true';
    this.textContent = video.muted ? '關閉' : '開啟';
    toast(video.muted ? '影片原聲：關' : '影片原聲：開');
  });
  $('#btnSpecSave').addEventListener('click', function () { spectro.save(); toast('圖版已存成 PNG'); });
  $('#btnSpecClear').addEventListener('click', function () {
    spectro.clear(); det.reset(); engine.resetHits(); toast('圖版已清除');
  });
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
    det.reset(); paintRails(); updateStatus();
    toast('預設：' + (PRESET_NAMES[name] || name));
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
    det.reset(); paintRails(); updateStatus();
    toast('已隨機換一組參數');
  }

  /* ---------------- dragging threshold lines ---------------- */
  let drag = null;
  function toNorm(e) {
    const r = vp.getBoundingClientRect();
    const cx = (e.clientX - r.left) * dpr, cy = (e.clientY - r.top) * dpr;
    return { x: (cx - vrect.x) / Math.max(1, vrect.w), y: (cy - vrect.y) / Math.max(1, vrect.h) };
  }
  vp.addEventListener('pointerdown', function (e) {
    if (!hasSource() || !linesShown()) return;   // hidden lines cannot be grabbed
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
    } else if (hasSource()) {
      vp.style.cursor = linesShown() && det.pick(n.x, n.y, 0.035) ? 'grab' : 'default';
    }
  });
  vp.addEventListener('pointerup', function () { drag = null; });
  vp.addEventListener('pointercancel', function () { drag = null; });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // inside a panel, keys belong to its controls (Tab moves focus, arrows turn knobs)
    const inUI = e.target.closest && e.target.closest('.pop, .knob, button');
    if (inUI && ['Space', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Delete', 'Backspace'].indexOf(e.code) >= 0) return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.code === 'Digit1') { S.voice = 'BELL'; engine.setVoice('BELL'); paintRails(); }
    if (e.code === 'Digit2') { S.voice = 'PLUCK'; engine.setVoice('PLUCK'); paintRails(); }
    if (e.code === 'Digit3') { S.voice = 'GLITCH'; engine.setVoice('GLITCH'); paintRails(); }
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.code === 'Tab') { e.preventDefault(); cycleSelect(e.shiftKey ? -1 : 1); return; }
    if (e.code === 'KeyF') { e.preventDefault(); setStageOnly(!S.stageOnly); return; }
    if (e.code === 'KeyR') { e.preventDefault(); toggleRec(); return; }
    if (e.code === 'KeyC') { e.preventDefault(); toggleCam(); return; }
    if (e.code === 'KeyL' && S.stageOnly) { e.preventDefault(); setStageLines(!S.stageLines); return; }
    if (e.code === 'KeyP') { e.preventDefault(); setPlate(!S.stagePlate); return; }
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
    const midiNote = AM.clamp(S.root + steps[idx % steps.length] + 12 * oct + 12 * ev.line.octave, 12, 120);
    const freq = AM.midiToFreq(midiNote);

    let ok = false;
    // the audio clock is also the MIDI clock, so start it even when AUDIO is off
    if (S.engineOn || midi.enabled) {
      if (!engine.ready) engine.init();
      else if (engine.ctx.state === 'suspended') engine.resume();
    }
    const when = qTime();
    if (S.engineOn) {
      ok = engine.trigger({
        freq: freq,
        vel: ev.vel,
        pan: AM.clamp(ev.nx * 2 - 1, -1, 1) * 0.75,
        when: when,
        voice: S.voice
      });
    }
    if (midi.enabled) {
      midi.note(midiNote, ev.vel, when - engine.now(), det.lines.indexOf(ev.line));
    }

    const stampEv = {
      nx: horiz ? ev.nx : ev.ny,
      ny: ev.ny,
      vel: ev.vel,
      r: ev.r, g: ev.g, b: ev.b,
      pitchNorm: AM.clamp((midiNote - S.root) / 36, 0, 1)
    };
    stampEv.ramp = ev.line.color ? [ev.line.color] : ramp();
    spectro.stamp(stampEv, engine.ready ? engine.getSpectrum() : null);

    if (ok) {
      const c = document.querySelector('#railVoice .opt[data-v="' + S.voice + '"] .cir');
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
      c.fillStyle = hexA(AM.RISO, 0.35 + act * 0.6);
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

    $('#tallyRead').textContent = 'L' + line.id + ' · 峰值 ' + peak.toFixed(2) + ' · 觸發 ' + hot + ' 格';
  }

  /* ---------------- overlay ---------------- */
  function drawOverlay() {
    const c = octx, W = over.width, H = over.height;
    c.clearRect(0, 0, W, H);
    if (!hasSource() || !vrect.w || !linesShown()) return;
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
      drawSource(sctx, vrect.x, vrect.y, vrect.w, vrect.h);

      if (aw) {
        drawSource(actx, 0, 0, aw, ah);
        const evs = det.analyze(actx, aw, ah, ts);
        if (det.tainted) {
          det.enabled = false;
          toast('瀏覽器擋住了影像讀取 — 請用本機伺服器開啟（見 README）');
        }
        for (let i = 0; i < evs.length; i++) fire(evs[i]);
      }
      drawOverlay();
    }

    if (spectro) spectro.frame(engine.ready ? engine.getSpectrum() : null, S.playing);
    if (recorder && recorder.recording()) {
      if (recorder.kind === 'video') recorder.tick();
      paintRecClock();
    }

    if (!S.stageOnly) drawTimeline();
    if (pop.isOpen('popLines')) drawTally();
    if (isCam()) {
      $('#timeRead').textContent = '即時 ' + clock(camElapsed());
    } else if (video.duration) {
      $('#timeRead').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
    }
    if (ts - lastFoot > 250) { lastFoot = ts; updateStatus(); }
  }

  /* the dot in the top capsule: is sound actually coming out? */
  function updateStatus() {
    const d = $('#audioDot');
    const st = audioState();
    d.textContent = 'AUD ' + { live: 'LIVE', armed: 'ARMED', off: 'OFF' }[st.k];
    d.classList.toggle('live', st.k === 'live');
    d.classList.toggle('warn', st.k !== 'live');
    d.title = '音訊：' + st.t;
  }

  function audioState() {
    if (!S.engineOn) return { k: 'off', t: '關閉（只印圖不發聲）' };
    if (!engine.ready) return { k: 'armed', t: '待命 · 點畫面任一處啟動' };
    if (engine.ctx.state === 'suspended') return { k: 'armed', t: '暫停 · 點畫面任一處啟動' };
    return { k: 'live', t: '發聲中' };
  }

  /* ---------------- toast ---------------- */
  let toastT = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ================================================================
     I/O — recording, MIDI out, state (share link / file / autosave)
     ================================================================ */
  const STATE_KEY = 'nijisen.threshold.state';
  const AUTOSAVE_KEY = 'nijisen.threshold.autosave';

  function linesShown() { return !(S.stageOnly && !S.stageLines); }
  function clock(sec) {
    sec = Math.max(0, sec | 0);
    return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + sec % 60).slice(-2);
  }

  /* ---------- panels ---------- */
  const pop = new AM.Popover({
    keepOpenInside: ['#viewport'],     // lines can be dragged while a panel is open
    onchange: function (id) {
      if (id === 'popOutput') { paintMidiUI(); paintRecUI(); }
      if (id === 'popLines') drawTally();
    }
  });

  /* ---------- stage line visibility ---------- */
  function setStageLines(on) {
    S.stageLines = !!on;
    if (!S.stageLines) drag = null;
    toast(S.stageLines ? '偵測線：顯示' : '偵測線：隱藏（仍持續偵測與發聲）');
  }

  /* ---------- recording ---------- */
  function recSources() {
    return {
      stage: stage, overlay: over, plate: $('#specCanvas'),
      showLines: linesShown(), withPlate: S.recPlate
    };
  }
  function toggleRec() {
    if (!recorder) return;
    if (recorder.recording()) { recorder.stop(); return; }
    if (!AM.Recorder.supported()) { toast('這個瀏覽器不支援錄製'); return; }
    if (S.recKind === 'video' && !hasSource()) { toast('影片錄製需要先載入影片或開啟攝影機'); return; }
    ensureAudio();
    try {
      recorder.start(S.recKind);
      if (!S.engineOn && S.recKind === 'audio') toast('● 錄製中 — 注意：音訊關閉中，錄到的會是靜音');
      else toast('● 錄製' + (S.recKind === 'video' ? '影片' : '聲音') + ' — 再按一次或 R 停止並下載');
    } catch (e) {
      toast('無法開始錄製：' + e.message);
    }
  }
  let lastClock = -1;
  function paintRecClock() {
    const t = recorder.elapsed() | 0;
    if (t === lastClock) return;
    lastClock = t;
    const txt = clock(t);
    $('#recRead').textContent = txt;
    $('#statusText').textContent = '● 錄製 ' + txt;
  }
  function paintSeg(id, v) {
    const el = $(id); if (!el) return;
    el.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === v); });
  }
  function paintRecUI() {
    const on = !!(recorder && recorder.recording());
    ['#btnRec', '#ioRec'].forEach(function (id) { $(id).dataset.on = on ? 'true' : 'false'; });
    $('#ioRec').textContent = on ? '停止並下載' : '開始錄製';
    $('#btnRec').setAttribute('aria-label', on ? '停止錄製' : '錄製');
    document.body.classList.toggle('is-recording', on);
    $('#statusText').classList.toggle('rec', on);
    if (!on) {
      lastClock = -1;
      $('#recRead').textContent = '00:00';
      paintTransport();
    }
    paintSeg('#segRecKind', S.recKind);
    paintSeg('#segRecPlate', S.recPlate ? 'on' : 'off');
    // kind and plate choice cannot change mid-take
    ['#segRecKind', '#segRecPlate'].forEach(function (id) { $(id).classList.toggle('dim', on); });
  }

  /* ---------- MIDI ---------- */
  function paintMidiUI() {
    const sup = AM.Midi.supported();
    $('#midiOn').dataset.on = midi.enabled ? 'true' : 'false';
    const out = midi.output();
    let status;
    if (!sup) status = '不支援';
    else if (!midi.enabled) status = '關閉';
    else if (!out) status = '沒有裝置';
    else status = '就緒 · 已送出 ' + midi.sent;
    $('#midiStatus').textContent = status;
    const name = out ? out.name : (midi.enabled ? '沒有輸出裝置' : '—');
    $('#midiOutRead').textContent = name.length > 26 ? name.slice(0, 24) + '..' : name;
    $('#midiChRead').textContent = midi.route === 'line' ? '線 = 頻道' : 'CH ' + (midi.channel + 1);
    paintSeg('#segMidiRoute', midi.route);
    paintSeg('#segMidiGate', String(midi.gate));
    if (!sup) $('#midiNote').textContent = '這個瀏覽器不支援 Web MIDI（Safari / iOS 目前沒有）。請改用 Chrome、Edge 或 Firefox。';
  }

  /* ---------- state ---------- */
  const HEX = /^#[0-9a-f]{6}$/i;
  function numIn(v, lo, hi, d) { return (typeof v === 'number' && isFinite(v)) ? AM.clamp(v, lo, hi) : d; }
  function oneOf(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }

  function captureState() {
    return {
      app: 'nijisen', mod: 'threshold', v: 1,
      det: { mode: det.mode, sens: +det.sens.toFixed(3), cells: det.cells, hold: det.hold, band: det.band },
      pitch: { root: S.root, scale: S.scale, q: S.quantIdx, bpm: Math.round(S.bpm) },
      sound: { voice: S.voice, vol: +S.vol.toFixed(2), fx: Object.assign({}, engine.fx) },
      lines: det.lines.map(function (l) {
        return { o: l.orient, p: +l.pos.toFixed(4), c: l.color || null, oc: l.octave || 0 };
      }),
      look: {
        scheme: S.scheme, custom: S.custom, plate: spectro ? spectro.mode : 'scroll',
        theme: S.theme, layout: S.layoutAuto ? 'auto' : S.layout
      },
      stage: { plate: S.stagePlate, lines: S.stageLines },
      io: { rec: S.recKind, recPlate: S.recPlate, mir: S.camMirror, ch: midi.channel, route: midi.route, gate: midi.gate }
    };
  }

  /* a shared link is untrusted input: every field is whitelisted or clamped */
  function applyState(st, quiet) {
    if (!st || typeof st !== 'object') return false;
    if (st.app && st.app !== 'nijisen') return false;
    if (st.mod && st.mod !== 'threshold') return false;

    const d = st.det || {}, p = st.pitch || {}, so = st.sound || {}, lk = st.look || {},
      sg = st.stage || {}, io = st.io || {};

    det.mode = oneOf(d.mode, ['motion', 'luma', 'edge'], det.mode);
    paintSeg('#segMode', det.mode);
    setRange('#pSens', numIn(d.sens, 0.01, 1, det.sens));
    setRange('#pCells', Math.round(numIn(d.cells, 4, 48, det.cells)));
    setRange('#pHold', Math.round(numIn(d.hold, 30, 600, det.hold) / 10) * 10);
    setRange('#pBand', Math.round(numIn(d.band, 1, 24, det.band)));

    setRange('#pRoot', Math.round(numIn(p.root, 24, 72, S.root)));
    setRange('#pBpm', Math.round(numIn(p.bpm, 40, 200, S.bpm)));
    S.scale = oneOf(p.scale, AM.SCALE_KEYS, S.scale);
    S.quantIdx = Math.round(numIn(p.q, 0, AM.QUANT.length - 1, S.quantIdx));

    S.voice = oneOf(so.voice, ['BELL', 'PLUCK', 'GLITCH'], S.voice);
    engine.setVoice(S.voice);
    setRange('#pVol', numIn(so.vol, 0, 1, S.vol));
    if (so.fx && typeof so.fx === 'object') {
      ['REV', 'DLY', 'LPF', 'BIT', 'SUB'].forEach(function (k) {
        if (typeof so.fx[k] === 'boolean') engine.fx[k] = so.fx[k];
      });
      engine.applyFx();
    }

    if (Array.isArray(st.lines)) {
      det.lines.length = 0;
      st.lines.slice(0, 8).forEach(function (li) {
        if (!li || typeof li !== 'object') return;
        const l = det.addLine(oneOf(li.o, ['h', 'v'], 'h'), numIn(li.p, 0.01, 0.99, 0.5));
        if (!l) return;
        l.color = typeof li.c === 'string' && HEX.test(li.c) ? li.c : null;
        l.octave = Math.round(numIn(li.oc, -3, 3, 0));
      });
      det.reset();
      select(null);
    }

    S.scheme = oneOf(lk.scheme, AM.SCHEME_KEYS, S.scheme);
    if (typeof lk.custom === 'string' && HEX.test(lk.custom)) S.custom = lk.custom;
    if (spectro) {
      const m = oneOf(lk.plate, ['scroll', 'stack', 'ring'], spectro.mode);
      spectro.setMode(m); paintSeg('#segSpecMode', m);
    }
    const th = oneOf(lk.theme, ['light', 'dark'], S.theme);
    if (th !== S.theme) setTheme(th, true);
    const lay = oneOf(lk.layout, ['auto', 'landscape', 'portrait'], null);
    if (lay === 'auto') { S.layoutAuto = true; autoLayout(); paintLayoutSeg(); }
    else if (lay) setLayout(lay, true);

    if (typeof sg.plate === 'boolean') setPlate(sg.plate, true);
    if (typeof sg.lines === 'boolean') S.stageLines = sg.lines;

    S.recKind = oneOf(io.rec, ['audio', 'video'], S.recKind);
    if (typeof io.recPlate === 'boolean') S.recPlate = io.recPlate;
    if (typeof io.mir === 'boolean') S.camMirror = io.mir;
    midi.channel = Math.round(numIn(io.ch, 0, 15, midi.channel));
    midi.route = oneOf(io.route, ['all', 'line'], midi.route);
    midi.gate = oneOf(io.gate, [60, 140, 400], midi.gate);

    paintRails(); paintColorUI(); syncPlateRamp(); paintLineUI();
    paintRecUI(); paintMidiUI(); paintCamUI(); updateStatus();
    if (!quiet) toast('已套用設定 — ' + det.lines.length + ' 條線 · ' + (SCALE_NAMES[S.scale] || S.scale) + ' ' + AM.midiToName(S.root) + ' · ' + S.voice);
    return true;
  }

  function buildIO() {
    recorder = new AM.Recorder(engine, recSources);
    recorder.onchange = paintRecUI;
    recorder.onsaved = function (info) {
      toast('已下載 ' + info.name + (info.fallback ? '（WAV 轉檔失敗，改存原始錄音）' : ''));
    };
    midi.onchange = paintMidiUI;

    ['#btnRec', '#ioRec'].forEach(function (id) { $(id).addEventListener('click', toggleRec); });
    bindSeg('#segRecKind', function (v) {
      if (!recorder.recording()) S.recKind = v;
      paintRecUI();
    });
    bindSeg('#segRecPlate', function (v) {
      if (!recorder.recording()) S.recPlate = v === 'on';
      paintRecUI();
    });

    $('#midiOn').addEventListener('click', function () {
      if (midi.enabled) { midi.disable(); toast('MIDI 輸出關閉（已送 all notes off）'); return; }
      midi.enable().then(function () {
        toast(midi.output() ? 'MIDI 輸出 → ' + midi.output().name : 'MIDI 已啟用，但沒有偵測到輸出裝置');
      }).catch(function (e) {
        toast('MIDI 無法啟用：' + (e && e.message ? e.message : '權限被拒'));
        paintMidiUI();
      });
    });
    $('#midiOutPrev').addEventListener('click', function () { midi.cycleOutput(-1); });
    $('#midiOutNext').addEventListener('click', function () { midi.cycleOutput(1); });
    $('#midiChPrev').addEventListener('click', function () { midi.setChannel(midi.channel - 1); });
    $('#midiChNext').addEventListener('click', function () { midi.setChannel(midi.channel + 1); });
    bindSeg('#segMidiRoute', function (v) { midi.panic(); midi.route = v; paintMidiUI(); });
    bindSeg('#segMidiGate', function (v) { midi.gate = parseInt(v, 10); paintMidiUI(); });
    $('#midiPanic').addEventListener('click', function () { midi.panic(); toast('MIDI 全部停止（all notes off）'); });

    $('#stLink').addEventListener('click', function () {
      const url = AM.State.writeHash(captureState());
      AM.State.copy(url).then(function () {
        toast('分享連結已複製（' + url.length + ' 字元）');
      }).catch(function () {
        toast('連結已寫入網址列，請手動複製');
      });
    });
    $('#stSave').addEventListener('click', function () {
      const blob = new Blob([JSON.stringify(captureState(), null, 2)], { type: 'application/json' });
      AM.download(blob, 'nijisen-threshold-' + AM.fileStamp() + '.json');
      toast('設定檔已下載');
    });
    $('#stLoad').addEventListener('click', function () { $('#stFile').click(); });
    $('#stFile').addEventListener('change', function (e) {
      const f = e.target.files[0]; if (!f) return;
      AM.State.readFile(f).then(function (st) {
        if (!applyState(st)) toast('這不是虹線 01 的設定檔');
      }).catch(function () { toast('設定檔讀取失敗'); });
      e.target.value = '';
    });
    bindSeg('#segAutosave', function (v) {
      S.autosave = v === 'on';
      try { localStorage.setItem(AUTOSAVE_KEY, S.autosave ? 'on' : 'off'); } catch (err) { }
      if (!S.autosave) AM.State.clear(STATE_KEY);
      toast(S.autosave ? '自動保存：開（重新整理會回到上次設定）' : '自動保存：關（已清除保存的設定）');
    });

    window.addEventListener('hashchange', function () {
      const st = AM.State.fromHash();
      if (st) applyState(st);
    });

    let lastSaved = '';
    setInterval(function () {
      if (!S.autosave) return;
      const st = captureState(), str = JSON.stringify(st);
      if (str !== lastSaved) { AM.State.save(STATE_KEY, st); lastSaved = str; }
    }, 1500);

    paintRecUI(); paintMidiUI(); paintCamUI();
    listCams();
  }

  /* boot order: a share link wins, then the last autosave */
  function restoreState() {
    try { S.autosave = localStorage.getItem(AUTOSAVE_KEY) !== 'off'; } catch (e) { }
    paintSeg('#segAutosave', S.autosave ? 'on' : 'off');
    const fromLink = AM.State.fromHash();
    if (fromLink && applyState(fromLink, true)) { toast('已載入分享連結的設定'); return; }
    if (S.autosave) {
      const saved = AM.State.load(STATE_KEY);
      if (saved && applyState(saved, true)) toast('已回復上次的設定');
    }
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
    buildChrome();
    setTheme('light', true);
    syncPlateRamp();
    buildIO();
    restoreState();
    paintLineUI();
    drawOrnaments();
    paintTransport();
    updateStatus();
    requestAnimationFrame(loop);
  }
  /* printed ornaments: the survey target on the loader */
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
  }

  boot();

  g.AMESEN = {
    S: S, engine: engine, det: det, video: video,
    spectro: function () { return spectro; },
    draw: { timeline: drawTimeline, tally: drawTally, overlay: drawOverlay, status: updateStatus },
    setLayout: setLayout,
    pop: pop,
    midi: midi,
    recorder: function () { return recorder; },
    captureState: captureState,
    applyState: applyState,
    fire: fire
  };
})(window);
