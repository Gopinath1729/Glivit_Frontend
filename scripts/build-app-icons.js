#!/usr/bin/env node
/* global __dirname */
/**
 * Derives the GLIVT app icons from the master brand logo.
 *
 * assets/images/logo.png is the full lockup -- the G mark above a "GLIVT FLEET
 * MANAGEMENT" wordmark. At launcher size the wordmark is an illegible smudge, so
 * the mark alone is cropped out, centred on a square brand-navy canvas and
 * padded to survive Android's adaptive-icon mask (which can crop to a circle and
 * clips roughly the outer 1/6 on every edge).
 *
 * Run after changing the brand logo:
 *   node ./scripts/build-app-icons.js
 */
const path = require('path');
const Jimp = require('jimp-compact');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'images', 'logo.png');
const OUT = path.join(ROOT, 'assets', 'images');

const CANVAS = 1024;
const BRAND_NAVY = 0x0b161eff;
// Fraction of the canvas the mark occupies. Adaptive icons keep only the middle
// ~66%, so the mark stays well inside that safe zone.
const MARK_SCALE = 0.68;
const MARK_SCALE_FOREGROUND = 0.52;

/** Bounding box of the mark, ignoring the flat background and the wordmark band. */
async function markBounds(img) {
  const { width, height } = img.bitmap;
  const bg = Jimp.intToRGBA(img.getPixelColor(4, 4));
  const wordmarkTop = Math.floor(height * 0.62);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < wordmarkTop; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = Jimp.intToRGBA(img.getPixelColor(x, y));
      const delta = Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b);
      if (delta > 60 && p.a > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Replaces the logo's flat background with transparency.
 *
 * logo.png is artwork on a solid dark panel, not a transparent PNG, so a crop of
 * it carries that panel along as an opaque rectangle. Composited onto the splash
 * -- which is a gradient, not one flat colour -- the rectangle does not match its
 * surroundings and shows as a visible box around the mark.
 *
 * The background is uniform (rgb 12,21,30) and the mark is bright, so distance
 * from that colour separates them cleanly. The ramp between the two thresholds
 * keeps edge pixels partly transparent instead of leaving a hard, aliased
 * outline.
 */
function keyOutBackground(image, background) {
  const CLEAR_BELOW = 30;
  const OPAQUE_ABOVE = 90;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
    const data = this.bitmap.data;
    const distance =
      Math.abs(data[idx] - background.r) +
      Math.abs(data[idx + 1] - background.g) +
      Math.abs(data[idx + 2] - background.b);
    if (distance <= CLEAR_BELOW) {
      data[idx + 3] = 0;
    } else if (distance < OPAQUE_ABOVE) {
      const ratio = (distance - CLEAR_BELOW) / (OPAQUE_ABOVE - CLEAR_BELOW);
      data[idx + 3] = Math.round(data[idx + 3] * ratio);
    }
  });
  return image;
}

/** The mark, cropped and scaled to sit centred inside a square of `canvas` px. */
async function scaledMark(canvas, scale) {
  const logo = await Jimp.read(SOURCE);
  const box = await markBounds(logo);
  const background = Jimp.intToRGBA(logo.getPixelColor(4, 4));
  const mark = keyOutBackground(logo.clone().crop(box.x, box.y, box.w, box.h), background);
  const target = Math.round(canvas * scale);
  // contain() preserves aspect ratio; the mark is wider than it is tall.
  mark.contain(target, target);
  return mark;
}

async function write(name, image) {
  const file = path.join(OUT, name);
  await image.writeAsync(file);
  console.log(`  ${name}  ${image.bitmap.width}x${image.bitmap.height}`);
}

async function main() {
  console.log('Building GLIVT app icons from logo.png');

  // iOS / web icon: opaque square, no transparency (App Store rejects alpha).
  const icon = new Jimp(CANVAS, CANVAS, BRAND_NAVY);
  const mark = await scaledMark(CANVAS, MARK_SCALE);
  icon.composite(mark, Math.round((CANVAS - mark.bitmap.width) / 2),
    Math.round((CANVAS - mark.bitmap.height) / 2));
  await write('icon.png', icon);

  // Android adaptive foreground: transparent, mark kept smaller for the mask.
  const foreground = new Jimp(CANVAS, CANVAS, 0x00000000);
  const fgMark = await scaledMark(CANVAS, MARK_SCALE_FOREGROUND);
  foreground.composite(fgMark, Math.round((CANVAS - fgMark.bitmap.width) / 2),
    Math.round((CANVAS - fgMark.bitmap.height) / 2));
  await write('android-icon-foreground.png', foreground);

  // Adaptive background: flat brand navy behind the foreground.
  await write('android-icon-background.png', new Jimp(CANVAS, CANVAS, BRAND_NAVY));

  // Monochrome (themed icons, Android 13+): silhouette of the mark.
  const mono = new Jimp(CANVAS, CANVAS, 0x00000000);
  const monoMark = (await scaledMark(CANVAS, MARK_SCALE_FOREGROUND)).greyscale().contrast(1);
  mono.composite(monoMark, Math.round((CANVAS - monoMark.bitmap.width) / 2),
    Math.round((CANVAS - monoMark.bitmap.height) / 2));
  await write('android-icon-monochrome.png', mono);

  // Splash artwork: the mark edge-to-edge on transparency.
  //
  // Deliberately unpadded, unlike the launcher icons. Whatever draws this adds
  // its own sizing, so padding baked in here would compound with it -- the mark
  // was landing at 0.72 x 0.36 of the screen and sat lost inside the splash
  // rings instead of filling them.
  const splash = new Jimp(CANVAS, CANVAS, 0x00000000);
  const splashMark = await scaledMark(CANVAS, 1);
  splash.composite(splashMark, Math.round((CANVAS - splashMark.bitmap.width) / 2),
    Math.round((CANVAS - splashMark.bitmap.height) / 2));
  await write('splash-icon.png', splash);

  // Favicon for the web build.
  const favicon = icon.clone().resize(48, 48);
  await write('favicon.png', favicon);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
