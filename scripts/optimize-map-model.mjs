/**
 * Build a lightweight GLB for an interactive map marker.
 *
 * Usage:
 *   node scripts/optimize-map-model.mjs models/bike.glb models/bike-map.glb 0.14 0.025
 *
 * The source model is retained for high-resolution renders. The map gets a
 * compact copy because it is redrawn continuously while the camera follows a
 * moving vehicle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BufferAttribute } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

const [, , inputArgument, outputArgument, ratioArgument = '0.18', errorArgument = '0.03'] = process.argv;
if (!inputArgument || !outputArgument) {
  throw new Error('Expected an input GLB and output GLB path.');
}

const ratio = Number(ratioArgument);
const targetError = Number(errorArgument);
if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
  throw new Error('The simplification ratio must be between 0 and 1.');
}
if (!Number.isFinite(targetError) || targetError <= 0 || targetError >= 1) {
  throw new Error('The simplification error must be between 0 and 1.');
}

// Three's Node loader/exporter use these browser types for progress and Blob
// conversion. The model has no image textures, so no DOM canvas is required.
globalThis.ProgressEvent ??= class ProgressEvent {};
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    }, (error) => this.onerror?.(error));
  }

  readAsDataURL(blob) {
    blob.arrayBuffer().then((value) => {
      const bytes = Buffer.from(value);
      this.result = `data:${blob.type};base64,${bytes.toString('base64')}`;
      this.onloadend?.();
    }, (error) => this.onerror?.(error));
  }
};

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const source = readFileSync(inputPath);
const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);

await MeshoptSimplifier.ready;
const gltf = await new Promise((resolveLoad, rejectLoad) => {
  new GLTFLoader().parse(sourceBuffer, '', resolveLoad, rejectLoad);
});

let originalTriangles = 0;
let mapTriangles = 0;
let simplifiedMeshes = 0;

gltf.scene.traverse((node) => {
  if (!node.isMesh || !node.geometry?.getAttribute('position')) return;

  const sourceGeometry = node.geometry;
  originalTriangles += (sourceGeometry.getIndex()?.count ?? sourceGeometry.getAttribute('position').count) / 3;

  // Map markers use solid materials and occupy only a small part of the
  // viewport. Removing unused UVs and rebuilding normals allows vertices split
  // only for texture seams or hard edges to be merged before simplification.
  let geometry = sourceGeometry.clone();
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('tangent');
  geometry.deleteAttribute('uv');
  geometry = mergeVertices(geometry, 0.0001);
  const originalIndex = geometry.getIndex();
  if (!originalIndex || geometry.groups.length > 0) return;

  const position = geometry.getAttribute('position');
  const indices = new Uint32Array(originalIndex.count);
  for (let index = 0; index < originalIndex.count; index += 1) {
    indices[index] = originalIndex.getX(index);
  }

  const positions = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) {
    const offset = index * 3;
    positions[offset] = position.getX(index);
    positions[offset + 1] = position.getY(index);
    positions[offset + 2] = position.getZ(index);
  }

  const targetCount = Math.max(12, Math.floor((indices.length * ratio) / 3) * 3);
  const [reduced] = MeshoptSimplifier.simplify(indices, positions, 3, targetCount, targetError);
  const compactIndices = new Uint32Array(reduced);
  const [remap, vertexCount] = MeshoptSimplifier.compactMesh(compactIndices);
  const optimized = geometry.clone();

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const AttributeArray = attribute.array.constructor;
    const array = new AttributeArray(vertexCount * attribute.itemSize);
    for (let sourceVertex = 0; sourceVertex < remap.length; sourceVertex += 1) {
      const targetVertex = remap[sourceVertex];
      if (targetVertex >= vertexCount) continue;
      for (let component = 0; component < attribute.itemSize; component += 1) {
        array[targetVertex * attribute.itemSize + component] =
          attribute.array[sourceVertex * attribute.itemSize + component];
      }
    }
    optimized.setAttribute(name, new BufferAttribute(array, attribute.itemSize, attribute.normalized));
  }

  const CompactIndex = vertexCount <= 65_535 ? Uint16Array : Uint32Array;
  optimized.setIndex(new BufferAttribute(new CompactIndex(compactIndices), 1));
  optimized.computeVertexNormals();
  optimized.computeBoundingBox();
  optimized.computeBoundingSphere();
  node.geometry = optimized;
  mapTriangles += compactIndices.length / 3;
  simplifiedMeshes += 1;
});

const exported = await new GLTFExporter().parseAsync(gltf.scene, {
  binary: true,
  includeCustomExtensions: true,
  onlyVisible: false,
});
writeFileSync(outputPath, Buffer.from(exported));

console.log(JSON.stringify({
  input: inputPath,
  output: outputPath,
  simplifiedMeshes,
  originalTriangles,
  mapTriangles,
  reductionPercent: Math.round((1 - mapTriangles / originalTriangles) * 100),
}, null, 2));
