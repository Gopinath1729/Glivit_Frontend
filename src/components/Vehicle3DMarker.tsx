import type { ExpoWebGLRenderingContext } from 'expo-gl';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Image, type ImageSourcePropType, StyleSheet, View } from 'react-native';
import * as THREE from 'three';

import { createExpoThreeRenderer } from '@/src/services/expoThreeRenderer';

import { SafeGLView } from './SafeGLView';

/**
 * A real-model 3D vehicle marker.
 *
 * Every GLB in /models is represented by a generated mobile JSON derivative.
 * The real silhouettes remain intact while hundreds of source primitives are
 * collapsed into a handful of cached GPU geometries.
 */

export const VEHICLE_MODEL_IDS = [
  'black',
  'white',
  'gallardo',
  'audi-r8',
  'porsche-cayman',
  'porsche-spyder',
  'concept',
  'sports-bike',
  'suzuki-gsx',
  'street-bike',
  'truck',
] as const;
export type CarVariant = (typeof VEHICLE_MODEL_IDS)[number];
type CarPartKind = 'paint' | 'glass' | 'wheel' | 'light' | 'detail';
type MobileCarAsset = {
  version: number;
  id: CarVariant;
  label: string;
  category: VehicleModelCategory;
  source: string;
  sourceSha256: string;
  sourceYawDegrees: number;
  targetLengthMeters: number;
  paintColor: string;
  bounds: { min: number[]; max: number[] };
  parts: {
    kind: CarPartKind;
    positions: number[];
    normals: number[];
    indices: number[];
  }[];
};
export type VehicleModelCategory = 'car' | 'bike' | 'truck';
export type VehicleModelOption = {
  id: CarVariant;
  label: string;
  category: VehicleModelCategory;
  paintColor: string;
  source: string;
  mobileAsset: string;
  sourceSha256: string;
  sourceYawDegrees: number;
  targetLengthMeters: number;
};
type VehicleModelCatalog = {
  schemaVersion: number;
  modelCount: number;
  models: VehicleModelOption[];
};

interface Vehicle3DMarkerProps {
  heading: number;
  speed: number;
  isActive: boolean;
  variant?: CarVariant;
  size?: number;
  showImageFallback?: boolean;
  renderMode?: 'webgl' | 'image';
}

const BODY_GEO = new THREE.BoxGeometry(2, 0.55, 4);
const CABIN_GEO = new THREE.BoxGeometry(1.6, 0.55, 1.9);
const WHEEL_GEO = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 14);
const FALLBACK_MARKERS: Record<VehicleModelCategory, ImageSourcePropType> = {
  car: require('../../assets/markers/car_running.png'),
  bike: require('../../assets/markers/veh_bike.png'),
  truck: require('../../assets/markers/veh_truck.png'),
};
const MODEL_GEOMETRIES: Partial<Record<CarVariant, Map<CarPartKind, THREE.BufferGeometry>>> = {};
const MODEL_GEOMETRY_USERS: Partial<Record<CarVariant, number>> = {};
const MODEL_LOAD_FAILED: Partial<Record<CarVariant, boolean>> = {};
const MODEL_ASSETS: Partial<Record<CarVariant, MobileCarAsset>> = {};
const CATALOG = require('../../models/catalog.json') as VehicleModelCatalog;
export const VEHICLE_MODELS = CATALOG.models.filter((model) =>
  VEHICLE_MODEL_IDS.includes(model.id)
);

function loadMobileModel(variant: CarVariant): MobileCarAsset {
  // Static paths are intentional: Metro must discover every generated JSON.
  switch (variant) {
    case 'black':
      return require('../../models/black-car.mobile.json') as MobileCarAsset;
    case 'white':
      return require('../../models/white-car.mobile.json') as MobileCarAsset;
    case 'gallardo':
      return require('../../models/gallardo.mobile.json') as MobileCarAsset;
    case 'audi-r8':
      return require('../../models/audi-r8.mobile.json') as MobileCarAsset;
    case 'porsche-cayman':
      return require('../../models/porsche-cayman.mobile.json') as MobileCarAsset;
    case 'porsche-spyder':
      return require('../../models/porsche-spyder.mobile.json') as MobileCarAsset;
    case 'concept':
      return require('../../models/concept.mobile.json') as MobileCarAsset;
    case 'sports-bike':
      return require('../../models/sports-bike.mobile.json') as MobileCarAsset;
    case 'suzuki-gsx':
      return require('../../models/suzuki-gsx.mobile.json') as MobileCarAsset;
    case 'street-bike':
      return require('../../models/street-bike.mobile.json') as MobileCarAsset;
    case 'truck':
      return require('../../models/truck.mobile.json') as MobileCarAsset;
  }
}

