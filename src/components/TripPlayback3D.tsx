import type { ExpoWebGLRenderingContext } from 'expo-gl';
import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import * as THREE from 'three';

import { createExpoThreeRenderer } from '@/src/services/expoThreeRenderer';
import { buildPlaybackTrack } from '@/src/services/playbackEngine';
import type { PlaybackEventMarker, PlaybackStopMarker, PlaybackTrackPoint } from '@/src/types/api';
import { SafeGLView } from './SafeGLView';
import { buildCar, type CarVariant } from './Vehicle3DMarker';

export type CameraMode = 'follow' | 'chase' | 'cinematic' | 'orbit' | 'top' | 'overview';

type Props = {
  points: PlaybackTrackPoint[];
  events: PlaybackEventMarker[];
  stops: PlaybackStopMarker[];
  /** Mutated at 60fps by the screen's clock — read in the render loop, no re-render. */
  progressRef: React.MutableRefObject<number>;
  cameraMode: CameraMode;
  /** Freezes camera and scene time while playback/live tracking is paused. */
  playing?: boolean;
  carVariant?: CarVariant;
  /** Fired after the first complete scene frame is presented. */
  onReady?: () => void;
  /** Called when the WebGL scene can't run, so the screen can show a 2D map. */
  onUnavailable?: () => void;
};

// Cinematic palette (independent of app theme — the stage is always a night scene).
const C = {
  bg: 0x05070c,
  grid: 0x11202e,
  route: 0x1ea7ff,
  routeGlow: 0x2be6ff,
  car: 0x22c55e,
  cabin: 0xe8eef5,
  tyre: 0x0a0d12,
  event: 0xff3b47,
  stop: 0x3b82f6,
};

const M_PER_DEG = 111_320;

function project(points: PlaybackTrackPoint[]) {
  const src = points;
  const lat0 = src.reduce((s, p) => s + p.lat, 0) / src.length;
  const lng0 = src.reduce((s, p) => s + p.lng, 0) / src.length;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const raw = src.map((p) => ({
    x: (p.lng - lng0) * cos * M_PER_DEG,
    z: -(p.lat - lat0) * M_PER_DEG,
    speed: p.speed,
  }));
  const parsedTimes = src.map((point) => Date.parse(point.t));
  const validTimeline = parsedTimes.every(Number.isFinite);
  const startTime = validTimeline ? parsedTimes[0] : 0;
  const duration = validTimeline ? Math.max(1, parsedTimes[parsedTimes.length - 1] - startTime) : 1;
  const timeFractions = parsedTimes.map((time, index) =>
    validTimeline ? (time - startTime) / duration : index / Math.max(1, src.length - 1)
  );
  let maxExtent = 1;
  for (const r of raw) maxExtent = Math.max(maxExtent, Math.abs(r.x), Math.abs(r.z));
  const scale = Math.min(1.8, 130 / maxExtent);
  const toWorld = (lat: number, lng: number) =>
    new THREE.Vector3((lng - lng0) * cos * M_PER_DEG * scale, 0.1, -(lat - lat0) * M_PER_DEG * scale);
  const pts = raw.map((r) => new THREE.Vector3(r.x * scale, 0.1, r.z * scale));
  const cumulative = new Array<number>(pts.length).fill(0);
  for (let index = 1; index < pts.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + pts[index - 1].distanceTo(pts[index]);
  }
  const totalLength = cumulative[cumulative.length - 1] || 1;
  return {
    pts,
    speeds: raw.map((r) => r.speed),
    timeFractions,
    distanceFractions: cumulative.map((distance) => distance / totalLength),
    toWorld,
    span: maxExtent * scale,
  };
}

function curveParameterAt(
  timeFractions: number[],
  distanceFractions: number[],
  progress: number
) {
  if (timeFractions.length < 2) return 0;
  const value = Math.max(0, Math.min(1, progress));
  if (value >= 1) return 1;
  let low = 0;
  let high = timeFractions.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeFractions[mid] <= value) low = mid;
    else high = mid;
  }
  const start = timeFractions[low];
  const end = timeFractions[high];
  const local = end > start ? (value - start) / (end - start) : 0;
  const clampedLocal = Math.max(0, Math.min(1, local));
  return (
    distanceFractions[low] +
    (distanceFractions[high] - distanceFractions[low]) * clampedLocal
  );
}

