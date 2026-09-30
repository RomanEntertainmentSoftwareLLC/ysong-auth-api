import test from "node:test";
import assert from "node:assert/strict";
import { ContentRightsRecordSchema, contentRightsEvidenceHash, evaluateContentRightsGate } from "../src/contentRights/gate.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const observedAt = "2026-09-29T12:00:00.000Z";
const source = { provider: "ysong", source: "user_upload", referenceId: null, observedAt };
const baseEvidence = {
  subject: { ownerUserId: owner, objectKey: `user-uploads/${owner}/song.wav` },
  claimedRelease: { isrc: "USABC2600001", title: "Song", artist: "Artist", durationSeconds: 180 },
  matches: [], identitySupport: [], sources: [source],
  attestation: { userId: owner, statementVersion: "v1", uses: ["public", "promoted"], assertedAt: observedAt, revokedAt: null },
};
const review = (evidence, state, uses = ["public"]) => ({
  state, uses, evidenceHash: contentRightsEvidenceHash(evidence), reviewerId: "reviewer-1", decidedAt: observedAt,
});

test("attestation and release identifiers alone do not clear public use", () => {
  const result = evaluateContentRightsGate({ evidence: baseEvidence, review: null }, "public");
  assert.equal(result.state, "unverified");
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "review_missing");
});

test("a current approval clears only reviewed and attested uses", () => {
  const record = { evidence: baseEvidence, review: review(baseEvidence, "approved") };
  assert.equal(evaluateContentRightsGate(record, "public").state, "clear");
  assert.equal(evaluateContentRightsGate(record, "public").allowed, true);
  assert.equal(evaluateContentRightsGate(record, "promoted").state, "needs-review");
  assert.equal(evaluateContentRightsGate(record, "monetized").allowed, false);
});

test("matches and conflicting identity support require review, not automatic legal conclusions", () => {
  const evidence = {
    ...baseEvidence,
    matches: [{ kind: "acoustic", outcome: "confirmed", referenceId: "catalog-1", confidence: 0.99,
      provenance: { ...source, provider: "reference-provider", source: "reference_service", referenceId: "catalog-1" } }],
    identitySupport: [{ field: "isrc", outcome: "conflicts", provenance: source }],
  };
  assert.equal(evaluateContentRightsGate({ evidence, review: null }, "public").state, "needs-review");
  assert.equal(evaluateContentRightsGate({ evidence, review: review(evidence, "rejected") }, "public").state, "blocked");
  assert.equal(evaluateContentRightsGate({ evidence, review: review(evidence, "approved") }, "public").state, "clear");
});

test("changed evidence and revoked attestation invalidate earlier approval", () => {
  const earlierReview = review(baseEvidence, "approved");
  const changed = { ...baseEvidence, identitySupport: [{ field: "title", outcome: "supports", provenance: source }] };
  assert.equal(evaluateContentRightsGate({ evidence: changed, review: earlierReview }, "public").state, "needs-review");
  const revoked = { ...baseEvidence, attestation: { ...baseEvidence.attestation, revokedAt: observedAt } };
  assert.equal(evaluateContentRightsGate({ evidence: revoked, review: review(revoked, "approved") }, "public").allowed, false);
});

test("record validation rejects owner mismatch and undecided approvals", () => {
  const wrongOwner = { ...baseEvidence, attestation: { ...baseEvidence.attestation, userId: "22222222-2222-4222-8222-222222222222" } };
  assert.equal(ContentRightsRecordSchema.safeParse({ evidence: wrongOwner, review: null }).success, false);
  assert.equal(ContentRightsRecordSchema.safeParse({ evidence: baseEvidence,
    review: { ...review(baseEvidence, "approved"), reviewerId: null } }).success, false);
});
