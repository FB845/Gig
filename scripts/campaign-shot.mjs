import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(root,p);if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(0,r)); const base=`http://localhost:${server.address().port}`;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const pg=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2}).then(c=>c.newPage());
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(base,{waitUntil:'networkidle'});
await pg.evaluate(async()=>{const s=await import('./js/store.js');s.clearAll();
  const iso=n=>{const x=new Date();x.setDate(x.getDate()-n);return s.isoDate(x);};
  // last 14 days: mix of hit / partial / empty
  const plan=[380,410,290,355,120,360,0,395,340,370,450,150,360,285]; // n days ago .. today-ish
  plan.forEach((amt,i)=>{ const n=13-i; if(amt<=0) return;
    const gig=Math.round(amt*0.6), man=amt-gig;
    s.addShift({platform:i%2?'doordash':'flex',date:iso(n),gross:Math.round(gig*0.8),tips:Math.round(gig*0.2),hours:3+(i%3),jobs:8+(i%6),miles:25+i, scheduledHours:i%2?0:3, tag:i%2?'':'Express'});
    if(man>0) s.addIncome({date:iso(n),source:'TraceHaus',amount:man});
  });
});
await pg.reload({waitUntil:'networkidle'});
await pg.locator('.tab[data-view=campaign]').click();
await pg.waitForTimeout(500);
await pg.screenshot({path:path.join(root,'scripts/campaign-mobile.png'),fullPage:true});
console.log('errors:', errs.length?errs.slice(0,3).join(' | '):'none');
await pg.evaluate(async()=>{(await import('./js/store.js')).clearAll();});
await b.close(); server.close(); console.log('campaign shot saved');
