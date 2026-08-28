#!/usr/bin/env node
/* global __dirname */
/**
 * Bakes the web-map vehicle marker PNG into a base64 data URI module.
 *
 * The MapLibre map runs inside a WebView loaded from `source={{ html }}` with
 * no baseUrl, so the document has an opaque origin: it cannot load file:// or
 * asset:// images at all. Reading the bundled PNG at runtime does not work
 * either -- in a release build expo-asset resolves it to an asset:// URI that
 * expo-file-system refuses to read -- which left the marker <img> broken and
 * the vehicles invisible on device. A data URI is the only form the WebView
 * will render, so it is generated here and shipped inside the JS bundle.
 *
 * Run after changing the marker artwork:
 *   node ./scripts/build-web-marker-data-uri.js
 */
const fs = require('fs');
const path = require('path');

const SOURCE_PNG = path.join(__dirname, '..', 'assets', 'markers', 'car-marker-photorealistic-v4-map.png');
const OUTPUT_TS = path.join(__dirname, '..', 'src', 'components', 'webMarkerImage.ts');

const base64 = fs.readFileSync(SOURCE_PNG).toString('base64');
const relativeSource = path.relative(path.join(__dirname, '..'), SOURCE_PNG).split(path.sep).join('/');

const contents = `/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: ${relativeSource}
 * Regenerate: node ./scripts/build-web-marker-data-uri.js
 *
 * See scripts/build-web-marker-data-uri.js for why the WebView map needs the
 * marker artwork as a data URI rather than a bundled asset reference.
 */
export const WEB_MARKER_DATA_URI =
  'data:image/png;base64,${base64}';
`;

fs.writeFileSync(OUTPUT_TS, contents, 'utf8');
console.log(`Wrote ${OUTPUT_TS} (${base64.length} base64 chars from ${fs.statSync(SOURCE_PNG).size} bytes)`);
