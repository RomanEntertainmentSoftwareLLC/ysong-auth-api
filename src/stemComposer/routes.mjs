import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { makeAudioStemManifest, midiStemPrompt, normalizeStemRequest, normalizeStemUniverse, parseMidiStemResponse, STEM_PREFERRED_MODE } from './engine.mjs';

function configuredAi(){const provider=String(process.env.AI_PROVIDER||(process.env.OPENAI_API_KEY?'openai':'none')).toLowerCase();return provider==='openai'&&Boolean(process.env.OPENAI_API_KEY);}
function audioProviderConfigured(){return Boolean(String(process.env.STEM_AUDIO_PROVIDER_URL||'').trim());}
function errStatus(e){return Number.isFinite(Number(e?.statusCode))?Number(e.statusCode):500;}
function safeExt(contentType=''){if(/flac/i.test(contentType))return '.flac';if(/mpeg|mp3/i.test(contentType))return '.mp3';if(/ogg/i.test(contentType))return '.ogg';if(/m4a|mp4|aac/i.test(contentType))return '.m4a';return '.wav';}
function run(bin,args,{timeoutMs=120000}={}){return new Promise((resolve,reject)=>{const child=spawn(bin,args,{stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');const e=new Error(`${bin}_timeout`);e.statusCode=504;reject(e);},timeoutMs);child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve({out,err});else{const e=new Error(`${bin}_failed`);e.details=err.slice(-3000);e.statusCode=502;reject(e);}});});}

export async function normalizeGeneratedAudioFile(inputPath, outputPath, { exactDurationSec, sampleRate }) {
  const duration=Math.max(.05,Number(exactDurationSec)||.05); const rate=[44100,48000,88200,96000].includes(Number(sampleRate))?Number(sampleRate):48000;
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',inputPath,'-vn','-af','apad','-t',duration.toFixed(6),'-ar',String(rate),'-ac','2','-c:a','pcm_s24le',outputPath],{timeoutMs:180000});
  const probe=await run('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=sample_rate,channels:format=duration','-of','json',outputPath]);
  const parsed=JSON.parse(probe.out||'{}'); const stream=parsed?.streams?.[0]||{}; const actualDuration=Number(parsed?.format?.duration||0); const actualRate=Number(stream.sample_rate||0);
  if(!Number.isFinite(actualDuration)||Math.abs(actualDuration-duration)>.05)throw Object.assign(new Error('stem_audio_duration_normalization_failed'),{statusCode:502});
  if(actualRate!==rate)throw Object.assign(new Error('stem_audio_sample_rate_normalization_failed'),{statusCode:502});
  return {durationSec:actualDuration,sampleRate:actualRate,channels:Number(stream.channels||2)};
}

async function providerAudioBytes(manifest){
  const url=String(process.env.STEM_AUDIO_PROVIDER_URL||'').trim(); if(!url)throw Object.assign(new Error('stem_audio_provider_not_configured'),{statusCode:503});
  const headers={'content-type':'application/json'}; const key=String(process.env.STEM_AUDIO_PROVIDER_API_KEY||'').trim(); if(key)headers.authorization=`Bearer ${key}`;
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),Math.max(15000,Number(process.env.STEM_AUDIO_PROVIDER_TIMEOUT_MS||180000)));
  let response; try{response=await fetch(url,{method:'POST',headers,body:JSON.stringify(manifest),signal:controller.signal});}finally{clearTimeout(timeout);}
  if(!response.ok)throw Object.assign(new Error(`stem_audio_provider_http_${response.status}`),{statusCode:502});
  const contentType=String(response.headers.get('content-type')||'');
  if(!/json/i.test(contentType)){const bytes=Buffer.from(await response.arrayBuffer());return {bytes,contentType:contentType||'audio/wav'};}
  const data=await response.json();
  if(data?.audioBase64){return {bytes:Buffer.from(String(data.audioBase64),'base64'),contentType:String(data.contentType||'audio/wav')};}
  if(data?.audioUrl){const audio=await fetch(String(data.audioUrl));if(!audio.ok)throw Object.assign(new Error(`stem_audio_download_http_${audio.status}`),{statusCode:502});return {bytes:Buffer.from(await audio.arrayBuffer()),contentType:String(audio.headers.get('content-type')||data.contentType||'audio/wav')};}
  throw Object.assign(new Error('stem_audio_provider_missing_audio'),{statusCode:502});
}

export function registerStemComposerRoutes(app,{requireAuth,callOpenAI,objectPath,writeObjectMetadata,assertOwnedObjectKey}){
  app.get('/api/stem-composer/status',requireAuth,(_req,res)=>res.json({
    structuredMidiConfigured:configuredAi(),audioProviderConfigured:audioProviderConfigured(),provider:configuredAi()?'openai':'none',model:process.env.OPENAI_MODEL||'gpt-5.6',
    audioProviderName:audioProviderConfigured()?(process.env.STEM_AUDIO_PROVIDER_NAME||'external-target-stem-provider'):'none',
    targetOnly:true,progressiveConditioning:true,absoluteTimeline:true,preferredModes:STEM_PREFERRED_MODE,audioOutputNormalization:'exact-duration-stereo-wav',learnedAudioModel:audioProviderConfigured(),
  }));

  app.post('/api/stem-composer/universe/lock',requireAuth,(req,res)=>{
    try{return res.json({universe:normalizeStemUniverse({...req.body,locked:true})});}
    catch(e){return res.status(errStatus(e)).json({error:String(e?.message||'stem_universe_invalid'),message:e?.message||'Could not lock the song universe.'});}
  });

  app.post('/api/stem-composer/midi/generate',requireAuth,async(req,res)=>{
    if(!configuredAi())return res.status(503).json({error:'stem_composer_ai_not_configured',message:'Configure the server AI provider before generating progressive MIDI stems.'});
    try{
      const request=normalizeStemRequest({...req.body,mode:'midi'});
      const answer=await callOpenAI([{role:'developer',content:midiStemPrompt(request)}],{maxOutputTokens:14000});
      const proposal=parseMidiStemResponse(answer.text,request);
      return res.json({proposal,provider:'openai',model:process.env.OPENAI_MODEL||'gpt-5.6'});
    }catch(e){console.error('POST /api/stem-composer/midi/generate ERROR',e);return res.status(errStatus(e)).json({error:String(e?.message||'stem_midi_generation_failed'),message:e?.message||'Could not generate the target MIDI stem.'});}
  });

  app.post('/api/stem-composer/audio/manifest',requireAuth,async(req,res)=>{
    try{return res.json({manifest:makeAudioStemManifest({...req.body,mode:'audio'})});}
    catch(e){return res.status(errStatus(e)).json({error:String(e?.message||'stem_audio_manifest_failed'),message:e?.message||'Could not prepare the target-stem request.'});}
  });

  app.post('/api/stem-composer/audio/generate',requireAuth,async(req,res)=>{
    if(!audioProviderConfigured())return res.status(503).json({error:'stem_audio_provider_not_configured',message:'Configure a target-stem audio generation provider before generating audio stems.'});
    const tempDir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'ysong-stem-'));
    try{
      const request=normalizeStemRequest({...req.body,mode:'audio'});
      for(const dep of request.dependencies){if(dep.assetId)assertOwnedObjectKey(req.user.id,dep.assetId);}
      const manifest=makeAudioStemManifest(request);
      const generated=await providerAudioBytes(manifest);
      if(!generated.bytes.length||generated.bytes.length>512*1024*1024)throw Object.assign(new Error('stem_audio_invalid_size'),{statusCode:502});
      const input=path.join(tempDir,`provider${safeExt(generated.contentType)}`);const output=path.join(tempDir,'normalized.wav');
      await fs.promises.writeFile(input,generated.bytes);
      const normalized=await normalizeGeneratedAudioFile(input,output,{exactDurationSec:request.universe.exactDurationSec,sampleRate:request.universe.sampleRate});
      const objectKey=`project-assets/${req.user.id}/stem-composer/${request.universe.songId}/${Date.now()}-${crypto.randomUUID()}-${request.targetRole}.wav`;
      const target=objectPath(objectKey);await fs.promises.mkdir(path.dirname(target),{recursive:true});await fs.promises.copyFile(output,target);
      const stat=await fs.promises.stat(target);
      await writeObjectMetadata(objectKey,{contentType:'audio/wav',size:stat.size,createdAt:new Date().toISOString(),source:'progressive-stem-composer',stemRole:request.targetRole,universeHash:request.universe.universeHash,generationFamily:request.universe.generationFamily,generationSeed:request.generationSeed,version:request.version,durationSec:normalized.durationSec,sampleRate:normalized.sampleRate});
      return res.json({proposal:{id:`stemidea_${crypto.randomUUID()}`,role:request.targetRole,mode:'audio',label:`${request.targetRole} stem`,startBar:1,lengthBars:request.universe.totalBars,exactDurationSec:request.universe.exactDurationSec,sampleRate:normalized.sampleRate,channels:normalized.channels,objectKey,assetId:objectKey,sizeBytes:stat.size,universeHash:request.universe.universeHash,generationFamily:request.universe.generationFamily,generationSeed:request.generationSeed,version:request.version,dependsOn:request.dependencies.map(d=>({nodeId:d.nodeId,version:d.version,role:d.role})),provider:process.env.STEM_AUDIO_PROVIDER_NAME||'external-target-stem-provider'},manifest});
    }catch(e){console.error('POST /api/stem-composer/audio/generate ERROR',e);return res.status(errStatus(e)).json({error:String(e?.message||'stem_audio_generation_failed'),message:e?.message||'Could not generate the target audio stem.'});}
    finally{await fs.promises.rm(tempDir,{recursive:true,force:true}).catch(()=>{});}
  });
}
