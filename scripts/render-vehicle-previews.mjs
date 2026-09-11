/**
 * Render the bundled GLB fleet models into lightweight transparent thumbnails.
 *
 * The vehicle list can display ten units at once. Giving every card its own
 * WebGL context would decode the same mesh ten times and exhaust mobile GPU
 * memory, so the list uses these real model renders while the maps retain the
 * interactive GLB models. Run with: node scripts/render-vehicle-previews.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = join(projectRoot, 'assets', 'images', 'vehicle-previews');
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chrome) throw new Error('Chrome or Edge is required to render vehicle previews.');
mkdirSync(outputDirectory, { recursive: true });

const mime = {
  '.glb': 'model/gltf-binary',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

function previewDocument(category) {
  const fileName = category === 'BIKE' ? 'bike-map.glb' : `${category.toLowerCase()}.glb`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><style>
html,body{margin:0;width:320px;height:210px;overflow:hidden;background:transparent}
canvas{display:block;width:320px;height:210px}
</style></head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const width=320,height=210;
const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(2); renderer.setSize(width,height); renderer.setClearColor(0x000000,0);
renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.12; renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap; document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(28,width/height,0.01,1000);
const hemi=new THREE.HemisphereLight(0xf6fbff,0x53636f,2.6); scene.add(hemi);
const key=new THREE.DirectionalLight(0xffffff,4.2); key.position.set(-5,9,7); key.castShadow=true;
key.shadow.mapSize.set(1024,1024); key.shadow.bias=-0.0003; scene.add(key);
const rim=new THREE.DirectionalLight(0x8fd8ff,1.8); rim.position.set(7,4,-5); scene.add(rim);
new GLTFLoader().load('/models/${fileName}',(gltf)=>{
  const model=gltf.scene;
  model.traverse((node)=>{if(node.isMesh){
    node.castShadow=true; node.receiveShadow=true;
    if('${category}'==='BIKE'){
      const materials=Array.isArray(node.material)?node.material:[node.material];
      materials.forEach((material)=>{if(material&&!material.map&&material.color){
        material.color.setHex(0x1d4f72); material.metalness=0.28; material.roughness=0.42;
      }});
    }
  }});
  model.updateMatrixWorld(true);
  let box=new THREE.Box3().setFromObject(model); let center=box.getCenter(new THREE.Vector3());
  model.position.set(-center.x,-box.min.y,-center.z); model.rotation.y=${category === 'BIKE' ? '-0.18' : '0.08'};
  model.updateMatrixWorld(true); box=new THREE.Box3().setFromObject(model);
  const size=box.getSize(new THREE.Vector3()); const max=Math.max(size.x,size.y,size.z,0.01);
  const target=new THREE.Vector3(0,size.y*0.32,0);
  camera.position.set(max*1.62,max*1.12,max*1.92); camera.lookAt(target);
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(max*5,max*5),new THREE.ShadowMaterial({color:0x11263a,opacity:0.24}));
  plane.rotation.x=-Math.PI/2; plane.position.y=-0.015; plane.receiveShadow=true; scene.add(plane); scene.add(model);
  renderer.render(scene,camera); document.documentElement.dataset.ready='true';
},undefined,(error)=>{document.body.dataset.error=String(error);});
</script></body></html>`;
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/preview') {
    const category = (requestUrl.searchParams.get('category') ?? 'CAR').toUpperCase();
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(previewDocument(category));
    return;
  }
  const decoded = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
  const target = normalize(join(projectRoot, decoded));
  if (!target.startsWith(projectRoot) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' });
  response.end(readFileSync(target));
});

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Preview server did not start.');

try {
  const debugPort = 12000 + (process.pid % 2000);
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    '--window-size=320,210',
    'about:blank',
  ], { stdio: 'ignore' });

  const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  let page;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      page = tabs.find((tab) => tab.type === 'page');
      if (page) break;
    } catch { /* Chrome is still starting. */ }
    await delay(100);
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('Could not connect to the preview browser.');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++commandId;
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });

  try {
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 210,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await command('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    for (const category of ['CAR', 'BIKE', 'TRUCK']) {
      await command('Page.navigate', {
        url: `http://127.0.0.1:${address.port}/preview?category=${category}`,
      });
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const evaluation = await command('Runtime.evaluate', {
          expression: "document.documentElement.dataset.ready === 'true'",
          returnByValue: true,
        });
        if (evaluation?.result?.value === true) {
          ready = true;
          break;
        }
        await delay(100);
      }
      if (!ready) throw new Error(`${category} model did not finish rendering.`);
      await delay(100);
      const capture = await command('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      writeFileSync(
        join(outputDirectory, `${category.toLowerCase()}-3d.png`),
        Buffer.from(capture.data, 'base64')
      );
    }
  } finally {
    socket.close();
    browser.kill();
  }
} finally {
  server.close();
}
