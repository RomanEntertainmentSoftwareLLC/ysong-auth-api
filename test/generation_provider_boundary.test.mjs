import test from 'node:test';
import assert from 'node:assert/strict';
import {generationCapability, generationProvider, supportsGeneration, generationJob, generationRequest} from '../src/generation/provider-boundary.mjs';
import {contentRightsEvidenceHash} from '../src/contentRights/gate.mjs';
import {generationJobState} from '../src/saas/job-state.mjs';

test('provider capabilities describe current and future audio paths without credentials', () => {
  const cloudflare = generationProvider({id:'cloudflare',model:'minimax/music-2.6',capabilities:[generationCapability({kind:'song',formats:['wav']})],submit:async()=>{}});
  const local = generationProvider({id:'audio_cpp',model:'minimax/music-3',capabilities:[generationCapability({kind:'audio',formats:['wav']})],submit:async()=>{}});
  const privateMusic = generationProvider({id:'private_music',model:'custom/music-3',capabilities:[generationCapability({kind:'multitrack',formats:['wav'],asynchronous:true,cancellation:true})],submit:async()=>{},poll:async()=>{},cancel:async()=>{}});
  assert.equal(supportsGeneration(cloudflare,'song','wav'),true);
  assert.equal(supportsGeneration(local,'midi','mid'),false);
  assert.equal(supportsGeneration(privateMusic,'multitrack','wav'),true);
  assert.throws(()=>generationProvider({id:'bad',model:'x',capabilities:privateMusic.capabilities,submit:async()=>{}}),/poll_required/);
  assert.equal(JSON.stringify(cloudflare).includes('secret'),false);
});

test('job projection retains safe provenance, artifacts, costs and cancellation', () => {
  const job = generationJob({id:'job',kind:'vocal',status:'partial',provider:'private_vocal',model:'v1',modelVersion:'2026-10',
    provenance:{kind:'revision',sourceId:'source',parentJobId:'parent',prompt:'private'},
    artifacts:[{kind:'vocal',objectKey:'user-uploads/owner/vocal.wav',contentType:'audio/wav',bytes:12,url:'private'}],
    cost:{basis:'estimated',amount:0.2,currency:'USD',token:'private'},cancellation:{supported:true,requested:false},error:{code:'upstream_secret',message:'private'}});
  assert.equal(job.error.code,'generation_failed');
  assert.equal(job.cost.basis,'estimated');
  assert.equal(job.artifacts[0].objectKey,'user-uploads/owner/vocal.wav');
  assert.equal(job.provider,'private_vocal');
  assert.equal(JSON.stringify(job).includes('private_vocal'),true); // provider identity is public
  assert.equal(JSON.stringify(job).includes('"private"'),false);
  assert.equal(JSON.stringify(job).includes('upstream_secret'),false);
  assert.throws(()=>generationJob({...job,artifacts:[{kind:'audio',objectKey:'https://provider.example/audio'}]}),/invalid_generation_artifact/);
  assert.throws(()=>generationJob({...job,artifacts:[{kind:'audio',objectKey:'user-uploads/owner/../other.wav'}]}),/invalid_generation_artifact/);
});

test('existing generation versions expose the common boundary', () => {
  const job=generationJobState({id:'v',batch_id:'b',state:'ready',provider:'cloudflare',model:'minimax/music-2.6',source:{kind:'session'},execution:{parts:{a:{state:'ready',objectKey:'user-uploads/u/a.wav',contentType:'audio/wav',bytes:4}}}});
  assert.equal(job.kind,'multitrack');
  assert.equal(job.provenance.sourceId,'b');
  assert.equal(job.artifacts[0].bytes,4);
  assert.equal(job.cost,null);
});

test('reference audio requires model support and current rights for the owned upload', () => {
  const owner='11111111-1111-4111-8111-111111111111';
  const objectKey=`user-uploads/${owner}/reference.wav`;
  const at='2026-10-01T00:00:00.000Z';
  const evidence={subject:{ownerUserId:owner,objectKey},claimedRelease:null,matches:[],identitySupport:[],
    sources:[{provider:'ysong',source:'user_upload',referenceId:null,observedAt:at}],
    attestation:{userId:owner,statementVersion:'v1',uses:['monetized'],assertedAt:at,revokedAt:null}};
  const rights={evidence,review:{state:'approved',uses:['monetized'],evidenceHash:contentRightsEvidenceHash(evidence),reviewerId:'reviewer',decidedAt:at}};
  const provider=generationProvider({id:'music',model:'reference-model',capabilities:[generationCapability({kind:'song',formats:['wav'],referenceAudio:true})],submit:async()=>{}});
  const referenceAudio={objectKey,contentType:'audio/wav',rights};
  const request=generationRequest({provider,kind:'song',format:'wav',input:{prompt:'music'},referenceAudio,userId:owner});
  assert.deepEqual(request.referenceAudio,{objectKey,contentType:'audio/wav',provenance:{ownerUserId:owner,evidenceHash:rights.review.evidenceHash,use:'monetized'}});
  assert.equal(JSON.stringify(request).includes('reviewer'),false);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',input:{referenceAudio},userId:owner}),/invalid_generation_input/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'mp3',referenceAudio,userId:owner}),/unsupported_generation/);
  const textOnly=generationProvider({id:'text',model:'text-model',capabilities:[generationCapability({kind:'song',formats:['wav']})],submit:async()=>{}});
  assert.throws(()=>generationRequest({provider:textOnly,kind:'song',format:'wav',referenceAudio,userId:owner}),/reference_audio_unsupported/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',referenceAudio:{...referenceAudio,objectKey:'https://stream.example/song'},userId:owner}),/invalid_reference_audio/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',referenceAudio:{...referenceAudio,objectKey:'user-uploads/another-user/reference.wav'},userId:owner}),/invalid_reference_audio/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',referenceAudio,userId:'22222222-2222-4222-8222-222222222222'}),/invalid_reference_audio/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',referenceAudio:{...referenceAudio,rights:{...rights,review:null}},userId:owner}),/reference_audio_rights_unverified/);
  assert.throws(()=>generationRequest({provider,kind:'song',format:'wav',referenceAudio:{...referenceAudio,rights:{...rights,evidence:{...evidence,attestation:{...evidence.attestation,revokedAt:at}}}},userId:owner}),/reference_audio_rights_unverified/);
});
