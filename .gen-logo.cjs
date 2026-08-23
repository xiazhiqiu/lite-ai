const fs = require('fs');
const pitch = 26, cell = 20, X = 104, Y = 312;
const cols = { l: 0, i: 6, t: 12, e: 18 };
const pixels = {};
const add = (L, rows) => {
  pixels[L] = [];
  rows.forEach((row, r) => row.forEach(c => pixels[L].push({ r, c })));
};
add('l', [[2],[2],[2],[2],[2],[2],[2]]);
add('i', [[2],[],[2],[2],[2],[2],[2]]);
add('t', [[],[2],[2],[1,2,3],[2],[2],[2]]);
add('e', [[],[1,2,3],[0,4],[0],[0,1,2,3],[0,4],[1,2,3]]);

// 黑白极简：黑底白字，像素块间留出 gap，无渐变无阴影
const tile = '#000000', glyph = '#ffffff';
let rects = [];
for (const L of ['l','i','t','e']) {
  for (const p of pixels[L]) {
    const px = X + (cols[L] + p.c) * pitch + 3;
    const py = Y + p.r * pitch + 3;
    rects.push(`<rect x="${px}" y="${py}" width="${cell-6}" height="${cell-6}" fill="${glyph}"/>`);
  }
}
const svg =
`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" role="img" aria-label="lite">
  <title>lite</title>
  <rect width="800" height="800" fill="${tile}"/>
${rects.join('\n')}
</svg>
`;
fs.writeFileSync('/workspace/assets/logo.svg', svg);
fs.writeFileSync('/workspace/assets/logo-mark.svg', svg);
console.log('rects:', rects.length);