/* ============================================================================
   Whoosh — Off to Print! — Figma-плагин для подготовки макетов к печати.
   main-поток (этот файл): создаёт кадры нужного формата, экспортирует SVG/PNG.
   UI-поток (ui.html): чистит SVG и собирает PDF.
   ========================================================================== */

var PX_PER_MM = 72 / 25.4; // в Figma 1 «пиксель» = 1 пункт = 1/72 дюйма

figma.showUI(__html__, { width: 470, height: 740, themeColors: true });

/* ------------------------------- утилиты -------------------------------- */

var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64CHARS[b0 >> 2];
    out += B64CHARS[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += (b1 === undefined) ? '=' : B64CHARS[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += (b2 === undefined) ? '=' : B64CHARS[b2 & 63];
  }
  return out;
}

function hexToRgb(hex) {
  var h = String(hex || '#ffffff').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255
  };
}

function safeName(s) {
  return String(s || 'layout').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60);
}

function round(v, d) {
  var m = Math.pow(10, d || 2);
  return Math.round(v * m) / m;
}

/* ------------------------- поиск «печатных» кадров ---------------------- */

function specOf(node) {
  var raw = node.getPluginData('print.spec');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Итоговые размеры для экспорта: считаем от реального размера кадра
function exportSpec(node) {
  var stored = specOf(node);
  var ble = stored && stored.bleedMm ? stored.bleedMm : 0;
  var wmm = node.width * 25.4 / 72;
  var hmm = node.height * 25.4 / 72;
  return {
    pageWmm: round(wmm, 3),
    pageHmm: round(hmm, 3),
    trimWmm: round(wmm - 2 * ble, 3),
    trimHmm: round(hmm - 2 * ble, 3),
    bleedMm: ble,
    safeMm: stored && stored.safeMm ? stored.safeMm : 0,
    dpi: stored && stored.dpi ? stored.dpi : 300,
    preset: stored && stored.preset ? stored.preset : ''
  };
}

function isPrintable(node) {
  return (node.type === 'FRAME' || node.type === 'COMPONENT' ||
    node.type === 'INSTANCE' || node.type === 'SECTION' || node.type === 'GROUP');
}

function listFrames() {
  var out = [];
  var sel = figma.currentPage.selection;
  var seen = {};

  for (var i = 0; i < sel.length; i++) {
    if (!isPrintable(sel[i])) continue;
    seen[sel[i].id] = 1;
    out.push({
      id: sel[i].id, name: sel[i].name, selected: true,
      spec: exportSpec(sel[i]), marked: !!specOf(sel[i])
    });
  }

  var marked = figma.currentPage.findAll(function (n) {
    return n.type === 'FRAME' && !!specOf(n);
  });
  for (var j = 0; j < marked.length; j++) {
    if (seen[marked[j].id]) continue;
    seen[marked[j].id] = 1;
    out.push({
      id: marked[j].id, name: marked[j].name, selected: false,
      spec: exportSpec(marked[j]), marked: true
    });
  }
  return out;
}

function postList() {
  figma.ui.postMessage({ type: 'init', frames: listFrames() });
}

/* --------------------------- создание макета ---------------------------- */

function makeGuide(name, x, y, w, h, color, weight) {
  var r = figma.createRectangle();
  r.name = name;
  r.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  r.x = x; r.y = y;
  r.fills = [];
  r.strokes = [{ type: 'SOLID', color: color }];
  r.strokeWeight = weight;
  r.strokeAlign = 'CENTER';
  r.dashPattern = [6, 4];
  // Метка «это направляющая, в экспорт не пускать». Раньше ориентировались
  // на имя слоя, но рисунок, случайно попавший в слой _GUIDES, тоже исчезал.
  r.setPluginData('print.guide', '1');
  r.locked = true;
  return r;
}

function isGuideNode(node) {
  try {
    if (node.getPluginData && node.getPluginData('print.guide') === '1') return true;
  } catch (e) { /* ignore */ }
  return /^_(TRIM|SAFE|BLEED)\b/.test(node.name || '');
}

function collectGuides(node, acc) {
  var kids = node.children || [];
  for (var i = 0; i < kids.length; i++) {
    if (isGuideNode(kids[i])) acc.push(kids[i]);
    else collectGuides(kids[i], acc);
  }
  return acc;
}

function createPrintFrame(cfg) {
  var wmm = cfg.wmm, hmm = cfg.hmm;
  var bleed = Math.max(0, cfg.bleed || 0);
  var safe = Math.max(0, cfg.safe || 0);
  var dpi = cfg.dpi || 300;

  var w = wmm * PX_PER_MM, h = hmm * PX_PER_MM, b = bleed * PX_PER_MM, s = safe * PX_PER_MM;
  var pageW = w + 2 * b, pageH = h + 2 * b;

  var frame = figma.createFrame();
  var label = (cfg.name && String(cfg.name).trim()) ? String(cfg.name).trim()
    : (cfg.preset || 'Custom') + ' ' + round(wmm, 1) + '×' + round(hmm, 1) + 'мм' +
      (bleed ? ' + ' + bleed + 'мм вылет' : '');
  frame.name = '[PRINT] ' + label;
  frame.resize(pageW, pageH);
  frame.clipsContent = true;
  frame.fills = cfg.paper === 'none' ? [] : [{ type: 'SOLID', color: hexToRgb(cfg.paper || '#ffffff') }];
  frame.x = Math.round(figma.viewport.center.x - pageW / 2);
  frame.y = Math.round(figma.viewport.center.y - pageH / 2);

  var spec = {
    preset: cfg.preset || 'Custom', wmm: round(wmm, 3), hmm: round(hmm, 3),
    bleedMm: bleed, safeMm: safe, dpi: dpi, paper: cfg.paper || '#ffffff'
  };
  frame.setPluginData('print.spec', JSON.stringify(spec));
  frame.exportSettings = [{
    format: 'PNG', suffix: '',
    constraint: { type: 'SCALE', value: dpi / 72 }
  }];

  // Направляющие — отдельные запертые прямоугольники прямо в кадре, а не
  // вложенный фрейм. Вложенный фрейм на весь формат перехватывал рисунок:
  // всё нарисованное попадало внутрь него и потом пряталось при экспорте.
  var weight = Math.max(0.5, Math.round(pageW / 900 * 10) / 10);
  var guideNodes = [
    makeGuide('_TRIM ' + round(wmm, 1) + '×' + round(hmm, 1) + 'мм',
      b, b, w, h, { r: 1, g: 0.1, b: 0.1 }, weight)
  ];
  if (s > 0) {
    guideNodes.push(makeGuide('_SAFE', b + s, b + s,
      Math.max(w - 2 * s, 0.1), Math.max(h - 2 * s, 0.1), { r: 0, g: 0.45, b: 1 }, weight));
  }
  if (bleed > 0) {
    guideNodes.push(makeGuide('_BLEED edge', 0.5, 0.5,
      Math.max(pageW - 1, 0.1), Math.max(pageH - 1, 0.1), { r: 0.9, g: 0.5, b: 0 }, weight));
  }
  // кладём направляющие под рисунок, чтобы они не мешали выделять объекты
  for (var gi = 0; gi < guideNodes.length; gi++) frame.insertChild(gi, guideNodes[gi]);

  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  return frame;
}

/* ------------------------------- экспорт -------------------------------- */

// Что прячем перед экспортом: направляющие и служебные слои «_имя».
// Старые файлы держали направляющие внутри фрейма _GUIDES — теперь внутрь
// такого фрейма заглядываем и прячем только сами направляющие, а рисунок,
// случайно туда попавший, остаётся в экспорте.
function collectHidden(node, acc) {
  var kids = node.children || [];
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i], name = k.name || '';
    if (isGuideNode(k)) { acc.push(k); continue; }
    if (name === '_GUIDES') { collectHidden(k, acc); continue; }
    if (name.charAt(0) === '_') { acc.push(k); continue; }
    collectHidden(k, acc);
  }
  return acc;
}

