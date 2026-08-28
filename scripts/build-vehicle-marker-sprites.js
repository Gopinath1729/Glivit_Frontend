#!/usr/bin/env node
/* global __dirname */
/**
 * Bakes the map's vehicle marker sprites.
 *
 * Android cannot use a React view as a marker under the New Architecture:
 * react-native-maps 1.20 ships no codegen spec, so it runs through Fabric's
 * legacy interop, where `updateExtraData` (the only thing that tells a marker
 * how large its view is) never fires. `MapMarker.createDrawable` then falls
 * back to a 100x100 PIXEL bitmap and draws the view from its top-left corner,
 * which on a 3x screen captures nothing but the transparent padding around the
 * car. Handing the marker a finished PNG through `image` skips rasterisation
 * completely, so the vehicle always shows in full.
 *
 * The status colour therefore has to be baked in. Every state gets a halo of
 * its own colour hugging the car's silhouette -- an outline rather than a
 * badge, so it stays correct at any heading once the marker rotates with the
 * map.
 *
 * Effects work on a scalar alpha mask rather than on RGBA pixels: blurring
 * straight-alpha colour bleeds the untouched RGB of transparent pixels, which
 * is what fringes a coloured glow. Run with:
 *   node scripts/build-vehicle-marker-sprites.js
 */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp-compact');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets/markers/car-marker-photorealistic-v4-map-trim.png');
const OUT_DIR = path.join(ROOT, 'assets/markers/vehicle');

/**
 * Mirrors CENTRALIZED_STATUS_COLORS in src/theme/tokens.ts, so a marker and the
 * legend dot for the same state are the same colour.
 *
 * The three offline states are all slate, and at marker size their haloes are
 * hard to tell apart from each other or from the car's own paint. They get the
 * vehicle itself drained of colour as well -- a greyed-out car reads as "not
 * reporting" at a glance, which no ring around a full-colour car does.
 */
const STATE_COLORS = {
  running: { color: '#22C55E', muted: false },
  idle: { color: '#F59E0B', muted: false },
  stopped: { color: '#EF4444', muted: false },
  inactive: { color: '#94A3B8', muted: true },
  no_data: { color: '#475569', muted: true },
  expired: { color: '#334155', muted: true },
};

/**
 * Density-independent geometry, in dp. `canvas` has to clear the car's diagonal
 * plus the halo so a rotated sprite never clips its own edge; `car` is the
 * drawn height of the vehicle itself.
 */
const VARIANTS = {
  normal: { canvas: 60, car: 44, ring: 0 },
  selected: { canvas: 74, car: 54, ring: 2.5 },
};

const SCALES = [1, 2, 3];
const CAR_ASPECT = 115 / 262;
const SHADOW_RGB = [10, 18, 30];

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** Drains colour and brightness from a sprite, marking a vehicle as offline. */
function desaturate(img, amount, brightness) {
  const { data } = img.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    for (let k = 0; k < 3; k += 1) {
      data[i + k] = Math.round((data[i + k] * (1 - amount) + lum * amount) * brightness);
    }
  }
  return img;
}

/** Alpha channel of `img` written into a `size` x `size` field at (ox, oy). */
function maskFrom(img, size, ox, oy) {
  const mask = new Float32Array(size * size);
  const { width, height, data } = img.bitmap;
  for (let y = 0; y < height; y += 1) {
    const ty = y + oy;
    if (ty < 0 || ty >= size) continue;
    for (let x = 0; x < width; x += 1) {
      const tx = x + ox;
      if (tx < 0 || tx >= size) continue;
      mask[ty * size + tx] = data[(y * width + x) * 4 + 3] / 255;
    }
  }
  return mask;
}

/** Separable max filter -- grows the silhouette by `r` pixels in every direction. */
function dilate(mask, size, r) {
  if (r <= 0) return mask;
  const pass = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(size - 1, x + r); k += 1) {
        const v = mask[y * size + k];
        if (v > m) m = v;
      }
      pass[y * size + x] = m;
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(size - 1, y + r); k += 1) {
        const v = pass[k * size + x];
        if (v > m) m = v;
      }
      out[y * size + x] = m;
    }
  }
  return out;
}

