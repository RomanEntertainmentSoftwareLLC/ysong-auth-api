import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('SaaS music persistence saves the exact audio through the existing owned R2 boundary', async () => {
  let saved;
  const context=vm.createContext({ USE_R2:true,governance:{recordUpload:async()=>{}}, putR2Object:async(key,audio,options)=>{saved={key,audio,options};},Date });
  vm.runInContext(section('async function persistGenerationAudio','app.post(\n\t"/api/music/generate"'),context);
  const bytes=Buffer.from('audio fixture');
  const key=await context.persistGenerationAudio('owner','version',{audio:bytes,contentType:'audio/wav'});
  assert.equal(key,'user-uploads/owner/generations/Generation-version.wav');
  assert.equal(saved.audio,bytes);assert.equal(saved.options.contentLength,bytes.length);
  assert.equal(saved.options.metadata.userId,'owner');assert.equal(saved.options.metadata.generationId,'version');
});

test("Cloudflare status is non-generating and music preserves the binary contract with production auth", async (t) => {
  const app = express(); app.use(express.json());
  const calls = [];
  let upstreamFailure = false;
  const context = vm.createContext({ app, z, fs, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    console: { error() {} }, LOCAL_MODE: false, saasEnabled: () => false,
    AccessError: class extends Error {},
    sha256: value => createHash('sha256').update(value).digest('hex'),
    process: { env: { MINIMAX_MUSIC_PROVIDER: "cf", CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_AI_API_TOKEN: "test-secret" } },
    requireAuth(req, res, next) { if (req.headers.authorization !== "Bearer test") return res.status(401).end(); next(); },
    generateWithAudioCpp: async () => ({ audio: Buffer.from("local"), contentType: "audio/wav", provider: "audio_cpp" }),
    generateWithMiniMaxHttp: async () => ({ audio: Buffer.from("legacy"), contentType: "audio/wav", provider: "http" }),
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (upstreamFailure) throw new Error("Cloudflare test-secret must never escape.");
      if (String(url).endsWith("/verify")) return { ok: true, status: 200, json: async () => ({ success: true, result: { status: "active" } }) };
      if (String(url).endsWith("/ai/run")) return { ok: true, json: async () => ({ success: true, result: { audio: "https://audio.example/music.wav" } }) };
      return { ok: true, headers: { get: () => "audio/wav" }, arrayBuffer: async () => Buffer.from("generated-audio") };
    },
  });
  vm.runInContext(section("function miniMaxProvider", "function runCapturedProcess") +
    section("function cloudflareMusicConfig", "const MusicGenerateSchema") +
    section("const MusicGenerateSchema", "function audioCppSteps") +
    section("async function generateWithCloudflareMusic", "async function generateWithMiniMaxHttp") +
    section('app.post(\n\t"/api/music/generate"', "// Optional AI bridge"), context);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(base + "/api/music/status")).json();
  assert.equal(status.provider, "cloudflare"); assert.equal(status.model, "minimax/music-2.6"); assert.equal(status.reachable, true);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith("/user/tokens/verify"));
  const post = (body, authenticated = true) => fetch(base + "/api/music/generate", { method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer test" } : {}) }, body: JSON.stringify(body) });
  const body = { instructions: "p".repeat(2100), lyrics: "l".repeat(3600) };
  assert.equal((await post(body, false)).status, 401); assert.equal(calls.length, 1);
  const generated = await post(body); assert.equal(generated.status, 200); assert.equal(await generated.text(), "generated-audio");
  assert.equal(generated.headers.get("x-ysong-music-provider"), "cloudflare");
  assert.equal(generated.headers.get("content-type"), "audio/wav");
  const input = JSON.parse(calls[1].options.body).input;
  assert.equal(input.prompt.length, 2000); assert.equal(input.lyrics.length, 3500);
  assert.equal(input.is_instrumental, false); assert.equal(input.lyrics_optimizer, false);
  assert.equal(input.format, "wav"); assert.equal(input.sample_rate, 44100);
  assert.equal(calls[2].options.headers, undefined);
  await post({ instructions: "instrumental", lyrics: "[Instrumental]" });
  const instrumental = JSON.parse(calls[3].options.body).input;
  assert.equal(instrumental.is_instrumental, true); assert.equal(instrumental.lyrics, undefined);
  for (const [provider, expected, audio] of [["cloudflare", "cloudflare", "generated-audio"], ["http", "http", "legacy"], ["server", "http", "legacy"], ["audio_cpp", "audio_cpp", "local"], ["audiocpp", "audio_cpp", "local"]]) {
    context.process.env.MINIMAX_MUSIC_PROVIDER = provider;
    const response = await post({ instructions: "prompt", lyrics: "[Instrumental]" });
    assert.equal(response.headers.get("x-ysong-music-provider"), expected); assert.equal(await response.text(), audio);
  }
  context.process.env.MINIMAX_MUSIC_PROVIDER = "cf";
  upstreamFailure = true;
  const failed = await post({ instructions: "prompt", lyrics: "[Instrumental]" });
  assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes("test-secret"));
  context.process.env.CLOUDFLARE_AI_API_TOKEN = "";
  const missing = await (await fetch(base + "/api/music/status")).json();
  assert.equal(missing.configured, false); assert.equal(missing.reachable, false);
});