async function exportSvgClean(node, outlineText) {
  var hide = collectHidden(node, []);
  var prev = [];
  var i;
  for (i = 0; i < hide.length; i++) {
    prev.push(hide[i].visible);
    try { hide[i].visible = false; } catch (e) { /* заблокировано — пропускаем */ }
  }
  var svg = null, err = null;
  try {
    svg = await node.exportAsync({
      format: 'SVG_STRING',
      svgOutlineText: outlineText !== false,
      svgSimplifyStroke: true,
      svgIdAttribute: false
    });
  } catch (e) {
    err = e;
  }
  for (i = 0; i < hide.length; i++) {
    try { hide[i].visible = prev[i]; } catch (e) { /* ignore */ }
  }
  if (err) throw err;
  return svg;
}

async function getNode(id) {
  var nodes;
  try {
    nodes = await figma.getNodeByIdAsync(id);
  } catch (e) {
    nodes = figma.getNodeById(id);
  }
  if (!nodes) throw new Error('Кадр не найден (возможно, удалён)');
  return nodes;
}

async function handleSvgRequest(msg) {
  var pages = [];
  for (var i = 0; i < msg.ids.length; i++) {
    var node = await getNode(msg.ids[i]);
    figma.ui.postMessage({ type: 'progress', text: 'Экспорт «' + node.name + '»…' });
    var svg = await exportSvgClean(node, msg.outlineText);
    pages.push({ name: node.name, svg: svg, spec: exportSpec(node) });
  }
  figma.ui.postMessage({ type: 'svgRaw', reqId: msg.reqId, kind: msg.kind, pages: pages });
}

