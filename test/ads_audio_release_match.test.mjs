import test from "node:test";
import assert from "node:assert/strict";
import { AudioReleaseMatchInputSchema, matchAdsAudioToRelease } from "../src/promotion/audio-release-match.mjs";

const fp = (value, durationSeconds = 180, algorithm = "acoustic-v1") => ({ value, durationSeconds, algorithm });
const upload = { fingerprint: fp("upload"), metadata: { isrc: "USABC2600001", title: "Song", artist: "Artist" } };
const reference = (id, source, fingerprint, metadata = {}) => ({ id, source, fingerprint, metadata });
const input = (references, comparisons = []) => ({ upload, references, comparisons });

test("exact authorized YSong master wins over artist reference and metadata", () => {
  const result = matchAdsAudioToRelease(input([
    reference("artist", "artist_reference", fp("upload")),
    reference("master", "ysong_master", fp("upload")),
  ]));
  assert.equal(result.outcome, "same_recording");
  assert.equal(result.referenceId, "master");
  assert.equal(result.confidence, 0.99);
  assert.ok(result.reasons.includes("fingerprint_exact"));
});

test("high similarity distinguishes same recording, likely match, and alternate edit", () => {
  const master = reference("master", "ysong_master", fp("other"));
  assert.equal(matchAdsAudioToRelease(input([master], [
    { referenceId: "master", similarity: 0.97, overlapSeconds: 120 },
  ])).outcome, "same_recording");
  assert.equal(matchAdsAudioToRelease(input([master], [
    { referenceId: "master", similarity: 0.86, overlapSeconds: 90 },
  ])).outcome, "likely_same_recording");
  const edit = reference("edit", "artist_reference", fp("other", 140));
  assert.equal(matchAdsAudioToRelease(input([edit], [
    { referenceId: "edit", similarity: 0.9, overlapSeconds: 90 },
  ])).outcome, "possible_alternate_master_or_edit");
});

test("moderate similarity, strong negative comparison, and thin evidence stay distinct", () => {
  const master = reference("master", "ysong_reference", fp("other"));
  const compare = (similarity, overlapSeconds) => matchAdsAudioToRelease(input([master], [
    { referenceId: "master", similarity, overlapSeconds },
  ]));
  assert.equal(compare(0.72, 90).outcome, "related_or_different_version");
  assert.equal(compare(0.18, 100).outcome, "mismatch");
  assert.equal(compare(0.18, 4).outcome, "insufficient_evidence");
  assert.equal(matchAdsAudioToRelease(input([master])).outcome, "insufficient_evidence");
});

test("metadata alone cannot establish or reject a recording", () => {
  const result = matchAdsAudioToRelease(input([
    reference("catalog", "ysong_reference", null, { isrc: upload.metadata.isrc, title: "Song", artist: "Artist" }),
  ]));
  assert.equal(result.outcome, "insufficient_evidence");
  assert.ok(result.reasons.includes("isrc_supports"));
  assert.equal(matchAdsAudioToRelease(input([])).referenceId, null);
});

test("positive artist evidence can beat a YSong mismatch and reports the conflict", () => {
  const result = matchAdsAudioToRelease(input([
    reference("catalog", "ysong_master", fp("other")),
    reference("artist", "artist_reference", fp("upload")),
  ], [{ referenceId: "catalog", similarity: 0.1, overlapSeconds: 120 }]));
  assert.equal(result.referenceId, "artist");
  assert.equal(result.outcome, "same_recording");
  assert.ok(result.reasons.includes("other_reference_conflicts"));
});

test("invalid or ungrounded comparator evidence is rejected", () => {
  const master = reference("master", "ysong_master", fp("other"));
  assert.equal(AudioReleaseMatchInputSchema.safeParse(input([master], [
    { referenceId: "missing", similarity: 1, overlapSeconds: 20 },
  ])).success, false);
  assert.equal(AudioReleaseMatchInputSchema.safeParse(input([master], [
    { referenceId: "master", similarity: 1, overlapSeconds: 200 },
  ])).success, false);
  assert.equal(AudioReleaseMatchInputSchema.safeParse(input([master, master])).success, false);
  assert.equal(AudioReleaseMatchInputSchema.safeParse(input([reference("other", "ysong_master", fp("x", 180, "different"))], [
    { referenceId: "other", similarity: 0.99, overlapSeconds: 90 },
  ])).success, false);
});
