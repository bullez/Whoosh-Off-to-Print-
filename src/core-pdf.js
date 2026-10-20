/* ============================================================================
   core-pdf.js — сборка PDF: чистый вектор, DeviceCMYK, TrimBox/BleedBox.
   Вход — SVG-строка от Figma (или её разобранное дерево).
   Внешних библиотек нет: PDF собирается «руками», картинки встраиваются как
   есть (PNG распаковывается встроенным DecompressionStream, JPEG — без
   перекодирования).
   ========================================================================== */
(function (global) {
  'use strict';

  var S = global.PrintSvg;
  var fmt = S.fmt, mul = S.mul, apply = S.apply, mmToPt = S.mmToPt;

  /* ---------------------------- байты/утилиты ---------------------------- */

  function ascii(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function b64ToBytes(b64) {
    var clean = String(b64).replace(/\s+/g, '');
    if (typeof atob === 'function') {
      var bin = atob(clean);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    /* istanbul ignore next */
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    throw new Error('Нет base64-декодера');
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    var cs = new CompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function u32(b, o) {
    return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  }
  function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  /* ------------------------------- PDF-документ -------------------------- */

  function PdfDoc() { this.objs = []; }

  PdfDoc.prototype.add = function (dict, stream) {
    this.objs.push({ dict: dict, stream: stream });
    return this.objs.length;
  };
  PdfDoc.prototype.reserve = function () { this.objs.push(null); return this.objs.length; };
  PdfDoc.prototype.set = function (n, dict, stream) { this.objs[n - 1] = { dict: dict, stream: stream }; };

  PdfDoc.prototype.toBytes = function (rootRef, infoRef) {
    var chunks = [], len = 0;
    function push(x) {
      var b = typeof x === 'string' ? ascii(x) : x;
      chunks.push(b); len += b.length;
    }
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    var offs = [];
    for (var i = 0; i < this.objs.length; i++) {
      var o = this.objs[i];
      offs[i] = len;
      push((i + 1) + ' 0 obj\n');
      if (!o) throw new Error('PDF: пустой объект ' + (i + 1));
      if (o.stream === undefined) {
        push(o.dict + '\nendobj\n');
      } else {
        var d = o.dict.replace(/\s*>>$/, '');
        push(d + ' /Length ' + o.stream.length + ' >>\nstream\n');
        push(o.stream);
        push('\nendstream\nendobj\n');
      }
    }

    var xrefPos = len;
    var n = this.objs.length + 1;
    var xref = 'xref\n0 ' + n + '\n0000000000 65535 f \n';
    for (var j = 0; j < offs.length; j++) {
      xref += ('0000000000' + offs[j]).slice(-10) + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + n + ' /Root ' + rootRef + ' 0 R' +
      (infoRef ? ' /Info ' + infoRef + ' 0 R' : '') + ' >>\n');
    push('startxref\n' + xrefPos + '\n%%EOF\n');

    var total = 0;
    for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (var m = 0; m < chunks.length; m++) { out.set(chunks[m], p); p += chunks[m].length; }
    return out;
  };

  function pdfString(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 126 || c < 32) out += '?';
      else if (c === 40 || c === 41 || c === 92) out += '\\' + s[i];
      else out += s[i];
    }
    return '(' + out + ')';
  }

  function pdfDate(d) {
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    return 'D:' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }

  /* -------------------------------- PNG ---------------------------------- */

  function isPng(bytes) {
    return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4E && bytes[3] === 0x47;
  }

  function pngInfo(bytes) {
    if (!isPng(bytes)) return null;
    var p = 8, info = { idat: [], palette: null, trns: null };
    while (p + 8 <= bytes.length) {
      var len = u32(bytes, p);
      var type = str4(bytes, p + 4);
      var data = bytes.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        info.w = u32(data, 0); info.h = u32(data, 4);
        info.depth = data[8]; info.colorType = data[9];
        info.interlace = data[12];
      } else if (type === 'IDAT') info.idat.push(data);
      else if (type === 'PLTE') info.palette = data;
      else if (type === 'tRNS') info.trns = data;
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    return info.w ? info : null;
  }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), p = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
    return out;
  }

  function paeth(a, b, c) {
    var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  // -> {w,h,rgba:Uint8Array} (всегда RGB или RGBA, 8 бит)
  async function decodePng(bytes) {
    var info = pngInfo(bytes);
    if (!info) return null;
    if (info.interlace) throw new Error('Чересстрочный PNG не поддерживается');
    if (info.depth !== 8 && info.depth !== 16) {
      if (info.depth === 1 || info.depth === 2 || info.depth === 4) { /* обработаем ниже */ }
      else throw new Error('PNG: неподдерживаемая битность ' + info.depth);
    }
    var raw = await inflate(concatBytes(info.idat));
    if (!raw) throw new Error('Браузер не умеет распаковывать PNG (нет DecompressionStream)');

    var ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[info.colorType];
    if (!ch) throw new Error('PNG: неизвестный тип цвета');
    var depth = info.depth;
    var bitsPerPixel = ch * depth;
    var bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    var stride = Math.ceil((info.w * bitsPerPixel) / 8);
    var out = new Uint8Array(info.w * info.h * 4);

    var prev = new Uint8Array(stride);
    var cur = new Uint8Array(stride);
    var p = 0;

    for (var y = 0; y < info.h; y++) {
      var ft = raw[p++];
      cur.set(raw.subarray(p, p + stride)); p += stride;
      for (var i = 0; i < stride; i++) {
        var a = i >= bpp ? cur[i - bpp] : 0;
        var b = prev[i];
        var c = i >= bpp ? prev[i - bpp] : 0;
        var v = cur[i];
        if (ft === 1) v = (v + a) & 255;
        else if (ft === 2) v = (v + b) & 255;
        else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
        else if (ft === 4) v = (v + paeth(a, b, c)) & 255;
        cur[i] = v;
      }

      for (var x = 0; x < info.w; x++) {
        var r = 0, g = 0, bl = 0, al = 255, idx = y * info.w + x;
        if (info.colorType === 2) {
          r = cur[x * 3]; g = cur[x * 3 + 1]; bl = cur[x * 3 + 2];
        } else if (info.colorType === 6) {
          r = cur[x * 4]; g = cur[x * 4 + 1]; bl = cur[x * 4 + 2]; al = cur[x * 4 + 3];
        } else if (info.colorType === 0) {
          if (depth === 16) { r = g = bl = cur[x * 2]; }
          else if (depth === 8) { r = g = bl = cur[x]; }
          else {
            var bitPos = x * depth;
            var byteI = bitPos >> 3;
            var shift = 8 - depth - (bitPos & 7);
            var val = (cur[byteI] >> shift) & ((1 << depth) - 1);
            r = g = bl = Math.round(val * 255 / ((1 << depth) - 1));
          }
        } else if (info.colorType === 4) {
          r = g = bl = cur[x * 2]; al = cur[x * 2 + 1];
        } else if (info.colorType === 3) {
          var pi = cur[x];
          if (info.palette && pi * 3 + 2 < info.palette.length) {
            r = info.palette[pi * 3]; g = info.palette[pi * 3 + 1]; bl = info.palette[pi * 3 + 2];
          }
          if (info.trns && pi < info.trns.length) al = info.trns[pi];
        }
        out[idx * 4] = r; out[idx * 4 + 1] = g; out[idx * 4 + 2] = bl; out[idx * 4 + 3] = al;
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return { w: info.w, h: info.h, rgba: out };
  }

  function jpegInfo(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    var p = 2;
    while (p + 4 < bytes.length) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      var marker = bytes[p + 1];
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
      var len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: (bytes[p + 5] << 8) | bytes[p + 6], w: (bytes[p + 7] << 8) | bytes[p + 8], comps: bytes[p + 9] };
      }
      p += 2 + len;
    }
    return { w: 1, h: 1, comps: 3 };
  }

  /* ------------------------------ ресурсы -------------------------------- */

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i += 7) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '_' + s.length;
  }

  function addXObject(doc, dict, stream) { return doc.add(dict, stream); }

  async function buildImage(ctx, bytes, mime) {
    var doc = ctx.doc;

    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      var ji = jpegInfo(bytes);
      var comps = ji ? ji.comps : 3;
      var cs = comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      var extra = comps === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
      var ref = addXObject(doc, '<< /Type /XObject /Subtype /Image /Width ' + (ji ? ji.w : 1) +
        ' /Height ' + (ji ? ji.h : 1) + ' /ColorSpace ' + cs +
        ' /BitsPerComponent 8 /Filter /DCTDecode' + extra + ' >>', bytes);
      return { ref: ref, w: ji ? ji.w : 1, h: ji ? ji.h : 1 };
    }

    var png = await decodePng(bytes);
    if (!png) return null;
    var n = png.w * png.h;
    var hasAlpha = false, i;
    for (i = 0; i < n; i++) { if (png.rgba[i * 4 + 3] !== 255) { hasAlpha = true; break; } }

    var comps = ctx.imgCmyk ? 4 : 3;
    var color = new Uint8Array(n * comps);
    for (i = 0; i < n; i++) {
      var r = png.rgba[i * 4] / 255, g = png.rgba[i * 4 + 1] / 255, b = png.rgba[i * 4 + 2] / 255;
      if (comps === 4) {
        var k = S.rgbToCmyk(r, g, b);
        color[i * 4] = Math.round(k[0] * 255);
        color[i * 4 + 1] = Math.round(k[1] * 255);
        color[i * 4 + 2] = Math.round(k[2] * 255);
        color[i * 4 + 3] = Math.round(k[3] * 255);
      } else {
        color[i * 3] = png.rgba[i * 4];
        color[i * 3 + 1] = png.rgba[i * 4 + 1];
        color[i * 3 + 2] = png.rgba[i * 4 + 2];
      }
    }

    var colorStream = await deflate(color);
    var filter = '/FlateDecode';
    if (!colorStream) { colorStream = color; filter = ''; }

    var smaskRef = 0;
    if (hasAlpha) {
      var alpha = new Uint8Array(n);
      for (i = 0; i < n; i++) alpha[i] = png.rgba[i * 4 + 3];
      var aStream = await deflate(alpha);
      var aFilter = '/FlateDecode';
      if (!aStream) { aStream = alpha; aFilter = ''; }
      smaskRef = addXObject(doc, '<< /Type /XObject /Subtype /Image /Width ' + png.w +
        ' /Height ' + png.h + ' /ColorSpace /DeviceGray /BitsPerComponent 8 ' +
        (aFilter ? '/Filter ' + aFilter + ' ' : '') + '>>', aStream);
    }

    var ref = addXObject(doc, '<< /Type /XObject /Subtype /Image /Width ' + png.w +
      ' /Height ' + png.h + ' /ColorSpace ' + (comps === 4 ? '/DeviceCMYK' : '/DeviceRGB') +
      ' /BitsPerComponent 8 ' + (filter ? '/Filter ' + filter + ' ' : '') +
      (smaskRef ? '/SMask ' + smaskRef + ' 0 R ' : '') + '>>', colorStream);

    return { ref: ref, w: png.w, h: png.h };
  }

  async function getImage(ctx, dataUri) {
    var key = hashStr(dataUri);
    if (ctx.imgCache[key]) return ctx.imgCache[key];
    var m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUri);
    if (!m) return null;
    var mime = m[1].toLowerCase();
    var payload = m[3];
    var bytes = m[2] ? b64ToBytes(payload) : null;
    if (!bytes) {
      var decoded = decodeURIComponent(payload);
      bytes = new Uint8Array(decoded.length);
      for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    }
    try {
      var img = await buildImage(ctx, bytes, mime);
      ctx.imgCache[key] = img;
      return img;
    } catch (e) {
      ctx.warn('Картинка пропущена: ' + e.message);
      return null;
    }
  }

  function getGs(ctx, fillA, strokeA) {
    fillA = Math.round(S.clamp(fillA, 0, 1) * 1000) / 1000;
    strokeA = Math.round(S.clamp(strokeA, 0, 1) * 1000) / 1000;
    if (fillA >= 1 && strokeA >= 1) return null;
    var key = fillA + ':' + strokeA;
    if (!ctx.gsMap) ctx.gsMap = {};
    if (ctx.gsMap[key]) return ctx.gsMap[key];
    var name = 'GS' + (ctx.nGs++);
    var ref = ctx.doc.add('<< /Type /ExtGState /ca ' + fillA + ' /CA ' + strokeA + ' >>');
    ctx.gsMap[key] = name;
    ctx.res.gstates.push('/' + name + ' ' + ref + ' 0 R');
    return name;
  }

  /* ----------------------------- градиенты ------------------------------- */

  function segsBBox(segs) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    function pt(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.op === 'C') { pt(s.x1, s.y1); pt(s.x2, s.y2); }
      if (s.x !== undefined) pt(s.x, s.y);
    }
    if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: x0, y: y0, w: Math.max(x1 - x0, 0.0001), h: Math.max(y1 - y0, 0.0001) };
  }

  function gradientStops(node) {
    var stops = [];
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.tag !== 'stop') continue;
      var off = c.attrs.offset;
      var o = off && String(off).indexOf('%') >= 0
        ? parseFloat(off) / 100 : parseFloat(off || '0');
      if (!isFinite(o)) o = 0;
      var col = S.parseColor(c.attrs['stop-color'], 1);
      if (!col || col.gradient) col = { r: 0, g: 0, b: 0, a: 1 };
      var so = c.attrs['stop-opacity'] !== undefined ? parseFloat(c.attrs['stop-opacity']) : 1;
      if (!isFinite(so)) so = 1;
      if (so < 0.999) o = o; // прозрачность стопа в PDF игнорируем (нужна soft-маска)
      stops.push({ o: S.clamp(o, 0, 1), r: col.r, g: col.g, b: col.b });
    }
    if (!stops.length) return null;
    stops.sort(function (a, b) { return a.o - b.o; });
    if (stops[0].o > 0) stops.unshift({ o: 0, r: stops[0].r, g: stops[0].g, b: stops[0].b });
    if (stops[stops.length - 1].o < 1) {
      var l = stops[stops.length - 1];
      stops.push({ o: 1, r: l.r, g: l.g, b: l.b });
    }
    return stops;
  }

  function makeShading(ctx, gradId, segs) {
    var node = ctx.defs.gradients[gradId];
    if (!node) return null;
    var stops = gradientStops(node);
    if (!stops) return null;

    var a = node.attrs;
    var bbox = segsBBox(segs);
    var unit = (a.gradientUnits || 'objectBoundingBox') === 'userSpaceOnUse';
    var gt = a.gradientTransform ? S.parseTransform(a.gradientTransform) : null;

    function mapPt(x, y) {
      if (!unit) { x = bbox.x + x * bbox.w; y = bbox.y + y * bbox.h; }
      if (gt) return apply(gt, x, y);
      return [x, y];
    }

    var isRadial = node.tag === 'radialGradient';
    var coords;

    if (!isRadial) {
      var p1 = mapPt(parseFloat(a.x1 || 0), parseFloat(a.y1 || 0));
      var p2 = mapPt(parseFloat(a.x2 !== undefined ? a.x2 : 1), parseFloat(a.y2 || 0));
      coords = [p1[0], p1[1], p2[0], p2[1]];
    } else {
      var c = mapPt(parseFloat(a.cx || '0.5'), parseFloat(a.cy || '0.5'));
      var r = parseFloat(a.r !== undefined ? a.r : '0.5');
      if (!unit) r = r * Math.sqrt((bbox.w * bbox.w + bbox.h * bbox.h) / 2);
      if (gt) r = r * Math.sqrt(Math.abs(gt[0] * gt[3] - gt[1] * gt[2]));
      var f = mapPt(parseFloat(a.fx !== undefined ? a.fx : (a.cx || '0.5')),
        parseFloat(a.fy !== undefined ? a.fy : (a.cy || '0.5')));
      coords = [f[0], f[1], 0, c[0], c[1], r];
    }

    // сэмплируем 64 значения
    var N = 64, comps = ctx.cmyk ? 4 : 3;
    var data = new Uint8Array(N * comps);
    for (var i = 0; i < N; i++) {
      var t = i / (N - 1), s0 = stops[0], s1 = stops[stops.length - 1];
      for (var k = 0; k < stops.length - 1; k++) {
        if (t >= stops[k].o && t <= stops[k + 1].o) { s0 = stops[k]; s1 = stops[k + 1]; break; }
      }
      var span = s1.o - s0.o;
      var f2 = span > 0.00001 ? (t - s0.o) / span : 0;
      var r = s0.r + (s1.r - s0.r) * f2;
      var g = s0.g + (s1.g - s0.g) * f2;
      var b = s0.b + (s1.b - s0.b) * f2;
      if (ctx.cmyk) {
        var cmyk = S.rgbToCmyk(r, g, b);
        data[i * 4] = Math.round(cmyk[0] * 255);
        data[i * 4 + 1] = Math.round(cmyk[1] * 255);
        data[i * 4 + 2] = Math.round(cmyk[2] * 255);
        data[i * 4 + 3] = Math.round(cmyk[3] * 255);
      } else {
        data[i * 3] = Math.round(r * 255);
        data[i * 3 + 1] = Math.round(g * 255);
        data[i * 3 + 2] = Math.round(b * 255);
      }
    }

    var range = ctx.cmyk ? '[0 1 0 1 0 1 0 1]' : '[0 1 0 1 0 1]';
    var decode = range;
    var fnRef = ctx.doc.add('<< /FunctionType 0 /Domain [0 1] /Range ' + range +
      ' /Size [' + N + '] /BitsPerSample 8 /Order 1 /Encode [0 ' + (N - 1) + '] /Decode ' + decode + ' >>', data);

    var shRef = ctx.doc.add('<< /ShadingType ' + (isRadial ? 3 : 2) +
      ' /ColorSpace ' + (ctx.cmyk ? '/DeviceCMYK' : '/DeviceRGB') +
      ' /Coords [' + coords.map(function (v) { return fmt(v); }).join(' ') + ']' +
      ' /Function ' + fnRef + ' 0 R /Extend [true true] >>');

    var name = 'Sh' + (ctx.nSh++);
    ctx.res.shadings.push('/' + name + ' ' + shRef + ' 0 R');
    return name;
  }

  /* ------------------------------ отрисовка ------------------------------ */

  var DROP = {
    defs: 1, title: 1, desc: 1, metadata: 1, style: 1,
    linearGradient: 1, radialGradient: 1, stop: 1,
    clipPath: 1, mask: 1, filter: 1, pattern: 1, marker: 1, symbol: 1, use: 1
  };

  var BASE_STYLE = {
    fill: 'none', stroke: 'none', fillOpacity: 1, strokeOpacity: 1,
    strokeWidth: 1, fillRule: 'nonzero', cap: 'butt', join: 'miter',
    miter: 4, dash: null, dashOffset: 0,
    fontSize: 12, fontFamily: 'Helvetica', fontWeight: '400',
    fontStyle: 'normal', anchor: 'start'
  };

  function pnum(v, d) { var x = parseFloat(v); return isFinite(x) ? x : d; }

  function inheritStyle(parent, a) {
    a = a || {};
    var st = {};
    for (var k in parent) if (Object.prototype.hasOwnProperty.call(parent, k)) st[k] = parent[k];
    if (a.fill !== undefined) st.fill = a.fill;
    if (a.stroke !== undefined) st.stroke = a.stroke;
    if (a['fill-opacity'] !== undefined) st.fillOpacity = pnum(a['fill-opacity'], 1);
    if (a['stroke-opacity'] !== undefined) st.strokeOpacity = pnum(a['stroke-opacity'], 1);
    if (a['stroke-width'] !== undefined) st.strokeWidth = pnum(a['stroke-width'], 1);
    if (a['fill-rule'] !== undefined) st.fillRule = a['fill-rule'];
    if (a['stroke-linecap'] !== undefined) st.cap = a['stroke-linecap'];
    if (a['stroke-linejoin'] !== undefined) st.join = a['stroke-linejoin'];
    if (a['stroke-miterlimit'] !== undefined) st.miter = pnum(a['stroke-miterlimit'], 4);
    if (a['stroke-dasharray'] !== undefined) st.dash = a['stroke-dasharray'];
    if (a['stroke-dashoffset'] !== undefined) st.dashOffset = pnum(a['stroke-dashoffset'], 0);
    if (a['font-size'] !== undefined) st.fontSize = pnum(a['font-size'], 12);
    if (a['font-family'] !== undefined) st.fontFamily = a['font-family'];
    if (a['font-weight'] !== undefined) st.fontWeight = a['font-weight'];
    if (a['font-style'] !== undefined) st.fontStyle = a['font-style'];
    if (a['text-anchor'] !== undefined) st.anchor = a['text-anchor'];
    // CSS из style перекрывает presentation-атрибуты
    if (a.style) {
      var sp = S.parseStyle(a.style);
      if (sp.fill !== undefined) st.fill = sp.fill;
      if (sp.stroke !== undefined) st.stroke = sp.stroke;
      if (sp['fill-opacity'] !== undefined) st.fillOpacity = pnum(sp['fill-opacity'], 1);
      if (sp['stroke-opacity'] !== undefined) st.strokeOpacity = pnum(sp['stroke-opacity'], 1);
      if (sp['stroke-width'] !== undefined) st.strokeWidth = pnum(sp['stroke-width'], 1);
      if (sp['fill-rule'] !== undefined) st.fillRule = sp['fill-rule'];
      if (sp['stroke-linecap'] !== undefined) st.cap = sp['stroke-linecap'];
      if (sp['stroke-linejoin'] !== undefined) st.join = sp['stroke-linejoin'];
      if (sp['stroke-miterlimit'] !== undefined) st.miter = pnum(sp['stroke-miterlimit'], 4);
      if (sp['stroke-dasharray'] !== undefined) st.dash = sp['stroke-dasharray'];
      if (sp['stroke-dashoffset'] !== undefined) st.dashOffset = pnum(sp['stroke-dashoffset'], 0);
      if (sp['font-size'] !== undefined) st.fontSize = pnum(sp['font-size'], 12);
      if (sp['font-family'] !== undefined) st.fontFamily = sp['font-family'];
      if (sp['font-weight'] !== undefined) st.fontWeight = sp['font-weight'];
      if (sp['font-style'] !== undefined) st.fontStyle = sp['font-style'];
      if (sp['text-anchor'] !== undefined) st.anchor = sp['text-anchor'];
    }
    return st;
  }

  function segsToOps(segs) {
    var s = '', i, g;
    for (i = 0; i < segs.length; i++) {
      g = segs[i];
      if (g.op === 'M') s += fmt(g.x) + ' ' + fmt(g.y) + ' m\n';
      else if (g.op === 'L') s += fmt(g.x) + ' ' + fmt(g.y) + ' l\n';
      else if (g.op === 'C') s += fmt(g.x1) + ' ' + fmt(g.y1) + ' ' + fmt(g.x2) + ' ' +
        fmt(g.y2) + ' ' + fmt(g.x) + ' ' + fmt(g.y) + ' c\n';
      else if (g.op === 'Z') s += 'h\n';
    }
    return s;
  }

  function setColor(ctx, col, isStroke) {
    if (ctx.cmyk) {
      var k = S.rgbToCmyk(col.r, col.g, col.b);
      return fmt(k[0]) + ' ' + fmt(k[1]) + ' ' + fmt(k[2]) + ' ' + fmt(k[3]) + (isStroke ? ' K' : ' k');
    }
    return fmt(col.r) + ' ' + fmt(col.g) + ' ' + fmt(col.b) + (isStroke ? ' RG' : ' rg');
  }

  function capCode(c) { return c === 'round' ? 1 : (c === 'square' ? 2 : 0); }
  function joinCode(j) { return j === 'round' ? 1 : (j === 'bevel' ? 2 : 0); }

  function dashOps(st) {
    if (!st.dash || st.dash === 'none') return '';
    var arr = String(st.dash).split(/[\s,]+/).map(parseFloat).filter(function (v) { return isFinite(v); });
    if (!arr.length) return '';
    return '[' + arr.map(function (v) { return fmt(v); }).join(' ') + '] ' + fmt(st.dashOffset) + ' d';
  }

  function hrefId(v) {
    var s = String(v || '').trim();
    if (s.charAt(0) === '#') return s.slice(1);
    return S.refId(s);
  }

  // Figma умеет красить фигуру картинкой: fill="url(#pattern...)", а внутри
  // pattern лежит <use xlink:href="#image...">. Достаём эту картинку.
  function patternImage(ctx, patId) {
    var pat = ctx.defs.patterns && ctx.defs.patterns[patId];
    if (!pat) return null;
    var found = null;
    function scan(node) {
      var kids = node.children || [];
      for (var i = 0; i < kids.length && !found; i++) {
        var c = kids[i];
        var href = c.attrs && (c.attrs['xlink:href'] || c.attrs.href);
        if (c.tag === 'image' && href) {
          found = { href: href, attrs: c.attrs, pattern: pat };
          return;
        }
        if (c.tag === 'use' && href) {
          var id = hrefId(href);
          var im = id && ctx.defs.images && ctx.defs.images[id];
          var ih = im && im.attrs && (im.attrs['xlink:href'] || im.attrs.href);
          if (ih) { found = { href: ih, attrs: im.attrs, pattern: pat }; return; }
        }
        scan(c);
      }
    }
    scan(pat);
    return found;
  }

  async function emitShape(node, st, ctx) {
    var segs = S.shapeToSegs(node);
    if (!segs || !segs.length) return;

    var fill = S.parseColor(st.fill);
    var stroke = S.parseColor(st.stroke);
    var fillA = st.fillOpacity * (fill && fill.a !== undefined ? fill.a : 1);
    var strokeA = st.strokeOpacity * (stroke && stroke.a !== undefined ? stroke.a : 1);
    var sw = st.strokeWidth;
    if (stroke && (!(sw > 0) || strokeA <= 0.002)) stroke = null;
    if (fill && fillA <= 0.002) fill = null;
    if (!fill && !stroke) return;

    var out = ctx.out;
    var gs = getGs(ctx, fill ? fillA : 1, stroke ? strokeA : 1);
    out.push('q');
    if (gs) out.push('/' + gs + ' gs');

    var ops = segsToOps(segs);
    var filled = false;

    if (fill && fill.gradient) {
      var sh = makeShading(ctx, fill.gradient, segs);
      if (sh) {
        out.push(ops);
        out.push('W n');
        out.push('/' + sh + ' sh');
        filled = true;
      } else {
        var pim = patternImage(ctx, fill.gradient);
        if (pim) {
          var bb = segsBBox(segs);
          var pat = pim.pattern;
          var userSpace = pat.attrs && pat.attrs.patternUnits === 'userSpaceOnUse';
          var ix = userSpace ? pnum(pat.attrs.x, bb.x) : bb.x;
          var iy = userSpace ? pnum(pat.attrs.y, bb.y) : bb.y;
          var iw = userSpace ? pnum(pat.attrs.width, bb.w) : bb.w;
          var ihh = userSpace ? pnum(pat.attrs.height, bb.h) : bb.h;
          if (iw > 0 && ihh > 0) {
            out.push(ops);
            out.push('W n');
            await emitImage({
              tag: 'image',
              attrs: {
                x: ix, y: iy, width: iw, height: ihh,
                'xlink:href': pim.href
              }
            }, st, ctx);
            filled = true;
          }
        }
        if (!filled) {
          ctx.warn('Заливка «' + fill.gradient + '» не найдена — залита чёрным');
          out.push('0 0 0 1 k');
          out.push(ops);
          out.push(st.fillRule === 'evenodd' ? 'f*' : 'f');
          filled = true;
        }
      }
    } else if (fill) {
      out.push(setColor(ctx, fill, false));
      out.push(ops);
      out.push(st.fillRule === 'evenodd' ? 'f*' : 'f');
      filled = true;
    }

    if (stroke) {
      out.push(setColor(ctx, stroke, true));
      out.push(fmt(sw) + ' w');
      out.push(capCode(st.cap) + ' J');
      out.push(joinCode(st.join) + ' j');
      out.push(fmt(st.miter) + ' M');
      var d = dashOps(st);
      if (d) out.push(d);
      out.push(ops);
      out.push('S');
    }

    out.push('Q');
    if (filled) ctx.shapes++;
  }

  function collectShapeSegs(node, acc) {
    if (!node.children) return;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.tag === '#text') continue;
      if (c.tag === 'g' || c.tag === 'svg') { collectShapeSegs(c, acc); continue; }
      var s = S.shapeToSegs(c);
      if (s && s.length) for (var j = 0; j < s.length; j++) acc.push(s[j]);
    }
  }

  function pickFont(family, weight, style) {
    var f = String(family || '').toLowerCase();
    var bold = /bold|700|800|900/.test(String(weight || ''));
    var italic = /italic|oblique/.test(String(style || ''));
    if (/courier|mono/.test(f)) return 'F4';
    if (/times|serif|georgia|garamond/.test(f) && !/sans/.test(f)) return 'F3';
    return bold ? 'F2' : 'F1';
  }

  function pdfTextString(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 40) out += '\\(';
      else if (c === 41) out += '\\)';
      else if (c === 92) out += '\\\\';
      else if (c < 32) out += ' ';
      else if (c < 127) out += s[i];
      else out += '?';
    }
    return '(' + out + ')';
  }

  function emitText(node, st, ctx) {
    var a = node.attrs || {};
    var fs = a['font-size'] !== undefined ? pnum(a['font-size'], st.fontSize) : st.fontSize;
    var font = pickFont(a['font-family'] || st.fontFamily, a['font-weight'] || st.fontWeight,
      a['font-style'] || st.fontStyle);
    var col = S.parseColor(a.fill !== undefined ? a.fill : st.fill) || { r: 0, g: 0, b: 0, a: 1 };

    var lines = [];
    var kids = (node.children || []).filter(function (c) { return c.tag === 'tspan'; });
    if (!kids.length) {
      if (node.text || (node.children && node.children[0] && node.children[0].text)) {
        lines.push({ x: pnum(a.x, 0), y: pnum(a.y, 0), t: textOf(node) });
      }
    } else {
      for (var i = 0; i < kids.length; i++) {
        var t = kids[i];
        lines.push({
          x: pnum(t.attrs.x, pnum(a.x, 0)),
          y: pnum(t.attrs.y, pnum(a.y, 0)),
          t: textOf(t)
        });
      }
    }
    if (!lines.length) return;

    ctx.warn('В PDF попал живой текст (не в кривых). Включите «Текст в кривые».');
    ctx.out.push('q');
    ctx.out.push(setColor(ctx, col, false));
    ctx.out.push('BT');
    ctx.out.push('/' + font + ' ' + fmt(fs) + ' Tf');
    for (var j = 0; j < lines.length; j++) {
      var L = lines[j];
      if (!L.t) continue;
      ctx.out.push('1 0 0 -1 ' + fmt(L.x) + ' ' + fmt(L.y) + ' Tm');
      ctx.out.push(pdfTextString(L.t) + ' Tj');
    }
    ctx.out.push('ET');
    ctx.out.push('Q');
  }

  function textOf(node) {
    var s = '';
    if (node.text) s += node.text;
    for (var i = 0; i < (node.children || []).length; i++) {
      if (node.children[i].tag === '#text') s += node.children[i].text;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  async function emitImage(node, st, ctx) {
    var a = node.attrs || {};
    var href = a['xlink:href'] || a.href;
    if (!href) return;
    if (String(href).indexOf('data:') !== 0) {
      ctx.warn('Картинка по внешней ссылке не встроена в PDF');
      return;
    }
    var img = await getImage(ctx, href);
    if (!img) return;
    var x = pnum(a.x, 0), y = pnum(a.y, 0);
    var w = pnum(a.width, img.w), h = pnum(a.height, img.h);
    if (!(w > 0) || !(h > 0)) return;
    var name = 'Im' + (ctx.nImg++);
    ctx.res.xobjects.push('/' + name + ' ' + img.ref + ' 0 R');
    ctx.out.push('q');
    ctx.out.push(fmt(w) + ' 0 0 ' + fmt(-h) + ' ' + fmt(x) + ' ' + fmt(y + h) + ' cm');
    ctx.out.push('/' + name + ' Do');
    ctx.out.push('Q');
    ctx.images++;
  }

  async function walk(node, st, ctx) {
    var tag = node.tag;
    if (tag === '#text') return;
    if (DROP[tag]) return;

    var a = node.attrs || {};
    var styleProps = a.style ? S.parseStyle(a.style) : null;
    if (a.display === 'none' || (styleProps && styleProps.display === 'none')) return;
    var t = a.transform ? S.parseTransform(a.transform) : null;
    var st2 = inheritStyle(st, a);
    var op = a.opacity !== undefined ? pnum(a.opacity, 1)
      : (styleProps && styleProps.opacity !== undefined ? pnum(styleProps.opacity, 1) : 1);

    var clipSegs = null, maskSegs = null;
    var cid = S.refId(a['clip-path']);
    if (cid) {
      if (ctx.stripClips) { ctx.clips++; }
      else {
        var cn = ctx.defs.clipPaths[cid];
        if (cn) { clipSegs = []; collectShapeSegs(cn, clipSegs); }
      }
    }
    var mid = S.refId(a.mask);
    if (mid) {
      var mn = ctx.defs.masks[mid];
      if (mn) { maskSegs = []; collectShapeSegs(mn, maskSegs); if (maskSegs.length) ctx.masksCliped++; }
    }

    var needQ = !!(t || op < 0.999 || (clipSegs && clipSegs.length) || (maskSegs && maskSegs.length));
    if (needQ) {
      ctx.out.push('q');
      if (t) ctx.out.push(t.map(function (v) { return fmt(v); }).join(' ') + ' cm');
      if (op < 0.999) {
        var gsn = getGs(ctx, op, op);
        if (gsn) ctx.out.push('/' + gsn + ' gs');
      }
      if (clipSegs && clipSegs.length) { ctx.out.push(segsToOps(clipSegs)); ctx.out.push('W n'); }
      if (maskSegs && maskSegs.length) { ctx.out.push(segsToOps(maskSegs)); ctx.out.push('W n'); }
    }

    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      for (var i = 0; i < node.children.length; i++) await walk(node.children[i], st2, ctx);
    } else if (tag === 'image') {
      await emitImage(node, st2, ctx);
    } else if (tag === 'text') {
      emitText(node, st2, ctx);
    } else if (tag === 'tspan') {
      for (var j = 0; j < node.children.length; j++) await walk(node.children[j], st2, ctx);
    } else {
      await emitShape(node, st2, ctx);
    }

    if (needQ) ctx.out.push('Q');
  }

  /* --------------------------- страница и документ ----------------------- */

  async function renderPage(doc, page, opts) {
    var root = page.svg;
    if (typeof root === 'string') root = S.findRootSvg(S.parseXml(root));
    if (!root) throw new Error('Не удалось разобрать SVG');
    var vb = S.parseViewBox(root);

    var spec = page.spec || {};
    var bleed = spec.bleedMm !== undefined ? spec.bleedMm : 0;
    var trimW = spec.trimWmm || S.ptToMm(vb.w);
    var trimH = spec.trimHmm || S.ptToMm(vb.h);
    var pageW = S.mmToPt(trimW + 2 * bleed);
    var pageH = S.mmToPt(trimH + 2 * bleed);
    if (!(pageW > 0) || !(pageH > 0)) throw new Error('Нулевой размер страницы');

    var ctx = {
      doc: doc,
      cmyk: opts.cmyk !== false,
      imgCmyk: !!opts.imgCmyk,
      stripClips: opts.stripClips !== false,
      defs: { gradients: {}, clipPaths: {}, masks: {}, patterns: {}, images: {} },
      out: [],
      res: { xobjects: [], shadings: [], gstates: [] },
      imgCache: opts.imgCache,
      warnSet: {}, warnings: [],
      nImg: 0, nSh: 0, nGs: 0,
      clips: 0, masksCliped: 0, shapes: 0, images: 0
    };
    ctx.warn = function (msg) {
      if (!ctx.warnSet[msg]) { ctx.warnSet[msg] = 1; ctx.warnings.push(msg); }
    };

    S.collectDefs(root, ctx.defs);

    var sc = pageW / (vb.w || 1);
    ctx.out.push('q');
    ctx.out.push([sc, 0, 0, -sc, -vb.x * sc, pageH + vb.y * sc].map(function (v) { return fmt(v); }).join(' ') + ' cm');
    // жёсткая обрезка по странице: всё, что за форматом, в файл не попадает
    ctx.out.push('0 0 ' + fmt(pageW) + ' ' + fmt(pageH) + ' re W n');

    var base = {};
    for (var k in BASE_STYLE) base[k] = BASE_STYLE[k];
    base.fill = 'none';
    var rootStyle = inheritStyle(base, root.attrs || {});
    for (var i = 0; i < root.children.length; i++) await walk(root.children[i], rootStyle, ctx);
    ctx.out.push('Q');

    var content = ctx.out.join('\n');
    var contentRef = doc.add('<< >>', ascii(content));

    var res = ['/ProcSet [/PDF /Text /ImageB /ImageC]'];
    res.push('/Font << /F1 ' + opts.fonts.F1 + ' 0 R /F2 ' + opts.fonts.F2 + ' 0 R /F3 ' +
      opts.fonts.F3 + ' 0 R /F4 ' + opts.fonts.F4 + ' 0 R >>');
    if (ctx.res.xobjects.length) res.push('/XObject << ' + ctx.res.xobjects.join(' ') + ' >>');
    if (ctx.res.gstates.length) res.push('/ExtGState << ' + ctx.res.gstates.join(' ') + ' >>');
    if (ctx.res.shadings.length) res.push('/Shading << ' + ctx.res.shadings.join(' ') + ' >>');
    var b = S.mmToPt(bleed);
    var box = [0, 0, pageW, pageH];
    var trimBox = [b, b, pageW - b, pageH - b];
    var fmtBox = function (ar) { return '[' + ar.map(function (v) { return fmt(v); }).join(' ') + ']'; };

    var pageRef = doc.add('<< /Type /Page /Parent ' + opts.pagesNum + ' 0 R' +
      ' /MediaBox ' + fmtBox(box) + ' /CropBox ' + fmtBox(box) +
      ' /BleedBox ' + fmtBox(box) + ' /TrimBox ' + fmtBox(trimBox) +
      ' /Resources << ' + res.join(' ') + ' >>' +
      ' /Contents ' + contentRef + ' 0 R >>');

    return {
      ref: pageRef, width: pageW, height: pageH,
      warnings: ctx.warnings, stats: {
        clips: ctx.clips, masks: ctx.masksCliped, shapes: ctx.shapes, images: ctx.images
      }
    };
  }

  async function buildPdf(pages, opts) {
    opts = opts || {};
    var doc = new PdfDoc();
    var pagesNum = doc.reserve();

    var fonts = {};
    var fontList = [['F1', 'Helvetica'], ['F2', 'Helvetica-Bold'],
      ['F3', 'Times-Roman'], ['F4', 'Courier']];
    for (var i = 0; i < fontList.length; i++) {
      fonts[fontList[i][0]] = doc.add('<< /Type /Font /Subtype /Type1 /BaseFont /' +
        fontList[i][1] + ' /Encoding /WinAnsiEncoding >>');
    }

    var imgCache = {};
    var pageRefs = [], allWarnings = [], stats = { pages: 0, shapes: 0, images: 0 };
    for (var p = 0; p < pages.length; p++) {
      var r = await renderPage(doc, pages[p], {
        cmyk: opts.cmyk, imgCmyk: opts.imgCmyk, stripClips: opts.stripClips,
        imgCache: imgCache, fonts: fonts, pagesNum: pagesNum
      });
      pageRefs.push(r.ref);
      allWarnings = allWarnings.concat(r.warnings);
      if (r.stats.shapes + r.stats.images === 0) {
        allWarnings.push('Страница «' + (pages[p].title || (p + 1)) +
          '» получилась пустой: в кадре нет видимых фигур. ' +
          'Проверьте, что рисунок лежит внутри кадра, а не рядом на холсте.');
      }
      stats.shapes += r.stats.shapes;
      stats.images += r.stats.images;
      stats.pages++;
    }

    doc.set(pagesNum, '<< /Type /Pages /Kids [' +
      pageRefs.map(function (n) { return n + ' 0 R'; }).join(' ') +
      '] /Count ' + pageRefs.length + ' >>');

    var catalog = doc.add('<< /Type /Catalog /Pages ' + pagesNum + ' 0 R >>');
    var title = pages.length ? (pages[0].title || 'Print') : 'Print';
    var info = doc.add('<< /Title ' + pdfString(title) +
      ' /Producer ' + pdfString('Whoosh - Off to Print') +
      ' /Creator ' + pdfString('Whoosh - Off to Print') +
      ' /CreationDate (' + pdfDate(new Date()) + ') >>');

    return { bytes: doc.toBytes(catalog, info), warnings: uniq(allWarnings), stats: stats };
  }

  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  /* ------------------------------ DPI-метки ------------------------------ */

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
  function crc32(buf) {
    var t = crcTable(), c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeChunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var len = data.length;
    out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255;
    out[2] = (len >>> 8) & 255; out[3] = len & 255;
    out.set(ascii(type), 4);
    out.set(data, 8);
    var c = crc32(out.subarray(4, 8 + len));
    out[8 + len] = (c >>> 24) & 255; out[9 + len] = (c >>> 16) & 255;
    out[10 + len] = (c >>> 8) & 255; out[11 + len] = c & 255;
    return out;
  }

  // прописывает в PNG реальный DPI (pHYs), чтобы Photoshop/Illustrator его видели
  function patchPngDpi(bytes, dpi) {
    if (!isPng(bytes)) return bytes;
    var ppu = Math.round(dpi / 0.0254);
    var data = new Uint8Array([
      (ppu >>> 24) & 255, (ppu >>> 16) & 255, (ppu >>> 8) & 255, ppu & 255,
      (ppu >>> 24) & 255, (ppu >>> 16) & 255, (ppu >>> 8) & 255, ppu & 255, 1
    ]);
    var phys = makeChunk('pHYs', data);
    var out = [bytes.subarray(0, 8)];
    var p = 8, inserted = false;
    while (p + 8 <= bytes.length) {
      var len = u32(bytes, p), type = str4(bytes, p + 4);
      var end = p + 12 + len;
      if (end > bytes.length) break;
      if (type !== 'pHYs') {
        out.push(bytes.subarray(p, end));
        if (type === 'IHDR' && !inserted) { out.push(phys); inserted = true; }
      }
      p = end;
      if (type === 'IEND') break;
    }
    return concatBytes(out);
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
    return insertJfif(bytes, dpi);
  }

  function insertJfif(bytes, dpi) {
    var app0 = new Uint8Array([
      0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
      (dpi >> 8) & 255, dpi & 255, (dpi >> 8) & 255, dpi & 255, 0x00, 0x00
    ]);
    var out = new Uint8Array(bytes.length + app0.length);
    out.set(bytes.subarray(0, 2), 0);
    out.set(app0, 2);
    out.set(bytes.subarray(2), 2 + app0.length);
    return out;
  }

  global.PrintPdf = {
    buildPdf: buildPdf,
    patchPngDpi: patchPngDpi,
    patchJpegDpi: patchJpegDpi,
    pngInfo: pngInfo,
    decodePng: decodePng,
    pdfDate: pdfDate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
