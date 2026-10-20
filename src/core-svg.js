/* ============================================================================
   core-svg.js — разбор SVG (экспорт из Figma) и «чистка» под Illustrator /
   CorelDRAW. Работает и в браузере (Figma UI), и в Node (для автотестов).
   Внешних библиотек нет.
   ========================================================================== */
(function (global) {
  'use strict';

  var MM = 72 / 25.4; // 1 мм в пунктах (и в «пикселях» Figma)

  /* ------------------------------- числа --------------------------------- */

  function fmt(n, p) {
    if (p === undefined) p = 4;
    if (typeof n !== 'number' || !isFinite(n)) n = 0;
    var s = n.toFixed(p);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    return s;
  }
  function mmToPt(mm) { return mm * MM; }
  function ptToMm(pt) { return pt / MM; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ----------------------------- XML-парсер ------------------------------ */

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, g) {
      if (g[0] === '#') {
        var code = (g[1] === 'x' || g[1] === 'X')
          ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        if (isFinite(code) && code > 0 && code < 0x110000) {
          try { return String.fromCodePoint(code); } catch (e) { return m; }
        }
        return m;
      }
      switch (g) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return '\u00a0';
        default: return m;
      }
    });
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(tag, attrs, children) {
    return { tag: tag, attrs: attrs || {}, children: children || [] };
  }

  // Возвращает узел "#doc" со списком детей.
  function parseXml(text) {
    var i = 0, len = text.length;
    var doc = { tag: '#doc', attrs: {}, children: [] };
    var stack = [doc];

    function push(node) { stack[stack.length - 1].children.push(node); }

    while (i < len) {
      var lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (lt > i) {
        var raw = text.slice(i, lt);
        if (raw.trim()) push({ tag: '#text', text: decodeEntities(raw), children: [] });
      }
      if (text[lt + 1] === '/') {
        var gc = text.indexOf('>', lt);
        if (stack.length > 1) stack.pop();
        i = gc < 0 ? len : gc + 1;
        continue;
      }
      if (text.startsWith('<!--', lt)) {
        var ce = text.indexOf('-->', lt + 4); i = ce < 0 ? len : ce + 3; continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        var de = text.indexOf(']]>', lt + 9);
        push({ tag: '#text', text: text.slice(lt + 9, de < 0 ? len : de), children: [] });
        i = de < 0 ? len : de + 3; continue;
      }
      if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
        var ee = text.indexOf(lt < len - 1 && text[lt + 1] === '?' ? '?>' : '>', lt);
        i = ee < 0 ? len : ee + (text[lt + 1] === '?' ? 2 : 1);
        continue;
      }
      var p = lt + 1, selfClose = false;
      while (p < len && !/[\s/>]/.test(text[p])) p++;
      var tag = text.slice(lt + 1, p);
      var attrs = {};
      while (p < len) {
        while (p < len && /\s/.test(text[p])) p++;
        if (text[p] === '/' && text[p + 1] === '>') { selfClose = true; p += 2; break; }
        if (text[p] === '>') { p += 1; break; }
        if (p >= len) break;
        var ns = p;
        while (p < len && !/[\s=/>]/.test(text[p])) p++;
        var name = text.slice(ns, p);
        if (!name) { p++; continue; }
        while (p < len && /\s/.test(text[p])) p++;
        if (text[p] === '=') {
          p++;
          while (p < len && /\s/.test(text[p])) p++;
          var q = text[p];
          if (q === '"' || q === "'") {
            var end = text.indexOf(q, p + 1);
            if (end < 0) end = len;
            attrs[name] = decodeEntities(text.slice(p + 1, end));
            p = end + 1;
          } else {
            var vs = p;
            while (p < len && !/[\s>]/.test(text[p])) p++;
            attrs[name] = decodeEntities(text.slice(vs, p));
          }
        } else {
          attrs[name] = '';
        }
      }
      var node = { tag: tag, attrs: attrs, children: [] };
      push(node);
      if (!selfClose) stack.push(node);
      i = p;
    }
    return doc;
  }

  function serializeXml(doc, pretty) {
    var out = [];
    walk(doc, 0);
    return out.join('');

    function walk(node, depth) {
      if (node.tag === '#text') { out.push(escapeText(node.text)); return; }
      if (node.tag === '#doc') {
        for (var k = 0; k < node.children.length; k++) walk(node.children[k], 0);
        return;
      }
      var keys = Object.keys(node.attrs);
      var a = '';
      for (var j = 0; j < keys.length; j++) {
        var v = node.attrs[keys[j]];
        if (v === undefined || v === null) continue;
        a += ' ' + keys[j] + '="' + escapeAttr(v) + '"';
      }
      var kids = node.children.filter(function (c) {
        return !(c.tag === '#text' && !String(c.text || '').trim());
      });
      if (!kids.length) { out.push('<' + node.tag + a + '/>'); return; }
      out.push('<' + node.tag + a + '>');
      if (pretty && (node.tag === 'svg' || node.tag === 'defs')) out.push('\n');
      for (var m = 0; m < kids.length; m++) walk(kids[m], depth + 1);
      out.push('</' + node.tag + '>');
      if (pretty && (node.tag === 'svg' || node.tag === 'defs')) out.push('\n');
    }
  }

  function findRootSvg(doc) {
    for (var i = 0; i < doc.children.length; i++) {
      var c = doc.children[i];
      if (c.tag === 'svg') return c;
      if (c.tag !== '#text') {
        var inner = findRootSvg(c);
        if (inner) return inner;
      }
    }
    return null;
  }

  /* ----------------------------- матрицы --------------------------------- */

  var IDENT = [1, 0, 0, 1, 0, 0];

  // m, затем n
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  function parseTransform(str) {
    var m = IDENT.slice();
    if (!str) return m;
    var re = /([a-zA-Z]+)\s*\(([^)]*)\)/g, hit;
    while ((hit = re.exec(str))) {
      var name = hit[1];
      var v = hit[2].split(/[\s,]+/).filter(function (s) { return s.length; })
        .map(parseFloat);
      var t = null;
      if (name === 'matrix' && v.length >= 6) t = v.slice(0, 6);
      else if (name === 'translate') t = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      else if (name === 'scale') {
        var sx = v.length ? v[0] : 1, sy = v.length > 1 ? v[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
      } else if (name === 'rotate') {
        var a = (v[0] || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        var rot = [cos, sin, -sin, cos, 0, 0];
        if (v.length >= 3) {
          rot = mul(mul([1, 0, 0, 1, v[1], v[2]], rot), [1, 0, 0, 1, -v[1], -v[2]]);
        }
        t = rot;
      } else if (name === 'skewX') t = [1, 0, Math.tan((v[0] || 0) * Math.PI / 180), 1, 0, 0];
      else if (name === 'skewY') t = [1, Math.tan((v[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      if (t) m = mul(m, t);
    }
    return m;
  }

  function matrixAttr(m) {
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) return '';
    return 'matrix(' + fmt(m[0]) + ' ' + fmt(m[1]) + ' ' + fmt(m[2]) + ' ' +
      fmt(m[3]) + ' ' + fmt(m[4]) + ' ' + fmt(m[5]) + ')';
  }

  /* --------------------------- разбор path d ----------------------------- */

  var NUMS = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

  function parsePath(d) {
    var segs = [];
    if (!d) return segs;
    var i = 0, S = String(d);

    function ws() {
      while (i < S.length && (S[i] === ' ' || S[i] === '\n' || S[i] === '\t' ||
        S[i] === '\r' || S[i] === ',')) i++;
    }
    function num() {
      ws();
      var m = NUMS.exec(S.slice(i, i + 40));
      if (!m) { i++; return NaN; }
      i += m[0].length;
      return parseFloat(m[0]);
    }
    function flag() {
      ws();
      if (S[i] === '0' || S[i] === '1') { var v = S[i] === '1'; i++; return v; }
      return num() !== 0;
    }

    var cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
    var lastC = null, lastQ = null, guard = 0;

    while (i < S.length && guard++ < 2000000) {
      ws();
      if (i >= S.length) break;
      var ch = S[i];
      if (/[a-zA-Z]/.test(ch)) { cmd = ch; i++; }
      else if (cmd === null) break;

      var C = cmd.toUpperCase();
      var rel = cmd !== C;
      var ox = rel ? cx : 0, oy = rel ? cy : 0;
      var x, y, x1, y1, x2, y2, r;

      if (C === 'Z') {
        segs.push({ op: 'Z' });
        cx = sx; cy = sy; lastC = null; lastQ = null; cmd = null;
        continue;
      }
      if (C === 'M') {
        x = num(); y = num();
        cx = ox + x; cy = oy + y; sx = cx; sy = cy;
        segs.push({ op: 'M', x: cx, y: cy });
        cmd = rel ? 'l' : 'L'; lastC = null; lastQ = null;
        continue;
      }
      if (C === 'L') {
        x = num(); y = num(); cx = ox + x; cy = oy + y;
        segs.push({ op: 'L', x: cx, y: cy }); lastC = null; lastQ = null;
        continue;
      }
      if (C === 'H') { x = num(); cx = ox + x; segs.push({ op: 'L', x: cx, y: cy }); lastC = null; lastQ = null; continue; }
      if (C === 'V') { y = num(); cy = oy + y; segs.push({ op: 'L', x: cx, y: cy }); lastC = null; lastQ = null; continue; }

      if (C === 'C') {
        x1 = ox + num(); y1 = oy + num(); x2 = ox + num(); y2 = oy + num();
        x = ox + num(); y = oy + num();
        segs.push({ op: 'C', x1: x1, y1: y1, x2: x2, y2: y2, x: x, y: y });
        lastC = [x2, y2]; lastQ = null; cx = x; cy = y;
        continue;
      }
      if (C === 'S') {
        if (lastC) { x1 = 2 * cx - lastC[0]; y1 = 2 * cy - lastC[1]; } else { x1 = cx; y1 = cy; }
        x2 = ox + num(); y2 = oy + num(); x = ox + num(); y = oy + num();
        segs.push({ op: 'C', x1: x1, y1: y1, x2: x2, y2: y2, x: x, y: y });
        lastC = [x2, y2]; lastQ = null; cx = x; cy = y;
        continue;
      }
      if (C === 'Q') {
        x1 = ox + num(); y1 = oy + num(); x = ox + num(); y = oy + num();
        segs.push({ op: 'C',
          x1: cx + 2 / 3 * (x1 - cx), y1: cy + 2 / 3 * (y1 - cy),
          x2: x + 2 / 3 * (x1 - x), y2: y + 2 / 3 * (y1 - y),
          x: x, y: y });
        lastQ = [x1, y1]; lastC = null; cx = x; cy = y;
        continue;
      }
      if (C === 'T') {
        if (lastQ) { x1 = 2 * cx - lastQ[0]; y1 = 2 * cy - lastQ[1]; } else { x1 = cx; y1 = cy; }
        x = ox + num(); y = oy + num();
        segs.push({ op: 'C',
          x1: cx + 2 / 3 * (x1 - cx), y1: cy + 2 / 3 * (y1 - cy),
          x2: x + 2 / 3 * (x1 - x), y2: y + 2 / 3 * (y1 - y),
          x: x, y: y });
        lastQ = [x1, y1]; lastC = null; cx = x; cy = y;
        continue;
      }
      if (C === 'A') {
        var rx = num(), ry = num(), rot = num();
        var largeArc = flag(), sweep = flag();
        x = ox + num(); y = oy + num();
        arcToSegs(segs, cx, cy, rx, ry, rot, largeArc, sweep, x, y);
        cx = x; cy = y; lastC = null; lastQ = null;
        continue;
      }
      break;
    }
    return segs;
  }

  function arcToSegs(segs, x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
    if (x1 === x2 && y1 === y2) return;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) { segs.push({ op: 'L', x: x2, y: y2 }); return; }
    var phi = phiDeg * Math.PI / 180, cs = Math.cos(phi), sn = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var xp = cs * dx + sn * dy, yp = -sn * dx + cs * dy;
    var lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lam > 1) { var sc = Math.sqrt(lam); rx *= sc; ry *= sc; }
    var num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    var den = rx * rx * yp * yp + ry * ry * xp * xp;
    var co = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
    var cxp = co * (rx * yp / ry), cyp = co * (-ry * xp / rx);
    var cx = cs * cxp - sn * cyp + (x1 + x2) / 2;
    var cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
    var ux = (xp - cxp) / rx, uy = (yp - cyp) / ry;
    var vx = (-xp - cxp) / rx, vy = (-yp - cyp) / ry;
    var t1 = Math.atan2(uy, ux);
    var dt = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
    var d = dt / n, al = 4 / 3 * Math.tan(d / 4);
    var t = t1;
    for (var k = 0; k < n; k++) {
      var c1 = Math.cos(t), s1 = Math.sin(t);
      var c2 = Math.cos(t + d), s2 = Math.sin(t + d);
      var p1x = c1 - al * s1, p1y = s1 + al * c1;
      var p2x = c2 + al * s2, p2y = s2 - al * c2;
      var map = function (px, py) {
        return [cs * rx * px - sn * ry * py + cx, sn * rx * px + cs * ry * py + cy];
      };
      var a1 = map(p1x, p1y), a2 = map(p2x, p2y), a3 = map(c2, s2);
      segs.push({ op: 'C', x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1], x: a3[0], y: a3[1] });
      t += d;
    }
  }

  /* ---------------------- фигуры -> сегменты пути ------------------------ */

  var KAPPA = 0.5522847498307936;

  function num2(a, k, d) {
    if (a[k] === undefined) return d;
    var v = parseFloat(a[k]);
    return isFinite(v) ? v : d;
  }

  function roundRectSegs(x, y, w, h, rx, ry) {
    var s = [];
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    rx = Math.min(Math.abs(rx), w / 2); ry = Math.min(Math.abs(ry), h / 2);
    if (!rx && !ry) {
      s.push({ op: 'M', x: x, y: y }, { op: 'L', x: x + w, y: y },
        { op: 'L', x: x + w, y: y + h }, { op: 'L', x: x, y: y + h }, { op: 'Z' });
      return s;
    }
    var kx = rx * (1 - KAPPA), ky = ry * (1 - KAPPA);
    s.push({ op: 'M', x: x + rx, y: y });
    s.push({ op: 'L', x: x + w - rx, y: y });
    s.push({ op: 'C', x1: x + w - kx, y1: y, x2: x + w, y2: y + ky, x: x + w, y: y + ry });
    s.push({ op: 'L', x: x + w, y: y + h - ry });
    s.push({ op: 'C', x1: x + w, y1: y + h - ky, x2: x + w - kx, y2: y + h, x: x + w - rx, y: y + h });
    s.push({ op: 'L', x: x + rx, y: y + h });
    s.push({ op: 'C', x1: x + kx, y1: y + h, x2: x, y2: y + h - ky, x: x, y: y + h - ry });
    s.push({ op: 'L', x: x, y: y + ry });
    s.push({ op: 'C', x1: x, y1: y + ky, x2: x + kx, y2: y, x: x + rx, y: y });
    s.push({ op: 'Z' });
    return s;
  }

  function ellipseSegs(cx, cy, rx, ry) {
    var s = [];
    var kx = rx * KAPPA, ky = ry * KAPPA;
    s.push({ op: 'M', x: cx + rx, y: cy });
    s.push({ op: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry });
    s.push({ op: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy });
    s.push({ op: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry });
    s.push({ op: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy });
    s.push({ op: 'Z' });
    return s;
  }

  function shapeToSegs(node) {
    var a = node.attrs || {};
    switch (node.tag) {
      case 'path':
        return parsePath(a.d || '');
      case 'rect': {
        var x = num2(a, 'x', 0), y = num2(a, 'y', 0);
        var w = num2(a, 'width', 0), h = num2(a, 'height', 0);
        var rx = num2(a, 'rx', NaN), ry = num2(a, 'ry', NaN);
        if (isNaN(rx) && isNaN(ry)) { rx = 0; ry = 0; }
        else if (isNaN(rx)) rx = ry;
        else if (isNaN(ry)) ry = rx;
        if (w <= 0 || h <= 0) return [];
        return roundRectSegs(x, y, w, h, rx, ry);
      }
      case 'circle': {
        var r = num2(a, 'r', 0);
        if (r <= 0) return [];
        return ellipseSegs(num2(a, 'cx', 0), num2(a, 'cy', 0), r, r);
      }
      case 'ellipse': {
        var ex = num2(a, 'cx', 0), ey = num2(a, 'cy', 0);
        var erx = num2(a, 'rx', 0), ery = num2(a, 'ry', 0);
        if (erx <= 0 || ery <= 0) return [];
        return ellipseSegs(ex, ey, erx, ery);
      }
      case 'line':
        return [{ op: 'M', x: num2(a, 'x1', 0), y: num2(a, 'y1', 0) },
          { op: 'L', x: num2(a, 'x2', 0), y: num2(a, 'y2', 0) }];
      case 'polyline':
      case 'polygon': {
        var pts = String(a.points || '').split(/[\s,]+/).filter(function (s) { return s.length; })
          .map(parseFloat);
        if (pts.length < 4) return [];
        var segs = [{ op: 'M', x: pts[0], y: pts[1] }];
        for (var i = 2; i + 1 < pts.length; i += 2) segs.push({ op: 'L', x: pts[i], y: pts[i + 1] });
        if (node.tag === 'polygon') segs.push({ op: 'Z' });
        return segs;
      }
    }
    return null;
  }

  /* ------------------------------- цвета --------------------------------- */

  var NAMED = {
    black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00',
    blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
    silver: '#c0c0c0', gray: '#808080', grey: '#808080', maroon: '#800000',
    olive: '#808000', green: '#008000', purple: '#800080', teal: '#008080',
    navy: '#000080', orange: '#ffa500', pink: '#ffc0cb'
  };

  // -> {r,g,b,a} в 0..1, либо {gradient:'id'}, либо null
  function parseColor(value, opacity) {
    if (value === undefined || value === null) return null;
    var s = String(value).trim();
    if (!s) return null;
    var low = s.toLowerCase();
    if (low === 'none' || low === 'transparent') return null;
    var gm = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/.exec(s);
    if (gm) return { gradient: gm[1] };
    if (low[0] === '#') {
      var h = low.slice(1);
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      if (h.length === 6 || h.length === 8) {
        var r = parseInt(h.slice(0, 2), 16) / 255;
        var g = parseInt(h.slice(2, 4), 16) / 255;
        var b = parseInt(h.slice(4, 6), 16) / 255;
        var al = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return { r: r, g: g, b: b, a: al * (opacity === undefined ? 1 : opacity) };
      }
      return null;
    }
    if (low.indexOf('rgb') === 0) {
      var mm = /rgba?\(([^)]+)\)/.exec(low);
      if (mm) {
        var parts = mm[1].split(/[\s,\/]+/).filter(function (x) { return x.length; });
        var f = function (t) { return t.indexOf('%') >= 0 ? parseFloat(t) / 100 : parseFloat(t) / 255; };
        return {
          r: f(parts[0]), g: f(parts[1]), b: f(parts[2]),
          a: (parts[3] !== undefined ? parseFloat(parts[3]) : 1) * (opacity === undefined ? 1 : opacity)
        };
      }
    }
    if (NAMED[low]) return parseColor(NAMED[low], opacity);
    return null;
  }

  // наивная (без ICC) конверсия sRGB -> CMYK, как в большинстве RIP-ов
  function rgbToCmyk(r, g, b) {
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
    var k = 1 - Math.max(r, g, b);
    if (k >= 1) return [0, 0, 0, 1];
    var d = 1 - k;
    return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
  }
  function cmykToRgb(c, m, y, k) {
    return [(1 - clamp(c, 0, 1)) * (1 - clamp(k, 0, 1)),
      (1 - clamp(m, 0, 1)) * (1 - clamp(k, 0, 1)),
      (1 - clamp(y, 0, 1)) * (1 - clamp(k, 0, 1))];
  }

  /* ------------------------- чистка SVG для AI/CDR ------------------------ */

  var KEEP_ATTRS = {
    fill: 1, 'fill-opacity': 1, 'fill-rule': 1, 'clip-rule': 1,
    stroke: 1, 'stroke-width': 1, 'stroke-opacity': 1, 'stroke-linecap': 1,
    'stroke-linejoin': 1, 'stroke-miterlimit': 1, 'stroke-dasharray': 1,
    'stroke-dashoffset': 1, 'vector-effect': 1,
    opacity: 1, transform: 1, display: 1,
    d: 1, x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, width: 1, height: 1,
    rx: 1, ry: 1, cx: 1, cy: 1, r: 1, points: 1,
    'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1,
    'font-variant': 1, 'letter-spacing': 1, 'word-spacing': 1,
    'text-anchor': 1, 'text-decoration': 1, 'xml:space': 1,
    'xlink:href': 1, href: 1, preserveAspectRatio: 1,
    offset: 1, 'stop-color': 1, 'stop-opacity': 1,
    gradientUnits: 1, gradientTransform: 1, spreadMethod: 1,
    fx: 1, fy: 1, fr: 1, 'maskUnits': 1, 'maskContentUnits': 1,
    clipPathUnits: 1, 'clip-path': 1, mask: 1,
    patternUnits: 1, patternContentUnits: 1, patternTransform: 1, viewBox: 1
  };

  // CSS из атрибута style. Figma обычно пишет presentation-атрибуты, но
  // вставленный извне SVG может нести всё в style — иначе фигуры «исчезают».
  var STYLE_MAP = {
    fill: 'fill', stroke: 'stroke', opacity: 'opacity', display: 'display',
    'fill-opacity': 'fill-opacity', 'stroke-opacity': 'stroke-opacity',
    'stroke-width': 'stroke-width', 'stroke-linecap': 'stroke-linecap',
    'stroke-linejoin': 'stroke-linejoin', 'stroke-miterlimit': 'stroke-miterlimit',
    'stroke-dasharray': 'stroke-dasharray', 'stroke-dashoffset': 'stroke-dashoffset',
    'fill-rule': 'fill-rule', 'font-family': 'font-family', 'font-size': 'font-size',
    'font-weight': 'font-weight', 'font-style': 'font-style',
    'text-anchor': 'text-anchor', 'letter-spacing': 'letter-spacing',
    'paint-order': 'paint-order'
  };

  function parseStyle(value) {
    var out = {};
    if (!value) return out;
    var parts = String(value).split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], c = p.indexOf(':');
      if (c < 0) continue;
      var k = p.slice(0, c).trim().toLowerCase();
      var v = p.slice(c + 1).trim();
      if (STYLE_MAP[k] && v) out[STYLE_MAP[k]] = v;
    }
    return out;
  }

  var DROP_TAGS = {
    clipPath: 1, mask: 1, filter: 1, pattern: 1, marker: 1, style: 1,
    metadata: 1, title: 1, desc: 1, symbol: 1, use: 1, foreignObject: 1,
    switch: 1, script: 1, linearGradient: 1, radialGradient: 1, stop: 1
  };

  function parseViewBox(root) {
    var vb = root.attrs && root.attrs.viewBox;
    if (vb) {
      var p = String(vb).replace(/,/g, ' ').trim().split(/\s+/).map(parseFloat);
      if (p.length === 4 && isFinite(p[2]) && isFinite(p[3]) && p[2] > 0 && p[3] > 0) {
        return { x: p[0], y: p[1], w: p[2], h: p[3] };
      }
    }
    var w = parseFloat(root.attrs && root.attrs.width) || 0;
    var h = parseFloat(root.attrs && root.attrs.height) || 0;
    return { x: 0, y: 0, w: w, h: h };
  }

  function collectDefs(node, acc) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      var id = c.attrs && c.attrs.id;
      if (c.tag === 'linearGradient' || c.tag === 'radialGradient') {
        if (id) acc.gradients[id] = c;
      } else if (c.tag === 'clipPath') {
        if (id) acc.clipPaths[id] = c;
      } else if (c.tag === 'mask') {
        if (id) acc.masks[id] = c;
      } else if (c.tag === 'pattern') {
        if (id) (acc.patterns || (acc.patterns = {}))[id] = c;
      } else if (c.tag === 'image') {
        if (id) (acc.images || (acc.images = {}))[id] = c;
      }
      if (c.children && c.children.length) collectDefs(c, acc);
    }
  }

  function refId(v) {
    var m = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/.exec(String(v || '').trim());
    return m ? m[1] : null;
  }

  // Грубая проверка: обрезка покрывает весь холст (такую можно просто выкинуть)
  function clipIsFullPage(clipNode, vb) {
    var kids = clipNode.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.tag === 'rect' && !c.attrs.rx) {
        var x = num2(c.attrs, 'x', 0), y = num2(c.attrs, 'y', 0);
        var w = num2(c.attrs, 'width', 0), h = num2(c.attrs, 'height', 0);
        var tol = Math.max(vb.w, vb.h) * 0.01;
        if (x <= vb.x + tol && y <= vb.y + tol &&
          x + w >= vb.x + vb.w - tol && y + h >= vb.y + vb.h - tol) return true;
      }
    }
    return false;
  }

  function cleanSvgForExport(svgText, opts) {
    opts = opts || {};
    var stripClips = opts.stripClips !== false;
    var doc = parseXml(svgText);
    var root = findRootSvg(doc);
    if (!root) throw new Error('В SVG от Figma не найден корневой тег <svg>');

    var vb = parseViewBox(root);
    var defs = { gradients: {}, clipPaths: {}, masks: {}, patterns: {}, images: {} };
    collectDefs(root, defs);

    var stats = { clips: 0, filters: 0, masks: 0, texts: 0, drawable: 0 };
    var notes = [];
    var usedDefs = { clips: {}, masks: {}, patterns: {} };

    function cleanAttrs(node) {
      var attrs = {}, src = node.attrs || {}, keys = Object.keys(src);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = src[k];
        if (k === 'style') continue;
        if (!KEEP_ATTRS[k]) continue;
        if (k === 'stroke-dasharray' && v === 'none') continue;
        if (k === 'display' && v !== 'none') continue;
        attrs[k] = v;
      }
      // style перекрывает presentation-атрибуты
      if (src.style) {
        if (/white-space\s*:\s*pre/.test(src.style)) attrs['xml:space'] = 'preserve';
        var sp = parseStyle(src.style);
        for (var sk in sp) {
          if (!KEEP_ATTRS[sk]) continue;
          if (sk === 'stroke-dasharray' && sp[sk] === 'none') continue;
          if (sk === 'display' && sp[sk] !== 'none') continue;
          attrs[sk] = sp[sk];
        }
      }
      return attrs;
    }

    function cleanNode(node, ctx) {
      if (node.tag === '#text') return [node];
      var tag = node.tag;
      if (tag === 'svg') return [];
      if (tag === 'defs') return [];
      if (DROP_TAGS[tag]) {
        if (tag === 'use' || tag === 'foreignObject') {
          notes.push('Пропущен элемент <' + tag + '> (не поддерживается)');
        }
        return [];
      }
      var attrs = cleanAttrs(node);

      // заливка/обводка картинкой через <pattern> — помечаем, чтобы перенести defs
      var paintId = refId(attrs.fill);
      if (paintId && defs.patterns[paintId]) usedDefs.patterns[paintId] = 1;
      paintId = refId(attrs.stroke);
      if (paintId && defs.patterns[paintId]) usedDefs.patterns[paintId] = 1;

      if (attrs['filter']) { stats.filters++; delete attrs['filter']; }
      if (attrs['mask']) {
        if (stripClips) { stats.masks++; delete attrs['mask']; }
        else { var umid = refId(attrs['mask']); if (umid) usedDefs.masks[umid] = 1; }
      }
      if (attrs['clip-path']) {
        var cid = refId(attrs['clip-path']);
        var cn = cid ? defs.clipPaths[cid] : null;
        if (stripClips || (cn && clipIsFullPage(cn, vb))) {
          if (!(cn && clipIsFullPage(cn, vb))) stats.clips++;
          delete attrs['clip-path'];
        } else if (cid) {
          usedDefs.clips[cid] = 1;
        }
      }

      var children = [];
      for (var i = 0; i < node.children.length; i++) {
        var res = cleanNode(node.children[i], ctx);
        for (var j = 0; j < res.length; j++) children.push(res[j]);
      }

      if (tag === 'text') stats.texts++;
      if (/^(path|rect|circle|ellipse|polygon|polyline|line|image|text)$/.test(tag)) stats.drawable++;

      // прозрачные группы-обёртки разворачиваем
      if (tag === 'g' && !Object.keys(attrs).length) return children;

      var out = { tag: tag, attrs: attrs, children: children };
      if (tag === 'image') out.children = [];
      return [out];
    }

    var kids = [];
    for (var i = 0; i < root.children.length; i++) {
      var r = cleanNode(root.children[i], {});
      for (var j = 0; j < r.length; j++) kids.push(r[j]);
    }

    // градиенты оставляем (Illustrator и CorelDRAW их понимают)
    var gradNodes = [];
    var gkeys = Object.keys(defs.gradients);
    for (var gi = 0; gi < gkeys.length; gi++) {
      var g = defs.gradients[gkeys[gi]];
      var gc = { tag: g.tag, attrs: cleanAttrs(g), children: [] };
      gc.attrs.id = gkeys[gi];
      for (var si = 0; si < g.children.length; si++) {
        var st = g.children[si];
        if (st.tag === 'stop') gc.children.push({ tag: 'stop', attrs: cleanAttrs(st), children: [] });
      }
      gradNodes.push(gc);
    }

    // обтравочные контуры и маски оставляем только по требованию
    var SHAPE_TAGS = { path: 1, rect: 1, circle: 1, ellipse: 1, polygon: 1, polyline: 1, line: 1, g: 1, image: 1, use: 1 };
    function copyDef(node) {
      var attrs = cleanAttrs(node);
      if (node.attrs && node.attrs.id) attrs.id = node.attrs.id;
      var kids = [];
      for (var q = 0; q < (node.children || []).length; q++) {
        var c = node.children[q];
        if (c.tag === '#text' || !SHAPE_TAGS[c.tag]) continue;
        kids.push(copyDef(c));
      }
      return { tag: node.tag, attrs: attrs, children: kids };
    }

    // Картинки, на которые ссылаются pattern'ы (Figma так экспортирует
    // image-fill у фигур): переносим сам pattern и вложенный <image>.
    var patKeys = Object.keys(usedDefs.patterns);
    var usedImages = {};
    function collectImageRefs(node) {
      var kids = node.children || [];
      for (var q = 0; q < kids.length; q++) {
        var c = kids[q];
        var href = c.attrs && (c.attrs['xlink:href'] || c.attrs.href);
        if (href && String(href).charAt(0) === '#') {
          var hid = String(href).slice(1);
          if (defs.images[hid]) usedImages[hid] = 1;
        }
        collectImageRefs(c);
      }
    }
    for (var pi = 0; pi < patKeys.length; pi++) {
      var pat = defs.patterns[patKeys[pi]];
      if (!pat) continue;
      gradNodes.push(copyDef(pat));
      collectImageRefs(pat);
    }
    var imgKeys = Object.keys(usedImages);
    for (var ii = 0; ii < imgKeys.length; ii++) {
      gradNodes.push(copyDef(defs.images[imgKeys[ii]]));
    }

    if (!stripClips) {
      var ck = Object.keys(usedDefs.clips);
      for (var ci = 0; ci < ck.length; ci++) {
        if (defs.clipPaths[ck[ci]]) gradNodes.push(copyDef(defs.clipPaths[ck[ci]]));
      }
      var mk = Object.keys(usedDefs.masks);
      for (var mi = 0; mi < mk.length; mi++) {
        if (defs.masks[mk[mi]]) gradNodes.push(copyDef(defs.masks[mk[mi]]));
      }
    }

    var vbW = vb.w || 1, vbH = vb.h || 1;
    var widthMm = opts.widthMm || ptToMm(vbW);
    var heightMm = opts.heightMm || ptToMm(vbH);

    var rootAttrs = {
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      version: '1.1',
      width: fmt(widthMm, 3) + 'mm',
      height: fmt(heightMm, 3) + 'mm',
      viewBox: fmt(vb.x) + ' ' + fmt(vb.y) + ' ' + fmt(vbW) + ' ' + fmt(vbH),
      fill: 'none',
      'shape-rendering': 'geometricPrecision'
    };

    var newRoot = { tag: 'svg', attrs: rootAttrs, children: [] };
    if (gradNodes.length) newRoot.children.push({ tag: 'defs', attrs: {}, children: gradNodes });
    for (var k = 0; k < kids.length; k++) newRoot.children.push(kids[k]);

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializeXml(newRoot, true) + '\n';

    if (stats.clips) {
      notes.push('Убрано clip-масок: ' + stats.clips + ' (для Illustrator). ' +
        'Если что-то вылезло за пределы блока — выключите «Сохранять обрезку».');
    }
    if (stats.masks) notes.push('Убрано масок: ' + stats.masks);
    if (stats.filters) notes.push('Убрано эффектов (тень/блюр): ' + stats.filters);
    if (!stats.drawable) {
      notes.push('В SVG нет видимых фигур: похоже, рисунок лежит вне кадра ' +
        'или скрыт. Проверьте, что объекты вложены в печатный кадр.');
    }

    return { svg: xml, notes: notes, stats: stats, viewBox: vb, widthMm: widthMm, heightMm: heightMm };
  }

  global.PrintSvg = {
    MM: MM,
    fmt: fmt,
    mmToPt: mmToPt,
    ptToMm: ptToMm,
    clamp: clamp,
    parseXml: parseXml,
    serializeXml: serializeXml,
    findRootSvg: findRootSvg,
    parseViewBox: parseViewBox,
    parseTransform: parseTransform,
    matrixAttr: matrixAttr,
    mul: mul,
    apply: apply,
    parsePath: parsePath,
    shapeToSegs: shapeToSegs,
    parseColor: parseColor,
    parseStyle: parseStyle,
    rgbToCmyk: rgbToCmyk,
    cmykToRgb: cmykToRgb,
    refId: refId,
    collectDefs: collectDefs,
    cleanSvgForExport: cleanSvgForExport,
    KEEP_ATTRS: KEEP_ATTRS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
