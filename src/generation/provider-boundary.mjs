// Internal audio-generation contract. Planner/chat providers are deliberately outside it.
const kinds = new Set(['song', 'audio', 'midi', 'multitrack', 'vocal']);
const statuses = new Set(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']);
const errorCodes = new Set(['generation_failed', 'provider_unavailable', 'provider_timeout', 'render_failed', 'finalization_failed']);
const artifactKinds = new Set(['audio', 'midi', 'stem', 'vocal']);

export function generationCapability({kind, formats, cancellation = false, asynchronous = false}) {
  if (!kinds.has(kind) || !Array.isArray(formats) || !formats.length || formats.some(f => typeof f !== 'string' || !/^[a-z0-9]{1,16}$/.test(f))) throw new TypeError('invalid_generation_capability');
  return Object.freeze({kind, formats:[...new Set(formats)], cancellation:!!cancellation, asynchronous:!!asynchronous});
}

export function generationProvider({id, model, modelVersion = null, capabilities, submit, poll, cancel}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(id) || !model || !Array.isArray(capabilities) || !capabilities.length || typeof submit !== 'function') throw new TypeError('invalid_generation_provider');
  if (capabilities.some(c => !kinds.has(c.kind) || !Array.isArray(c.formats))) throw new TypeError('invalid_generation_capability');
  if (capabilities.some(c => c.asynchronous) && typeof poll !== 'function') throw new TypeError('poll_required');
  if (capabilities.some(c => c.cancellation) && typeof cancel !== 'function') throw new TypeError('cancel_required');
  return Object.freeze({id, model, modelVersion, capabilities, submit, poll, cancel});
}

export function supportsGeneration(provider, kind, format) {
  return provider.capabilities.some(c => c.kind === kind && c.formats.includes(format));
}

// Only a server-owned storage reference can become a public artifact. Provider URLs and
// arbitrary upstream response bodies must never be copied into a job projection.
export function generationJob({id, kind, status, provider, model, modelVersion = null, provenance,
  artifacts = [], cost = null, cancellation = null, error = null}) {
  if (!id || !kinds.has(kind) || !statuses.has(status) || !provenance || !['user', 'session', 'revision'].includes(provenance.kind)) throw new TypeError('invalid_generation_job');
  if (!Array.isArray(artifacts) || artifacts.some(a => !artifactKinds.has(a.kind) || typeof a.objectKey !== 'string' || !/^user-uploads\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(a.objectKey) || a.objectKey.split('/').includes('..') || (a.bytes != null && (!Number.isSafeInteger(a.bytes) || a.bytes < 0)))) throw new TypeError('invalid_generation_artifact');
  if (cost && (!['reported', 'estimated'].includes(cost.basis) || !Number.isFinite(cost.amount) || cost.amount < 0 || !/^[A-Z]{3}$/.test(cost.currency))) throw new TypeError('invalid_generation_cost');
  return {
    id, kind, status, provider:provider ?? null, model:model ?? null, modelVersion,
    provenance:{kind:provenance.kind, sourceId:provenance.sourceId ?? null, parentJobId:provenance.parentJobId ?? null},
    artifacts:artifacts.map(a => ({kind:a.kind, objectKey:a.objectKey, contentType:a.contentType ?? null, bytes:a.bytes ?? null})),
    cost:cost ? {basis:cost.basis, amount:cost.amount, currency:cost.currency} : null,
    cancellation:{supported:!!cancellation?.supported, requested:!!cancellation?.requested},
    error:['failed', 'partial'].includes(status) ? {code:errorCodes.has(error?.code) ? error.code : 'generation_failed'} : null
  };
}
