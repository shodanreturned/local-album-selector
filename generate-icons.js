// Generates PWA PNG icons from the Lightbox brand icon design.
// Run: node generate-icons.js
'use strict';
const { Jimp } = require('jimp');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, 'src/assets/icons');

// Brand colours (from home.component.css) — stored as 0xRRGGBBAA integers
const BG    = 0x1f1a14ff;
const GOLD  = 0xd8bd95ff;
const CREAM = 0xf2ece2ff;
const CLEAR = 0x00000000;

function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const inH = px >= x + r && px <= x + w - r;
  const inV = py >= y + r && py <= y + h - r;
  if (inH || inV) return true;
  const corners = [
    [x + r,     y + r    ],
    [x + w - r, y + r    ],
    [x + r,     y + h - r],
    [x + w - r, y + h - r],
  ];
  return corners.some(([cx, cy]) => Math.hypot(px - cx, py - cy) <= r);
}

async function renderIcon(size) {
  const img = new Jimp({ width: size, height: size, color: CLEAR });

  // Proportional layout (designed at 512, scaled)
  const s = size / 512;
  const bgR  = Math.round(108 * s);
  const pad  = Math.round(64  * s);
  const gap  = Math.round(32  * s);
  const cell = Math.round(176 * s);
  const cR   = Math.round(20  * s);

  const c1x = pad,              c1y = pad;
  const c2x = pad + cell + gap, c2y = pad;
  const c3x = pad,              c3y = pad + cell + gap;
  const c4x = pad + cell + gap, c4y = pad + cell + gap;

  img.scan(0, 0, size, size, function(px, py, idx) {
    let color = CLEAR;

    if (insideRoundedRect(px, py, 0, 0, size - 1, size - 1, bgR)) {
      color = BG;
      if      (insideRoundedRect(px, py, c1x, c1y, cell, cell, cR)) color = GOLD;
      else if (insideRoundedRect(px, py, c2x, c2y, cell, cell, cR)) color = CREAM;
      else if (insideRoundedRect(px, py, c3x, c3y, cell, cell, cR)) color = CREAM;
      else if (insideRoundedRect(px, py, c4x, c4y, cell, cell, cR)) color = CREAM;
    }

    this.bitmap.data[idx]     = (color >>> 24) & 0xff;
    this.bitmap.data[idx + 1] = (color >>> 16) & 0xff;
    this.bitmap.data[idx + 2] = (color >>>  8) & 0xff;
    this.bitmap.data[idx + 3] =  color         & 0xff;
  });

  return img;
}

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const img = await renderIcon(size);
    const outFile = path.join(OUT_DIR, `icon-${size}x${size}.png`);
    await img.write(outFile);
    console.log(`wrote ${outFile}`);
  }
  console.log('done');
})();
