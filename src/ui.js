/* ============================================================================
   UI-логика плагина «Whoosh — Off to Print!» (эта часть попадает внутрь ui.html).
   ========================================================================== */
(function () {
  'use strict';

  var SVG = globalThis.PrintSvg;
  var PDF = globalThis.PrintPdf;
  var $ = function (id) { return document.getElementById(id); };

  var PRESETS = {
    'A4': [210, 297], 'A3': [297, 420], 'A2': [420, 594], 'A1': [594, 841],
    'A0': [841, 1189], 'A5': [148, 210], 'A6': [105, 148],
    'B1': [707, 1000], 'B2': [500, 707], 'Letter': [215.9, 279.4],
    'Квадрат 210': [210, 210], 'Свой размер': null
  };

  var QUICK = [
    ['Чёрный текст', 0, 0, 0, 100],
    ['Богатый чёрный', 60, 40, 40, 100],
    ['Серый 50%', 0, 0, 0, 50],
    ['Красный', 0, 100, 100, 0],
    ['Оранжевый', 0, 60, 100, 0],
    ['Жёлтый', 0, 0, 100, 0],
    ['Зелёный', 100, 0, 100, 0],
    ['Бирюзовый', 100, 0, 20, 0],
    ['Синий', 100, 60, 0, 0],
    ['Фиолетовый', 60, 100, 0, 0]
  ];

  var state = { frames: [], preset: 'A4', orient: 'portrait', busy: false, wmm: 210, hmm: 297, guides: {} };

  function num(v, d) { var x = parseFloat(v); return isFinite(x) ? x : d; }
  function round(v, d) { var m = Math.pow(10, d || 1); return Math.round(v * m) / m; }
  function safeName(s) {
    return String(s || 'layout').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60);
  }
  function log(text, cls) {
    var el = $('log');
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  function send(msg) { parent.postMessage({ pluginMessage: msg }, '*'); }

  function download(data, filename, mime) {
    try {
      var blob = new Blob([data], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
      return true;
    } catch (e) {
      log('Не удалось сохранить файл: ' + e.message, 'err');
      return false;
    }
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ------------------------------ вкладки ------------------------------- */

  var tabs = document.querySelectorAll('nav button');
  for (var ti = 0; ti < tabs.length; ti++) {
    tabs[ti].addEventListener('click', function () {
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
      this.classList.add('active');
      var panels = document.querySelectorAll('.panel');
      for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
      $('panel-' + this.getAttribute('data-tab')).classList.add('active');
    });
  }

  /* --------------------------- вкладка «Макет» -------------------------- */

  (function buildPresets() {
    var box = $('presets');
    var keys = Object.keys(PRESETS);
    keys.forEach(function (k, idx) {
      var b = document.createElement('button');
      b.className = 'chip' + (idx === 0 ? ' active' : '');
      b.textContent = k;
      b.onclick = function () {
        var all = box.querySelectorAll('.chip');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
        b.classList.add('active');
        state.preset = k;
        var size = PRESETS[k];
        if (size) {
          state.wmm = size[0]; state.hmm = size[1];
          applyOrientation();
        }
        calc();
      };
      box.appendChild(b);
    });
  })();

  function applyOrientation() {
    var portrait = state.orient === 'portrait';
    $('wmm').value = portrait ? state.wmm : state.hmm;
    $('hmm').value = portrait ? state.hmm : state.wmm;
  }

  var orientBtns = document.querySelectorAll('#orient button');
  for (var oi = 0; oi < orientBtns.length; oi++) {
    orientBtns[oi].addEventListener('click', function () {
      for (var i = 0; i < orientBtns.length; i++) orientBtns[i].classList.remove('active');
      this.classList.add('active');
      state.orient = this.getAttribute('data-o');
      if (state.preset !== 'Свой размер') applyOrientation();
      calc();
    });
  }

  function readDocForm() {
    return {
      wmm: num($('wmm').value, 210),
      hmm: num($('hmm').value, 297),
      bleed: num($('bleed').value, 0),
      safe: num($('safe').value, 5),
      dpi: num($('dpi').value, 300),
      paper: $('paper').value,
      name: $('pname').value.trim(),
      preset: state.preset
    };
  }

  function calc() {
    var f = readDocForm();
    var pageW = f.wmm + 2 * f.bleed;
    var pageH = f.hmm + 2 * f.bleed;
    var px = Math.round(pageW / 25.4 * f.dpi);
    var py = Math.round(pageH / 25.4 * f.dpi);
    $('calc').innerHTML =
      'Кадр: <b>' + round(pageW, 2) + '×' + round(pageH, 2) + ' мм</b> ' +
      (f.bleed ? '(обрез ' + round(f.wmm, 1) + '×' + round(f.hmm, 1) + ' + вылет ' + f.bleed + ' мм)<br>' : '<br>') +
      'Растр при ' + f.dpi + ' dpi: <b>' + px + '×' + py + ' px</b>';
  }

  ['wmm', 'hmm', 'bleed', 'safe', 'dpi', 'paper', 'pname'].forEach(function (id) {
    $(id).addEventListener('input', calc);
    $(id).addEventListener('change', calc);
  });

  $('create').onclick = function () {
    var f = readDocForm();
    if (f.wmm < 5 || f.hmm < 5) { log('Слишком маленький формат', 'err'); return; }
    send({ type: 'create', cfg: f });
  };

  /* --------------------------- вкладка «Экспорт» ------------------------ */

  function currentTarget() {
    var id = $('target').value;
    for (var i = 0; i < state.frames.length; i++) {
      if (state.frames[i].id === id) return state.frames[i];
    }
    return state.frames[0] || null;
  }

  function renderFrames() {
    var sel = $('target');
    var prev = sel.value;
    sel.innerHTML = '';
    if (!state.frames.length) {
      var o = document.createElement('option');
      o.textContent = '— выберите кадр на холсте —';
      o.value = '';
      sel.appendChild(o);
      $('targetInfo').textContent = 'Выделите кадр в Figma или создайте новый на вкладке «Макет».';
      return;
    }
    state.frames.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = (f.selected ? '▸ ' : '') + f.name +
        ' · ' + round(f.spec.pageWmm, 1) + '×' + round(f.spec.pageHmm, 1) + ' мм';
      sel.appendChild(o);
    });
    if (prev && state.frames.some(function (f) { return f.id === prev; })) sel.value = prev;
    renderTargetInfo();
  }

  function renderTargetInfo() {
    var t = currentTarget();
    if (!t) return;
    var dpi = num($('dpi2').value, 300);
    var s = t.spec;
    $('targetInfo').innerHTML =
      'Обрезной формат: <b>' + s.trimWmm + '×' + s.trimHmm + ' мм</b>' +
      (s.bleedMm ? ' · вылет ' + s.bleedMm + ' мм с каждой стороны' : ' · без вылетов') + '<br>' +
      'Страница файла: <b>' + s.pageWmm + '×' + s.pageHmm + ' мм</b> · растр: <b>' +
      Math.round(s.pageWmm / 25.4 * dpi) + '×' + Math.round(s.pageHmm / 25.4 * dpi) + ' px @ ' + dpi + ' dpi</b>';
  }

  $('target').addEventListener('change', function () {
    renderTargetInfo();
    syncGuidesCheckbox();
  });
  $('dpi2').addEventListener('change', renderTargetInfo);

  function syncGuidesCheckbox() {
    var t = currentTarget();
    if (!t) return;
    $('gvis').checked = t.guides !== false;
  }

  $('gvis').addEventListener('change', function () {
    var t = currentTarget();
    if (!t) return;
    var v = $('gvis').checked;
    t.guides = v;
    state.guides[t.id] = v;
    send({ type: 'toggleGuides', targetId: t.id, visible: v });
  });

  function requestExport(kind) {
    if (state.busy) { log('Подождите, идёт экспорт…', 'warn'); return; }
    var all = $('allpages').checked;
    var ids = [];
    if (all && state.frames.length) {
      ids = state.frames.filter(function (f) { return f.marked; }).map(function (f) { return f.id; });
      if (!ids.length) ids = state.frames.map(function (f) { return f.id; });
    } else {
      var t = currentTarget();
      if (!t) { log('Нет выбранного кадра', 'err'); return; }
      ids = [t.id];
    }
    state.busy = true;
    send({
      type: kind === 'png' || kind === 'jpg' ? kind : (kind === 'svg' ? 'svg' : 'pdf'),
      kind: kind,
      ids: ids,
      targetId: ids[0],
      reqId: String(Date.now()),
      dpi: num(kind === 'png' || kind === 'jpg' ? $('dpi2').value : $('dpi2').value, 300),
      outlineText: $('outline').checked,
      cmyk: $('cmyk').checked,
      imgCmyk: $('imgcmyk').checked,
      stripClips: $('clips').value === 'drop'
    });
    log('Экспорт: ' + kind.toUpperCase() + ' · ' + ids.length + ' макет(ов)');
  }

  $('expPdf').onclick = function () { requestExport('pdf'); };
  $('expSvg').onclick = function () { requestExport('svg'); };
  $('expPng').onclick = function () { requestExport('png'); };
  $('expJpg').onclick = function () { requestExport('jpg'); };

  /* ------------------------- обработка ответов -------------------------- */

  window.onmessage = async function (event) {
    var msg = event.data && event.data.pluginMessage;
    if (!msg) return;

    if (msg.type === 'init') {
      state.frames = msg.frames.map(function (f) {
        f.guides = state.guides[f.id] !== false;
        return f;
      });
      renderFrames();
      syncGuidesCheckbox();
      return;
    }

    if (msg.type === 'progress') {
      log('… ' + msg.text);
      return;
    }

    if (msg.type === 'error') {
      state.busy = false;
      log('Ошибка: ' + msg.text, 'err');
      return;
    }

    if (msg.type === 'created') {
      log('Макет создан. Рисуйте внутри кадра.', 'ok');
      return;
    }

    if (msg.type === 'styleCreated') {
      log('Стиль «' + msg.name + '» создан (' + msg.hex + ')', 'ok');
      return;
    }

    if (msg.type === 'svgRaw') {
      try {
        if (msg.kind === 'svg') await doSvgWrite(msg);
        else await doPdfWrite(msg);
      } catch (e) {
        log('Ошибка обработки: ' + (e && e.message ? e.message : e), 'err');
      } finally {
        state.busy = false;
      }
      return;
    }

    if (msg.type === 'raster') {
      try {
        var bytes = b64ToBytes(msg.data);
        var fname = msg.name + (msg.kind === 'jpg' ? '.jpg' : '.png');
        if (download(bytes, fname, msg.kind === 'jpg' ? 'image/jpeg' : 'image/png')) {
          log(fname + ' · ' + msg.width + '×' + msg.height + ' px', 'ok');
        }
      } catch (e) {
        log('Ошибка растра: ' + e.message, 'err');
      } finally {
        state.busy = false;
      }
      return;
    }
  };

  /* ------------------------------ запись -------------------------------- */

  // Имя файла: «[PRINT] A4 210×297мм + 3мм вылет» → «A4_210x297mm_bleed3»
  function pageNameOf(page) {
    var base = String(page.name || 'layout').replace(/^\s*\[PRINT\]\s*/i, '');
    base = base.replace(/×/g, 'x').replace(/\s*\d+(?:[.,]\d+)?x\d+(?:[.,]\d+)?\s*мм.*$/i, '');
    base = safeName(base).replace(/[^0-9A-Za-zА-Яа-яЁё._-]+/g, '_')
      .replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '') || 'layout';
    return base + '_' + page.spec.trimWmm + 'x' + page.spec.trimHmm + 'mm' +
      (page.spec.bleedMm ? '_bleed' + page.spec.bleedMm : '');
  }

  async function doSvgWrite(msg) {
    for (var i = 0; i < msg.pages.length; i++) {
      var page = msg.pages[i];
      var res = SVG.cleanSvgForExport(page.svg, {
        widthMm: page.spec.pageWmm,
        heightMm: page.spec.pageHmm,
        stripClips: $('clips').value === 'drop'
      });
      var fname = pageNameOf(page) + '.svg';
      if (download(res.svg, fname, 'image/svg+xml')) {
        log('SVG ' + fname + ' — ' + res.widthMm + '×' + res.heightMm + ' мм, ' +
          'текст: ' + ($('outline').checked ? 'в кривых' : 'живой'), 'ok');
      }
      for (var n = 0; n < res.notes.length; n++) log('  ' + res.notes[n], 'warn');
    }
  }

  async function doPdfWrite(msg) {
    var pages = msg.pages.map(function (p) {
      return { svg: p.svg, spec: p.spec, title: p.name };
    });
    var built = await PDF.buildPdf(pages, {
      cmyk: $('cmyk').checked,
      imgCmyk: $('imgcmyk').checked,
      stripClips: $('clips').value === 'drop'
    });
    var first = msg.pages[0];
    var fname;
    if (msg.pages.length > 1) {
      fname = 'print_' + msg.pages.length + 'p_' + first.spec.trimWmm + 'x' + first.spec.trimHmm +
        'mm' + (first.spec.bleedMm ? '_bleed' + first.spec.bleedMm : '') + '.pdf';
    } else {
      fname = pageNameOf(first) + '.pdf';
    }
    var kb = Math.round(built.bytes.length / 1024);
    if (download(built.bytes, fname, 'application/pdf')) {
      log('PDF ' + fname + ' · ' + built.stats.pages + ' стр., ' + kb + ' КБ, ' +
        built.stats.shapes + ' фигур, ' + built.stats.images + ' картинок', 'ok');
      log('  страница ' + first.spec.pageWmm + '×' + first.spec.pageHmm +
        ' мм, TrimBox ' + first.spec.trimWmm + '×' + first.spec.trimHmm + ' мм', 'ok');
    }
    for (var i = 0; i < built.warnings.length; i++) log('  ' + built.warnings[i], 'warn');
  }

  /* ---------------------------- вкладка CMYK ---------------------------- */

  function readCmyk() {
    return {
      c: Math.min(Math.max(num($('c').value, 0), 0), 100),
      m: Math.min(Math.max(num($('m').value, 0), 0), 100),
      y: Math.min(Math.max(num($('y').value, 0), 0), 100),
      k: Math.min(Math.max(num($('k').value, 0), 0), 100)
    };
  }

  function hexOf(rgb) {
    return '#' + [rgb[0], rgb[1], rgb[2]].map(function (v) {
      var s = Math.round(v * 255).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('');
  }

  function refreshCmyk() {
    var c = readCmyk();
    var rgb = SVG.cmykToRgb(c.c / 100, c.m / 100, c.y / 100, c.k / 100);
    var hex = hexOf(rgb);
    $('swatch').style.background = hex;
    $('cmykInfo').innerHTML = 'CMYK <b>' + c.c + '/' + c.m + '/' + c.y + '/' + c.k +
      '</b> · RGB для экрана <b>' + hex + '</b>';
  }

  ['c', 'm', 'y', 'k'].forEach(function (id) {
    $(id).addEventListener('input', refreshCmyk);
  });

  (function buildQuick() {
    var box = $('quick');
    QUICK.forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'chip';
      var rgb = SVG.cmykToRgb(q[1] / 100, q[2] / 100, q[3] / 100, q[4] / 100);
      b.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
        'background:' + hexOf(rgb) + ';margin-right:6px"></span>' + q[0];
      b.onclick = function () {
        $('c').value = q[1]; $('m').value = q[2];
        $('y').value = q[3]; $('k').value = q[4];
        refreshCmyk();
      };
      box.appendChild(b);
    });
  })();

  $('mkstyle').onclick = function () {
    send({ type: 'cmykStyle', cmyk: readCmyk() });
  };

  refreshCmyk();
  calc();
  send({ type: 'ready' });
})();