/** Separable box blur, run twice so the falloff is smooth rather than linear. */
function blurMask(mask, size, r, passes = 2) {
  if (r <= 0) return mask;
  let src = mask;
  for (let p = 0; p < passes; p += 1) {
    const mid = new Float32Array(size * size);
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(size - 1, x + r); k += 1) {
          sum += src[y * size + k];
          n += 1;
        }
        mid[y * size + x] = sum / n;
      }
    }
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(size - 1, y + r); k += 1) {
          sum += mid[k * size + x];
          n += 1;
        }
        out[y * size + x] = sum / n;
      }
    }
    src = out;
  }
  return src;
}

function shiftMask(mask, size, dy) {
  if (dy === 0) return mask;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= size) continue;
    out.set(mask.subarray(sy * size, sy * size + size), y * size);
  }
  return out;
}

/** Source-over blend of one straight-alpha colour onto the canvas. */
function blend(data, idx, rgb, a) {
  if (a <= 0) return;
  const dstA = data[idx + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let i = 0; i < 3; i += 1) {
    data[idx + i] = Math.round((rgb[i] * a + data[idx + i] * dstA * (1 - a)) / outA);
  }
  data[idx + 3] = Math.round(outA * 255);
}

function paintMask(img, mask, rgb, opacity) {
  const { data } = img.bitmap;
  for (let i = 0; i < mask.length; i += 1) {
    const a = mask[i] * opacity;
    if (a > 0.002) blend(data, i * 4, rgb, Math.min(1, a));
  }
}

/** Antialiased ring plus a faint disc, marking the selected vehicle. */
function drawRing(img, size, radius, thickness, rgb) {
  const { data } = img.bitmap;
  const c = size / 2;
  const half = thickness / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const idx = (y * size + x) * 4;
      if (d < radius - half) {
        blend(data, idx, rgb, 0.1);
        continue;
      }
      const alpha = Math.max(0, Math.min(1, half + 0.5 - Math.abs(d - radius)));
      if (alpha > 0) blend(data, idx, rgb, alpha * 0.95);
    }
  }
}

async function build() {
  const source = await Jimp.read(SRC);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let count = 0;

  for (const [state, { color, muted }] of Object.entries(STATE_COLORS)) {
    const rgb = hexToRgb(color);
    for (const [variant, layout] of Object.entries(VARIANTS)) {
      for (const scale of SCALES) {
        const size = Math.round(layout.canvas * scale);
        const carH = Math.round(layout.car * scale);
        const carW = Math.round(carH * CAR_ASPECT);
        const carX = Math.round((size - carW) / 2);
        const carY = Math.round((size - carH) / 2);

        const canvas = new Jimp(size, size, 0x00000000);
        const car = source.clone().resize(carW, carH, Jimp.RESIZE_BICUBIC);
        if (muted) desaturate(car, 0.82, 0.88);
        const body = maskFrom(car, size, carX, carY);

        // Contact shadow: the car's own shape, blurred and nudged down, which
        // is what lifts a flat top-down render off the map tiles.
        const drop = Math.max(1, Math.round(1.6 * scale));
        paintMask(canvas, blurMask(shiftMask(body, size, drop), size, drop), SHADOW_RGB, 0.4);

        // Status halo: the silhouette grown by a fixed ring of pixels, then
        // softened. Dilating before blurring keeps the colour tight to the car
        // instead of fading out from under it.
        // A slate halo has far less contrast against the map than green or red
        // does, so the offline states get a wider, fully opaque one.
        const grow = Math.max(1, Math.round((muted ? 2.1 : 1.7) * scale));
        const soften = Math.max(1, Math.round(1.5 * scale));
        paintMask(canvas, blurMask(dilate(body, size, grow), size, soften), rgb, muted ? 1 : 0.86);

        if (layout.ring > 0) {
          drawRing(canvas, size, size / 2 - layout.ring * scale - 1, layout.ring * scale, rgb);
        }

        canvas.composite(car, carX, carY);

        const suffix = scale === 1 ? '' : `@${scale}x`;
        const name = `vehicle_${state}${variant === 'selected' ? '_selected' : ''}${suffix}.png`;
        await canvas.writeAsync(path.join(OUT_DIR, name));
        count += 1;
      }
    }
  }

  console.log(`Wrote ${count} sprites to assets/markers/vehicle`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
