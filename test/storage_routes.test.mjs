import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import vm from "node:vm";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import multer from "multer";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function section(start, end) {
  const begin = source.indexOf(start);
  assert.ok(begin >= 0);
  const finish = source.indexOf(end, begin);
  assert.ok(finish > begin);
  return source.slice(begin, finish);
}

for (const useR2 of [false, true]) {
  test(`${useR2 ? "R2" : "local"} upload, copy, ownership, signed read, ranges, and deletion`, async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ysong-storage-test-"));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const objects = new Map();
    let published = false;
    const app = express();
    app.use(express.json());
    const context = vm.createContext({
      app, fs, path, crypto, Buffer, pipeline, USE_R2: useR2, R2_BUCKET: "ysong-assets",
      saasEnabled:()=>false,governance:{recordUpload:async()=>{},assertPublic:async()=>{}},
      LOCAL_STORAGE_ROOT: root, process: { env: { JWT_SECRET: "test-only-secret" } },
      console, upload: multer({ storage: multer.memoryStorage() }),
      requireAuth(req, res, next) {
        if (req.headers.authorization !== "Bearer test") return res.sendStatus(401);
        req.user = { id: "test-user" }; next();
      },
      pool: { query: async () => ({ rows: published ? [{}] : [] }) },
      putR2Object: async (key, body, options) => {
        const chunks = []; for await (const chunk of Buffer.isBuffer(body) ? [body] : body) chunks.push(chunk);
        objects.set(key, { bytes: Buffer.concat(chunks), ...options });
      },
      headR2Object: async (key) => {
        const value = objects.get(key);
        if (!value) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentLength: value.bytes.length, ContentType: value.contentType,
          Metadata: { ysong: Buffer.from(JSON.stringify(value.metadata || {})).toString("base64") } };
      },
      getR2Object: async (key, { range } = {}) => {
        const bytes = objects.get(key).bytes;
        const match = range?.match(/^bytes=(\d+)-(\d+)$/);
        return { Body: Readable.from([match ? bytes.subarray(Number(match[1]), Number(match[2]) + 1) : bytes]) };
      },
      copyR2Object: async (from, to) => objects.set(to, { ...objects.get(from) }),
      deleteR2Object: async (key) => objects.delete(key),
      getR2SignedUrl: async (key, options) => `https://r2.example/${encodeURIComponent(key)}?download=${options.download}`,
    });
    vm.runInContext(section("function sanitizeFilename", "// ---- ToS version") +
      section('// -------------------- API: Local uploads', '// -------------------- API: YSong World') +
      section("async function streamWorldObject", 'app.get("/api/world/playlists/:id/artwork"'), context);
    app.get("/test/world", (req, res) => context.streamWorldObject(req, res, req.query.key));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: "Bearer test" };
    const post = (route, body) => fetch(base + route, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const form = new FormData(); form.append("file", new Blob(["0123456789"], { type: "audio/wav" }), "test.wav");
    const upload = await fetch(base + "/api/uploads", { method: "POST", headers: auth, body: form });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json(); const key = uploaded.objectKey;
    assert.match(key, /^user-uploads\/test-user\//);
    assert.equal(uploaded.bucket, useR2 ? "ysong-assets" : "local-disk");
    const signed = await fetch(base + `/api/uploads/signed-url?objectKey=${encodeURIComponent(key)}`, { headers: auth });
    assert.equal(signed.status, 200); const link = await signed.json();
    assert.equal(link.local, !useR2);
    if (useR2) assert.match(link.url, /^https:\/\/r2.example\//);
    const expires = Date.now() + 60000;
    const sig = context.makeLocalFileSignature(key, "play", expires);
    const file = `/api/uploads/file?${new URLSearchParams({ objectKey: key, expires, sig })}`;
    const full = await fetch(base + file); assert.equal(full.status, 200); assert.equal(await full.text(), "0123456789");
    const partial = await fetch(base + file, { headers: { Range: "bytes=2-4" } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 2-4/10"); assert.equal(await partial.text(), "234");
    const suffix = await fetch(base + file, { headers: { Range: "bytes=-3" } }); assert.equal(await suffix.text(), "789");
    assert.equal((await fetch(base + file, { headers: { Range: "bytes=20-" } })).status, 416);
    assert.equal((await fetch(base + file.replace(sig, "bad"))).status, 403);
    const world = await fetch(base + `/test/world?key=${encodeURIComponent(key)}`); assert.equal(await world.text(), "0123456789");
    assert.equal(world.headers.get("cache-control"), "public, max-age=3600");
    assert.equal((await post("/api/uploads/copy", { objectKey: "user-uploads/another-user/file.wav", projectId: "p" })).status, 403);
    assert.equal((await post("/api/uploads/delete", { objectKey: "user-uploads/test-user/../file.wav" })).status, 500);
    const copied = await (await post("/api/uploads/copy", { objectKey: key, projectId: "project" })).json();
    assert.match(copied.objectKey, /^project-assets\/test-user\/project\//);
    const nativePath = await context.materializeObject(key); assert.equal(await fs.promises.readFile(nativePath, "utf8"), "0123456789");
    await context.writeObjectMetadata(key, { originalName: "日本語.wav", contentType: "audio/wav" });
    assert.equal((await context.readObjectMetadata(key)).originalName, "日本語.wav");
    published = true; assert.equal((await post("/api/uploads/delete", { objectKey: key })).status, 409);
    published = false; assert.equal((await post("/api/uploads/delete", { objectKey: copied.objectKey })).status, 200);
    assert.equal((await post("/api/uploads/delete", { objectKey: key })).status, 200);
    assert.equal((await fetch(base + `/api/uploads/signed-url?objectKey=${encodeURIComponent(key)}`, { headers: auth })).status, 404);
    assert.equal((await fetch(base + "/api/uploads/signed-url")).status, 401);
    if (useR2) assert.equal(objects.size, 0);
  });
}