function buildRoadCurve(points: THREE.Vector3[]) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let index = 0; index < points.length - 1; index += 1) {
    path.add(new THREE.LineCurve3(points[index], points[index + 1]));
  }
  return path;
}

function damp(current: THREE.Vector3, target: THREE.Vector3, lambda: number, dt: number) {
  const t = 1 - Math.exp(-lambda * dt);
  current.lerp(target, t);
}

function buildRibbonGeometry(curve: THREE.Curve<THREE.Vector3>, width: number, segments: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i <= segments; i += 1) {
    const u = i / segments;
    const p = curve.getPointAt(u);
    curve.getTangentAt(Math.min(0.9999, u), tangent).normalize();
    side.copy(tangent).cross(up).normalize();
    if (!Number.isFinite(side.x) || !Number.isFinite(side.z)) side.set(1, 0, 0);

    positions.push(
      p.x + side.x * width * 0.5,
      -0.06,
      p.z + side.z * width * 0.5,
      p.x - side.x * width * 0.5,
      -0.06,
      p.z - side.z * width * 0.5
    );

    if (i < segments) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function seededUnit(index: number) {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function distanceToRoute2D(point: THREE.Vector3, route: THREE.Vector3[]) {
  let best = Infinity;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount =
      lengthSquared > 0
        ? Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)
          )
        : 0;
    best = Math.min(
      best,
      Math.hypot(point.x - (start.x + dx * amount), point.z - (start.z + dz * amount))
    );
  }
  return best;
}

