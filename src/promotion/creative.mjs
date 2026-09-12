import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 1_000_000;

function appendTail(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      // FFmpeg may create worker processes on Windows. Killing the tree prevents
      // timed-out Promotion renders from lingering in the background.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}

function run(exe, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    };

    child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.on("error", (error) => finishReject(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut) {
        return finishReject(Object.assign(new Error("ffmpeg_timeout"), { code, signal }));
      }
      if (Number(code ?? -1) !== 0) {
        return finishReject(Object.assign(new Error(`ffmpeg_exit_${code}`), { code, signal }));
      }
      settled = true;
      resolve({ stdout, stderr, code: Number(code || 0), signal: signal || null });
    });
  });
}

function ffmpegPath() { return String(process.env.FFMPEG_PATH || "ffmpeg"); }
function ffprobePath() { return String(process.env.FFPROBE_PATH || "ffprobe"); }
function renderTimeoutMs() {
  return Math.max(30_000, Number(process.env.PROMOTION_RENDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
}

export async function inspectPromotionRenderRuntime() {
  try {
    const [version, encoders] = await Promise.all([
      run(ffmpegPath(), ["-hide_banner", "-version"], { timeoutMs: 15_000 }),
      run(ffmpegPath(), ["-hide_banner", "-encoders"], { timeoutMs: 15_000 }),
    ]);
    const firstLine = String(version.stdout || version.stderr || "").split(/\r?\n/)[0] || "";
    const encoderText = `${encoders.stdout}\n${encoders.stderr}`;
    return {
      available: true,
      ffmpeg: ffmpegPath(),
      ffprobe: ffprobePath(),
      version: firstLine,
      encoders: {
        h264: /\blibx264\b/.test(encoderText),
        aac: /^\s*A\S*\s+aac\s/m.test(encoderText) || /\baac\s+AAC\b/.test(encoderText),
      },
    };
  } catch (error) {
    return {
      available: false,
      ffmpeg: ffmpegPath(),
      ffprobe: ffprobePath(),
      version: "",
      encoders: { h264: false, aac: false },
      error: String(error?.message || error || "ffmpeg_unavailable"),
    };
  }
}

export async function probeMedia(filePath) {
  const result = await run(ffprobePath(), [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration,sample_rate,channels",
    "-of", "json",
    filePath,
  ], { timeoutMs: 30_000 });
  const parsed = JSON.parse(result.stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video") || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;
  const formatDuration = Number(parsed.format?.duration || 0) || null;
  return {
    duration: formatDuration || Number(video?.duration || audio?.duration || 0) || null,
    video: video ? {
      codec: String(video.codec_name || ""),
      width: Number(video.width || 0) || null,
      height: Number(video.height || 0) || null,
      duration: Number(video.duration || 0) || formatDuration || null,
    } : null,
    audio: audio ? {
      codec: String(audio.codec_name || ""),
      duration: Number(audio.duration || 0) || formatDuration || null,
      sampleRate: Number(audio.sample_rate || 0) || null,
      channels: Number(audio.channels || 0) || null,
    } : null,
  };
}

function validateDimensions(width, height) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 320 || w > 4096 || h > 4096) {
    throw new Error("invalid_render_dimensions");
  }
  // H.264 4:2:0 requires even dimensions.
  return { width: w % 2 ? w - 1 : w, height: h % 2 ? h - 1 : h };
}

function renderArgs({ videoPath, audioPath, audioStart, duration, outputPath, width, height }) {
  const start = Math.max(0, Number(audioStart || 0));
  const length = Math.max(5, Math.min(60, Number(duration || 30)));
  const dims = validateDimensions(width, height);
  const videoFilter = [
    `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=increase`,
    `crop=${dims.width}:${dims.height}`,
    "setsar=1",
    "fps=30",
    "format=yuv420p",
    "setpts=PTS-STARTPTS",
  ].join(",");
  // atrim gives sample-accurate-ish boundaries after decode even for MP3/AAC input.
  // We intentionally do not loudness-normalize or compress here: the Promotion
  // renderer should use the artist's master, not silently remaster the ad.
  const audioFilter = [
    `atrim=start=${start.toFixed(6)}:duration=${length.toFixed(6)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
  ].join(",");

  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-stream_loop", "-1", "-i", videoPath,
    "-i", audioPath,
    "-filter_complex", `[0:v:0]${videoFilter}[v];[1:a:0]${audioFilter}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", length.toFixed(6),
    "-c:v", "libx264",
    "-preset", String(process.env.PROMOTION_FFMPEG_PRESET || "medium"),
    "-crf", String(process.env.PROMOTION_FFMPEG_CRF || "20"),
    "-profile:v", "high", "-level:v", "4.1",
    "-g", "60", "-keyint_min", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "2048",
    outputPath,
  ];
}

async function validateRenderInputs({ videoPath, audioPath, audioStart, duration }) {
  await Promise.all([
    fs.promises.access(videoPath, fs.constants.R_OK),
    fs.promises.access(audioPath, fs.constants.R_OK),
  ]);
  const [videoProbe, audioProbe] = await Promise.all([probeMedia(videoPath), probeMedia(audioPath)]);
  if (!videoProbe.video) throw new Error("background_video_stream_required");
  if (!audioProbe.audio) throw new Error("song_audio_stream_required");

  const start = Math.max(0, Number(audioStart || 0));
  const requested = Math.max(5, Math.min(60, Number(duration || 30)));
  const audioDuration = Number(audioProbe.audio.duration || audioProbe.duration || 0);
  if (audioDuration > 0 && start >= audioDuration) throw new Error("audio_snippet_start_out_of_range");
  const available = audioDuration > 0 ? Math.max(0, audioDuration - start) : requested;
  if (available < 5) throw new Error("audio_snippet_too_short");
  const actualDuration = Math.min(requested, available);
  return { videoProbe, audioProbe, start, requestedDuration: requested, actualDuration };
}

export async function renderPromotionCreative({
  userId,
  adCampaignId,
  creativeId,
  videoPath,
  audioPath,
  audioStart,
  duration,
  objectPath,
  writeObjectMetadata,
}) {
  const runtime = await inspectPromotionRenderRuntime();
  if (!runtime.available) throw new Error("promotion_ffmpeg_unavailable");
  if (!runtime.encoders.h264) throw new Error("promotion_h264_encoder_unavailable");
  if (!runtime.encoders.aac) throw new Error("promotion_aac_encoder_unavailable");

  const validated = await validateRenderInputs({ videoPath, audioPath, audioStart, duration });
  const length = validated.actualDuration;
  const rootKey = `project-assets/${userId}/promotion-${adCampaignId}`;
  const key916 = `${rootKey}/${creativeId}-9x16.mp4`;
  const key43 = `${rootKey}/${creativeId}-4x3.mp4`;
  const out916 = objectPath(key916);
  const out43 = objectPath(key43);
  await fs.promises.mkdir(path.dirname(out916), { recursive: true });

  // Render sequentially by default. Two 1080p x264 jobs in parallel can saturate a
  // small production VM and make every API request miserable. A future render
  // worker/queue can parallelize safely based on machine capacity.
  try {
    await run(ffmpegPath(), renderArgs({
      videoPath, audioPath, audioStart: validated.start, duration: length,
      outputPath: out916, width: 1080, height: 1920,
    }), { timeoutMs: renderTimeoutMs() });
    await run(ffmpegPath(), renderArgs({
      videoPath, audioPath, audioStart: validated.start, duration: length,
      outputPath: out43, width: 1080, height: 810,
    }), { timeoutMs: renderTimeoutMs() });
  } catch (error) {
    // Never leave a half-rendered creative looking like a usable project asset.
    await Promise.allSettled([
      fs.promises.unlink(out916),
      fs.promises.unlink(out43),
    ]);
    throw error;
  }

  const createdAt = new Date().toISOString();
  const common = {
    userId: String(userId),
    contentType: "video/mp4",
    createdAt,
    generatedBy: "YSong Promotion Center",
    source: "audio-snippet-x-muted-background",
    audioStartSeconds: validated.start,
    durationSeconds: length,
    backgroundOriginalAudioUsed: false,
    videoCodec: "h264",
    audioCodec: "aac",
    sampleRate: 48000,
    frameRate: 30,
  };
  const stat916 = await fs.promises.stat(out916);
  const stat43 = await fs.promises.stat(out43);
  await writeObjectMetadata(key916, {
    ...common,
    originalName: `${creativeId}-9x16.mp4`,
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    size: stat916.size,
  });
  await writeObjectMetadata(key43, {
    ...common,
    originalName: `${creativeId}-4x3.mp4`,
    aspectRatio: "4:3",
    width: 1080,
    height: 810,
    size: stat43.size,
  });
  return {
    key916,
    key43,
    durationSeconds: length,
    requestedDurationSeconds: validated.requestedDuration,
    clippedToAvailableAudio: length + 1e-6 < validated.requestedDuration,
    runtime: { version: runtime.version },
  };
}
