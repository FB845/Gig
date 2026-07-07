import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(root,p);if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(0,r)); const base=`http://localhost:${server.address().port}`;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:390,height:844},permissions:['geolocation'],geolocation:{latitude:40,longitude:-74,accuracy:8}});
const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(base,{waitUntil:'networkidle'});
await pg.evaluate(async()=>{(await import('./js/store.js')).clearAll();});
await pg.reload({waitUntil:'networkidle'}); await pg.waitForTimeout(200);
// start drive
await pg.locator('#drive-cta').click();
await pg.waitForTimeout(400);
const overlayVisible = await pg.locator('#drive-overlay:not(.hidden)').count();
// simulate driving ~1 mile north in steps (watchPosition fires on each setGeolocation)
for(let i=1;i<=5;i++){ await ctx.setGeolocation({latitude:40+(i*0.2)/69,longitude:-74,accuracy:8}); await pg.waitForTimeout(250); }
const miles = parseFloat(await pg.locator('#drive-miles').innerText());
const stateTxt = await pg.locator('#drive-state').innerText();
// stop & save
await pg.locator('#drive-stop').click();
await pg.waitForTimeout(300);
const hiddenAfter = await pg.locator('#drive-overlay.hidden').count();
const onLog = await pg.locator('#view-log.active').count();
const milesField = await pg.locator('#shift-form [name=miles]').inputValue();
// trip logged
const tripCount = await pg.evaluate(async()=>{const s=await import('./js/store.js');return s.getTrips().length;});
console.log('overlay opened:', overlayVisible===1);
console.log('state while tracking:', JSON.stringify(stateTxt));
console.log('odometer miles after ~1mi drive:', miles);
console.log('overlay closed after stop:', hiddenAfter===1);
console.log('switched to Log w/ shift prefilled miles =', milesField, '| on log view:', onLog===1);
console.log('trips stored:', tripCount);
console.log('page errors:', errs.length? errs.slice(0,2).join(' | ') : 'none');
const pass = overlayVisible===1 && miles>0.8 && miles<1.2 && hiddenAfter===1 && onLog===1 && parseFloat(milesField)>0.8 && tripCount===1 && errs.length===0;
await pg.evaluate(async()=>{(await import('./js/store.js')).clearAll();});
await b.close(); server.close();
console.log('\nDRIVE E2E:', pass?'PASS ✓':'FAIL ✗');
process.exit(pass?0:1);
