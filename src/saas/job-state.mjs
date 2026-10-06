// Public view of the existing generation-version job. Never expose provider
// messages, execution internals, or arbitrary stored error text here.
const states = Object.freeze({
  queued:'queued', planning:'running', generating:'running', processing:'running', finalizing:'running',
  ready:'succeeded', partially_ready:'partial', failed:'failed', cancelled:'cancelled'
});
const safeCodes = new Set(['generation_failed','provider_unavailable','provider_timeout','render_failed','finalization_failed']);

export function generationJobState(version) {
  if (!version?.id || !Object.hasOwn(states, version.state)) throw new TypeError('invalid_generation_job');
  const parts = Object.values(version.execution?.parts ?? {});
  const total = parts.length + 1;
  const completed = parts.filter(part => part.state === 'ready').length + (version.execution?.saved ? 1 : 0);
  const status = states[version.state];
  const terminal = ['succeeded','failed','cancelled','partial'].includes(status);
  const reviewRequired = parts.some(part => part.state === 'ambiguous');
  return {
    id:version.id,
    status,
    progress:{completed,total,percent:Math.floor(100 * completed / total)},
    createdAt:version.created_at ?? null,
    updatedAt:version.updated_at ?? null,
    finishedAt:terminal ? version.updated_at ?? null : null,
    retryable:(status === 'failed' || status === 'partial') && !reviewRequired && parts.some(part => part.state === 'failed'),
    error:status === 'failed' || status === 'partial'
      ? {code:safeCodes.has(version.error_code) ? version.error_code : 'generation_failed'} : null
  };
}
