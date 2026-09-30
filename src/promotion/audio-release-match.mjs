import { z } from "zod";

const fingerprint = z.object({
  algorithm: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(2048),
  durationSeconds: z.number().finite().positive(),
}).strict();
const metadata = z.object({
  isrc: z.string().trim().max(32).nullable().default(null),
  title: z.string().trim().max(180).nullable().default(null),
  artist: z.string().trim().max(180).nullable().default(null),
}).strict().default({});

export const AudioReleaseMatchInputSchema = z.object({
  upload: z.object({ fingerprint, metadata }).strict(),
  references: z.array(z.object({
    id: z.string().trim().min(1).max(240),
    source: z.enum(["ysong_master", "ysong_reference", "artist_reference"]),
    fingerprint: fingerprint.nullable(),
    metadata,
  }).strict()).max(100),
  // Scores must come from a trusted fingerprint comparator over authorized audio.
  // A request supplied score is not evidence of a match.
  comparisons: z.array(z.object({
    referenceId: z.string().trim().min(1).max(240),
    similarity: z.number().finite().min(0).max(1),
    overlapSeconds: z.number().finite().min(0),
  }).strict()).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  const ids = new Set();
  for (const reference of value.references) {
    if (ids.has(reference.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["references"], message: "Reference IDs must be unique" });
    ids.add(reference.id);
  }
  const compared = new Set();
  for (const comparison of value.comparisons) {
    const reference = value.references.find(item => item.id === comparison.referenceId);
    if (!reference?.fingerprint || reference.fingerprint.algorithm !== value.upload.fingerprint.algorithm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisons"], message: "Comparison requires a known reference with the same fingerprint algorithm" });
    } else if (comparison.overlapSeconds > Math.min(reference.fingerprint.durationSeconds, value.upload.fingerprint.durationSeconds)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisons"], message: "Overlap exceeds available audio" });
    }
    if (compared.has(comparison.referenceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisons"], message: "Only one comparison per reference is allowed" });
    compared.add(comparison.referenceId);
  }
});

export const AudioReleaseMatchOutcomeSchema = z.enum([
  "same_recording", "likely_same_recording", "possible_alternate_master_or_edit",
  "related_or_different_version", "mismatch", "insufficient_evidence",
]);

const rank = { same_recording: 5, likely_same_recording: 4, possible_alternate_master_or_edit: 3,
  related_or_different_version: 2, mismatch: 1, insufficient_evidence: 0 };
const sourceRank = { ysong_master: 3, ysong_reference: 2, artist_reference: 1 };
const normalized = value => value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en") || null;

function metadataReasons(upload, reference) {
  const reasons = [];
  for (const field of ["isrc", "title", "artist"]) {
    const left = normalized(upload[field]);
    const right = normalized(reference[field]);
    if (left && right) reasons.push(`${field}_${left === right ? "supports" : "conflicts"}`);
  }
  return reasons;
}

function evaluateReference(upload, reference, comparison) {
  const reasons = metadataReasons(upload.metadata, reference.metadata);
  const base = { referenceId: reference.id, referenceSource: reference.source, reasons };
  const ref = reference.fingerprint;
  if (!ref || ref.algorithm !== upload.fingerprint.algorithm) {
    return { ...base, outcome: "insufficient_evidence", confidence: 0 };
  }
  const durationDelta = Math.abs(upload.fingerprint.durationSeconds - ref.durationSeconds) /
    Math.max(upload.fingerprint.durationSeconds, ref.durationSeconds);
  const durationCompatible = durationDelta <= 0.03;
  if (upload.fingerprint.value === ref.value) {
    return { ...base, outcome: durationCompatible ? "same_recording" : "possible_alternate_master_or_edit",
      confidence: durationCompatible ? 0.99 : 0.9,
      reasons: ["fingerprint_exact", durationCompatible ? "duration_supports" : "duration_differs", ...reasons] };
  }
  if (!comparison) return { ...base, outcome: "insufficient_evidence", confidence: 0,
    reasons: ["comparison_missing", ...reasons] };
  const { similarity, overlapSeconds } = comparison;
  const coverage = overlapSeconds / Math.min(upload.fingerprint.durationSeconds, ref.durationSeconds);
  const evidenceReasons = [`fingerprint_similarity_${similarity >= 0.82 ? "high" : similarity >= 0.65 ? "moderate" : "low"}`,
    durationCompatible ? "duration_supports" : "duration_differs", ...reasons];
  if (similarity >= 0.94 && overlapSeconds >= 20 && coverage >= 0.5 && durationCompatible) {
    return { ...base, outcome: "same_recording", confidence: 0.95, reasons: evidenceReasons };
  }
  if (similarity >= 0.82 && overlapSeconds >= 10 && coverage >= 0.25) {
    return { ...base, outcome: durationCompatible ? "likely_same_recording" : "possible_alternate_master_or_edit",
      confidence: durationCompatible ? 0.84 : 0.78, reasons: evidenceReasons };
  }
  if (similarity >= 0.65 && overlapSeconds >= 8 && coverage >= 0.2) {
    return { ...base, outcome: "related_or_different_version", confidence: 0.66, reasons: evidenceReasons };
  }
  if (similarity <= 0.35 && overlapSeconds >= 15 && coverage >= 0.5) {
    return { ...base, outcome: "mismatch", confidence: 0.85, reasons: evidenceReasons };
  }
  return { ...base, outcome: "insufficient_evidence", confidence: 0,
    reasons: ["comparison_inconclusive", ...evidenceReasons] };
}

// Trusted callers supply fingerprints from the upload and authorized references,
// plus optional comparator scores. This function never retrieves any media.
export function matchAdsAudioToRelease(input) {
  const { upload, references, comparisons } = AudioReleaseMatchInputSchema.parse(input);
  if (!references.length) return { outcome: "insufficient_evidence", confidence: 0,
    referenceId: null, referenceSource: null, reasons: ["no_authorized_reference"] };
  const byId = new Map(comparisons.map(item => [item.referenceId, item]));
  const results = references.map(reference => evaluateReference(upload, reference, byId.get(reference.id)));
  results.sort((a, b) => rank[b.outcome] - rank[a.outcome] ||
    sourceRank[b.referenceSource] - sourceRank[a.referenceSource] || b.confidence - a.confidence ||
    a.referenceId.localeCompare(b.referenceId));
  const selected = results[0];
  const conflicts = results.some(item => item.referenceId !== selected.referenceId &&
    item.outcome === "mismatch" && rank[selected.outcome] >= 3);
  return { ...selected, reasons: [...selected.reasons, ...(conflicts ? ["other_reference_conflicts"] : [])] };
}
