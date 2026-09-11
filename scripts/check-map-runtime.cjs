// node scripts/check-map-runtime.cjs <playwright-module-path> [--flat] [--slow-style]
// Uses the actual shipped HTML and GLBs, with synthetic telemetry only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const builder = source('src/components/FleetWebMap.tsx').statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'buildHtml');
const palette = source('src/services/mapStyle.ts').statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText() === 'PREMIUM_FLEET_MAP_PALETTE'));
const code = ts.transpileModule(palette.getText().replace('export ', '') + '\n' + builder.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const buildHtml = vm.runInNewContext(code + '\nbuildHtml');
const flat = process.argv.includes('--flat');
const slowStyle = process.argv.includes('--slow-style');
const style = flat ? {version:8, sources:{}, layers:[{id:'background',type:'background',paint:{'background-color':'#eff3f4'}}]} : 'https://tiles.openfreemap.org/styles/liberty';
let html = buildHtml(style, '', !flat);
// Instrument only the test copy, never the shipped page.
html = html.replace('var markerEls = {};', 'window.__testMap = map; window.__test3D = function(){return vehicle3D;}; var markerEls = {};');
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end(html); return; }
  if (req.url === '/favicon.ico') {res.writeHead(204).end();return;}
  res.writeHead(404).end();
});
/* Headless Chrome stops issuing requestAnimationFrame once the map goes idle,
   so MapLibre's own triggerRepaint parks a frame request that never lands and
   every 3D transform below would be read one update stale. redraw() paints
   synchronously, so each reading is taken from a frame that really drew.
   waitForFunction is polled on a timer for the same reason: its default 'raf'
   polling cannot tick on a page whose rAF has stalled. */
