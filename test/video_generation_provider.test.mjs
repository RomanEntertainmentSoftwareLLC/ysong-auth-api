import test from "node:test";
import assert from "node:assert/strict";
import { createVideoGenerationProviderRegistry, VideoGenerationRequestSchema } from "../src/promotion/video-generation.mjs";

const request = {
  aspectRatio: "9:16", durationSeconds: 15, prompt: "Night drive through a neon city",
  references: [{ kind: "image", objectKey: "project-assets/owner/reference.png", role: "style" }],
  timing: [{ atSeconds: 4, instruction: "Show the skyline" }],
};
const queued = { providerJobId: "job-1", status: "queued", output: null, errorCode: null };

test("generation boundary validates requests and checks provider eligibility before submission", async () => {
  const calls = [];
  let eligible = false;
  const registry = createVideoGenerationProviderRegistry([{
    id: "example", checkEligibility: async (args) => { calls.push(["eligibility", args]); return { eligible, reason: "commercial_use_unavailable" }; },
    submit: async (args) => { calls.push(["submit", args]); return queued; },
    poll: async () => queued,
  }]);
  const context = { ownerUserId: "owner" };
  await assert.rejects(registry.submit("example", request, context), (error) =>
    error.message === "video_generation_provider_ineligible" && error.reason === "commercial_use_unavailable");
  assert.deepEqual(calls.map(([name]) => name), ["eligibility"]);
  eligible = true;
  assert.deepEqual(await registry.submit("example", request, context), queued);
  assert.deepEqual(calls.map(([name]) => name), ["eligibility", "eligibility", "submit"]);
  assert.deepEqual(calls[2][1], { request, context });
  await assert.rejects(registry.submit("example", { ...request, prompt: "" }, context));
  assert.equal(calls.length, 3);
});

test("generation request rejects extra provider payloads and cues beyond duration", () => {
  assert.equal(VideoGenerationRequestSchema.safeParse({ ...request, vendorModel: "private-model" }).success, false);
  assert.equal(VideoGenerationRequestSchema.safeParse({ ...request, timing: [{ atSeconds: 15, instruction: "too late" }] }).success, false);
  assert.equal(VideoGenerationRequestSchema.safeParse({ ...request, aspectRatio: "2:3" }).success, false);
});

test("registry validates adapters and normalized asynchronous job results", async () => {
  assert.throws(() => createVideoGenerationProviderRegistry([{ id: "example", submit() {} }]), /invalid_video_generation_provider_adapter/);
  const adapter = { id: "example", checkEligibility: async () => ({ eligible: true }), submit: async () => queued, poll: async () => queued };
  assert.throws(() => createVideoGenerationProviderRegistry([adapter, adapter]), /duplicate_video_generation_provider/);
  const registry = createVideoGenerationProviderRegistry([adapter]);
  assert.deepEqual(await registry.poll("example", "job-1", {}), queued);
  await assert.rejects(registry.poll("example", "other-job", {}), /video_generation_job_id_mismatch/);
  await assert.rejects(registry.submit("unknown", request, {}), /video_generation_provider_not_supported/);
  const completed = { providerJobId: "job-1", status: "succeeded", errorCode: null,
    output: { objectKey: "project-assets/owner/generated.mp4", contentType: "video/mp4", durationSeconds: 15, width: 1080, height: 1920 } };
  assert.deepEqual(await createVideoGenerationProviderRegistry([{ ...adapter, poll: async () => completed }]).poll("example", "job-1", {}), completed);
  const invalid = createVideoGenerationProviderRegistry([{ ...adapter, submit: async () => ({ ...queued, status: "succeeded" }) }]);
  await assert.rejects(invalid.submit("example", request, {}));
  const remoteOnly = createVideoGenerationProviderRegistry([{ ...adapter, poll: async () => ({ ...completed, output: { ...completed.output, url: "https://example.test/file" } }) }]);
  await assert.rejects(remoteOnly.poll("example", "job-1", {}));
});