async function handleRasterRequest(msg) {
  var node = await getNode(msg.targetId);
  var dpi = msg.dpi || 300;
  var spec = exportSpec(node);
  var scale = dpi / 72;

  figma.ui.postMessage({ type: 'progress', text: 'Растр ' + dpi + ' dpi…' });
  var settings = {
    format: msg.kind === 'jpg' ? 'JPG' : 'PNG',
    constraint: { type: 'SCALE', value: scale }
  };
  if (msg.kind === 'jpg') settings.quality = 0.95;

  var bytes = await node.exportAsync(settings);
  var w = Math.round(node.width * scale);
  var h = Math.round(node.height * scale);
  var baseName = safeName(node.name) + '_' +
    spec.trimWmm + 'x' + spec.trimHmm + 'mm_' + dpi + 'dpi';

  var patched;
  try {
    patched = msg.kind === 'jpg' ? patchJpegDpi(bytes, dpi) : patchPngDpi(bytes, dpi);
  } catch (e) {
    patched = bytes;
  }
  // PNG: точный размер берём из IHDR, если он отличается
  try {
    if (msg.kind !== 'jpg') {
      var ihdr = readPngSize(bytes);
      if (ihdr) { w = ihdr.w; h = ihdr.h; }
    }
  } catch (e) { /* ignore */ }

  figma.ui.postMessage({
    type: 'raster', reqId: msg.reqId, kind: msg.kind, name: baseName,
    data: toBase64(patched), width: w, height: h
  });
}

function readPngSize(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  return {
    w: ((bytes[16] << 24) >>> 0) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19],
    h: ((bytes[20] << 24) >>> 0) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23]
  };
}

