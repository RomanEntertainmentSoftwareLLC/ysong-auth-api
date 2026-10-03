import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerMultipartUploads, UPLOAD_PART_BYTES as partBytes } from '../src/storage/multipartUploads.mjs';
import { createGovernance } from '../src/saas/governance.mjs';
import crypto from 'node:crypto';

test('multipart validates ownership and stored parts, supports a 91.9 MiB master and completion retry', async () => {
 const app=express();app.use(express.json());const objects=new Map(),parts=new Map();let finished=0,reviewed=0;
 const storage={start:async()=> 'real-upload-id',part:async(key,id,n,body)=>parts.set(n,{PartNumber:n,ETag:`real-${n}`,Size:body.length}),
  list:async()=>[...parts.values()],finish:async key=>{finished++;objects.set(key,{ContentLength:[...parts.values()].reduce((s,p)=>s+p.Size,0)});},
  head:async key=>{if(objects.has(key))return objects.get(key);throw Object.assign(new Error(),{name:'NotFound'});}};
 registerMultipartUploads(app,{requireAuth:(req,res,next)=>{req.user={id:req.get('Test-User')||'owner'};next();},enabled:()=>true,secret:()=> 'test-only-secret',storage,recordUpload:async()=>reviewed++});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/uploads/multipart`;
 const size=Math.round(91.9*1024*1024);
 const start=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'song.wav',size,contentType:'audio/wav'})});assert.equal(start.status,201);
 const session=(await start.json()).session,headers={'X-YSong-Upload-Session':session};
 try {
  assert.equal((await fetch(base+'/complete',{method:'POST',headers:{...headers,'Test-User':'other'}})).status,400);
  assert.equal((await fetch(base+'/complete',{method:'POST',headers})).status,400);
  assert.equal((await fetch(base+'/parts/1',{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:Buffer.alloc(2)})).status,400);
  for(let offset=0,n=1;offset<size;offset+=partBytes,n++)assert.equal((await fetch(base+`/parts/${n}`,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:Buffer.alloc(Math.min(partBytes,size-offset))})).status,200);
  const completed=await fetch(base+'/complete',{method:'POST',headers});assert.equal(completed.status,201);assert.equal((await completed.json()).size,size);
  assert.equal((await fetch(base+'/complete',{method:'POST',headers})).status,201);assert.equal(finished,1);assert.equal(reviewed,2);
  assert.equal((await fetch(base+'/complete',{method:'POST',headers:{'X-YSong-Upload-Session':session+'tampered'}})).status,401);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('streamed upload governance preserves digest and image classification with bounded header memory', async()=>{
 const bytes=Buffer.from([137,80,78,71,...Buffer.alloc(1000)]);let recorded;
 const governance=createGovernance({pool:{query:async(_sql,args)=>{recorded=args;}},enabled:()=>true});
 async function* stream(){yield bytes.subarray(0,2);yield bytes.subarray(2);}
 await governance.recordUpload('owner','key',stream(),'application/octet-stream');
 assert.equal(recorded[2],crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(recorded[3],'needs_review');
});
