/* eslint-disable no-console */
/**
 * Builds compact, runtime-safe geometry and an exact catalogue from every GLB
 * in the models folder.
 *
 * The source files contain hundreds of thousands of triangles split across
 * roughly a thousand draw primitives. Loading those primitives directly in an
 * Expo GLView is both slow and unreliable on mobile. This script flattens the
 * real scene graph, groups surfaces into five useful materials, and applies a
 * topology-preserving vertex-cluster reduction. The original GLBs remain the
 * source of truth and are never modified.
 *
 * Run:
 *   node scripts/build-mobile-car-models.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const THREE = require('three');

const ROOT = path.resolve(__dirname, '..');
// About 55k triangles retains body creases and wheel detail while five merged
// draw calls remain dramatically cheaper than the source's 920–1,437 calls.
const TARGET_TRIANGLES = 55_000;
const MODELS = [
  {
    id: 'black',
    label: 'Bugatti Atlantic',
    category: 'car',
    source: 'black-car.glb',
    output: 'black-car.mobile.json',
    paintColor: '#101820',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.85,
  },
  {
    id: 'white',
    label: 'BMW M8',
    category: 'car',
    source: 'white-car.glb',
    output: 'white-car.mobile.json',
    paintColor: '#F4F6F8',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.87,
  },
  {
    id: 'gallardo',
    label: 'Lamborghini Gallardo',
    category: 'car',
    source: '2009_lamborghini_gallardo_lp560-4_spyder.glb',
    output: 'gallardo.mobile.json',
    paintColor: '#F2B705',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.35,
  },
  {
    id: 'audi-r8',
    label: 'Audi R8 LMS',
    category: 'car',
    source: '2015_audi_r8_lms_ultra.glb',
    output: 'audi-r8.mobile.json',
    paintColor: '#DCE4EA',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.62,
  },
  {
    id: 'porsche-cayman',
    label: 'Porsche 718 Cayman',
    category: 'car',
    source: '2018_porsche_718_cayman_gts.glb',
    output: 'porsche-cayman.mobile.json',
    paintColor: '#E8EEF2',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.39,
  },
  {
    id: 'porsche-spyder',
    label: 'Porsche 718 Spyder',
    category: 'car',
    source: '2020_porsche_718_spyder.glb',
    output: 'porsche-spyder.mobile.json',
    paintColor: '#40A8E0',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.43,
  },
  {
    id: 'concept',
    label: 'Concept Car',
    category: 'car',
    source: 'model.glb',
    output: 'concept.mobile.json',
    paintColor: '#C7D2DC',
    sourceYawDegrees: 0,
    targetLengthMeters: 4.55,
  },
  {
    id: 'sports-bike',
    label: 'Red Sport Bike',
    category: 'bike',
    source: 'sports_bike.glb',
    output: 'sports-bike.mobile.json',
    paintColor: '#D62828',
    sourceYawDegrees: 180,
    targetLengthMeters: 2.12,
  },
  {
    id: 'suzuki-gsx',
    label: 'Suzuki GSX 750',
    category: 'bike',
    source: 'suzuki_gsx_750_bike.glb',
    output: 'suzuki-gsx.mobile.json',
    paintColor: '#C8161D',
    sourceYawDegrees: 180,
    targetLengthMeters: 2.05,
  },
  {
    id: 'street-bike',
    label: 'Naked Street Bike',
    category: 'bike',
    source: 'three_cylinder_naked_street_bike.glb',
    output: 'street-bike.mobile.json',
    paintColor: '#1D2733',
    sourceYawDegrees: 180,
    targetLengthMeters: 2.08,
  },
  {
    id: 'truck',
    label: 'Long-Haul Truck',
    category: 'truck',
    source: 'truck.glb',
    output: 'truck.mobile.json',
    paintColor: '#E6EEF5',
    sourceYawDegrees: 0,
    targetLengthMeters: 12.2,
  },
];
const PART_ORDER = ['paint', 'glass', 'wheel', 'light', 'detail'];
const COMPONENT_READERS = {
  5120: { bytes: 1, read: 'readInt8' },
  5121: { bytes: 1, read: 'readUInt8' },
  5122: { bytes: 2, read: 'readInt16LE' },
  5123: { bytes: 2, read: 'readUInt16LE' },
  5125: { bytes: 4, read: 'readUInt32LE' },
  5126: { bytes: 4, read: 'readFloatLE' },
};
const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function parseGlb(filePath) {
  const file = fs.readFileSync(filePath);
  if (file.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`${filePath} is not a binary glTF file`);
  }

  let json = null;
  let binary = null;
  let offset = 12;
  while (offset + 8 <= file.length) {
    const chunkLength = file.readUInt32LE(offset);
    const chunkType = file.readUInt32LE(offset + 4);
    const chunk = file.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(chunk.toString('utf8').replace(/\u0000+$/g, '').trim());
    } else if (chunkType === 0x004e4942) {
      binary = chunk;
    }
    offset += 8 + chunkLength;
  }
  if (!json || !binary) throw new Error(`Missing JSON or BIN chunk in ${filePath}`);
  return { file, json, binary };
}

function classifyMaterial(material) {
  const name = String(material?.name ?? '').toLowerCase();
  if (
    name.includes('paint') ||
    name.includes('bodycolour') ||
    name.includes('body color') ||
    name.includes('car_paint') ||
    name.includes('carpaint')
  ) {
    return 'paint';
  }
  if (
    name.includes('window') ||
    name.includes('glass') ||
    name.includes('windglass') ||
    name.includes('windshield')
  ) {
    return 'glass';
  }
  if (
    name.includes('light') ||
    name.includes('lamp') ||
    name.includes('signal') ||
    name.includes('projector') ||
    name.includes('red_glass') ||
    name.includes('red glass')
  ) {
    return 'light';
  }
  if (
    name.includes('wheel') ||
    name.includes('tyre') ||
    name.includes('tire') ||
    name.includes('rim') ||
    name.includes('brake') ||
    name.includes('calliper') ||
    name.includes('caliper')
  ) {
    return 'wheel';
  }
  return 'detail';
}

function createAccessorReader(gltf, binary, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  if (accessor.sparse) {
    throw new Error(`Sparse accessor ${accessorIndex} is not supported by the mobile model builder`);
  }
  const view = gltf.bufferViews[accessor.bufferView];
  const component = COMPONENT_READERS[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  if (!component || !components) throw new Error(`Unsupported accessor ${accessorIndex}`);

  const itemBytes = component.bytes * components;
  const stride = view.byteStride ?? itemBytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return {
    count: accessor.count,
    components,
    read(item, componentIndex = 0) {
      return binary[component.read](start + item * stride + componentIndex * component.bytes);
    },
  };
}

function collectSceneGeometry(gltf, binary) {
  const parts = Object.fromEntries(
    PART_ORDER.map((kind) => [kind, { positions: [], normals: [], indices: [] }])
  );
  const sourceStats = { primitives: 0, triangles: 0, vertices: 0 };
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  function appendPrimitive(primitive, worldMatrix) {
    if (primitive.mode != null && primitive.mode !== 4) return;
    if (primitive.attributes?.POSITION == null) return;

    const material = gltf.materials?.[primitive.material ?? -1];
    const target = parts[classifyMaterial(material)];
    const positions = createAccessorReader(gltf, binary, primitive.attributes.POSITION);
    const normals =
      primitive.attributes.NORMAL != null
        ? createAccessorReader(gltf, binary, primitive.attributes.NORMAL)
        : null;
    const indices =
      primitive.indices != null ? createAccessorReader(gltf, binary, primitive.indices) : null;
    const baseIndex = target.positions.length / 3;
    normalMatrix.getNormalMatrix(worldMatrix);

    for (let i = 0; i < positions.count; i += 1) {
      position
        .set(positions.read(i, 0), positions.read(i, 1), positions.read(i, 2))
        .applyMatrix4(worldMatrix);
      target.positions.push(position.x, position.y, position.z);

      if (normals) {
        normal
          .set(normals.read(i, 0), normals.read(i, 1), normals.read(i, 2))
          .applyNormalMatrix(normalMatrix);
        target.normals.push(normal.x, normal.y, normal.z);
      } else {
        target.normals.push(0, 1, 0);
      }
    }

    const indexCount = indices?.count ?? positions.count;
    const triangleCount = Math.floor(indexCount / 3);
    for (let i = 0; i < triangleCount * 3; i += 1) {
      target.indices.push(baseIndex + (indices ? indices.read(i) : i));
    }

    sourceStats.primitives += 1;
    sourceStats.triangles += triangleCount;
    sourceStats.vertices += positions.count;
  }

  function traverse(nodeIndex, parentMatrix) {
    const node = gltf.nodes[nodeIndex];
    const local = new THREE.Matrix4();
    if (node.matrix) {
      local.fromArray(node.matrix);
    } else {
      local.compose(
        new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1])
      );
    }
    const world = parentMatrix.clone().multiply(local);
    if (node.mesh != null) {
      for (const primitive of gltf.meshes[node.mesh].primitives ?? []) {
        appendPrimitive(primitive, world);
      }
    }
    for (const child of node.children ?? []) traverse(child, world);
  }

  const scene = gltf.scenes[gltf.scene ?? 0] ?? gltf.scenes[0];
  const identity = new THREE.Matrix4();
  for (const node of scene.nodes ?? []) traverse(node, identity);
  return { parts, sourceStats };
}

function geometryBounds(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of Object.values(parts)) {
    for (let i = 0; i < part.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], part.positions[i + axis]);
        max[axis] = Math.max(max[axis], part.positions[i + axis]);
      }
    }
  }
  return { min, max };
}

function simplifyPart(source, bounds, cellSize) {
  if (source.indices.length === 0) {
    return { positions: [], normals: [], indices: [] };
  }

  const clusters = new Map();
  const remap = new Uint32Array(source.positions.length / 3);
  const min = bounds.min;

  for (let i = 0; i < remap.length; i += 1) {
    const p = i * 3;
    const nx = source.normals[p];
    const ny = source.normals[p + 1];
    const nz = source.normals[p + 2];
    // The coarse normal cell keeps body creases, glass edges and wheel faces
    // sharp even when their positions share a spatial cluster.
    const key = [
      Math.round((source.positions[p] - min[0]) / cellSize),
      Math.round((source.positions[p + 1] - min[1]) / cellSize),
      Math.round((source.positions[p + 2] - min[2]) / cellSize),
      Math.round(nx * 3),
      Math.round(ny * 3),
      Math.round(nz * 3),
    ].join(',');
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        index: clusters.size,
        count: 0,
        px: 0,
        py: 0,
        pz: 0,
        nx: 0,
        ny: 0,
        nz: 0,
      };
      clusters.set(key, cluster);
    }
    cluster.count += 1;
    cluster.px += source.positions[p];
    cluster.py += source.positions[p + 1];
    cluster.pz += source.positions[p + 2];
    cluster.nx += nx;
    cluster.ny += ny;
    cluster.nz += nz;
    remap[i] = cluster.index;
  }

  const positions = new Array(clusters.size * 3);
  const normals = new Array(clusters.size * 3);
  for (const cluster of clusters.values()) {
    const p = cluster.index * 3;
    positions[p] = cluster.px / cluster.count;
    positions[p + 1] = cluster.py / cluster.count;
    positions[p + 2] = cluster.pz / cluster.count;
    const length = Math.hypot(cluster.nx, cluster.ny, cluster.nz) || 1;
    normals[p] = cluster.nx / length;
    normals[p + 1] = cluster.ny / length;
    normals[p + 2] = cluster.nz / length;
  }

  const indices = [];
  const seen = new Set();
  for (let i = 0; i < source.indices.length; i += 3) {
    const a = remap[source.indices[i]];
    const b = remap[source.indices[i + 1]];
    const c = remap[source.indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    const key = `${a},${b},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indices.push(a, b, c);
  }

  // Remove clusters left unused after degenerate triangles were discarded.
  const compactRemap = new Map();
  const compactPositions = [];
  const compactNormals = [];
  for (let i = 0; i < indices.length; i += 1) {
    const oldIndex = indices[i];
    let nextIndex = compactRemap.get(oldIndex);
    if (nextIndex == null) {
      nextIndex = compactRemap.size;
      compactRemap.set(oldIndex, nextIndex);
      compactPositions.push(
        positions[oldIndex * 3],
        positions[oldIndex * 3 + 1],
        positions[oldIndex * 3 + 2]
      );
      compactNormals.push(
        normals[oldIndex * 3],
        normals[oldIndex * 3 + 1],
        normals[oldIndex * 3 + 2]
      );
    }
    indices[i] = nextIndex;
  }

  return { positions: compactPositions, normals: compactNormals, indices };
}

function simplifyToTarget(parts, bounds, targetTriangles) {
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const diagonal = Math.hypot(...size);
  const sourceTriangles = Object.values(parts).reduce(
    (total, part) => total + part.indices.length / 3,
    0
  );

  function simplify(cellSize) {
    const result = Object.fromEntries(
      PART_ORDER.map((kind) => [kind, simplifyPart(parts[kind], bounds, cellSize)])
    );
    const triangles = Object.values(result).reduce(
      (total, part) => total + part.indices.length / 3,
      0
    );
    return { result, triangles };
  }

  if (sourceTriangles <= targetTriangles) {
    return { result: parts, triangles: sourceTriangles, cellSize: 0 };
  }

  // A full binary search reclusters every source vertex on every iteration and
  // can take close to an hour for the 600k+ triangle bikes. Two adaptive passes
  // reach the same mobile budget while keeping generation bounded.
  let cellSize = diagonal / 28;
  let best = simplify(cellSize);
  if (best.triangles > targetTriangles * 1.12 || best.triangles < targetTriangles * 0.72) {
    const ratio = Math.max(0.3, best.triangles / targetTriangles);
    cellSize *= Math.max(0.68, Math.min(1.8, Math.sqrt(ratio)));
    const candidate = simplify(cellSize);
    const bestDistance = Math.abs(best.triangles - targetTriangles);
    const candidateDistance = Math.abs(candidate.triangles - targetTriangles);
    if (candidateDistance < bestDistance || candidate.triangles <= targetTriangles * 1.12) {
      best = candidate;
    }
  }
  return { ...best, cellSize };
}

function roundArray(values, digits) {
  const factor = 10 ** digits;
  return values.map((value) => Math.round(value * factor) / factor);
}

function buildModel(definition) {
  const sourcePath = path.join(ROOT, 'models', definition.source);
  const outputPath = path.join(ROOT, 'models', definition.output);
  const sourceFile = fs.readFileSync(sourcePath);
  const sourceSha256 = crypto.createHash('sha256').update(sourceFile).digest('hex');
  if (process.argv.includes('--resume') && fs.existsSync(outputPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (
        cached.version === 3 &&
        cached.id === definition.id &&
        cached.sourceSha256 === sourceSha256 &&
        cached.sourceYawDegrees === definition.sourceYawDegrees
      ) {
        const outputBytes = fs.statSync(outputPath).size;
        console.log(`Reusing ${definition.output} (${(outputBytes / 1024 / 1024).toFixed(2)} MB)`);
        return {
          id: definition.id,
          label: definition.label,
          category: definition.category,
          source: definition.source,
          mobileAsset: definition.output,
          sourceSha256,
          sourceBytes: sourceFile.length,
          sourceYawDegrees: definition.sourceYawDegrees,
          targetLengthMeters: definition.targetLengthMeters,
          paintColor: definition.paintColor,
          bounds: cached.bounds,
          sourceStats: cached.sourceStats,
          optimizedStats: cached.optimizedStats,
          mobileBytes: outputBytes,
        };
      }
    } catch {
      // A partial/interrupted file is rebuilt below.
    }
  }
  console.log(`Reading ${definition.source}...`);
  const { file, json, binary } = parseGlb(sourcePath);
  const { parts, sourceStats } = collectSceneGeometry(json, binary);
  const bounds = geometryBounds(parts);
  console.log(
    `  Source: ${sourceStats.primitives} primitives, ${sourceStats.triangles.toLocaleString()} triangles`
  );

  const simplified = simplifyToTarget(parts, bounds, TARGET_TRIANGLES);
  const outputParts = PART_ORDER.map((kind) => {
    const part = simplified.result[kind];
    return {
      kind,
      positions: roundArray(part.positions, 5),
      normals: roundArray(part.normals, 4),
      indices: part.indices,
    };
  }).filter((part) => part.indices.length > 0);
  const outputVertices = outputParts.reduce((sum, part) => sum + part.positions.length / 3, 0);

  const payload = {
    version: 3,
    id: definition.id,
    label: definition.label,
    category: definition.category,
    source: definition.source,
    sourceSha256,
    sourceBytes: file.length,
    sourceYawDegrees: definition.sourceYawDegrees,
    targetLengthMeters: definition.targetLengthMeters,
    paintColor: definition.paintColor,
    bounds,
    sourceStats,
    optimizedStats: {
      drawCalls: outputParts.length,
      triangles: simplified.triangles,
      vertices: outputVertices,
      clusterSize: Number(simplified.cellSize.toFixed(6)),
    },
    parts: outputParts,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload));
  const outputBytes = fs.statSync(outputPath).size;
  console.log(
    `  Output: ${outputParts.length} draw calls, ${simplified.triangles.toLocaleString()} triangles, ` +
      `${outputVertices.toLocaleString()} vertices, ${(outputBytes / 1024 / 1024).toFixed(2)} MB`
  );
  return {
    id: definition.id,
    label: definition.label,
    category: definition.category,
    source: definition.source,
    mobileAsset: definition.output,
    sourceSha256: payload.sourceSha256,
    sourceBytes: file.length,
    sourceYawDegrees: definition.sourceYawDegrees,
    targetLengthMeters: definition.targetLengthMeters,
    paintColor: definition.paintColor,
    bounds,
    sourceStats,
    optimizedStats: payload.optimizedStats,
    mobileBytes: outputBytes,
  };
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  modelCount: MODELS.length,
  models: MODELS.map(buildModel),
};
fs.writeFileSync(path.join(ROOT, 'models', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote models/catalog.json with ${catalog.modelCount} models.`);