/* Метки DPI прямо в теле PNG/JPEG (чтобы размер видели Photoshop/Illustrator) */
var CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32bytes(buf) {
  var t = crcTable(), c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunkBytes(type, data) {
  var out = new Uint8Array(12 + data.length);
  var len = data.length;
  out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255;
  out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  var c = crc32bytes(out.subarray(4, 8 + len));
  out[8 + len] = (c >>> 24) & 255; out[9 + len] = (c >>> 16) & 255;
  out[10 + len] = (c >>> 8) & 255; out[11 + len] = c & 255;
  return out;
}
function concatU8(list) {
  var total = 0, i;
  for (i = 0; i < list.length; i++) total += list[i].length;
  var out = new Uint8Array(total), p = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
  return out;
}
function u32be(b, o) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function patchPngDpi(bytes, dpi) {
  if (!bytes || bytes[0] !== 0x89) return bytes;
  var ppu = Math.round(dpi / 0.0254);
  var data = new Uint8Array([
    (ppu >>> 24) & 255, (ppu >>> 16) & 255, (ppu >>> 8) & 255, ppu & 255,
    (ppu >>> 24) & 255, (ppu >>> 16) & 255, (ppu >>> 8) & 255, ppu & 255, 1
  ]);
  var phys = chunkBytes('pHYs', data);
  var out = [bytes.subarray(0, 8)];
  var p = 8, inserted = false;
  while (p + 8 <= bytes.length) {
    var len = u32be(bytes, p);
    var type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    var end = p + 12 + len;
    if (end > bytes.length) break;
    if (type !== 'pHYs') {
      out.push(bytes.subarray(p, end));
      if (type === 'IHDR' && !inserted) { out.push(phys); inserted = true; }
    }
    p = end;
    if (type === 'IEND') break;
  }
  return concatU8(out);
}

function patchJpegDpi(bytes, dpi) {
  if (!bytes || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  var p = 2;
  while (p + 4 < bytes.length) {
    if (bytes[p] !== 0xFF) { p++; continue; }
    var marker = bytes[p + 1];
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
    if (marker === 0xDA || marker === 0xD9) break;
    var len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xE0 && len >= 16) {
      var b = p + 4;
      if (bytes[b] === 0x4A && bytes[b + 1] === 0x46 && bytes[b + 2] === 0x49 &&
        bytes[b + 3] === 0x46 && bytes[b + 4] === 0) {
        var copy = new Uint8Array(bytes);
        copy[b + 7] = 1;
        copy[b + 8] = (dpi >> 8) & 255; copy[b + 9] = dpi & 255;
        copy[b + 10] = (dpi >> 8) & 255; copy[b + 11] = dpi & 255;
        return copy;
      }
    }
    p += 2 + len;
  }
  var app0 = new Uint8Array([
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
    (dpi >> 8) & 255, dpi & 255, (dpi >> 8) & 255, dpi & 255, 0x00, 0x00
  ]);
  var res = new Uint8Array(bytes.length + app0.length);
  res.set(bytes.subarray(0, 2), 0);
  res.set(app0, 2);
  res.set(bytes.subarray(2), 2 + app0.length);
  return res;
}

/* ------------------------------ сообщения ------------------------------- */

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'ready' || msg.type === 'list') {
      postList();
      return;
    }

    if (msg.type === 'create') {
      var frame = createPrintFrame(msg.cfg);
      postList();
      figma.notify('Макет ' + round(msg.cfg.wmm, 1) + '×' + round(msg.cfg.hmm, 1) +
        ' мм создан' + (msg.cfg.bleed ? ' (вылет ' + msg.cfg.bleed + ' мм)' : ''));
      figma.ui.postMessage({ type: 'created', id: frame.id });
      return;
    }

    if (msg.type === 'svg' || msg.type === 'pdf') {
      await handleSvgRequest(msg);
      return;
    }

    if (msg.type === 'png' || msg.type === 'jpg') {
      await handleRasterRequest(msg);
      return;
    }

    if (msg.type === 'toggleGuides') {
      var node = await getNode(msg.targetId);
      var guides = collectGuides(node, []);
      for (var g = 0; g < guides.length; g++) {
        try { guides[g].visible = !!msg.visible; } catch (e) { /* ignore */ }
      }
      if (guides.length) {
        figma.notify(msg.visible ? 'Направляющие включены' : 'Направляющие скрыты');
      } else {
        figma.notify('В этом кадре нет направляющих');
      }
      return;
    }

    if (msg.type === 'focus') {
      var n2 = await getNode(msg.id);
      figma.currentPage.selection = [n2];
      figma.viewport.scrollAndZoomIntoView([n2]);
      return;
    }

    if (msg.type === 'cmykStyle') {
      var c = msg.cmyk;
      var rgb = {
        r: (1 - Math.min(Math.max(c.c, 0), 100) / 100) * (1 - Math.min(Math.max(c.k, 0), 100) / 100),
        g: (1 - Math.min(Math.max(c.m, 0), 100) / 100) * (1 - Math.min(Math.max(c.k, 0), 100) / 100),
        b: (1 - Math.min(Math.max(c.y, 0), 100) / 100) * (1 - Math.min(Math.max(c.k, 0), 100) / 100)
      };
      var style = figma.createPaintStyle();
      style.name = 'CMYK ' + c.c + '/' + c.m + '/' + c.y + '/' + c.k;
      style.paints = [{ type: 'SOLID', color: rgb }];
      figma.notify('Стиль «' + style.name + '» создан. В PDF он выйдет ровно этими CMYK-числами');
      figma.ui.postMessage({
        type: 'styleCreated',
        name: style.name,
        hex: '#' + [rgb.r, rgb.g, rgb.b].map(function (v) {
          var s = Math.round(v * 255).toString(16);
          return s.length < 2 ? '0' + s : s;
        }).join('')
      });
      return;
    }

    if (msg.type === 'notify') {
      figma.notify(msg.text);
      return;
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: (e && e.message) ? e.message : String(e) });
  }
};

figma.on('selectionchange', function () { postList(); });
figma.on('currentpagechange', function () { postList(); });
postList();