export const TripPlayback3D: React.FC<Props> = ({
  points,
  events,
  stops,
  progressRef,
  cameraMode,
  playing = true,
  carVariant = 'black',
  onReady,
  onUnavailable,
}) => {
  // Only auto-fail on web (no expo-gl) or explicit WebGL failure.
  // We must NOT treat points.length < 2 as a failure at mount time because
  // data often hasn't loaded yet — the parent screen already shows its own
  // loading/empty state and passes us points only when there are ≥ 2.
  const [failed, setFailed] = useState(Platform.OS === 'web');
  const [ready, setReady] = useState(false);
  const modeRef = useRef(cameraMode);
  modeRef.current = cameraMode;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Notify parent only when WebGL itself fails, not when data isn't ready yet.
  const notifiedRef = useRef(false);
  React.useEffect(() => {
    if (failed && !notifiedRef.current) {
      notifiedRef.current = true;
      onUnavailable?.();
    }
  }, [failed, onUnavailable]);

  const cleanPoints = useMemo(() => buildPlaybackTrack(points).points, [points]);
  const geo = useMemo(
    () => (cleanPoints.length >= 2 ? project(cleanPoints) : null),
    [cleanPoints]
  );
  const curve = useMemo(
    // Piecewise-linear interpolation stays exactly on the recorded route. A
    // spline can overshoot a corner and place the car inside a building.
    () => (geo ? buildRoadCurve(geo.pts) : null),
    [geo]
  );

  const disposerRef = useRef<(() => void) | null>(null);
  React.useEffect(() => () => disposerRef.current?.(), []);

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    if (!curve || !geo) {
      setFailed(true);
      return;
    }
    let renderer: THREE.WebGLRenderer | null = null;
    let frame: number | null = null;
    const disposables: { dispose: () => void }[] = [];

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(C.bg);
      scene.fog = new THREE.Fog(C.bg, Math.max(geo.span * 0.9, 70), Math.max(geo.span * 3.5, 360));

      const camera = new THREE.PerspectiveCamera(
        48,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
        0.35,
        Math.max(900, geo.span * 8)
      );
      renderer = createExpoThreeRenderer(gl, { antialias: true });
      renderer.setPixelRatio(1);
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;

      // Lighting — cool key + warm rim for depth.
      scene.add(new THREE.HemisphereLight(0xa8dfff, 0x10151c, carVariant === 'black' ? 1.5 : 1.18));
      const key = new THREE.DirectionalLight(0xbfe6ff, 1.4);
      key.position.set(80, 160, 40);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x2be6ff, carVariant === 'black' ? 1.45 : 0.8);
      rim.position.set(-60, 40, -80);
      scene.add(rim);
      const warmRim = new THREE.DirectionalLight(0xff9d5c, carVariant === 'black' ? 0.85 : 0.45);
      warmRim.position.set(45, 22, 65);
      scene.add(warmRim);
      const chaseLight = new THREE.PointLight(C.car, 2.2, 90);
      chaseLight.position.set(geo.pts[0].x, 12, geo.pts[0].z);
      scene.add(chaseLight);

      // Ground grid, faded by fog.
      const grid = new THREE.GridHelper(Math.max(geo.span * 4, 420), 72, C.grid, C.grid);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.5;
      scene.add(grid);
      disposables.push(grid.geometry, grid.material as THREE.Material);

      const groundGeo = new THREE.PlaneGeometry(
        Math.max(geo.span * 5, 520),
        Math.max(geo.span * 5, 520)
      );
      const groundMat = new THREE.MeshStandardMaterial({
        color: 0x07101b,
        metalness: 0.05,
        roughness: 0.96,
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.position.y = -0.12;
      ground.rotation.x = -Math.PI / 2;
      ground.renderOrder = -3;
      scene.add(ground);
      disposables.push(groundGeo, groundMat);

      // Capping the mesh keeps CPU geometry creation and GPU upload fast on
      // phones while remaining visually smooth at mobile resolution.
      const routeSegments = Math.min(360, Math.max(56, geo.pts.length * 3));

      const roadGeo = buildRibbonGeometry(curve, 7.2, routeSegments);
      const roadMat = new THREE.MeshStandardMaterial({
        color: 0x182333,
        emissive: new THREE.Color(0x07111e),
        emissiveIntensity: 0.3,
        metalness: 0.1,
        roughness: 0.74,
        side: THREE.DoubleSide,
      });
      const road = new THREE.Mesh(roadGeo, roadMat);
      road.renderOrder = -2;
      scene.add(road);
      disposables.push(roadGeo, roadMat);

      const glowGeo = new THREE.TubeGeometry(curve, routeSegments, 0.72, 8, false);
      const glowMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: C.routeGlow,
        depthWrite: false,
        opacity: 0.15,
        transparent: true,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.renderOrder = 1;
      scene.add(glow);
      disposables.push(glowGeo, glowMat);

      // Route as a crisp neon tube.
      const tubeGeo = new THREE.TubeGeometry(curve, routeSegments, 0.2, 8, false);
      const tubeMat = new THREE.MeshStandardMaterial({
        color: C.route,
        emissive: new THREE.Color(C.routeGlow),
        emissiveIntensity: 0.7,
        metalness: 0.2,
        roughness: 0.4,
      });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.renderOrder = 2;
      scene.add(tube);
      disposables.push(tubeGeo, tubeMat);

      const cityGeo = new THREE.BufferGeometry();
      const cityPositions: number[] = [];
      const citySpan = Math.max(geo.span * 3.6, 180);
      for (let i = 0; i < 220; i += 1) {
        cityPositions.push(
          (seededUnit(i) - 0.5) * citySpan,
          0.25 + seededUnit(i + 331) * 2.2,
          (seededUnit(i + 97) - 0.5) * citySpan
        );
      }
      cityGeo.setAttribute('position', new THREE.Float32BufferAttribute(cityPositions, 3));
      const cityMat = new THREE.PointsMaterial({
        blending: THREE.AdditiveBlending,
        color: 0x7dd3fc,
        depthWrite: false,
        opacity: 0.42,
        size: 1.35,
        transparent: true,
      });
      const cityLights = new THREE.Points(cityGeo, cityMat);
      scene.add(cityLights);
      disposables.push(cityGeo, cityMat);

      // An instanced skyline gives chase/orbit shots parallax and depth in a
      // single draw call, without loading textures or hundreds of meshes.
      const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
      const buildingMat = new THREE.MeshStandardMaterial({
        color: 0x102237,
        emissive: new THREE.Color(0x0b2034),
        emissiveIntensity: 0.62,
        metalness: 0.22,
        roughness: 0.72,
      });
      const buildingCount = 84;
      const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, buildingCount);
      const buildingMatrix = new THREE.Matrix4();
      const buildingPosition = new THREE.Vector3();
      const buildingScale = new THREE.Vector3();
      const buildingQuaternion = new THREE.Quaternion();
      const buildingSpan = Math.max(geo.span * 2.6, 250);
      let buildingIndex = 0;
      let buildingAttempt = 0;
      while (buildingIndex < buildingCount && buildingAttempt < buildingCount * 8) {
        const i = buildingAttempt;
        buildingAttempt += 1;
        const height = 4 + seededUnit(i + 812) * 24;
        buildingPosition.set(
          (seededUnit(i + 401) - 0.5) * buildingSpan,
          height * 0.5,
          (seededUnit(i + 709) - 0.5) * buildingSpan
        );
        const routeDistance = distanceToRoute2D(buildingPosition, geo.pts);
        if (routeDistance < 13) continue;
        buildingScale.set(3 + seededUnit(i + 91) * 8, height, 3 + seededUnit(i + 211) * 8);
        buildingMatrix.compose(buildingPosition, buildingQuaternion, buildingScale);
        buildings.setMatrixAt(buildingIndex, buildingMatrix);
        buildingIndex += 1;
      }
      buildings.count = buildingIndex;
      buildings.instanceMatrix.needsUpdate = true;
      scene.add(buildings);
      disposables.push(buildingGeo, buildingMat);

      // Start / finish pylons.
      const makePylon = (pos: THREE.Vector3, color: number) => {
        const g = new THREE.CylinderGeometry(0.18, 0.18, 4.8, 8);
        const m = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.8 });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(pos.x, 2.4, pos.z);
        scene.add(mesh);
        disposables.push(g, m);
      };
      makePylon(geo.pts[0], C.car);
      makePylon(geo.pts[geo.pts.length - 1], C.event);

      // Stop rings.
      for (const s of stops) {
        const p = geo.toWorld(s.lat, s.lng);
        const g = new THREE.TorusGeometry(1.6, 0.12, 8, 32);
        const m = new THREE.MeshStandardMaterial({ color: C.stop, emissive: new THREE.Color(C.stop), emissiveIntensity: 0.7 });
        const ring = new THREE.Mesh(g, m);
        ring.position.set(p.x, 0.2, p.z);
        ring.rotation.x = Math.PI / 2;
        scene.add(ring);
        disposables.push(g, m);
      }

      // Event beacons (pulsing).
      const beacons: THREE.Mesh[] = [];
      for (const e of events) {
        const p = geo.toWorld(e.lat, e.lng);
        const g = new THREE.ConeGeometry(0.75, 3.2, 6);
        const m = new THREE.MeshStandardMaterial({ color: C.event, emissive: new THREE.Color(C.event), emissiveIntensity: 1 });
        const cone = new THREE.Mesh(g, m);
        cone.position.set(p.x, 1.6, p.z);
        scene.add(cone);
        beacons.push(cone);
        disposables.push(g, m);
      }

      // Vehicle: use the baked 3D mesh + glowing halo.
      const built = buildCar(carVariant);
      const car = built.group;
      // Keep the real model readable in the establishing shot. Previously it
      // rendered as a near-invisible dot for the first several seconds.
      car.scale.setScalar(1.45);
      car.renderOrder = 4;
      const haloGeo = new THREE.RingGeometry(1.55, 2.35, 32);
      const haloMat = new THREE.MeshBasicMaterial({ color: C.car, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      car.add(halo);
      scene.add(car);
      disposables.push(haloGeo, haloMat, ...built.materials);

      const routeRadius = Math.max(geo.span, 80);
      const sceneRadius = Math.min(routeRadius, 96);
      const routeCenter = new THREE.Box3().setFromPoints(geo.pts).getCenter(new THREE.Vector3());
      const up = new THREE.Vector3(0, 1, 0);
      const tmpTan = curve.getTangentAt(0, new THREE.Vector3()).normalize();
      const desiredPos = new THREE.Vector3();
      const desiredLook = new THREE.Vector3();
      const side = new THREE.Vector3().copy(tmpTan).cross(up).normalize();
      const camPos = geo.pts[0]
        .clone()
        .addScaledVector(tmpTan, -sceneRadius * 0.38)
        .addScaledVector(side, sceneRadius * 0.12)
        .addScaledVector(up, sceneRadius * 0.28);
      const camLook = geo.pts[0].clone().addScaledVector(tmpTan, 4);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      let camClock = 0;
      let sceneClock = 0;
      let last = Date.now();
      let firstFrame = true;

      const shot = (t: number, carPos: THREE.Vector3, tan: THREE.Vector3, mode: CameraMode) => {
        side.copy(tan).cross(up).normalize();
        if (mode === 'top') {
          desiredPos.set(carPos.x + 0.01, routeRadius * 2.25, carPos.z + 0.01);
          desiredLook.copy(carPos);
          return;
        }
        if (mode === 'overview') {
          desiredPos.set(
            routeCenter.x + routeRadius * 0.72,
            routeRadius * 1.45,
            routeCenter.z + routeRadius * 0.72
          );
          desiredLook.copy(routeCenter);
          return;
        }
        if (mode === 'follow') {
          desiredPos.copy(carPos).addScaledVector(tan, -22).addScaledVector(up, 18);
          desiredLook.copy(carPos).addScaledVector(tan, 10);
          return;
        }
        if (mode === 'chase') {
          desiredPos.copy(carPos).addScaledVector(tan, -16).addScaledVector(up, 8);
          desiredLook.copy(carPos).addScaledVector(tan, 6);
          return;
        }
        if (mode === 'orbit') {
          const a = t * 0.6;
          desiredPos.set(
            carPos.x + Math.cos(a) * 30,
            carPos.y + 18 + Math.sin(t * 0.3) * 4,
            carPos.z + Math.sin(a) * 30
          );
          desiredLook.copy(carPos);
          return;
        }
        // cinematic: cycle establishing -> chase -> orbit -> crane
        const cycle = t % 24;
        if (t < 2.8) {
          const k = t / 2.8;
          desiredPos
            .copy(carPos)
            .addScaledVector(tan, -sceneRadius * (0.38 - k * 0.12))
            .addScaledVector(side, sceneRadius * 0.12)
            .addScaledVector(up, sceneRadius * (0.28 - k * 0.08));
          desiredLook.copy(carPos).addScaledVector(tan, 4);
        } else if (cycle < 8) {
          desiredPos.copy(carPos).addScaledVector(tan, -28).addScaledVector(up, 15);
          desiredLook.copy(carPos).addScaledVector(tan, 7);
        } else if (cycle < 17) {
          const a = t * 0.55;
          desiredPos.set(
            carPos.x + Math.cos(a) * 34,
            carPos.y + 21 + Math.sin(t * 0.35) * 5,
            carPos.z + Math.sin(a) * 34
          );
          desiredLook.copy(carPos);
        } else {
          const craneT = (cycle - 17) / 7;
          desiredPos
            .copy(carPos)
            .addScaledVector(side, 30)
            .addScaledVector(up, 16 + craneT * 34)
            .addScaledVector(tan, -12);
          desiredLook.copy(carPos);
        }
      };

      const render = () => {
        frame = requestAnimationFrame(render);
        const now = Date.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const activeDt = playingRef.current ? dt : 0;
        camClock += activeDt;
        sceneClock += activeDt;

        const mode = modeRef.current;
        const routeT = curveParameterAt(
          geo.timeFractions,
          geo.distanceFractions,
          progressRef.current
        );
        const carPos = curve.getPointAt(routeT);
        curve.getTangentAt(Math.min(0.99999, routeT), tmpTan).normalize();

        car.position.copy(carPos);
        car.rotation.y = Math.atan2(tmpTan.x, tmpTan.z);
        const sceneNow = sceneClock * 1000;
        const pulse = 0.4 + Math.sin(sceneNow * 0.006) * 0.18;
        const glowPulse = 0.5 + Math.sin(sceneNow * 0.0035) * 0.5;
        haloMat.opacity = pulse;
        halo.scale.setScalar(1 + Math.sin(sceneNow * 0.006) * 0.08);
        glowMat.opacity = 0.1 + glowPulse * 0.08;
        tubeMat.emissiveIntensity = 0.48 + glowPulse * 0.28;
        cityMat.opacity = 0.26 + glowPulse * 0.12;
        chaseLight.position.set(carPos.x, 11, carPos.z);
        chaseLight.intensity = 1.7 + glowPulse * 1.1;
        for (const b of beacons) {
          b.scale.y = 1 + Math.sin(sceneNow * 0.005 + b.position.x) * 0.15;
        }

        shot(camClock, carPos, tmpTan, mode);
        damp(camPos, desiredPos, 3.2, activeDt);
        damp(camLook, desiredLook, 4.5, activeDt);
        camera.position.copy(camPos);
        camera.up.set(0, mode === 'top' ? 0 : 1, mode === 'top' ? -1 : 0);
        camera.lookAt(camLook);

        renderer!.render(scene, camera);
        gl.endFrameEXP();
        if (firstFrame) {
          firstFrame = false;
          setReady(true);
          onReady?.();
        }
      };
      render();

      disposerRef.current = () => {
        if (frame != null) cancelAnimationFrame(frame);
        disposables.forEach((d) => d.dispose());
        renderer?.dispose();
        renderer = null;
      };
    } catch (err) {
      console.warn('[TripPlayback3D] init failed', err);
      setReady(false);
      setFailed(true);
    }
  };

  if (failed) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>3D playback unavailable — showing 2D route on the map.</Text>
      </View>
    );
  }

  // Points not yet loaded (< 2) — show a dark loading placeholder instead of
  // an error so the screen doesn't flicker to 2D before data arrives.
  if (!geo || !curve) {
    return <View style={styles.fallback} />;
  }

  return (
    <View style={styles.stage}>
      <SafeGLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
      {!ready ? (
        <View pointerEvents="none" style={styles.bootOverlay}>
          <View style={styles.bootCore}>
            <ActivityIndicator color="#2BE6FF" size="large" />
            <Text style={styles.bootEyebrow}>3D ENGINE</Text>
            <Text style={styles.bootTitle}>Building cinematic world</Text>
            <Text style={styles.bootText}>Optimizing route, lighting and vehicle geometry…</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  stage: { backgroundColor: '#05070c', flex: 1 },
  fallback: { alignItems: 'center', backgroundColor: '#05070c', flex: 1, justifyContent: 'center', padding: 24 },
  fallbackText: { color: '#9fb0c0', textAlign: 'center' },
  bootOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: '#05070c',
    justifyContent: 'center',
    padding: 28,
  },
  bootCore: {
    alignItems: 'center',
    backgroundColor: 'rgba(12, 21, 34, 0.88)',
    borderColor: 'rgba(82, 220, 255, 0.2)',
    borderRadius: 22,
    borderWidth: 1,
    maxWidth: 320,
    paddingHorizontal: 24,
    paddingVertical: 24,
    width: '100%',
  },
  bootEyebrow: { color: '#53D8FF', fontSize: 9, fontWeight: '900', letterSpacing: 2, marginTop: 16 },
  bootTitle: { color: '#F3FAFF', fontSize: 18, fontWeight: '900', marginTop: 5 },
  bootText: { color: '#8FA6BA', fontSize: 12, lineHeight: 18, marginTop: 6, textAlign: 'center' },
});
