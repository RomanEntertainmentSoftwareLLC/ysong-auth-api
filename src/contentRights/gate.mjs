import crypto from "node:crypto";
import { z } from "zod";

export const ContentUseSchema = z.enum(["public", "promoted", "monetized"]);
export const ContentRightsStateSchema = z.enum(["clear", "needs-review", "blocked", "unverified"]);

const timestamp = z.string().datetime();
const provenance = z.object({
  provider: z.string().trim().min(1).max(120),
  source: z.enum(["user_upload", "ysong_catalog", "distributor", "reference_service", "other"]),
  referenceId: z.string().trim().max(240).nullable(),
  observedAt: timestamp,
}).strict();

export const ContentRightsEvidenceSchema = z.object({
  subject: z.object({ ownerUserId: z.string().uuid(), objectKey: z.string().trim().min(1).max(1000) }).strict(),
  claimedRelease: z.object({
    isrc: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/).nullable(),
    title: z.string().trim().min(1).max(180),
    artist: z.string().trim().min(1).max(180),
    durationSeconds: z.number().finite().positive().nullable(),
  }).strict().nullable(),
  matches: z.array(z.object({
    kind: z.enum(["acoustic", "reference"]),
    outcome: z.enum(["possible", "confirmed", "no_match"]),
    referenceId: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1).nullable(),
    provenance,
  }).strict()).max(100),
  identitySupport: z.array(z.object({
    field: z.enum(["isrc", "title", "artist", "duration"]),
    outcome: z.enum(["supports", "conflicts", "inconclusive"]),
    provenance,
  }).strict()).max(100),
  sources: z.array(provenance).max(100),
  attestation: z.object({
    userId: z.string().uuid(),
    statementVersion: z.string().trim().min(1).max(80),
    uses: z.array(ContentUseSchema).min(1).max(3),
    assertedAt: timestamp,
    revokedAt: timestamp.nullable(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.attestation && value.attestation.userId !== value.subject.ownerUserId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attestation", "userId"], message: "Attestation must belong to the content owner" });
  }
  if (value.attestation && new Set(value.attestation.uses).size !== value.attestation.uses.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attestation", "uses"], message: "Uses must be unique" });
  }
});

export const ContentRightsRecordSchema = z.object({
  evidence: ContentRightsEvidenceSchema,
  review: z.object({
    state: z.enum(["pending", "approved", "rejected"]),
    uses: z.array(ContentUseSchema).min(1).max(3),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewerId: z.string().trim().min(1).max(160).nullable(),
    decidedAt: timestamp.nullable(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  const review = value.review;
  if (!review) return;
  if (new Set(review.uses).size !== review.uses.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review", "uses"], message: "Uses must be unique" });
  }
  if (review.state !== "pending" && (!review.reviewerId || !review.decidedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review"], message: "A decision requires a reviewer and decision time" });
  }
});

// A review is valid only for the exact evidence package it considered.
export function contentRightsEvidenceHash(evidence) {
  const parsed = ContentRightsEvidenceSchema.parse(evidence);
  return crypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

export function evaluateContentRightsGate(record, use) {
  const { evidence, review } = ContentRightsRecordSchema.parse(record);
  const requestedUse = ContentUseSchema.parse(use);
  const evidenceHash = contentRightsEvidenceHash(evidence);
  const attested = !!evidence.attestation && !evidence.attestation.revokedAt &&
    evidence.attestation.uses.includes(requestedUse);
  const reviewApplies = !!review && review.uses.includes(requestedUse) && review.evidenceHash === evidenceHash;
  const signalsNeedReview = evidence.matches.some(match => match.outcome !== "no_match") ||
    evidence.identitySupport.some(item => item.outcome === "conflicts");

  let state;
  let reason;
  if (reviewApplies && review.state === "rejected") {
    state = "blocked";
    reason = "review_rejected";
  } else if (reviewApplies && review.state === "approved" && attested) {
    state = "clear";
    reason = "review_approved";
  } else if (signalsNeedReview || (review && (!reviewApplies || review.state === "pending")) ||
    (reviewApplies && review.state === "approved" && !attested)) {
    state = "needs-review";
    reason = !attested ? "attestation_missing_or_revoked" :
      review && !reviewApplies ? "review_stale_or_out_of_scope" : "evidence_requires_review";
  } else {
    state = "unverified";
    reason = attested ? "review_missing" : "attestation_missing_or_revoked";
  }
  return { state: ContentRightsStateSchema.parse(state), allowed: state === "clear", use: requestedUse, reason, evidenceHash };
}
