import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import vm from 'node:vm';

test('authenticated client-state accepts project snapshots above 100 KB without widening other JSON routes', async()=>{
 const source=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const parser=source.match(/app\.use\('\/api\/client-state', requireAuth, express\.json\(\{ limit: '50mb' \}\)\);\s*app\.use\(express\.json\(\)\);/);
 assert.ok(parser);
 const app=express();const requireAuth=(req,res,next)=>req.get('Authorization')==='Bearer test'?next():res.sendStatus(401);
 vm.runInNewContext(parser[0],{app,express,requireAuth});
 app.post('/api/client-state',(req,res)=>res.json({length:req.body.value.length}));app.post('/other',(_req,res)=>res.sendStatus(200));
 app.use((error,_req,res,_next)=>res.sendStatus(error.status||500));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,body=JSON.stringify({key:'ysong:project',value:'a'.repeat(200000)});
 try {
  assert.equal((await fetch(base+'/api/client-state',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  const saved=await fetch(base+'/api/client-state',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test'},body});
  assert.equal(saved.status,200);assert.equal((await saved.json()).length,200000);
  assert.equal((await fetch(base+'/other',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,413);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