export function getVehicleModel(variant: CarVariant): VehicleModelOption {
  return VEHICLE_MODELS.find((model) => model.id === variant) ?? VEHICLE_MODELS[0];
}

export function preloadVehicleModels(): void {
  for (const variant of VEHICLE_MODEL_IDS) {
    try {
      getModelGeometries(variant);
    } catch {
      // Ignore preloading error for any specific asset
    }
  }
}

export function getModelCategory(category?: string | null): VehicleModelCategory {
  const cat = (category ?? '').toUpperCase();
  if (cat.includes('TRUCK') || cat.includes('MACHINERY') || cat.includes('MIXER')) {
    return 'truck';
  }
  if (cat.includes('BIKE') || cat.includes('MOTOR') || cat.includes('CYCLE')) {
    return 'bike';
  }
  return 'car';
}

export function modelForVehicle(category: string | null | undefined, vehicleId: string | number) {
  const normalizedCategory = (category ?? '').toUpperCase();
  const numericId = Math.abs(Number(vehicleId) || 0);
  if (normalizedCategory.includes('TRUCK') || normalizedCategory.includes('MACHINERY')) {
    return 'truck' satisfies CarVariant;
  }
  if (normalizedCategory.includes('BIKE') || normalizedCategory.includes('MOTOR')) {
    const bikes: CarVariant[] = ['sports-bike', 'suzuki-gsx', 'street-bike'];
    return bikes[numericId % bikes.length];
  }
  const cars: CarVariant[] = [
    'black',
    'white',
    'gallardo',
    'audi-r8',
    'porsche-cayman',
    'porsche-spyder',
    'concept',
  ];
  return cars[numericId % cars.length];
}

function getModelGeometries(variant: CarVariant) {
  if (MODEL_GEOMETRIES[variant] || MODEL_LOAD_FAILED[variant]) {
    return MODEL_GEOMETRIES[variant] ?? null;
  }

  try {
    if (__DEV__) {
      console.debug(`[VehicleModel] loading ${variant}`);
    }
    const data = loadMobileModel(variant);
    const catalogModel = getVehicleModel(variant);
    if (
      data.version !== 3 ||
      data.id !== variant ||
      data.source !== catalogModel.source ||
      data.sourceSha256 !== catalogModel.sourceSha256 ||
      data.sourceYawDegrees !== catalogModel.sourceYawDegrees ||
      !Number.isFinite(data.targetLengthMeters) ||
      data.targetLengthMeters <= 0 ||
      data.bounds.min.length !== 3 ||
      data.bounds.max.length !== 3 ||
      data.parts.length === 0
    ) {
      throw new Error('invalid mobile car asset');
    }
    MODEL_ASSETS[variant] = data;

    const min = new THREE.Vector3().fromArray(data.bounds.min);
    const max = new THREE.Vector3().fromArray(data.bounds.max);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const dimensions = max.clone().sub(min);
    const scale = data.targetLengthMeters / (Math.max(dimensions.x, dimensions.z) || 1);
    const yaw = THREE.MathUtils.degToRad(data.sourceYawDegrees);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const geometries = new Map<CarPartKind, THREE.BufferGeometry>();

    for (const part of data.parts) {
      const positions = new Float32Array(part.positions.length);
      const normals = new Float32Array(part.normals.length);
      for (let i = 0; i < part.positions.length; i += 3) {
        // Generated metadata rotates each source so its physical nose points
        // toward local +Z, which is the travel tangent used by both renderers.
        const x = part.positions[i] - center.x;
        const z = part.positions[i + 2] - center.z;
        positions[i] = (cosYaw * x + sinYaw * z) * scale;
        positions[i + 1] = (part.positions[i + 1] - min.y) * scale;
        positions[i + 2] = (-sinYaw * x + cosYaw * z) * scale;
        normals[i] = cosYaw * part.normals[i] + sinYaw * part.normals[i + 2];
        normals[i + 1] = part.normals[i + 1];
        normals[i + 2] = -sinYaw * part.normals[i] + cosYaw * part.normals[i + 2];
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(part.indices);
      geometry.computeBoundingSphere();
      geometries.set(part.kind, geometry);
    }

    MODEL_GEOMETRIES[variant] = geometries;
    if (__DEV__) {
      console.debug(
        `[VehicleModel] ready ${variant} (${data.source}, ${geometries.size} draw groups)`
      );
    }
    return geometries;
  } catch (error) {
    console.warn(`[Vehicle3DMarker] ${variant} model load failed; using fallback`, error);
    MODEL_LOAD_FAILED[variant] = true;
    return null;
  }
}

function retainModelGeometries(variant: CarVariant): () => void {
  MODEL_GEOMETRY_USERS[variant] = (MODEL_GEOMETRY_USERS[variant] ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (MODEL_GEOMETRY_USERS[variant] ?? 1) - 1);
    if (remaining > 0) {
      MODEL_GEOMETRY_USERS[variant] = remaining;
      return;
    }
    delete MODEL_GEOMETRY_USERS[variant];
    MODEL_GEOMETRIES[variant]?.forEach((geometry) => geometry.dispose());
    delete MODEL_GEOMETRIES[variant];
    delete MODEL_ASSETS[variant];
  };
}

