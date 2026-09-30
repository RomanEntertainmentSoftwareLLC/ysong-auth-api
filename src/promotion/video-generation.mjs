import { z } from "zod";

// References are YSong-owned assets. The job owner must be checked before an
// orchestrator passes their object keys to an adapter.
export const VideoGenerationRequestSchema = z.object({
  aspectRatio: z.enum(["9:16", "4:3", "1:1", "16:9"]),
  durationSeconds: z.number().int().positive().max(120),
  prompt: z.string().trim().min(1).max(4000),
  references: z.array(z.object({
    kind: z.enum(["image", "video", "audio"]),
    objectKey: z.string().min(1).max(1024),
    role: z.enum(["style", "subject", "motion", "soundtrack"]),
  }).strict()).max(8).default([]),
  timing: z.array(z.object({
    atSeconds: z.number().min(0),
    instruction: z.string().trim().min(1).max(1000),
  }).strict()).max(24).default([]),
}).strict().superRefine((value, ctx) => {
  for (const [index, cue] of value.timing.entries()) {
    if (cue.atSeconds >= value.durationSeconds) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timing", index, "atSeconds"], message: "Cue must precede the video end" });
    }
  }
});

export const VideoGenerationJobSchema = z.object({
  providerJobId: z.string().min(1).max(512),
  status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]),
  output: z.object({
    objectKey: z.string().min(1).max(1024),
    contentType: z.literal("video/mp4"),
    durationSeconds: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict().nullable(),
  errorCode: z.string().min(1).max(160).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "succeeded" && !value.output) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "Completed job needs an output" });
  }
  if (value.status !== "succeeded" && value.output) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "Output requires a completed job" });
  }
});

// Adapter contract: id, checkEligibility({ request, context }), submit({ request,
// context }), poll({ providerJobId, context }). Credentials, official API access,
// commercial terms, and provider payloads belong entirely to the adapter.
export function createVideoGenerationProviderRegistry(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    const id = String(provider?.id || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) ||
        typeof provider.checkEligibility !== "function" ||
        typeof provider.submit !== "function" ||
        typeof provider.poll !== "function") {
      throw new TypeError("invalid_video_generation_provider_adapter");
    }
    if (registry.has(id)) throw new Error("duplicate_video_generation_provider");
    registry.set(id, provider);
  }
  function get(id) {
    const provider = registry.get(String(id || "").trim().toLowerCase());
    if (!provider) throw new Error("video_generation_provider_not_supported");
    return provider;
  }
  return {
    async submit(id, request, context) {
      const provider = get(id);
      const parsed = VideoGenerationRequestSchema.parse(request);
      const eligibility = await provider.checkEligibility({ request: parsed, context });
      if (eligibility?.eligible !== true) {
        const error = new Error("video_generation_provider_ineligible");
        error.reason = String(eligibility?.reason || "unspecified");
        throw error;
      }
      return VideoGenerationJobSchema.parse(await provider.submit({ request: parsed, context }));
    },
    async poll(id, providerJobId, context) {
      const provider = get(id);
      const jobId = z.string().min(1).max(512).parse(providerJobId);
      const job = VideoGenerationJobSchema.parse(await provider.poll({ providerJobId: jobId, context }));
      if (job.providerJobId !== jobId) throw new Error("video_generation_job_id_mismatch");
      return job;
    },
  };
}