const paint = page => page.evaluate(() => window.__testMap.redraw());
const poll = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, {timeout, polling: 100});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'glivt-map-'));
  console.log('Artifacts:', output);
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport:{width:430,height:850},deviceScaleFactor:1});
    const errors = [];
    const events = [];
    const failedResponses = [];
    let droppedCarDelivery = false;
    if(slowStyle) {
      let requestCount=0;
      await page.route('https://tiles.openfreemap.org/styles/liberty',async route=>{
        requestCount+=1;
        if(requestCount===1) await new Promise(resolve=>setTimeout(resolve,14000));
        await route.continue().catch(()=>{});
      });
    }
    page.on('response', r => {if(r.status()>=400 && r.url().startsWith('https:')) {failedResponses.push({status:r.status(),url:r.url()});console.log('HTTP:',r.status(),r.url());}});
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR:', e.stack); });
    page.on('console', m => { if(m.type()==='error') console.log('CONSOLE:',m.text().slice(0,400)); });
    page.on('requestfailed', r => console.log('REQUEST FAILED:',r.url().slice(0,160),r.failure()?.errorText));
    await page.exposeFunction('__bridge', async message => {
      const e=JSON.parse(message);
      events.push(e);
      if (['ready','error','model-error','model-ready','model-request'].includes(e.type)) console.log('BRIDGE:',JSON.stringify(e));
      if(e.type==='model-request') {
        // Lost native asset delivery must retry without a map reload.
        if(e.category==='CAR'&&!droppedCarDelivery) {droppedCarDelivery=true;return;}
        const modelName=e.category==='BIKE'?'bike-map.glb':e.category.toLowerCase()+'.glb';
        const data=fs.readFileSync(path.join(root,'models',modelName)).toString('base64');
        await page.evaluate(({category,uri})=>window.__glivtSetVehicleModel(category,uri),{category:e.category,uri:'data:model/gltf-binary;base64,'+data});
      }
    });
    await page.addInitScript(()=>{window.ReactNativeWebView={postMessage:m=>window.__bridge(m)};});
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
    await poll(page,()=>window.__testMap?.getSource('route'),undefined,55000);
    const all=[];
    for(const category of ['CAR','TRUCK','BIKE']) {
      await page.evaluate(category=>{
        window.__glivtSyncMarkers({markers:[{id:'test',lat:13.0874,lng:80.2074,heading:0,category,color:'#1db98a',label:category,moving:false,sourceTime:1000}],followSelected:false,cameraMode:'follow'},false);
        window.__testMap.jumpTo({center:[80.2074,13.0874],zoom:18,pitch:58,bearing:0});
      },category);
      await poll(page,c=>window.__test3D()?.entities.test?.category===c,category,30000);
      await paint(page);
      for(const bearing of [0,45,89,90,135,180,270]) {
        await page.evaluate(b=>window.__testMap.jumpTo({bearing:b}),bearing);
        await paint(page);
        const state=await page.evaluate(()=>{
          const v=window.__test3D(),e=v.entities.test;
          return {matrix:e.object.matrix.elements,visible:e.object.visible,triangles:v.renderer.info.render.triangles,scale:Math.hypot(...e.object.matrix.elements.slice(0,3)),modelSize:e.modelSize,dom:document.querySelector('.glivt-marker')?.className};
        });
        assert.equal(state.visible,true);
        assert(state.dom.includes('model-ready'),'Only a drawn GLB may replace the fallback');
        assert.equal(state.matrix[12],0,'Orbit must not move the trusted vehicle longitude');
        assert.equal(state.matrix[13],0,'Orbit must not move the trusted vehicle latitude');
        console.log(category,bearing,JSON.stringify({scale:state.scale,triangles:state.triangles,visible:state.visible}));
        all.push({category,bearing,...state});
        if([0,90].includes(bearing)) await page.screenshot({path:path.join(output,`${category}-${bearing}.png`)});
      }
      // Playback hides offline sections and must restore the real mesh
      // when it resumes; do not accidentally leave the fallback latched on.
      for(const hidden of [true,false]) {
        const visible=await page.evaluate(({category,hidden})=>{
          window.__glivtSyncMarkers({markers:[{id:'test',lat:13.0874,lng:80.2074,heading:0,category,color:'#1db98a',moving:false,hidden,sourceTime:1000}],followSelected:false,cameraMode:'follow'},false);
          return window.__test3D().entities.test.object.visible;
        },{category,hidden});
        assert.equal(visible,!hidden,`${category} hidden=${hidden} must drive mesh visibility`);
        await paint(page);
        // Resuming playback must hand the map back the real mesh. A latched
        // fallback here is the bug that leaves a flat sprite for the rest of
        // the session, and object.visible alone would not catch it.
        const dom=await page.evaluate(()=>document.querySelector('.glivt-marker')?.className||'');
        assert.equal(dom.includes('model-ready'),!hidden,
          `${category} playback hidden=${hidden}: expected model-ready ${!hidden}, got "${dom}"`);
      }
    }
    // Check direction in the local east/north/up model frame.
    for(const heading of [0,90,180,270]) {
      await page.evaluate(heading=>{
        window.__glivtSyncMarkers({markers:[{id:'test',lat:13.0874,lng:80.2074,heading,category:'CAR',color:'#1db98a',moving:false,sourceTime:1000}],followSelected:false,cameraMode:'follow'},false);
      },heading);
      await paint(page);
      const forward=await page.evaluate(()=>{
        const m=window.__test3D().entities.test.object.matrix.elements;
        const length=Math.hypot(m[8],m[9]);
        return [-m[8]/length,-m[9]/length];
      });
      const want=[Math.sin(heading*Math.PI/180),Math.cos(heading*Math.PI/180)];
      console.log('HEADING',heading,'forward',forward.map(n=>n.toFixed(4)).join(','),'want',want.map(n=>n.toFixed(4)).join(','));
      assert(Math.abs(forward[0]-want[0])<1e-6&&Math.abs(forward[1]-want[1])<1e-6,
        'heading '+heading+': model forward '+JSON.stringify(forward)+' != '+JSON.stringify(want));
    }
    // The validated GPS/playback pipeline owns heading. A coordinate-derived
    // second opinion here used animation samples as GPS fixes and overrode the
    // supplied turn, making the model and heading-up camera snap between legs.
    const authoritativeHeading=await page.evaluate(()=>{
      window.__glivtSyncMarkers({markers:[{id:'test',lat:13.0874,lng:80.2074,heading:25,category:'CAR',color:'#1db98a',moving:true,sourceTime:2000}],followSelected:false,cameraMode:'follow'},false);
      window.__glivtSyncMarkers({markers:[{id:'test',lat:13.0874,lng:80.20743,heading:25,category:'CAR',color:'#1db98a',moving:true,sourceTime:3000}],followSelected:false,cameraMode:'follow'},false);
      return window.__test3D().entities.test.targetHeading;
    });
    assert(Math.abs(authoritativeHeading-25)<1e-6,
      'Map runtime must preserve the upstream heading, got '+authoritativeHeading);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({errors,failedResponses,events,states:all},null,2));
    assert.equal(errors.length,0,'No runtime errors');
    assert.equal(failedResponses.length,0,'No unavailable terrain or CDN assets');
    assert.equal(events.filter(e=>e.type==='error').length,0,'No map error overlay');
    assert.equal(events.filter(e=>e.type==='model-request'&&e.category==='CAR').length,2,'Lost asset delivery must retry exactly once');
    for(const category of ['CAR','TRUCK','BIKE']) {
      const states=all.filter(s=>s.category===category);
      assert(states.every(s=>s.triangles>0),'Models must submit real geometry');
      assert(Math.max(...states.map(s=>s.scale))/Math.min(...states.map(s=>s.scale))<1.15,`${category} scale must not depend on camera bearing`);
    }
    console.log('PASS: real GLBs, stable scale/compass bearings, hidden playback, asset retry, no map errors.');
  } finally {await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