function materialForPart(
  kind: CarPartKind,
  model: MobileCarAsset,
  detailIsBody: boolean
): THREE.Material {
  if (kind === 'paint') {
    const black = model.id === 'black' || model.paintColor.toLowerCase() === '#101820';
    return new THREE.MeshStandardMaterial({
      color: model.paintColor,
      emissive: black ? 0x05090f : 0x080b0e,
      emissiveIntensity: black ? 0.34 : 0.08,
      metalness: black ? 0.78 : 0.52,
      roughness: 0.2,
      side: THREE.DoubleSide,
    });
  }
  if (kind === 'glass') {
    return new THREE.MeshStandardMaterial({
      color: 0x79b9d6,
      depthWrite: false,
      metalness: 0.22,
      opacity: 0.38,
      roughness: 0.12,
      side: THREE.DoubleSide,
      transparent: true,
    });
  }
  if (kind === 'light') {
    return new THREE.MeshStandardMaterial({
      color: 0xe6f7ff,
      emissive: 0x8edfff,
      emissiveIntensity: 1.35,
      metalness: 0.08,
      roughness: 0.18,
      side: THREE.DoubleSide,
    });
  }
  if (kind === 'wheel') {
    return new THREE.MeshStandardMaterial({
      color: 0x090d12,
      metalness: 0.58,
      roughness: 0.46,
      side: THREE.DoubleSide,
    });
  }
  if (kind === 'detail' && detailIsBody) {
    return new THREE.MeshStandardMaterial({
      color: model.paintColor,
      metalness: model.category === 'bike' ? 0.58 : 0.72,
      roughness: 0.27,
      side: THREE.DoubleSide,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: model.category === 'truck' ? 0x657482 : 0x303a46,
    metalness: 0.62,
    roughness: 0.38,
    side: THREE.DoubleSide,
  });
}

export function buildCar(
  variant: CarVariant = 'black'
): {
  disposeModel: () => void;
  group: THREE.Group;
  materials: THREE.Material[];
  model: MobileCarAsset | null;
} {
  const group = new THREE.Group();
  const geometries = getModelGeometries(variant);
  const model = MODEL_ASSETS[variant] ?? null;

  if (geometries && model) {
    const materials: THREE.Material[] = [];
    const detailIsBody = !geometries.has('paint');
    for (const kind of ['detail', 'paint', 'wheel', 'glass', 'light'] as CarPartKind[]) {
      const geometry = geometries.get(kind);
      if (!geometry) continue;
      const material = materialForPart(kind, model, detailIsBody);
      materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = kind === 'glass' ? 2 : kind === 'light' ? 1 : 0;
      group.add(mesh);
    }
    return { disposeModel: retainModelGeometries(variant), group, materials, model };
  }

  // The fallback is intentionally small and allocation-light; it appears only
  // if a packaged model is corrupt or the current device cannot parse it.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: getVehicleModel(variant).paintColor,
    metalness: 0.5,
    roughness: 0.35,
  });
  const cabinMat = new THREE.MeshStandardMaterial({
    color: '#8dbbd0',
    metalness: 0.1,
    roughness: 0.35,
  });
  const wheelMat = new THREE.MeshStandardMaterial({
    color: '#090d12',
    metalness: 0.3,
    roughness: 0.7,
  });

  const body = new THREE.Mesh(BODY_GEO, bodyMat);
  body.position.y = 0.5;
  group.add(body);
  const cabin = new THREE.Mesh(CABIN_GEO, cabinMat);
  cabin.position.set(0, 0.95, -0.2);
  group.add(cabin);
  for (const [x, z] of [
    [-1, 1.3],
    [1, 1.3],
    [-1, -1.3],
    [1, -1.3],
  ] as [number, number][]) {
    const wheel = new THREE.Mesh(WHEEL_GEO, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.35, z);
    group.add(wheel);
  }
  return {
    disposeModel: () => undefined,
    group,
    materials: [bodyMat, cabinMat, wheelMat],
    model: null,
  };
}

