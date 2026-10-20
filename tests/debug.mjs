import fs from 'fs';
await import('../src/core-svg.js');
const S = globalThis.PrintSvg;

const b64 = fs.readFileSync(new URL('./png_b64.txt', import.meta.url), 'utf8').trim();
const svg = `<svg width="612" height="858" viewBox="0 0 612 858" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#c0)">
<rect width="612" height="858" fill="white"/>
<g clip-path="url(#c1)">
<rect x="40" y="40" width="500" height="300" fill="#FF0000"/>
<g transform="rotate(-15 400 700)" opacity="0.8">
  <rect x="350" y="650" width="120" height="120" fill="#FFCC00"/>
</g>
<image x="40" y="120" width="200" height="150" preserveAspectRatio="none" xlink:href="data:image/png;base64,${b64}"/>
<text fill="black" font-family="Inter" font-size="24"><tspan x="60" y="280">LIVE TEXT</tspan></text>
</g>
</g>
<defs>
<clipPath id="c0"><rect width="612" height="858" fill="white"/></clipPath>
<clipPath id="c1"><rect x="40" y="40" width="500" height="700" fill="white"/></clipPath>
</defs>
</svg>`;

const doc = S.parseXml(svg);
const root = S.findRootSvg(doc);
const g0 = root.children.find(c => c.tag === 'g');
const g1 = g0.children.find(c => c.tag === 'g');
console.log('дети внешней g:', g0.children.map(c => c.tag));
console.log('дети внутренней g:', g1.children.map(c => c.tag));
const img = g1.children.find(c => c.tag === 'image');
console.log('image attrs keys:', img && Object.keys(img.attrs));
console.log('href len:', img && (img.attrs['xlink:href'] || '').length);
const text = g1.children.find(c => c.tag === 'text');
console.log('text children:', text && text.children.map(c => c.tag), JSON.stringify(text && text.children[0].children));
