import test from 'node:test';
import assert from 'node:assert/strict';
import {generationJobState} from '../src/saas/job-state.mjs';

const base={id:'stable-version-id',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:01:00Z'};

test('generation versions project every lifecycle state with stable identity and timestamps',()=>{
  for(const [state,status] of Object.entries({queued:'queued',planning:'running',generating:'running',processing:'running',finalizing:'running',ready:'succeeded',partially_ready:'partial',failed:'failed',cancelled:'cancelled'})){
    const job=generationJobState({...base,state});
    assert.equal(job.id,base.id);
    assert.equal(job.status,status);
    assert.equal(job.createdAt,base.created_at);
    assert.equal(job.finishedAt,['succeeded','partial','failed','cancelled'].includes(status)?base.updated_at:null);
  }
});

test('progress and retryability reflect durable parts while errors stay redacted',()=>{
  const job=generationJobState({...base,state:'partially_ready',error_code:'secret provider response',execution:{saved:true,parts:{a:{state:'ready'},b:{state:'failed',error:'private'}}}});
  assert.deepEqual(job.progress,{completed:2,total:3,percent:66});
  assert.equal(job.retryable,true);
  assert.deepEqual(job.error,{code:'generation_failed'});
  assert.equal(JSON.stringify(job).includes('private'),false);
  assert.equal(generationJobState({...base,state:'failed',execution:{parts:{a:{state:'ambiguous'}}}}).retryable,false);
  assert.throws(()=>generationJobState({...base,state:'unknown'}));
});