function lerpAngle(current: number, target: number, t: number): number {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * t;
}

function markerImageHeading(heading: number, category: VehicleModelCategory) {
  const sourceOffset = category === 'bike' ? 0 : category === 'truck' ? 180 : 90;
  return (((heading + sourceOffset) % 360) + 360) % 360;
}

export const Vehicle3DMarker: React.FC<Vehicle3DMarkerProps> = ({
  heading,
  speed,
  isActive,
  variant = 'black',
  size = 56,
  showImageFallback = false,
  renderMode = 'webgl',
}) => {
  const [webglFailed, setWebglFailed] = useState(false);
  const [webglReady, setWebglReady] = useState(false);
  const propsRef = useRef({ heading, speed, isActive });
  const glDisposerRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  propsRef.current = { heading, speed, isActive };

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    glDisposerRef.current?.();
    glDisposerRef.current = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let frame: number | null = null;
    let materials: THREE.Material[] = [];
    let car: THREE.Group | null = null;
    let disposeModel: () => void = () => undefined;

    try {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        42,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
        0.1,
        100
      );
      camera.position.set(0, 8.5, -8.5);
      camera.lookAt(0, 0.3, 0);

      renderer = createExpoThreeRenderer(gl, { antialias: false, alpha: true });
      renderer.setPixelRatio(1);
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight, false);
      renderer.setClearColor(0x000000, 0);

      scene.add(new THREE.HemisphereLight(0xe5f5ff, 0x17202a, 1.15));
      const key = new THREE.DirectionalLight(0xffffff, 1.45);
      key.position.set(6, 12, -4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x58d8ff, variant === 'black' ? 1.1 : 0.62);
      rim.position.set(-5, 7, 8);
      scene.add(rim);

      const built = buildCar(variant);
      disposeModel = built.disposeModel;
      if (!built.model) {
        throw new Error(`Packaged ${variant} geometry could not be loaded`);
      }
      car = built.group;
      materials = built.materials;
      if (built.model) {
        car.scale.setScalar(3.8 / built.model.targetLengthMeters);
      }
      // Models are baked nose -> local +Z (see buildCar), so a nose vector of
      // (sin y, 0, cos y) results from rotation.y = y. This camera sits at z = -8.6
      // looking toward +Z, which makes screen-right world -X; the nose therefore
      // projects to (-sin y, cos y). Matching the compass direction (sin H, cos H)
      // gives y = -H.
      //
      // Fleet3DOverlay uses (180 - H) for the SAME geometry, and both are correct:
      // its camera looks from +Z, so screen-right is world +X and its parent group
      // is tilted +90deg about X. Do not "unify" these two formulas.
      car.rotation.y = THREE.MathUtils.degToRad(-heading);
      scene.add(car);

      let firstFrame = true;
      let readyReported = false;
      const render = () => {
        frame = requestAnimationFrame(render);
        const current = propsRef.current;
        let dirty = false;
        if (car) {
          const target = THREE.MathUtils.degToRad(-current.heading);
          const previous = car.rotation.y;
          car.rotation.y = lerpAngle(previous, target, 0.18);
          if (Math.abs(car.rotation.y - previous) > 0.0004) dirty = true;

          const bob =
            current.isActive && current.speed <= 0.5 ? Math.sin(Date.now() * 0.004) * 0.08 : 0;
          if (Math.abs(bob - car.position.y) > 0.0004) dirty = true;
          car.position.y = bob;
        }
        if (!dirty && !firstFrame) return;
        firstFrame = false;
        renderer!.render(scene, camera);
        gl.endFrameEXP();
        if (!readyReported) {
          readyReported = true;
          if (mountedRef.current) setWebglReady(true);
        }
      };
      render();
    } catch (error) {
      console.warn('[Vehicle3DMarker] WebGL init failed; using image fallback', error);
      if (frame != null) cancelAnimationFrame(frame);
      materials.forEach((material) => material.dispose());
      disposeModel();
      renderer?.renderLists.dispose();
      renderer?.dispose();
      if (mountedRef.current) setWebglFailed(true);
      return;
    }

    glDisposerRef.current = () => {
      if (frame != null) cancelAnimationFrame(frame);
      materials.forEach((material) => material.dispose());
      disposeModel();
      renderer?.renderLists.dispose();
      renderer?.dispose();
      renderer = null;
    };
  };

  useLayoutEffect(() => {
    setWebglReady(false);
    setWebglFailed(false);
    return () => {
      glDisposerRef.current?.();
      glDisposerRef.current = null;
    };
  }, [variant]);

  useEffect(() => {
    if (renderMode !== 'webgl' || webglReady || webglFailed) return;
    const timeout = setTimeout(() => {
      if (mountedRef.current) setWebglFailed(true);
    }, 3500);
    return () => clearTimeout(timeout);
  }, [renderMode, variant, webglFailed, webglReady]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  if (renderMode === 'image') {
    return (
      <View style={[styles.container, { width: size, height: size }, styles.center]}>
        <FallbackVehicleImage heading={heading} size={size} variant={variant} />
      </View>
    );
  }

  if (webglFailed) {
    if (!showImageFallback) {
      return <View style={[styles.container, { width: size, height: size }]} />;
    }
    return (
      <View style={[styles.container, { width: size, height: size }, styles.center]}>
        <FallbackVehicleImage heading={heading} size={size} variant={variant} />
      </View>
    );
  }

  return (
    <View collapsable={false} style={[styles.container, { width: size, height: size }]}>
      {showImageFallback && !webglReady ? (
        <FallbackVehicleImage heading={heading} muted size={size} variant={variant} />
      ) : null}
      <SafeGLView
        key={variant}
        collapsable={false}
        msaaSamples={0}
        style={StyleSheet.absoluteFill}
        onContextCreate={onContextCreate}
      />
    </View>
  );
};

function FallbackVehicleImage({
  heading,
  muted = false,
  size,
  variant,
}: {
  heading: number;
  muted?: boolean;
  size: number;
  variant: CarVariant;
}) {
  const imageSize = size * 0.54;
  const model = getVehicleModel(variant);
  return (
    <View pointerEvents="none" style={[styles.fallbackLayer, muted && styles.fallbackLayerMuted]}>
      <View style={[styles.fallbackGlow, { height: imageSize * 0.9, width: imageSize * 1.12 }]} />
      <Image
        source={FALLBACK_MARKERS[model.category]}
        style={[
          styles.fallbackImage,
          {
            height: imageSize,
            transform: [{ rotate: `${markerImageHeading(heading, model.category)}deg` }],
            width: imageSize,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: 'transparent', overflow: 'visible' },
  center: { alignItems: 'center', justifyContent: 'center' },
  fallbackGlow: {
    backgroundColor: 'rgba(43, 230, 158, 0.22)',
    borderRadius: 999,
    position: 'absolute',
    shadowColor: '#2be69e',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
  },
  fallbackImage: { resizeMode: 'contain' },
  fallbackLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackLayerMuted: { opacity: 0.74 },
});
