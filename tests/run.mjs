import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

await import('../src/core-svg.js');
await import('../src/core-pdf.js');

const S = globalThis.PrintSvg;
const P = globalThis.PrintPdf;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

const b64 = fs.readFileSync(path.join(here, 'png_b64.txt'), 'utf8').trim();

// Размер «вылетного» кадра A4 + 3 мм с каждой стороны (216 x 303 мм) в пунктах
const PAGE_W = 216 * 72 / 25.4;
const PAGE_H = 303 * 72 / 25.4;

function makeSvg(tint) {
  return `<svg width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1_2)">
<rect width="${PAGE_W}" height="${PAGE_H}" fill="white"/>
<g clip-path="url(#clip1_1_2)">
<rect x="40" y="40" width="${PAGE_W - 80}" height="300" fill="${tint}"/>
<path d="M40 400H${PAGE_W - 40}V500H40V400Z" fill="url(#paint0_linear_1_2)"/>
<ellipse cx="300" cy="600" rx="120" ry="60" fill="#0000FF" fill-opacity="0.5"/>
<path d="M100 700 L 200 700 A 50 50 0 0 1 200 800 L 100 800 Z" fill="#00A000" stroke="#000000" stroke-width="3"/>
<path d="M20 820L${PAGE_W - 20} 820" stroke="black" stroke-width="1" stroke-dasharray="6 4"/>
<g transform="rotate(-15 400 700)" opacity="0.8">
  <rect x="350" y="650" width="120" height="120" fill="#FFCC00"/>
</g>
<image x="40" y="120" width="200" height="150" preserveAspectRatio="none" xlink:href="data:image/png;base64,${b64}"/>
<text fill="black" font-family="Inter" font-size="24"><tspan x="60" y="280">LIVE TEXT</tspan></text>
</g>
</g>
<defs>
<linearGradient id="paint0_linear_1_2" x1="40" y1="400" x2="${PAGE_W - 40}" y2="500" gradientUnits="userSpaceOnUse">
<stop stop-color="#FF00FF"/><stop offset="1" stop-color="#00FFFF"/>
</linearGradient>
<clipPath id="clip0_1_2"><rect width="${PAGE_W}" height="${PAGE_H}" fill="white"/></clipPath>
<clipPath id="clip1_1_2"><rect x="40" y="40" width="${PAGE_W - 80}" height="${PAGE_H - 120}" fill="white"/></clipPath>
</defs>
</svg>`;
}

const spec = { trimWmm: 210, trimHmm: 297, bleedMm: 3 };

// 1. Чистка SVG
const cleaned = S.cleanSvgForExport(makeSvg('#FF0000'), {
  widthMm: 216, heightMm: 303, stripClips: true
});
fs.writeFileSync(path.join(outDir, 'clean.svg'), cleaned.svg, 'utf8');
console.log('--- SVG ---');
console.log('размер:', cleaned.svg.match(/width="[^"]+" height="[^"]+"/)[0]);
console.log('clip-path осталось:', (cleaned.svg.match(/clip-path/g) || []).length);
console.log('notes:', cleaned.notes);

// 1b. Чистка с сохранением обрезки
const cleaned2 = S.cleanSvgForExport(makeSvg('#FF0000'), {
  widthMm: 216, heightMm: 303, stripClips: false
});
fs.writeFileSync(path.join(outDir, 'clean_clips.svg'), cleaned2.svg, 'utf8');
console.log('с обрезкой: clipPath в defs =', (cleaned2.svg.match(/<clipPath/g) || []).length,
  ', ссылок clip-path =', (cleaned2.svg.match(/clip-path=/g) || []).length);

// 2. PDF
const t0 = Date.now();
const res = await P.buildPdf([
  { svg: makeSvg('#FF0000'), spec, title: 'Page 1' },
  { svg: makeSvg('#00FF00'), spec, title: 'Page 2' }
], { cmyk: true, imgCmyk: true, stripClips: true });

fs.writeFileSync(path.join(outDir, 'out.pdf'), Buffer.from(res.bytes));
console.log('\n--- PDF ---');
console.log('байт:', res.bytes.length, 'за', (Date.now() - t0) + 'мс');
console.log('страниц:', res.stats.pages, 'фигур:', res.stats.shapes, 'картинок:', res.stats.images);
console.log('warnings:', res.warnings);

// 2b. Картинка через <pattern> и цвета в style (частые случаи Figma/вставки)
const patSvg = `<svg width="300" height="300" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="120" height="100" fill="url(#pattern0_1_2)"/>
<rect x="20" y="150" width="80" height="60" style="fill:#123456;stroke:#000000;stroke-width:2"/>
<defs>
<pattern id="pattern0_1_2" patternContentUnits="objectBoundingBox" width="1" height="1">
<use xlink:href="#image0_1_2" transform="scale(0.001)"/>
</pattern>
<image id="image0_1_2" width="1000" height="1000" xlink:href="data:image/png;base64,${b64}"/>
</defs>
</svg>`;

const patClean = S.cleanSvgForExport(patSvg, { widthMm: 100, heightMm: 100, stripClips: true });
const patOk = /<pattern/.test(patClean.svg) && /<image/.test(patClean.svg) &&
  /fill="#123456"/.test(patClean.svg);
console.log('\n--- pattern/style ---');
console.log('SVG pattern+image+style:', patOk ? 'ok' : 'FAIL', '| фигур:', patClean.stats.drawable);

const patPdf = await P.buildPdf([{ svg: patSvg, spec: { trimWmm: 100, trimHmm: 100, bleedMm: 0 }, title: 'Pattern' }],
  { cmyk: true, imgCmyk: true, stripClips: true });
console.log('PDF pattern:', patPdf.stats.shapes, 'фигур,', patPdf.stats.images, 'картинок, warnings:',
  patPdf.warnings.length ? patPdf.warnings : 'нет');
fs.writeFileSync(path.join(outDir, 'pattern.pdf'), Buffer.from(patPdf.bytes));

// 3. DPI
const png = P.patchPngDpi(fs.readFileSync(path.join(here, 'sample.png')), 300);
fs.writeFileSync(path.join(outDir, 'dpi300.png'), png);
const info = P.pngInfo(png);
console.log('\nPNG ok, размер', info.w + 'x' + info.h, 'chunks:', png.length, 'vs', fs.statSync(path.join(here, 'sample.png')).size);

const jpgLike = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
const jpg2 = P.patchJpegDpi(jpgLike, 300);
console.log('JPEG APP0 dpi bytes:', jpg2[13], jpg2[14], jpg2[15], jpg2[16]);
