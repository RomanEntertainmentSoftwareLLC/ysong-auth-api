import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import argon2 from "argon2";
import { z } from "zod";
import { pool } from "./db.js";
import { sendVerifyEmail, sendSocialNotificationEmail } from "./email.js";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();

// ---- File uploads: local hard-drive storage ----
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 500));
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 1024 * 1024 * MAX_UPLOAD_MB },
});

const LOCAL_MODE = process.env.LOCAL_MODE !== "0";
const LOCAL_STORAGE_ROOT = path.resolve(
	process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), "..", "data", "uploads")
);
fs.mkdirSync(LOCAL_STORAGE_ROOT, { recursive: true });
console.log(`YSong local storage: ${LOCAL_STORAGE_ROOT}`);

function sanitizeFilename(name) {
	return String(name || "file")
		.replace(/[\\/]+/g, "_")
		.replace(/[<>:\"|?*\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180) || "file";
}

function normalizeObjectKey(objectKey) {
	const key = String(objectKey || "").replace(/\\/g, "/").replace(/^\/+/, "");
	if (!key || key.split("/").some((part) => part === ".." || part === ".")) {
		throw new Error("invalid_object_key");
	}
	return key;
}

function objectPath(objectKey) {
	const key = normalizeObjectKey(objectKey);
	const resolved = path.resolve(LOCAL_STORAGE_ROOT, ...key.split("/"));
	const rootPrefix = LOCAL_STORAGE_ROOT.endsWith(path.sep) ? LOCAL_STORAGE_ROOT : LOCAL_STORAGE_ROOT + path.sep;
	if (resolved !== LOCAL_STORAGE_ROOT && !resolved.startsWith(rootPrefix)) {
		throw new Error("invalid_object_key");
	}
	return resolved;
}

function metadataPath(objectKey) {
	return objectPath(objectKey) + ".ysong-meta.json";
}

async function writeObjectMetadata(objectKey, metadata) {
	const metaFile = metadataPath(objectKey);
	await fs.promises.mkdir(path.dirname(metaFile), { recursive: true });
	await fs.promises.writeFile(metaFile, JSON.stringify(metadata, null, 2), "utf8");
}

async function readObjectMetadata(objectKey) {
	try {
		return JSON.parse(await fs.promises.readFile(metadataPath(objectKey), "utf8"));
	} catch {
		return {};
	}
}

function assertOwnedObjectKey(userId, objectKey, { uploadOnly = false } = {}) {
	const key = normalizeObjectKey(objectKey);
	const prefixes = uploadOnly
		? [`user-uploads/${userId}/`]
		: [`user-uploads/${userId}/`, `project-assets/${userId}/`];
	if (!prefixes.some((prefix) => key.startsWith(prefix))) {
		const error = new Error("forbidden");
		error.statusCode = 403;
		throw error;
	}
	return key;
}

function makeLocalFileSignature(objectKey, mode, expiresAt) {
	return crypto
		.createHmac("sha256", process.env.JWT_SECRET)
		.update(`${objectKey}\n${mode}\n${expiresAt}`)
		.digest("hex");
}

function validLocalFileSignature(objectKey, mode, expiresAt, signature) {
	if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
	const expected = makeLocalFileSignature(objectKey, mode, expiresAt);
	try {
		const a = Buffer.from(expected, "hex");
		const b = Buffer.from(String(signature), "hex");
		return a.length === b.length && crypto.timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

// ---- ToS version (server-driven) ----
const CURRENT_TOS_VERSION = process.env.TOS_VERSION || "2025-11-05-v1";

// -------------------- CORS --------------------
const allowedOrigins = [
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"https://ysong.ai",
	"https://www.ysong.ai",
	/\.vercel\.app$/,
	// Local YSong devices on the same private LAN (phone/tablet/another PC).
	/^http:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+):5173$/,
];

const corsOptions = {
	origin(origin, cb) {
		if (!origin) return cb(null, true);
		const ok = allowedOrigins.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
		return ok ? cb(null, true) : cb(new Error("Not allowed by CORS"));
	},
	methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "Range", "X-YSong-Client-Id"],
	exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"],
	credentials: true,
	maxAge: 86400,
};

const LoginSchema = z.object({
	email: z.string().email().max(320),
	password: z.string().min(8).max(200),
});

app.set("trust proxy", 1);
app.use((_, res, next) => {
	res.header("Vary", "Origin");
	next();
});
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

// -------------------- Helpers --------------------
const SignupSchema = z.object({
	email: z.string().email().max(320),
	password: z.string().min(8).max(200),
	// Public identity is required for every new account. Email remains private/auth-only.
	name: z.string().trim().min(1).max(80),
});

function requireAuth(req, res, next) {
	try {
		const header = req.get("authorization") || "";
		const token = header.startsWith("Bearer ") ? header.slice(7) : null;
		if (!token) return res.status(401).json({ error: "missing_token" });

		const payload = jwt.verify(token, process.env.JWT_SECRET);
		const userId = payload.uid || payload.id;
		if (!userId) return res.status(401).json({ error: "invalid_token" });
		req.user = { id: userId, email: payload.email };
		next();
	} catch {
		return res.status(401).json({ error: "unauthorized" });
	}
}

function sha256(hexOrBuffer) {
	return crypto.createHash("sha256").update(hexOrBuffer).digest("hex");
}
function minutesFromNow(mins) {
	return new Date(Date.now() + mins * 60_000);
}
function signToken(user) {
	return jwt.sign({ uid: user.id, email: user.email }, process.env.JWT_SECRET, {
		algorithm: "HS256",
		expiresIn: "7d",
	});
}
function authFromHeader(req) {
	const h = req.headers.authorization || "";
	const m = /^Bearer (.+)$/.exec(h);
	return m ? m[1] : null;
}

// -------------------- Local/LAN realtime device sync --------------------
// Server-Sent Events are enough here: YSong mutations already travel to this
// API over HTTP, and this channel only needs to fan change notifications back
// out to the user's other authenticated devices.
const syncClientsByUser = new Map();

function addSyncClient(userId, res) {
	const key = String(userId);
	let clients = syncClientsByUser.get(key);
	if (!clients) {
		clients = new Set();
		syncClientsByUser.set(key, clients);
	}
	clients.add(res);
	return () => {
		clients.delete(res);
		if (clients.size === 0) syncClientsByUser.delete(key);
	};
}

function broadcastToUser(userId, payload) {
	const clients = syncClientsByUser.get(String(userId));
	if (!clients || clients.size === 0) return;
	const line = `data: ${JSON.stringify(payload)}\n\n`;
	for (const res of [...clients]) {
		try { res.write(line); } catch { clients.delete(res); }
	}
}

function verifyTokenString(token) {
	try {
		const payload = jwt.verify(token, process.env.JWT_SECRET);
		const userId = payload.uid || payload.id;
		if (!userId) return null;
		return { id: String(userId), email: payload.email };
	} catch {
		return null;
	}
}

app.get("/api/sync/events", (req, res) => {
	const token = String(req.query.token || authFromHeader(req) || "");
	const user = verifyTokenString(token);
	if (!user) return res.status(401).json({ error: "unauthorized" });

	res.status(200);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();
	res.write(`data: ${JSON.stringify({ type: "ysong-sync-ready", ts: Date.now() })}\n\n`);

	const remove = addSyncClient(user.id, res);
	const heartbeat = setInterval(() => {
		try { res.write(`: ysong-heartbeat ${Date.now()}\n\n`); } catch {}
	}, 25000);

	req.on("close", () => {
		clearInterval(heartbeat);
		remove();
	});
});

// Realtime refreshes are intentionally EXPLICIT. Background autosaves and
// client-state mirroring must never make every open YSong device refresh.
// The browser calls this endpoint only after a real user action has completed.
app.post("/api/sync/action", requireAuth, (req, res) => {
	const sourceId = String(req.get("x-ysong-client-id") || req.body?.sourceId || "");
	const reason = String(req.body?.reason || "user-action").slice(0, 240);
	broadcastToUser(req.user.id, {
		type: "ysong-state-changed",
		sourceId,
		reason,
		ts: Date.now(),
	});
	return res.json({ ok: true });
});

// Mirror selected browser-local YSong state (DAW/project state, etc.) so a
// different authenticated device can hydrate before/after a realtime refresh.
app.get("/api/client-state", requireAuth, async (req, res) => {
	try {
		const { rows } = await pool.query(
			`SELECT state FROM user_client_state WHERE user_id = $1 LIMIT 1`,
			[req.user.id]
		);
		return res.json({ state: rows[0]?.state && typeof rows[0].state === "object" ? rows[0].state : {} });
	} catch (e) {
		console.error("GET /api/client-state ERROR", e);
		return res.status(500).json({ error: "server_error" });
	}
});

app.post("/api/client-state", requireAuth, async (req, res) => {
	try {
		const key = typeof req.body?.key === "string" ? req.body.key : "";
		if (!key || key.length > 240) return res.status(400).json({ error: "invalid_key" });
		const remove = req.body?.remove === true;
		const value = typeof req.body?.value === "string" ? req.body.value : null;
		if (!remove && value == null) return res.status(400).json({ error: "missing_value" });
		if (value != null && value.length > 8_000_000) return res.status(413).json({ error: "state_value_too_large" });

		await pool.query(
			`INSERT INTO user_client_state (user_id, state, updated_at)
			 VALUES ($1, '{}'::jsonb, now())
			 ON CONFLICT (user_id) DO NOTHING`,
			[req.user.id]
		);

		if (remove) {
			await pool.query(
				`UPDATE user_client_state SET state = state - $2, updated_at = now() WHERE user_id = $1`,
				[req.user.id, key]
			);
		} else {
			await pool.query(
				`UPDATE user_client_state
				 SET state = jsonb_set(state, ARRAY[$2]::text[], to_jsonb($3::text), true), updated_at = now()
				 WHERE user_id = $1`,
				[req.user.id, key, value]
			);
		}
		return res.json({ ok: true });
	} catch (e) {
		console.error("POST /api/client-state ERROR", e);
		return res.status(500).json({ error: "server_error" });
	}
});

// -------------------- API: Local uploads --------------------
app.post("/api/uploads", requireAuth, upload.single("file"), async (req, res) => {
	try {
		const userId = req.user.id;
		const file = req.file;
		if (!file) return res.status(400).json({ error: "no_file" });

		const safeName = sanitizeFilename(file.originalname);
		const objectKey = `user-uploads/${userId}/${Date.now()}-${safeName}`;
		const dest = objectPath(objectKey);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await fs.promises.writeFile(dest, file.buffer);
		await writeObjectMetadata(objectKey, {
			userId: String(userId),
			originalName: file.originalname,
			contentType: file.mimetype || "application/octet-stream",
			size: file.size,
			createdAt: new Date().toISOString(),
		});

		return res.status(201).json({
			filename: file.originalname,
			size: file.size,
			contentType: file.mimetype,
			bucket: "local-disk",
			objectKey,
			publicUrl: null,
		});
	} catch (e) {
		console.error("POST /api/uploads ERROR", e);
		return res.status(500).json({ error: "upload_failed", message: e?.message });
	}
});

app.post("/api/uploads/copy", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const { objectKey, projectId } = req.body ?? {};
		if (!objectKey || typeof objectKey !== "string") return res.status(400).json({ error: "missing_objectKey" });
		if (!projectId || typeof projectId !== "string") return res.status(400).json({ error: "missing_projectId" });

		const sourceKey = assertOwnedObjectKey(userId, objectKey, { uploadOnly: true });
		const src = objectPath(sourceKey);
		await fs.promises.access(src, fs.constants.R_OK);

		const meta = await readObjectMetadata(sourceKey);
		const safeName = sanitizeFilename(meta.originalName || sourceKey.split("/").pop() || "file");
		const safeProjectId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "project";
		const destKey = `project-assets/${userId}/${safeProjectId}/${Date.now()}-${safeName}`;
		const dest = objectPath(destKey);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await fs.promises.copyFile(src, dest);
		await writeObjectMetadata(destKey, { ...meta, copiedAt: new Date().toISOString(), sourceObjectKey: sourceKey });

		return res.json({ ok: true, local: true, objectKey: destKey });
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "forbidden" });
		if (e?.code === "ENOENT") return res.status(404).json({ error: "not_found" });
		console.error("POST /api/uploads/copy ERROR", e);
		return res.status(500).json({ error: "copy_failed" });
	}
});

app.post("/api/uploads/delete", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const { objectKey } = req.body ?? {};
		if (!objectKey || typeof objectKey !== "string") return res.status(400).json({ error: "missing_objectKey" });
		const key = assertOwnedObjectKey(userId, objectKey);
		// Published World media cannot be physically deleted out from under a release.
		// A future Unpublish/Delete Release flow should remove the catalog reference first.
		try {
			const inUse = await pool.query(
				`SELECT 1 FROM world_tracks WHERE audio_object_key = $1
				 UNION ALL
				 SELECT 1 FROM world_releases WHERE artwork_object_key = $1
				 LIMIT 1`,
				[key]
			);
			if (inUse.rows[0]) return res.status(409).json({ error: "asset_is_published" });
		} catch (schemaErr) {
			// During first-ever startup the World schema may not exist yet; deletion should
			// still behave exactly as it did before this pre-alpha feature.
			if (schemaErr?.code !== "42P01") throw schemaErr;
		}
		for (const target of [objectPath(key), metadataPath(key)]) {
			try { await fs.promises.unlink(target); } catch (e) { if (e?.code !== "ENOENT") throw e; }
		}
		return res.json({ ok: true, local: true });
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "forbidden" });
		console.error("POST /api/uploads/delete ERROR", e);
		return res.status(500).json({ error: "server_error" });
	}
});

// Returns a short-lived URL that the <audio>/<video> element can read without
// needing an Authorization header. The file itself remains on the local disk.
app.get("/api/uploads/signed-url", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const objectKey = assertOwnedObjectKey(userId, String(req.query.objectKey || ""));
		const mode = String(req.query.mode || "play") === "download" ? "download" : "play";
		await fs.promises.access(objectPath(objectKey), fs.constants.R_OK);
		const meta = await readObjectMetadata(objectKey);
		const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
		const sig = makeLocalFileSignature(objectKey, mode, expiresAt);
		const base = `${req.protocol}://${req.get("host")}`;
		const url = `${base}/api/uploads/file?objectKey=${encodeURIComponent(objectKey)}&mode=${encodeURIComponent(mode)}&expires=${expiresAt}&sig=${sig}`;
		return res.json({
			url,
			contentType: meta.contentType || "application/octet-stream",
			expiresAt,
			objectKey,
			mode,
			local: true,
		});
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "forbidden" });
		if (e?.code === "ENOENT") return res.status(404).json({ error: "not_found" });
		console.error("GET /api/uploads/signed-url ERROR", e);
		return res.status(500).json({ error: "signed_url_failed" });
	}
});

app.get("/api/uploads/file", async (req, res) => {
	try {
		const objectKey = normalizeObjectKey(String(req.query.objectKey || ""));
		const mode = String(req.query.mode || "play") === "download" ? "download" : "play";
		const expiresAt = Number(req.query.expires);
		const sig = String(req.query.sig || "");
		if (!validLocalFileSignature(objectKey, mode, expiresAt, sig)) {
			return res.status(403).json({ error: "invalid_or_expired_file_link" });
		}

		const filePath = objectPath(objectKey);
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) return res.status(404).end();
		const meta = await readObjectMetadata(objectKey);
		const contentType = meta.contentType || "application/octet-stream";
		const originalName = sanitizeFilename(meta.originalName || path.basename(filePath));
		const disposition = mode === "download" ? "attachment" : "inline";

		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(originalName)}`);
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Cache-Control", "private, max-age=300");

		const range = req.headers.range;
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
			if (!match) return res.status(416).end();
			let start = match[1] ? Number(match[1]) : 0;
			let end = match[2] ? Number(match[2]) : stat.size - 1;
			if (!match[1] && match[2]) {
				const suffix = Number(match[2]);
				start = Math.max(0, stat.size - suffix);
				end = stat.size - 1;
			}
			if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
				res.setHeader("Content-Range", `bytes */${stat.size}`);
				return res.status(416).end();
			}
			end = Math.min(end, stat.size - 1);
			res.status(206);
			res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
			res.setHeader("Content-Length", end - start + 1);
			return fs.createReadStream(filePath, { start, end }).pipe(res);
		}

		res.setHeader("Content-Length", stat.size);
		return fs.createReadStream(filePath).pipe(res);
	} catch (e) {
		if (e?.code === "ENOENT") return res.status(404).end();
		console.error("GET /api/uploads/file ERROR", e);
		return res.status(500).end();
	}
});


// -------------------- API: YSong World (pre-alpha) --------------------
// The pre-alpha keeps public catalog metadata in Neon while audio/artwork are
// still served from YSong's local object store. Production can swap these
// object keys to R2 without changing the World/Release data model.
function worldRow(row) {
	return {
		id: String(row.id),
		releaseId: String(row.release_id),
		title: row.title,
		artistName: row.artist_name,
		albumName: row.album_name,
		releaseType: row.release_type,
		genre: row.genre || "Other",
		tags: Array.isArray(row.tags) ? row.tags : [],
		description: row.description || "",
		explicit: !!row.explicit,
		trackNumber: Number(row.track_number || 1),
		durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
		playCount: Number(row.play_count || 0),
		likes: Number(row.likes || 0),
		dislikes: Number(row.dislikes || 0),
		myReaction: Number(row.my_reaction || 0),
		publishedAt: row.published_at,
		hasArtwork: !!row.has_artwork,
		isOwner: !!row.is_owner,
		isrc: row.isrc || "",
		previouslyReleased: !!row.previously_released,
		ownerUserId: row.owner_user_id ? String(row.owner_user_id) : "",
		isSaved: !!row.is_saved,
		isReleaseSaved: !!row.is_release_saved,
		isArtistFollowed: !!row.is_artist_followed,
		commentCount: Number(row.comment_count || 0),
	};
}

function normalizeIsrc(value) {
	const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (!compact) return "";
	return compact;
}

function validIsrc(value) {
	return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(String(value || ""));
}

const ACHIEVEMENT_DEFINITIONS = [
	{ key: "publish-first", category: "Publishing", icon: "🚀", title: "First Release", description: "Publish your first song to YSong World.", metric: "tracksPublished", target: 1, points: 10 },
	{ key: "publish-ten", category: "Publishing", icon: "💿", title: "Catalog Builder", description: "Publish 10 songs to YSong World.", metric: "tracksPublished", target: 10, points: 25 },
	{ key: "publish-album", category: "Publishing", icon: "📀", title: "Long Player", description: "Publish your first album.", metric: "albumsPublished", target: 1, points: 20 },
	{ key: "like-first", category: "Discovery", icon: "❤️", title: "First Impression", description: "Like your first song.", metric: "likesGiven", target: 1, points: 5 },
	{ key: "like-25", category: "Discovery", icon: "🎧", title: "Taste Maker I", description: "Like 25 songs.", metric: "likesGiven", target: 25, points: 10 },
	{ key: "like-100", category: "Discovery", icon: "✨", title: "Taste Maker II", description: "Like 100 songs.", metric: "likesGiven", target: 100, points: 20 },
	{ key: "genres-five", category: "Discovery", icon: "🧭", title: "Open Ears", description: "Like songs across 5 different genres.", metric: "genresLiked", target: 5, points: 15 },
	{ key: "save-song-first", category: "Collection", icon: "🔖", title: "Keep That One", description: "Save your first song.", metric: "tracksSaved", target: 1, points: 5 },
	{ key: "save-song-25", category: "Collection", icon: "🎵", title: "Song Collector", description: "Save 25 songs.", metric: "tracksSaved", target: 25, points: 15 },
	{ key: "save-album-first", category: "Collection", icon: "📚", title: "Album Hunter", description: "Save your first album or release.", metric: "releasesSaved", target: 1, points: 5 },
	{ key: "save-album-ten", category: "Collection", icon: "🗃️", title: "Record Collector", description: "Save 10 albums or releases.", metric: "releasesSaved", target: 10, points: 15 },
	{ key: "follow-first", category: "Fandom", icon: "⭐", title: "Found a Favorite", description: "Favorite your first artist.", metric: "artistsFollowed", target: 1, points: 5 },
	{ key: "follow-ten", category: "Fandom", icon: "🌟", title: "Fan Club", description: "Favorite 10 artists.", metric: "artistsFollowed", target: 10, points: 15 },
	{ key: "comment-first", category: "Community", icon: "💬", title: "Say Something", description: "Leave your first song comment.", metric: "commentsMade", target: 1, points: 5 },
	{ key: "comment-25", category: "Community", icon: "🗣️", title: "Community Voice", description: "Leave 25 comments.", metric: "commentsMade", target: 25, points: 15 },
	{ key: "playlist-first", category: "Playlists", icon: "📋", title: "Curator", description: "Create your first playlist.", metric: "playlistsCreated", target: 1, points: 10 },
	{ key: "playlist-five", category: "Playlists", icon: "🎚️", title: "Curator II", description: "Create 5 playlists.", metric: "playlistsCreated", target: 5, points: 20 },
	{ key: "creator-first-save", category: "Creator", icon: "🥇", title: "First Fan", description: "Have another listener save one of your songs.", metric: "receivedTrackSaves", target: 1, points: 10 },
	{ key: "creator-playlisted", category: "Creator", icon: "🎶", title: "Playlisted", description: "Have one of your songs added to somebody else's playlist.", metric: "receivedPlaylistAdds", target: 1, points: 15 },
	{ key: "creator-100-plays", category: "Creator", icon: "📈", title: "On Repeat", description: "Reach 100 total plays across your published songs.", metric: "creatorPlays", target: 100, points: 15 },
	{ key: "creator-1000-plays", category: "Creator", icon: "🔥", title: "Rising", description: "Reach 1,000 total plays across your published songs.", metric: "creatorPlays", target: 1000, points: 30 },
];

function fallbackPublicName(userId) {
	const suffix = String(userId || "user").replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase() || "USER";
	return `YSong User ${suffix}`;
}

function publicNameFromRow(row, userIdField = "user_id", displayNameField = "display_name") {
	const name = String(row?.[displayNameField] || "").trim();
	return name || fallbackPublicName(row?.[userIdField]);
}

async function publicNameForUserId(userId) {
	if (!userId) return "YSong User";
	try {
		const { rows } = await pool.query(`SELECT display_name FROM users WHERE id=$1 LIMIT 1`, [userId]);
		const name = String(rows[0]?.display_name || "").trim();
		return name || fallbackPublicName(userId);
	} catch {
		return fallbackPublicName(userId);
	}
}

async function createNotification(userId, {
	actorUserId = null,
	kind,
	entityType = null,
	entityId = null,
	title,
	body = "",
	href = "/app",
	email = true,
} = {}) {
	if (!userId) return null;
	if (actorUserId && String(actorUserId) === String(userId) && kind !== "achievement") return null;
	const id = crypto.randomUUID();
	await pool.query(
		`INSERT INTO ysong_notifications
		 (id, user_id, actor_user_id, kind, entity_type, entity_id, title, body, href)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		[id, userId, actorUserId, String(kind || "activity"), entityType, entityId ? String(entityId) : null, String(title || "YSong activity").slice(0, 220), String(body || "").slice(0, 1000), String(href || "/app").slice(0, 1000)]
	);

	if (email) {
		try {
			const { rows } = await pool.query(
				`SELECT u.email, COALESCE(p.email_enabled, false) AS email_enabled
				 FROM users u
				 LEFT JOIN ysong_notification_preferences p ON p.user_id = u.id
				 WHERE u.id = $1 LIMIT 1`, [userId]
			);
			if (rows[0]?.email_enabled && rows[0]?.email) {
				await sendSocialNotificationEmail(rows[0].email, { title, body, href });
			}
		} catch (e) {
			console.warn("YSong notification email failed", e?.message || e);
		}
	}
	return id;
}

async function getAchievementStats(userId) {
	const { rows } = await pool.query(`
		SELECT
			(SELECT count(*) FROM world_tracks WHERE owner_user_id = $1 AND status = 'published')::int AS tracks_published,
			(SELECT count(*) FROM world_releases WHERE owner_user_id = $1 AND release_type = 'album')::int AS albums_published,
			(SELECT count(*) FROM world_track_reactions WHERE user_id = $1 AND reaction = 1)::int AS likes_given,
			(SELECT count(DISTINCT t.genre) FROM world_track_reactions r JOIN world_tracks t ON t.id = r.track_id WHERE r.user_id = $1 AND r.reaction = 1)::int AS genres_liked,
			(SELECT count(*) FROM world_saved_tracks WHERE user_id = $1)::int AS tracks_saved,
			(SELECT count(*) FROM world_saved_releases WHERE user_id = $1)::int AS releases_saved,
			(SELECT count(*) FROM world_followed_artists WHERE user_id = $1)::int AS artists_followed,
			(SELECT count(*) FROM world_track_comments WHERE user_id = $1 AND is_deleted = false)::int AS comments_made,
			(SELECT count(*) FROM world_playlists WHERE owner_user_id = $1)::int AS playlists_created,
			(SELECT count(*) FROM world_saved_tracks s JOIN world_tracks t ON t.id = s.track_id WHERE t.owner_user_id = $1 AND s.user_id <> $1)::int AS received_track_saves,
			(SELECT count(*) FROM world_playlist_tracks pt JOIN world_tracks t ON t.id = pt.track_id JOIN world_playlists p ON p.id = pt.playlist_id WHERE t.owner_user_id = $1 AND p.owner_user_id <> $1)::int AS received_playlist_adds,
			COALESCE((SELECT sum(play_count) FROM world_tracks WHERE owner_user_id = $1 AND status = 'published'), 0)::bigint AS creator_plays
	`, [userId]);
	const r = rows[0] || {};
	return {
		tracksPublished: Number(r.tracks_published || 0),
		albumsPublished: Number(r.albums_published || 0),
		likesGiven: Number(r.likes_given || 0),
		genresLiked: Number(r.genres_liked || 0),
		tracksSaved: Number(r.tracks_saved || 0),
		releasesSaved: Number(r.releases_saved || 0),
		artistsFollowed: Number(r.artists_followed || 0),
		commentsMade: Number(r.comments_made || 0),
		playlistsCreated: Number(r.playlists_created || 0),
		receivedTrackSaves: Number(r.received_track_saves || 0),
		receivedPlaylistAdds: Number(r.received_playlist_adds || 0),
		creatorPlays: Number(r.creator_plays || 0),
	};
}

async function syncAchievementsForUser(userId, { notify = true } = {}) {
	if (!userId) return { stats: {}, unlocked: new Map(), newlyUnlocked: [] };
	const stats = await getAchievementStats(userId);
	const unlockedRows = await pool.query(`SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = $1`, [userId]);
	const unlocked = new Map(unlockedRows.rows.map((r) => [r.achievement_key, r.unlocked_at]));
	const newlyUnlocked = [];
	for (const def of ACHIEVEMENT_DEFINITIONS) {
		const progress = Number(stats[def.metric] || 0);
		if (progress < def.target || unlocked.has(def.key)) continue;
		const inserted = await pool.query(
			`INSERT INTO user_achievements (user_id, achievement_key, unlocked_at)
			 VALUES ($1,$2,now()) ON CONFLICT (user_id, achievement_key) DO NOTHING RETURNING unlocked_at`,
			[userId, def.key]
		);
		if (!inserted.rows[0]) continue;
		unlocked.set(def.key, inserted.rows[0].unlocked_at);
		newlyUnlocked.push(def.key);
		if (notify) {
			await createNotification(userId, {
				kind: "achievement",
				entityType: "achievement",
				entityId: def.key,
				title: `Achievement unlocked: ${def.title}`,
				body: `${def.description} +${def.points} achievement points.`,
				href: "/app",
				email: false,
			});
		}
	}
	return { stats, unlocked, newlyUnlocked };
}

async function initializeAchievementBaselines() {
	const { rows } = await pool.query(`
		SELECT u.id FROM users u
		LEFT JOIN ysong_achievement_state s ON s.user_id=u.id
		WHERE s.user_id IS NULL
	`);
	for (const row of rows) {
		try {
			await syncAchievementsForUser(row.id, { notify: false });
			// v20 could award old history the first time any action happened and flood the bell.
			// During this one-time baseline migration, keep the achievements but clear that legacy noise.
			await pool.query(`DELETE FROM ysong_notifications WHERE user_id=$1 AND kind='achievement'`, [row.id]);
			await pool.query(`INSERT INTO ysong_achievement_state (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [row.id]);
		} catch (e) {
			console.warn("Achievement baseline backfill failed", row.id, e?.message || e);
		}
	}
	if (rows.length) console.log(`YSong achievements: silently baselined ${rows.length} existing account(s).`);
}

async function ensureWorldSchema() {
	await pool.query(`
		ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
		CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_unique_idx ON users (lower(display_name)) WHERE display_name IS NOT NULL AND btrim(display_name) <> '';

		-- Browser-local project/DAW state mirrored for authenticated device sync.
		-- Keep this in the runtime schema guard so an older Neon/local database can
		-- self-heal instead of returning 42P01 on every /api/client-state write.
		CREATE TABLE IF NOT EXISTS user_client_state (
			user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			state jsonb NOT NULL DEFAULT '{}'::jsonb,
			updated_at timestamptz NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS world_releases (
			id uuid PRIMARY KEY,
			owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			artist_name text NOT NULL,
			title text NOT NULL,
			release_type text NOT NULL CHECK (release_type IN ('single', 'album')),
			genre text NOT NULL DEFAULT 'Other',
			artwork_object_key text,
			created_at timestamptz NOT NULL DEFAULT now(),
			published_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS world_releases_owner_idx ON world_releases(owner_user_id);
		CREATE INDEX IF NOT EXISTS world_releases_published_idx ON world_releases(published_at DESC);

		CREATE TABLE IF NOT EXISTS world_tracks (
			id uuid PRIMARY KEY,
			release_id uuid NOT NULL REFERENCES world_releases(id) ON DELETE CASCADE,
			owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			title text NOT NULL,
			track_number integer NOT NULL DEFAULT 1 CHECK (track_number > 0),
			audio_object_key text NOT NULL,
			genre text NOT NULL DEFAULT 'Other',
			tags jsonb NOT NULL DEFAULT '[]'::jsonb,
			description text NOT NULL DEFAULT '',
			explicit boolean NOT NULL DEFAULT false,
			duration_seconds double precision,
			play_count bigint NOT NULL DEFAULT 0,
			status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'blocked')),
			created_at timestamptz NOT NULL DEFAULT now(),
			published_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS world_tracks_release_idx ON world_tracks(release_id, track_number);
		CREATE INDEX IF NOT EXISTS world_tracks_published_idx ON world_tracks(status, published_at DESC);
		CREATE INDEX IF NOT EXISTS world_tracks_genre_idx ON world_tracks(genre);

		ALTER TABLE world_tracks ADD COLUMN IF NOT EXISTS isrc text;
		ALTER TABLE world_tracks ADD COLUMN IF NOT EXISTS previously_released boolean NOT NULL DEFAULT false;
		CREATE INDEX IF NOT EXISTS world_tracks_isrc_idx ON world_tracks(isrc) WHERE isrc IS NOT NULL AND isrc <> '';

		CREATE TABLE IF NOT EXISTS world_track_reactions (
			track_id uuid NOT NULL REFERENCES world_tracks(id) ON DELETE CASCADE,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			reaction smallint NOT NULL CHECK (reaction IN (-1, 1)),
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (track_id, user_id)
		);

		CREATE TABLE IF NOT EXISTS world_saved_tracks (
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			track_id uuid NOT NULL REFERENCES world_tracks(id) ON DELETE CASCADE,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, track_id)
		);
		CREATE INDEX IF NOT EXISTS world_saved_tracks_track_idx ON world_saved_tracks(track_id);

		CREATE TABLE IF NOT EXISTS world_saved_releases (
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			release_id uuid NOT NULL REFERENCES world_releases(id) ON DELETE CASCADE,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, release_id)
		);

		CREATE TABLE IF NOT EXISTS world_followed_artists (
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			artist_owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			artist_name text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, artist_owner_user_id, artist_name)
		);

		CREATE TABLE IF NOT EXISTS world_playlists (
			id uuid PRIMARY KEY,
			owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			title text NOT NULL,
			description text NOT NULL DEFAULT '',
			artwork_object_key text,
			tags jsonb NOT NULL DEFAULT '[]'::jsonb,
			is_public boolean NOT NULL DEFAULT true,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		);
		ALTER TABLE world_playlists ADD COLUMN IF NOT EXISTS artwork_object_key text;
		ALTER TABLE world_playlists ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
		CREATE INDEX IF NOT EXISTS world_playlists_owner_idx ON world_playlists(owner_user_id);
		CREATE INDEX IF NOT EXISTS world_playlists_public_idx ON world_playlists(is_public, updated_at DESC);

		CREATE TABLE IF NOT EXISTS world_playlist_tracks (
			playlist_id uuid NOT NULL REFERENCES world_playlists(id) ON DELETE CASCADE,
			track_id uuid NOT NULL REFERENCES world_tracks(id) ON DELETE CASCADE,
			added_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			position integer NOT NULL DEFAULT 0,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (playlist_id, track_id)
		);
		CREATE INDEX IF NOT EXISTS world_playlist_tracks_position_idx ON world_playlist_tracks(playlist_id, position, created_at);

		CREATE TABLE IF NOT EXISTS world_saved_playlists (
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			playlist_id uuid NOT NULL REFERENCES world_playlists(id) ON DELETE CASCADE,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, playlist_id)
		);

		CREATE TABLE IF NOT EXISTS world_track_comments (
			id uuid PRIMARY KEY,
			track_id uuid NOT NULL REFERENCES world_tracks(id) ON DELETE CASCADE,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			parent_comment_id uuid REFERENCES world_track_comments(id) ON DELETE CASCADE,
			body text NOT NULL,
			is_deleted boolean NOT NULL DEFAULT false,
			is_pinned boolean NOT NULL DEFAULT false,
			created_at timestamptz NOT NULL DEFAULT now(),
			updated_at timestamptz NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS world_track_comments_track_idx ON world_track_comments(track_id, is_pinned DESC, created_at DESC);

		CREATE TABLE IF NOT EXISTS world_comment_likes (
			comment_id uuid NOT NULL REFERENCES world_track_comments(id) ON DELETE CASCADE,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (comment_id, user_id)
		);

		CREATE TABLE IF NOT EXISTS world_comment_reports (
			comment_id uuid NOT NULL REFERENCES world_track_comments(id) ON DELETE CASCADE,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			reason text NOT NULL DEFAULT 'reported',
			created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (comment_id, user_id)
		);

		CREATE TABLE IF NOT EXISTS ysong_notifications (
			id uuid PRIMARY KEY,
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
			kind text NOT NULL,
			entity_type text,
			entity_id text,
			title text NOT NULL,
			body text NOT NULL DEFAULT '',
			href text NOT NULL DEFAULT '/app',
			created_at timestamptz NOT NULL DEFAULT now(),
			read_at timestamptz
		);
		CREATE INDEX IF NOT EXISTS ysong_notifications_user_idx ON ysong_notifications(user_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS ysong_notifications_unread_idx ON ysong_notifications(user_id, read_at) WHERE read_at IS NULL;

		CREATE TABLE IF NOT EXISTS ysong_notification_preferences (
			user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			email_enabled boolean NOT NULL DEFAULT false,
			updated_at timestamptz NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS user_achievements (
			user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			achievement_key text NOT NULL,
			unlocked_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, achievement_key)
		);

		CREATE TABLE IF NOT EXISTS ysong_achievement_state (
			user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			baseline_initialized_at timestamptz NOT NULL DEFAULT now()
		);
	`);
}

app.post("/api/world/publish", requireAuth, async (req, res) => {
	try {
		const body = req.body ?? {};
		const title = String(body.title || "").trim().slice(0, 180);
		const artistName = String(body.artistName || "").trim().slice(0, 180);
		const releaseType = body.releaseType === "album" ? "album" : "single";
		const albumTitle = String(body.albumTitle || title).trim().slice(0, 180);
		const genre = String(body.genre || "Other").trim().slice(0, 80) || "Other";
		const tags = Array.isArray(body.tags)
			? body.tags.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 20)
			: [];
		const description = String(body.description || "").trim().slice(0, 4000);
		const explicit = !!body.explicit;
		const trackNumber = Math.max(1, Math.min(999, Number(body.trackNumber || 1) || 1));
		const durationSeconds = Number.isFinite(Number(body.durationSeconds)) ? Math.max(0, Number(body.durationSeconds)) : null;
		const previouslyReleased = !!body.previouslyReleased;
		const isrc = normalizeIsrc(body.isrc);
		const rightsConfirmed = body.rightsConfirmed === true;

		if (!title) return res.status(400).json({ error: "title_required" });
		if (!artistName) return res.status(400).json({ error: "artist_required" });
		if (releaseType === "album" && !albumTitle) return res.status(400).json({ error: "album_required" });
		if (!rightsConfirmed) return res.status(400).json({ error: "rights_confirmation_required" });
		if (previouslyReleased && !isrc) return res.status(400).json({ error: "isrc_required_for_released_track" });
		if (isrc && !validIsrc(isrc)) return res.status(400).json({ error: "invalid_isrc" });

		const audioObjectKey = assertOwnedObjectKey(req.user.id, String(body.audioObjectKey || ""), { uploadOnly: true });
		const artworkObjectKey = body.artworkObjectKey
			? assertOwnedObjectKey(req.user.id, String(body.artworkObjectKey), { uploadOnly: true })
			: null;

		await fs.promises.access(objectPath(audioObjectKey), fs.constants.R_OK);
		const audioMeta = await readObjectMetadata(audioObjectKey);
		const audioType = String(audioMeta.contentType || "");
		const audioName = String(audioMeta.originalName || audioObjectKey);
		if (!audioType.startsWith("audio/") && !/\.(wav|flac|mp3|m4a|aac|ogg)$/i.test(audioName)) {
			return res.status(400).json({ error: "audio_file_required" });
		}
		if (artworkObjectKey) {
			await fs.promises.access(objectPath(artworkObjectKey), fs.constants.R_OK);
			const artMeta = await readObjectMetadata(artworkObjectKey);
			if (!String(artMeta.contentType || "").startsWith("image/")) {
				return res.status(400).json({ error: "image_file_required" });
			}
		}

		let releaseId = null;
		if (releaseType === "album") {
			const existing = await pool.query(
				`SELECT id, artwork_object_key FROM world_releases
				 WHERE owner_user_id = $1 AND release_type = 'album'
				   AND lower(artist_name) = lower($2) AND lower(title) = lower($3)
				 ORDER BY created_at ASC LIMIT 1`,
				[req.user.id, artistName, albumTitle]
			);
			if (existing.rows[0]) {
				releaseId = existing.rows[0].id;
				if (artworkObjectKey) {
					await pool.query(`UPDATE world_releases SET artwork_object_key = $2, genre = $3 WHERE id = $1`, [releaseId, artworkObjectKey, genre]);
				}
			}
		}

		if (!releaseId) {
			releaseId = crypto.randomUUID();
			await pool.query(
				`INSERT INTO world_releases (id, owner_user_id, artist_name, title, release_type, genre, artwork_object_key)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[releaseId, req.user.id, artistName, releaseType === "album" ? albumTitle : title, releaseType, genre, artworkObjectKey]
			);
		}

		const trackId = crypto.randomUUID();
		await pool.query(
			`INSERT INTO world_tracks
			 (id, release_id, owner_user_id, title, track_number, audio_object_key, genre, tags, description, explicit, duration_seconds, isrc, previously_released, status)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, 'published')`,
			[trackId, releaseId, req.user.id, title, trackNumber, audioObjectKey, genre, JSON.stringify(tags), description, explicit, durationSeconds, isrc || null, previouslyReleased]
		);

		const { rows } = await pool.query(
			`SELECT t.*, r.artist_name, r.title AS album_name, r.release_type,
			        (r.artwork_object_key IS NOT NULL) AS has_artwork,
			        true AS is_owner,
			        0::bigint AS likes, 0::bigint AS dislikes, 0::smallint AS my_reaction
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id WHERE t.id = $1`,
			[trackId]
		);
		await syncAchievementsForUser(req.user.id).catch((e) => console.warn("achievement sync after publish failed", e?.message || e));
		return res.status(201).json({ ok: true, track: worldRow(rows[0]), releaseId: String(releaseId) });
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "forbidden" });
		if (e?.code === "ENOENT") return res.status(404).json({ error: "uploaded_asset_missing" });
		console.error("POST /api/world/publish ERROR", e);
		return res.status(500).json({ error: "publish_failed", message: e?.message });
	}
});

app.get("/api/world/tracks", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const search = String(req.query.search || "").trim().slice(0, 120);
		const genre = String(req.query.genre || "").trim().slice(0, 80);
		const sort = ["newest", "popular"].includes(String(req.query.sort)) ? String(req.query.sort) : "algorithm";
		const orderBy = sort === "newest"
			? "published_at DESC"
			: sort === "popular"
				? "play_count DESC, likes DESC, published_at DESC"
				: `(ln(play_count + 1) * 1.25 + likes * 3.0 - dislikes * 1.25 + GREATEST(0, 8 - (EXTRACT(EPOCH FROM (now() - published_at)) / 86400.0) / 3.0)) DESC, published_at DESC`;

		const { rows } = await pool.query(
			`WITH base AS (
				SELECT t.*, r.artist_name, r.title AS album_name, r.release_type,
				       (r.artwork_object_key IS NOT NULL) AS has_artwork,
				       COALESCE(t.owner_user_id = $1::uuid, false) AS is_owner,
				       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = 1) AS likes,
				       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = -1) AS dislikes,
				       COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id = t.id AND x.user_id = $1::uuid), 0) AS my_reaction,
			       EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id = t.id AND s.user_id = $1::uuid) AS is_saved,
			       EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id = t.release_id AND s.user_id = $1::uuid) AS is_release_saved,
			       EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id = $1::uuid AND f.artist_owner_user_id = t.owner_user_id AND f.artist_name = r.artist_name) AS is_artist_followed,
			       (SELECT count(*) FROM world_track_comments c WHERE c.track_id = t.id AND c.is_deleted = false) AS comment_count
				FROM world_tracks t
				JOIN world_releases r ON r.id = t.release_id
				WHERE t.status = 'published'
				  AND ($2 = '' OR t.title ILIKE '%' || $2 || '%' OR r.artist_name ILIKE '%' || $2 || '%' OR r.title ILIKE '%' || $2 || '%' OR t.tags::text ILIKE '%' || $2 || '%')
				  AND ($3 = '' OR lower(t.genre) = lower($3))
			)
			SELECT * FROM base ORDER BY ${orderBy} LIMIT 120`,
			[user?.id || null, search, genre]
		);
		const genreRows = await pool.query(`SELECT DISTINCT genre FROM world_tracks WHERE status = 'published' AND genre <> '' ORDER BY genre LIMIT 100`);
		return res.json({ tracks: rows.map(worldRow), genres: genreRows.rows.map((x) => x.genre) });
	} catch (e) {
		console.error("GET /api/world/tracks ERROR", e);
		return res.status(500).json({ error: "world_load_failed" });
	}
});

app.get("/api/world/tracks/:id", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const { rows } = await pool.query(`
			SELECT t.*, r.artist_name, r.title AS album_name, r.release_type,
			       (r.artwork_object_key IS NOT NULL) AS has_artwork,
			       COALESCE(t.owner_user_id = $2::uuid, false) AS is_owner,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=1) AS likes,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=-1) AS dislikes,
			       COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id=t.id AND x.user_id=$2::uuid),0) AS my_reaction,
			       EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id=t.id AND s.user_id=$2::uuid) AS is_saved,
			       EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id=t.release_id AND s.user_id=$2::uuid) AS is_release_saved,
			       EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id=$2::uuid AND f.artist_owner_user_id=t.owner_user_id AND f.artist_name=r.artist_name) AS is_artist_followed,
			       (SELECT count(*) FROM world_track_comments c WHERE c.track_id=t.id AND c.is_deleted=false) AS comment_count
			FROM world_tracks t JOIN world_releases r ON r.id=t.release_id WHERE t.id=$1 AND t.status='published' LIMIT 1`,
			[String(req.params.id || ""), user?.id || null]);
		if (!rows[0]) return res.status(404).json({ error:"track_not_found" });
		return res.json({ track: worldRow(rows[0]) });
	} catch (e) { console.error("GET /api/world/tracks/:id ERROR", e); return res.status(500).json({ error:"track_load_failed" }); }
});

app.get("/api/world/releases/:id", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const releaseId = String(req.params.id || "");
		const releaseResult = await pool.query(
			`SELECT id, owner_user_id, artist_name, title, release_type, genre, published_at, (artwork_object_key IS NOT NULL) AS has_artwork,
			        COALESCE(owner_user_id = $2::uuid, false) AS is_owner,
			        EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id = world_releases.id AND s.user_id = $2::uuid) AS is_saved,
			        EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id = $2::uuid AND f.artist_owner_user_id = world_releases.owner_user_id AND f.artist_name = world_releases.artist_name) AS is_artist_followed
			 FROM world_releases WHERE id = $1 LIMIT 1`,
			[releaseId, user?.id || null]
		);
		if (!releaseResult.rows[0]) return res.status(404).json({ error: "release_not_found" });
		const tracksResult = await pool.query(
			`SELECT t.*, r.artist_name, r.title AS album_name, r.release_type,
			        (r.artwork_object_key IS NOT NULL) AS has_artwork,
			        COALESCE(t.owner_user_id = $2::uuid, false) AS is_owner,
			        (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = 1) AS likes,
			        (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = -1) AS dislikes,
			        COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id = t.id AND x.user_id = $2::uuid), 0) AS my_reaction,
			        EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id = t.id AND s.user_id = $2::uuid) AS is_saved,
			        EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id = t.release_id AND s.user_id = $2::uuid) AS is_release_saved,
			        EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id = $2::uuid AND f.artist_owner_user_id = t.owner_user_id AND f.artist_name = r.artist_name) AS is_artist_followed,
			        (SELECT count(*) FROM world_track_comments c WHERE c.track_id = t.id AND c.is_deleted = false) AS comment_count
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id
			 WHERE t.release_id = $1 AND t.status = 'published'
			 ORDER BY t.track_number ASC, t.published_at ASC`,
			[releaseId, user?.id || null]
		);
		const r = releaseResult.rows[0];
		return res.json({
			id: String(r.id), ownerUserId: String(r.owner_user_id || ""), artistName: r.artist_name, title: r.title, releaseType: r.release_type,
			genre: r.genre || "Other", publishedAt: r.published_at, hasArtwork: !!r.has_artwork, isOwner: !!r.is_owner,
			isSaved: !!r.is_saved, isArtistFollowed: !!r.is_artist_followed, tracks: tracksResult.rows.map(worldRow),
		});
	} catch (e) {
		console.error("GET /api/world/releases/:id ERROR", e);
		return res.status(500).json({ error: "release_load_failed" });
	}
});


app.patch("/api/world/tracks/:id", requireAuth, async (req, res) => {
	try {
		const trackId = String(req.params.id || "");
		const existing = await pool.query(
			`SELECT t.*, r.artist_name, r.title AS album_name, r.release_type, r.artwork_object_key
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id
			 WHERE t.id = $1 AND t.owner_user_id = $2 LIMIT 1`,
			[trackId, req.user.id]
		);
		if (!existing.rows[0]) return res.status(404).json({ error: "track_not_found_or_not_owner" });
		const current = existing.rows[0];
		const body = req.body ?? {};
		const title = body.title === undefined ? current.title : String(body.title || "").trim().slice(0, 180);
		const genre = body.genre === undefined ? current.genre : (String(body.genre || "Other").trim().slice(0, 80) || "Other");
		const tags = body.tags === undefined
			? (Array.isArray(current.tags) ? current.tags : [])
			: (Array.isArray(body.tags) ? body.tags.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 20) : []);
		const description = body.description === undefined ? current.description : String(body.description || "").trim().slice(0, 4000);
		const explicit = body.explicit === undefined ? !!current.explicit : !!body.explicit;
		const trackNumber = body.trackNumber === undefined ? Number(current.track_number || 1) : Math.max(1, Math.min(999, Number(body.trackNumber || 1) || 1));
		const previouslyReleased = body.previouslyReleased === undefined ? !!current.previously_released : !!body.previouslyReleased;
		const isrc = body.isrc === undefined ? String(current.isrc || "") : normalizeIsrc(body.isrc);
		if (!title) return res.status(400).json({ error: "title_required" });
		if (previouslyReleased && !isrc) return res.status(400).json({ error: "isrc_required_for_released_track" });
		if (isrc && !validIsrc(isrc)) return res.status(400).json({ error: "invalid_isrc" });

		await pool.query(
			`UPDATE world_tracks
			 SET title = $3, genre = $4, tags = $5::jsonb, description = $6, explicit = $7,
			     track_number = $8, isrc = $9, previously_released = $10
			 WHERE id = $1 AND owner_user_id = $2`,
			[trackId, req.user.id, title, genre, JSON.stringify(tags), description, explicit, trackNumber, isrc || null, previouslyReleased]
		);
		if (current.release_type === "single") {
			await pool.query(`UPDATE world_releases SET title = $3, genre = $4 WHERE id = $1 AND owner_user_id = $2`, [current.release_id, req.user.id, title, genre]);
		}
		const { rows } = await pool.query(
			`SELECT t.*, r.artist_name, r.title AS album_name, r.release_type,
			        (r.artwork_object_key IS NOT NULL) AS has_artwork, true AS is_owner,
			        (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = 1) AS likes,
			        (SELECT count(*) FROM world_track_reactions x WHERE x.track_id = t.id AND x.reaction = -1) AS dislikes,
			        COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id = t.id AND x.user_id = $2::uuid), 0) AS my_reaction,
			        EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id = t.id AND s.user_id = $2::uuid) AS is_saved,
			        EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id = t.release_id AND s.user_id = $2::uuid) AS is_release_saved,
			        EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id = $2::uuid AND f.artist_owner_user_id = t.owner_user_id AND f.artist_name = r.artist_name) AS is_artist_followed,
			        (SELECT count(*) FROM world_track_comments c WHERE c.track_id = t.id AND c.is_deleted = false) AS comment_count
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id WHERE t.id = $1`,
			[trackId, req.user.id]
		);
		return res.json({ ok: true, track: worldRow(rows[0]) });
	} catch (e) {
		console.error("PATCH /api/world/tracks/:id ERROR", e);
		return res.status(500).json({ error: "track_update_failed" });
	}
});

app.patch("/api/world/releases/:id", requireAuth, async (req, res) => {
	try {
		const releaseId = String(req.params.id || "");
		const existing = await pool.query(`SELECT * FROM world_releases WHERE id = $1 AND owner_user_id = $2 LIMIT 1`, [releaseId, req.user.id]);
		if (!existing.rows[0]) return res.status(404).json({ error: "release_not_found_or_not_owner" });
		const current = existing.rows[0];
		const body = req.body ?? {};
		const artistName = body.artistName === undefined ? current.artist_name : String(body.artistName || "").trim().slice(0, 180);
		const title = body.title === undefined ? current.title : String(body.title || "").trim().slice(0, 180);
		const genre = body.genre === undefined ? current.genre : (String(body.genre || "Other").trim().slice(0, 80) || "Other");
		if (!artistName) return res.status(400).json({ error: "artist_required" });
		if (!title) return res.status(400).json({ error: "title_required" });
		await pool.query(`UPDATE world_releases SET artist_name = $3, title = $4, genre = $5 WHERE id = $1 AND owner_user_id = $2`, [releaseId, req.user.id, artistName, title, genre]);
		if (current.release_type === "single") {
			await pool.query(`UPDATE world_tracks SET title = $3, genre = $4 WHERE release_id = $1 AND owner_user_id = $2`, [releaseId, req.user.id, title, genre]);
		}
		return res.json({ ok: true, release: { id: releaseId, artistName, title, releaseType: current.release_type, genre, publishedAt: current.published_at, hasArtwork: !!current.artwork_object_key, isOwner: true, tracks: [] } });
	} catch (e) {
		console.error("PATCH /api/world/releases/:id ERROR", e);
		return res.status(500).json({ error: "release_update_failed" });
	}
});

app.post("/api/world/tracks/:id/reaction", requireAuth, async (req, res) => {
	try {
		const trackId = String(req.params.id || "");
		const reaction = Number(req.body?.reaction);
		if (reaction !== 1 && reaction !== -1) return res.status(400).json({ error: "invalid_reaction" });
		const exists = await pool.query(
			`SELECT t.id, t.owner_user_id, t.title, r.artist_name
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id
			 WHERE t.id = $1 AND t.status = 'published' LIMIT 1`, [trackId]
		);
		if (!exists.rows[0]) return res.status(404).json({ error: "track_not_found" });
		const current = await pool.query(`SELECT reaction FROM world_track_reactions WHERE track_id = $1 AND user_id = $2`, [trackId, req.user.id]);
		const previous = Number(current.rows[0]?.reaction || 0);
		let next = reaction;
		if (previous === reaction) {
			await pool.query(`DELETE FROM world_track_reactions WHERE track_id = $1 AND user_id = $2`, [trackId, req.user.id]);
			next = 0;
		} else {
			await pool.query(
				`INSERT INTO world_track_reactions (track_id, user_id, reaction) VALUES ($1, $2, $3)
				 ON CONFLICT (track_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, updated_at = now()`,
				[trackId, req.user.id, reaction]
			);
		}
		const counts = await pool.query(
			`SELECT count(*) FILTER (WHERE reaction = 1) AS likes, count(*) FILTER (WHERE reaction = -1) AS dislikes
			 FROM world_track_reactions WHERE track_id = $1`, [trackId]
		);
		if (next === 1 && previous !== 1) {
			const track = exists.rows[0];
			await createNotification(track.owner_user_id, {
				actorUserId: req.user.id,
				kind: "track_like",
				entityType: "track",
				entityId: trackId,
				title: `${await publicNameForUserId(req.user.id)} liked your song`,
				body: `${track.title} • ${track.artist_name}`,
				href: "/app",
			});
		}
		await syncAchievementsForUser(req.user.id).catch(() => {});
		return res.json({ ok: true, reaction: next, likes: Number(counts.rows[0].likes || 0), dislikes: Number(counts.rows[0].dislikes || 0) });
	} catch (e) {
		console.error("POST /api/world/tracks/:id/reaction ERROR", e);
		return res.status(500).json({ error: "reaction_failed" });
	}
});

app.post("/api/world/tracks/:id/play", async (req, res) => {
	try {
		const { rows } = await pool.query(
			`UPDATE world_tracks SET play_count = play_count + 1 WHERE id = $1 AND status = 'published' RETURNING play_count, owner_user_id`,
			[String(req.params.id || "")]
		);
		if (!rows[0]) return res.status(404).json({ error: "track_not_found" });
		syncAchievementsForUser(rows[0].owner_user_id).catch(() => {});
		return res.json({ ok: true, playCount: Number(rows[0].play_count || 0) });
	} catch (e) {
		console.error("POST /api/world/tracks/:id/play ERROR", e);
		return res.status(500).json({ error: "play_count_failed" });
	}
});


// -------------------- YSong World social / library / playlists --------------------
app.post("/api/world/tracks/:id/save", requireAuth, async (req, res) => {
	try {
		const trackId = String(req.params.id || "");
		const found = await pool.query(
			`SELECT t.id, t.owner_user_id, t.title, r.artist_name FROM world_tracks t
			 JOIN world_releases r ON r.id = t.release_id WHERE t.id = $1 AND t.status = 'published' LIMIT 1`, [trackId]
		);
		if (!found.rows[0]) return res.status(404).json({ error: "track_not_found" });
		const removed = await pool.query(`DELETE FROM world_saved_tracks WHERE user_id = $1 AND track_id = $2 RETURNING track_id`, [req.user.id, trackId]);
		let saved = false;
		if (!removed.rows[0]) {
			await pool.query(`INSERT INTO world_saved_tracks (user_id, track_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, trackId]);
			saved = true;
			const track = found.rows[0];
			await createNotification(track.owner_user_id, {
				actorUserId: req.user.id, kind: "track_save", entityType: "track", entityId: trackId,
				title: `${await publicNameForUserId(req.user.id)} saved your song`, body: `${track.title} • ${track.artist_name}`, href: "/app",
			});
		}
		await syncAchievementsForUser(req.user.id).catch(() => {});
		if (saved) await syncAchievementsForUser(found.rows[0].owner_user_id).catch(() => {});
		return res.json({ ok: true, saved });
	} catch (e) {
		console.error("POST /api/world/tracks/:id/save ERROR", e);
		return res.status(500).json({ error: "track_save_failed" });
	}
});

app.post("/api/world/releases/:id/save", requireAuth, async (req, res) => {
	try {
		const releaseId = String(req.params.id || "");
		const found = await pool.query(`SELECT id, owner_user_id, title, artist_name FROM world_releases WHERE id = $1 LIMIT 1`, [releaseId]);
		if (!found.rows[0]) return res.status(404).json({ error: "release_not_found" });
		const removed = await pool.query(`DELETE FROM world_saved_releases WHERE user_id = $1 AND release_id = $2 RETURNING release_id`, [req.user.id, releaseId]);
		let saved = false;
		if (!removed.rows[0]) {
			await pool.query(`INSERT INTO world_saved_releases (user_id, release_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, releaseId]);
			saved = true;
			const release = found.rows[0];
			await createNotification(release.owner_user_id, {
				actorUserId: req.user.id, kind: "release_save", entityType: "release", entityId: releaseId,
				title: `${await publicNameForUserId(req.user.id)} saved your release`, body: `${release.title} • ${release.artist_name}`, href: "/app",
			});
		}
		await syncAchievementsForUser(req.user.id).catch(() => {});
		return res.json({ ok: true, saved });
	} catch (e) {
		console.error("POST /api/world/releases/:id/save ERROR", e);
		return res.status(500).json({ error: "release_save_failed" });
	}
});

app.post("/api/world/artists/follow", requireAuth, async (req, res) => {
	try {
		const ownerUserId = String(req.body?.ownerUserId || "");
		const artistName = String(req.body?.artistName || "").trim().slice(0, 180);
		if (!ownerUserId || !artistName) return res.status(400).json({ error: "artist_required" });
		const found = await pool.query(`SELECT 1 FROM world_releases WHERE owner_user_id = $1 AND artist_name = $2 LIMIT 1`, [ownerUserId, artistName]);
		if (!found.rows[0]) return res.status(404).json({ error: "artist_not_found" });
		const removed = await pool.query(`DELETE FROM world_followed_artists WHERE user_id = $1 AND artist_owner_user_id = $2 AND artist_name = $3 RETURNING artist_name`, [req.user.id, ownerUserId, artistName]);
		let followed = false;
		if (!removed.rows[0]) {
			await pool.query(`INSERT INTO world_followed_artists (user_id, artist_owner_user_id, artist_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.user.id, ownerUserId, artistName]);
			followed = true;
			await createNotification(ownerUserId, {
				actorUserId: req.user.id, kind: "artist_follow", entityType: "artist", entityId: `${ownerUserId}:${artistName}`,
				title: `${await publicNameForUserId(req.user.id)} favorited ${artistName}`, body: "You have a new artist follower on YSong World.", href: "/app",
			});
		}
		await syncAchievementsForUser(req.user.id).catch(() => {});
		return res.json({ ok: true, followed });
	} catch (e) {
		console.error("POST /api/world/artists/follow ERROR", e);
		return res.status(500).json({ error: "artist_follow_failed" });
	}
});

function playlistRow(row) {
	return {
		id: String(row.id), ownerUserId: String(row.owner_user_id || ""), ownerName: publicNameFromRow(row, "owner_user_id", "owner_display_name"),
		title: row.title, description: row.description || "", tags: Array.isArray(row.tags) ? row.tags : [], isPublic: !!row.is_public,
		hasArtwork: !!row.artwork_object_key,
		trackCount: Number(row.track_count || 0), saveCount: Number(row.save_count || 0), coverTrackId: row.cover_track_id ? String(row.cover_track_id) : null,
		isSaved: !!row.is_saved, isOwner: !!row.is_owner, createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

app.get("/api/world/playlists", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const { rows } = await pool.query(`
			SELECT p.*, u.display_name AS owner_display_name,
			       (SELECT count(*) FROM world_playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
			       (SELECT count(*) FROM world_saved_playlists sp WHERE sp.playlist_id = p.id) AS save_count,
			       (SELECT pt.track_id FROM world_playlist_tracks pt WHERE pt.playlist_id = p.id ORDER BY pt.position, pt.created_at LIMIT 1) AS cover_track_id,
			       EXISTS(SELECT 1 FROM world_saved_playlists sp WHERE sp.playlist_id = p.id AND sp.user_id = $1::uuid) AS is_saved,
			       COALESCE(p.owner_user_id = $1::uuid, false) AS is_owner
			FROM world_playlists p JOIN users u ON u.id = p.owner_user_id
			WHERE p.is_public = true
			ORDER BY save_count DESC, p.updated_at DESC LIMIT 80`, [user?.id || null]);
		return res.json({ playlists: rows.map(playlistRow) });
	} catch (e) {
		console.error("GET /api/world/playlists ERROR", e);
		return res.status(500).json({ error: "playlists_load_failed" });
	}
});

app.post("/api/world/playlists", requireAuth, async (req, res) => {
	try {
		const title = String(req.body?.title || "").trim().slice(0, 180);
		const description = String(req.body?.description || "").trim().slice(0, 1000);
		const tags = Array.isArray(req.body?.tags)
			? req.body.tags.map((x) => String(x).trim().slice(0, 48)).filter(Boolean).slice(0, 16)
			: [];
		const isPublic = req.body?.isPublic !== false;
		let artworkObjectKey = null;
		if (req.body?.artworkObjectKey) {
			artworkObjectKey = assertOwnedObjectKey(req.user.id, String(req.body.artworkObjectKey), { uploadOnly: true });
			await fs.promises.access(objectPath(artworkObjectKey), fs.constants.R_OK);
			const meta = await readObjectMetadata(artworkObjectKey);
			if (meta?.contentType && !String(meta.contentType).toLowerCase().startsWith("image/")) {
				return res.status(400).json({ error: "playlist_artwork_must_be_image" });
			}
		}
		if (!title) return res.status(400).json({ error: "playlist_title_required" });
		const id = crypto.randomUUID();
		await pool.query(
			`INSERT INTO world_playlists (id, owner_user_id, title, description, artwork_object_key, tags, is_public)
			 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
			[id, req.user.id, title, description, artworkObjectKey, JSON.stringify(tags), isPublic]
		);
		await syncAchievementsForUser(req.user.id).catch(() => {});
		return res.status(201).json({
			ok: true,
			playlist: {
				id, ownerUserId: req.user.id, ownerName: await publicNameForUserId(req.user.id),
				title, description, tags, hasArtwork: !!artworkObjectKey, isPublic,
				trackCount: 0, saveCount: 0, coverTrackId: null, isSaved: false, isOwner: true
			}
		});
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "playlist_artwork_not_owned" });
		if (e?.code === "ENOENT") return res.status(400).json({ error: "playlist_artwork_missing" });
		console.error("POST /api/world/playlists ERROR", e);
		return res.status(500).json({ error: "playlist_create_failed" });
	}
});

app.patch("/api/world/playlists/:id", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const found = await pool.query(`SELECT * FROM world_playlists WHERE id = $1 AND owner_user_id = $2 LIMIT 1`, [id, req.user.id]);
		if (!found.rows[0]) return res.status(404).json({ error: "playlist_not_found_or_not_owner" });
		const cur = found.rows[0];
		const title = req.body?.title === undefined ? cur.title : String(req.body.title || "").trim().slice(0, 180);
		const description = req.body?.description === undefined ? cur.description : String(req.body.description || "").trim().slice(0, 1000);
		const tags = req.body?.tags === undefined
			? (Array.isArray(cur.tags) ? cur.tags : [])
			: (Array.isArray(req.body.tags) ? req.body.tags.map((x) => String(x).trim().slice(0, 48)).filter(Boolean).slice(0, 16) : []);
		const isPublic = req.body?.isPublic === undefined ? cur.is_public : !!req.body.isPublic;
		let artworkObjectKey = cur.artwork_object_key || null;
		if (req.body?.artworkObjectKey === null) artworkObjectKey = null;
		else if (req.body?.artworkObjectKey !== undefined) {
			artworkObjectKey = assertOwnedObjectKey(req.user.id, String(req.body.artworkObjectKey), { uploadOnly: true });
			await fs.promises.access(objectPath(artworkObjectKey), fs.constants.R_OK);
			const meta = await readObjectMetadata(artworkObjectKey);
			if (meta?.contentType && !String(meta.contentType).toLowerCase().startsWith("image/")) {
				return res.status(400).json({ error: "playlist_artwork_must_be_image" });
			}
		}
		if (!title) return res.status(400).json({ error: "playlist_title_required" });
		await pool.query(
			`UPDATE world_playlists SET title=$3, description=$4, artwork_object_key=$5, tags=$6::jsonb, is_public=$7, updated_at=now()
			 WHERE id=$1 AND owner_user_id=$2`,
			[id, req.user.id, title, description, artworkObjectKey, JSON.stringify(tags), isPublic]
		);
		return res.json({ ok: true });
	} catch (e) {
		if (e?.statusCode === 403) return res.status(403).json({ error: "playlist_artwork_not_owned" });
		if (e?.code === "ENOENT") return res.status(400).json({ error: "playlist_artwork_missing" });
		console.error("PATCH /api/world/playlists/:id ERROR", e);
		return res.status(500).json({ error: "playlist_update_failed" });
	}
});

app.delete("/api/world/playlists/:id", requireAuth, async (req, res) => {
	try {
		const deleted = await pool.query(`DELETE FROM world_playlists WHERE id = $1 AND owner_user_id = $2 RETURNING id`, [String(req.params.id || ""), req.user.id]);
		if (!deleted.rows[0]) return res.status(404).json({ error: "playlist_not_found_or_not_owner" });
		return res.json({ ok: true });
	} catch (e) {
		console.error("DELETE /api/world/playlists/:id ERROR", e);
		return res.status(500).json({ error: "playlist_delete_failed" });
	}
});

app.get("/api/world/playlists/:id", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const id = String(req.params.id || "");
		const meta = await pool.query(`
			SELECT p.*, u.display_name AS owner_display_name,
			       (SELECT count(*) FROM world_playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
			       (SELECT count(*) FROM world_saved_playlists sp WHERE sp.playlist_id = p.id) AS save_count,
			       (SELECT pt.track_id FROM world_playlist_tracks pt WHERE pt.playlist_id = p.id ORDER BY pt.position, pt.created_at LIMIT 1) AS cover_track_id,
			       EXISTS(SELECT 1 FROM world_saved_playlists sp WHERE sp.playlist_id = p.id AND sp.user_id = $2::uuid) AS is_saved,
			       COALESCE(p.owner_user_id = $2::uuid, false) AS is_owner
			FROM world_playlists p JOIN users u ON u.id = p.owner_user_id
			WHERE p.id = $1 AND (p.is_public = true OR p.owner_user_id = $2::uuid) LIMIT 1`, [id, user?.id || null]);
		if (!meta.rows[0]) return res.status(404).json({ error: "playlist_not_found" });
		const tracks = await pool.query(`
			SELECT t.*, r.artist_name, r.title AS album_name, r.release_type, (r.artwork_object_key IS NOT NULL) AS has_artwork,
			       COALESCE(t.owner_user_id = $2::uuid, false) AS is_owner,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=1) AS likes,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=-1) AS dislikes,
			       COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id=t.id AND x.user_id=$2::uuid),0) AS my_reaction,
			       EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id=t.id AND s.user_id=$2::uuid) AS is_saved,
			       EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id=t.release_id AND s.user_id=$2::uuid) AS is_release_saved,
			       EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id=$2::uuid AND f.artist_owner_user_id=t.owner_user_id AND f.artist_name=r.artist_name) AS is_artist_followed,
			       (SELECT count(*) FROM world_track_comments c WHERE c.track_id=t.id AND c.is_deleted=false) AS comment_count
			FROM world_playlist_tracks pt JOIN world_tracks t ON t.id=pt.track_id JOIN world_releases r ON r.id=t.release_id
			WHERE pt.playlist_id=$1 AND t.status='published' ORDER BY pt.position, pt.created_at`, [id, user?.id || null]);
		return res.json({ playlist: playlistRow(meta.rows[0]), tracks: tracks.rows.map(worldRow) });
	} catch (e) {
		console.error("GET /api/world/playlists/:id ERROR", e);
		return res.status(500).json({ error: "playlist_load_failed" });
	}
});

app.post("/api/world/playlists/:id/save", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const found = await pool.query(`SELECT id, owner_user_id, title FROM world_playlists WHERE id=$1 AND (is_public=true OR owner_user_id=$2) LIMIT 1`, [id, req.user.id]);
		if (!found.rows[0]) return res.status(404).json({ error: "playlist_not_found" });
		const removed = await pool.query(`DELETE FROM world_saved_playlists WHERE user_id=$1 AND playlist_id=$2 RETURNING playlist_id`, [req.user.id, id]);
		let saved = false;
		if (!removed.rows[0]) {
			await pool.query(`INSERT INTO world_saved_playlists (user_id, playlist_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, id]);
			saved = true;
			await createNotification(found.rows[0].owner_user_id, {
				actorUserId: req.user.id, kind: "playlist_save", entityType: "playlist", entityId: id,
				title: `${await publicNameForUserId(req.user.id)} saved your playlist`, body: found.rows[0].title, href: "/app",
			});
		}
		return res.json({ ok: true, saved });
	} catch (e) {
		console.error("POST /api/world/playlists/:id/save ERROR", e);
		return res.status(500).json({ error: "playlist_save_failed" });
	}
});

app.post("/api/world/playlists/:id/tracks", requireAuth, async (req, res) => {
	try {
		const playlistId = String(req.params.id || "");
		const trackId = String(req.body?.trackId || "");
		const playlist = await pool.query(`SELECT id, title FROM world_playlists WHERE id=$1 AND owner_user_id=$2 LIMIT 1`, [playlistId, req.user.id]);
		if (!playlist.rows[0]) return res.status(404).json({ error: "playlist_not_found_or_not_owner" });
		const track = await pool.query(`SELECT id, owner_user_id, title FROM world_tracks WHERE id=$1 AND status='published' LIMIT 1`, [trackId]);
		if (!track.rows[0]) return res.status(404).json({ error: "track_not_found" });
		const pos = await pool.query(`SELECT COALESCE(max(position), -1) + 1 AS next FROM world_playlist_tracks WHERE playlist_id=$1`, [playlistId]);
		const inserted = await pool.query(`INSERT INTO world_playlist_tracks (playlist_id, track_id, added_by_user_id, position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING track_id`, [playlistId, trackId, req.user.id, Number(pos.rows[0]?.next || 0)]);
		if (inserted.rows[0]) {
			await pool.query(`UPDATE world_playlists SET updated_at=now() WHERE id=$1`, [playlistId]);
			await createNotification(track.rows[0].owner_user_id, {
				actorUserId: req.user.id, kind: "track_playlisted", entityType: "track", entityId: trackId,
				title: `${await publicNameForUserId(req.user.id)} added your song to a playlist`, body: `${track.rows[0].title} → ${playlist.rows[0].title}`, href: "/app",
			});
			await syncAchievementsForUser(track.rows[0].owner_user_id).catch(() => {});
		}
		return res.json({ ok: true, added: !!inserted.rows[0] });
	} catch (e) {
		console.error("POST /api/world/playlists/:id/tracks ERROR", e);
		return res.status(500).json({ error: "playlist_add_failed" });
	}
});

app.delete("/api/world/playlists/:id/tracks/:trackId", requireAuth, async (req, res) => {
	try {
		const playlistId = String(req.params.id || "");
		const own = await pool.query(`SELECT 1 FROM world_playlists WHERE id=$1 AND owner_user_id=$2`, [playlistId, req.user.id]);
		if (!own.rows[0]) return res.status(404).json({ error: "playlist_not_found_or_not_owner" });
		await pool.query(`DELETE FROM world_playlist_tracks WHERE playlist_id=$1 AND track_id=$2`, [playlistId, String(req.params.trackId || "")]);
		return res.json({ ok: true });
	} catch (e) {
		console.error("DELETE playlist track ERROR", e);
		return res.status(500).json({ error: "playlist_remove_failed" });
	}
});

app.post("/api/world/playlists/:id/reorder", requireAuth, async (req, res) => {
	const client = await pool.connect();
	try {
		const playlistId = String(req.params.id || "");
		const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds.map(String).slice(0, 500) : [];
		const own = await client.query(`SELECT 1 FROM world_playlists WHERE id=$1 AND owner_user_id=$2`, [playlistId, req.user.id]);
		if (!own.rows[0]) return res.status(404).json({ error: "playlist_not_found_or_not_owner" });
		await client.query("BEGIN");
		for (let i = 0; i < trackIds.length; i++) await client.query(`UPDATE world_playlist_tracks SET position=$3 WHERE playlist_id=$1 AND track_id=$2`, [playlistId, trackIds[i], i]);
		await client.query(`UPDATE world_playlists SET updated_at=now() WHERE id=$1`, [playlistId]);
		await client.query("COMMIT");
		return res.json({ ok: true });
	} catch (e) {
		await client.query("ROLLBACK").catch(() => {});
		console.error("POST playlist reorder ERROR", e);
		return res.status(500).json({ error: "playlist_reorder_failed" });
	} finally { client.release(); }
});

function commentRow(row, viewerId) {
	return {
		id: String(row.id), trackId: String(row.track_id), parentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
		userId: String(row.user_id), authorName: publicNameFromRow(row, "user_id", "display_name"), body: row.is_deleted ? "Comment deleted" : row.body,
		isDeleted: !!row.is_deleted, isPinned: !!row.is_pinned, likes: Number(row.likes || 0), likedByMe: !!row.liked_by_me,
		isMine: !!viewerId && String(viewerId) === String(row.user_id), canModerate: !!row.can_moderate, createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

app.get("/api/world/tracks/:id/comments", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const trackId = String(req.params.id || "");
		const { rows } = await pool.query(`
			SELECT c.*, u.display_name,
			       (SELECT count(*) FROM world_comment_likes l WHERE l.comment_id=c.id) AS likes,
			       EXISTS(SELECT 1 FROM world_comment_likes l WHERE l.comment_id=c.id AND l.user_id=$2::uuid) AS liked_by_me,
			       EXISTS(SELECT 1 FROM world_tracks t WHERE t.id=c.track_id AND t.owner_user_id=$2::uuid) AS can_moderate
			FROM world_track_comments c JOIN users u ON u.id=c.user_id WHERE c.track_id=$1
			ORDER BY c.is_pinned DESC, c.created_at ASC LIMIT 300`, [trackId, user?.id || null]);
		return res.json({ comments: rows.map((r) => commentRow(r, user?.id)) });
	} catch (e) {
		console.error("GET track comments ERROR", e);
		return res.status(500).json({ error: "comments_load_failed" });
	}
});

app.post("/api/world/tracks/:id/comments", requireAuth, async (req, res) => {
	try {
		const trackId = String(req.params.id || "");
		const body = String(req.body?.body || "").trim().slice(0, 2000);
		const parentId = req.body?.parentId ? String(req.body.parentId) : null;
		if (!body) return res.status(400).json({ error: "comment_required" });
		const tooFast = await pool.query(`SELECT 1 FROM world_track_comments WHERE user_id=$1 AND created_at > now() - interval '3 seconds' LIMIT 1`, [req.user.id]);
		if (tooFast.rows[0]) return res.status(429).json({ error: "comment_rate_limited" });
		const track = await pool.query(`SELECT t.id, t.title, t.owner_user_id FROM world_tracks t WHERE t.id=$1 AND t.status='published' LIMIT 1`, [trackId]);
		if (!track.rows[0]) return res.status(404).json({ error: "track_not_found" });
		let parent = null;
		if (parentId) {
			const p = await pool.query(`SELECT id, user_id FROM world_track_comments WHERE id=$1 AND track_id=$2 LIMIT 1`, [parentId, trackId]);
			if (!p.rows[0]) return res.status(400).json({ error: "invalid_parent_comment" });
			parent = p.rows[0];
		}
		const id = crypto.randomUUID();
		await pool.query(`INSERT INTO world_track_comments (id, track_id, user_id, parent_comment_id, body) VALUES ($1,$2,$3,$4,$5)`, [id, trackId, req.user.id, parentId, body]);
		const actor = await publicNameForUserId(req.user.id);
		await createNotification(track.rows[0].owner_user_id, {
			actorUserId: req.user.id, kind: parent ? "comment_reply" : "track_comment", entityType: "track", entityId: trackId,
			title: `${actor} commented on your song`, body: body.slice(0, 180), href: "/app",
		});
		if (parent && String(parent.user_id) !== String(track.rows[0].owner_user_id)) {
			await createNotification(parent.user_id, {
				actorUserId: req.user.id, kind: "comment_reply", entityType: "track", entityId: trackId,
				title: `${actor} replied to your comment`, body: body.slice(0, 180), href: "/app",
			});
		}
		await syncAchievementsForUser(req.user.id).catch(() => {});
		const row = await pool.query(`SELECT c.*, u.display_name, 0::bigint AS likes, false AS liked_by_me, EXISTS(SELECT 1 FROM world_tracks t WHERE t.id=c.track_id AND t.owner_user_id=$2) AS can_moderate FROM world_track_comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id, req.user.id]);
		return res.status(201).json({ ok: true, comment: commentRow(row.rows[0], req.user.id) });
	} catch (e) {
		console.error("POST track comment ERROR", e);
		return res.status(500).json({ error: "comment_create_failed" });
	}
});

app.post("/api/world/comments/:id/like", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const comment = await pool.query(`SELECT c.id, c.user_id, c.track_id, c.body FROM world_track_comments c WHERE c.id=$1 LIMIT 1`, [id]);
		if (!comment.rows[0]) return res.status(404).json({ error: "comment_not_found" });
		const removed = await pool.query(`DELETE FROM world_comment_likes WHERE comment_id=$1 AND user_id=$2 RETURNING comment_id`, [id, req.user.id]);
		let liked = false;
		if (!removed.rows[0]) {
			await pool.query(`INSERT INTO world_comment_likes (comment_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.user.id]);
			liked = true;
			await createNotification(comment.rows[0].user_id, {
				actorUserId: req.user.id, kind: "comment_like", entityType: "track", entityId: String(comment.rows[0].track_id),
				title: `${await publicNameForUserId(req.user.id)} liked your comment`, body: String(comment.rows[0].body || "").slice(0,180), href: "/app",
			});
		}
		const count = await pool.query(`SELECT count(*) FROM world_comment_likes WHERE comment_id=$1`, [id]);
		return res.json({ ok: true, liked, likes: Number(count.rows[0]?.count || 0) });
	} catch (e) { console.error("POST comment like ERROR", e); return res.status(500).json({ error: "comment_like_failed" }); }
});

app.post("/api/world/comments/:id/pin", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const found = await pool.query(`SELECT c.id,c.track_id,c.is_pinned FROM world_track_comments c JOIN world_tracks t ON t.id=c.track_id WHERE c.id=$1 AND t.owner_user_id=$2 LIMIT 1`, [id, req.user.id]);
		if (!found.rows[0]) return res.status(404).json({ error: "comment_not_found_or_not_moderator" });
		const next = !found.rows[0].is_pinned;
		if (next) await pool.query(`UPDATE world_track_comments SET is_pinned=false WHERE track_id=$1`, [found.rows[0].track_id]);
		await pool.query(`UPDATE world_track_comments SET is_pinned=$2, updated_at=now() WHERE id=$1`, [id, next]);
		return res.json({ ok: true, pinned: next });
	} catch (e) { console.error("POST comment pin ERROR", e); return res.status(500).json({ error: "comment_pin_failed" }); }
});

app.post("/api/world/comments/:id/report", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const reason = String(req.body?.reason || "reported").trim().slice(0, 500) || "reported";
		const found = await pool.query(`SELECT 1 FROM world_track_comments WHERE id=$1 LIMIT 1`, [id]);
		if (!found.rows[0]) return res.status(404).json({ error:"comment_not_found" });
		await pool.query(`INSERT INTO world_comment_reports (comment_id,user_id,reason) VALUES ($1,$2,$3) ON CONFLICT (comment_id,user_id) DO UPDATE SET reason=$3,created_at=now()`, [id, req.user.id, reason]);
		return res.json({ ok:true });
	} catch (e) { console.error("POST comment report ERROR", e); return res.status(500).json({ error:"comment_report_failed" }); }
});

app.delete("/api/world/comments/:id", requireAuth, async (req, res) => {
	try {
		const id = String(req.params.id || "");
		const found = await pool.query(`SELECT c.id,c.user_id,c.track_id,t.owner_user_id FROM world_track_comments c JOIN world_tracks t ON t.id=c.track_id WHERE c.id=$1 LIMIT 1`, [id]);
		if (!found.rows[0]) return res.status(404).json({ error: "comment_not_found" });
		if (String(found.rows[0].user_id) !== String(req.user.id) && String(found.rows[0].owner_user_id) !== String(req.user.id)) return res.status(403).json({ error: "forbidden" });
		await pool.query(`UPDATE world_track_comments SET body='', is_deleted=true, is_pinned=false, updated_at=now() WHERE id=$1`, [id]);
		return res.json({ ok: true });
	} catch (e) { console.error("DELETE comment ERROR", e); return res.status(500).json({ error: "comment_delete_failed" }); }
});

app.get("/api/library", requireAuth, async (req, res) => {
	try {
		const uid = req.user.id;
		const savedTracks = await pool.query(`
			SELECT t.*, r.artist_name, r.title AS album_name, r.release_type, (r.artwork_object_key IS NOT NULL) AS has_artwork,
			       COALESCE(t.owner_user_id=$1::uuid,false) AS is_owner,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=1) AS likes,
			       (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=-1) AS dislikes,
			       COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id=t.id AND x.user_id=$1::uuid),0) AS my_reaction,
			       true AS is_saved,
			       EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id=t.release_id AND s.user_id=$1::uuid) AS is_release_saved,
			       EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id=$1::uuid AND f.artist_owner_user_id=t.owner_user_id AND f.artist_name=r.artist_name) AS is_artist_followed,
			       (SELECT count(*) FROM world_track_comments c WHERE c.track_id=t.id AND c.is_deleted=false) AS comment_count
			FROM world_saved_tracks s JOIN world_tracks t ON t.id=s.track_id JOIN world_releases r ON r.id=t.release_id
			WHERE s.user_id=$1 AND t.status='published' ORDER BY s.created_at DESC`, [uid]);
		const releases = await pool.query(`
			SELECT r.*, (r.artwork_object_key IS NOT NULL) AS has_artwork,
			       (SELECT t.id FROM world_tracks t WHERE t.release_id=r.id AND t.status='published' ORDER BY t.track_number LIMIT 1) AS cover_track_id,
			       (SELECT count(*) FROM world_tracks t WHERE t.release_id=r.id AND t.status='published') AS track_count
			FROM world_saved_releases s JOIN world_releases r ON r.id=s.release_id WHERE s.user_id=$1 ORDER BY s.created_at DESC`, [uid]);
		const artists = await pool.query(`SELECT artist_owner_user_id, artist_name, created_at FROM world_followed_artists WHERE user_id=$1 ORDER BY created_at DESC`, [uid]);
		const ownPlaylists = await pool.query(`SELECT p.*, u.display_name AS owner_display_name, (SELECT count(*) FROM world_playlist_tracks pt WHERE pt.playlist_id=p.id) AS track_count, (SELECT count(*) FROM world_saved_playlists sp WHERE sp.playlist_id=p.id) AS save_count, (SELECT pt.track_id FROM world_playlist_tracks pt WHERE pt.playlist_id=p.id ORDER BY pt.position,pt.created_at LIMIT 1) AS cover_track_id, false AS is_saved, true AS is_owner FROM world_playlists p JOIN users u ON u.id=p.owner_user_id WHERE p.owner_user_id=$1 ORDER BY p.updated_at DESC`, [uid]);
		const savedPlaylists = await pool.query(`SELECT p.*, u.display_name AS owner_display_name, (SELECT count(*) FROM world_playlist_tracks pt WHERE pt.playlist_id=p.id) AS track_count, (SELECT count(*) FROM world_saved_playlists sp2 WHERE sp2.playlist_id=p.id) AS save_count, (SELECT pt.track_id FROM world_playlist_tracks pt WHERE pt.playlist_id=p.id ORDER BY pt.position,pt.created_at LIMIT 1) AS cover_track_id, true AS is_saved, COALESCE(p.owner_user_id=$1,false) AS is_owner FROM world_saved_playlists sp JOIN world_playlists p ON p.id=sp.playlist_id JOIN users u ON u.id=p.owner_user_id WHERE sp.user_id=$1 ORDER BY sp.created_at DESC`, [uid]);
		const uploads = await pool.query(`SELECT t.*, r.artist_name, r.title AS album_name, r.release_type, (r.artwork_object_key IS NOT NULL) AS has_artwork, true AS is_owner, (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=1) AS likes, (SELECT count(*) FROM world_track_reactions x WHERE x.track_id=t.id AND x.reaction=-1) AS dislikes, COALESCE((SELECT x.reaction FROM world_track_reactions x WHERE x.track_id=t.id AND x.user_id=$1),0) AS my_reaction, EXISTS(SELECT 1 FROM world_saved_tracks s WHERE s.track_id=t.id AND s.user_id=$1) AS is_saved, EXISTS(SELECT 1 FROM world_saved_releases s WHERE s.release_id=t.release_id AND s.user_id=$1) AS is_release_saved, EXISTS(SELECT 1 FROM world_followed_artists f WHERE f.user_id=$1 AND f.artist_owner_user_id=t.owner_user_id AND f.artist_name=r.artist_name) AS is_artist_followed, (SELECT count(*) FROM world_track_comments c WHERE c.track_id=t.id AND c.is_deleted=false) AS comment_count FROM world_tracks t JOIN world_releases r ON r.id=t.release_id WHERE t.owner_user_id=$1 AND t.status='published' ORDER BY t.published_at DESC`, [uid]);
		return res.json({
			tracks: savedTracks.rows.map(worldRow),
			releases: releases.rows.map((r) => ({ id:String(r.id), ownerUserId:String(r.owner_user_id), artistName:r.artist_name, title:r.title, releaseType:r.release_type, genre:r.genre||"Other", publishedAt:r.published_at, hasArtwork:!!r.has_artwork, coverTrackId:r.cover_track_id?String(r.cover_track_id):null, trackCount:Number(r.track_count||0), isSaved:true })),
			artists: artists.rows.map((r) => ({ ownerUserId:String(r.artist_owner_user_id), artistName:r.artist_name, followedAt:r.created_at })),
			playlists: ownPlaylists.rows.map(playlistRow), savedPlaylists: savedPlaylists.rows.map(playlistRow), uploads: uploads.rows.map(worldRow),
		});
	} catch (e) { console.error("GET /api/library ERROR", e); return res.status(500).json({ error: "library_load_failed" }); }
});

// -------------------- Notifications --------------------
app.get("/api/notifications", requireAuth, async (req, res) => {
	try {
		const limit = Math.max(1, Math.min(100, Number(req.query.limit || 40)));
		const { rows } = await pool.query(`SELECT id, kind, entity_type, entity_id, title, body, href, created_at, read_at FROM ysong_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [req.user.id, limit]);
		const unread = await pool.query(`SELECT count(*) FROM ysong_notifications WHERE user_id=$1 AND read_at IS NULL`, [req.user.id]);
		return res.json({ notifications: rows.map((r) => ({ id:String(r.id), kind:r.kind, entityType:r.entity_type, entityId:r.entity_id, title:r.title, body:r.body, href:r.href, createdAt:r.created_at, read:!!r.read_at })), unreadCount:Number(unread.rows[0]?.count||0) });
	} catch (e) { console.error("GET notifications ERROR", e); return res.status(500).json({ error: "notifications_load_failed" }); }
});

app.post("/api/notifications/read", requireAuth, async (req, res) => {
	try {
		const id = req.body?.id ? String(req.body.id) : null;
		if (id) await pool.query(`UPDATE ysong_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
		else await pool.query(`UPDATE ysong_notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND read_at IS NULL`, [req.user.id]);
		return res.json({ ok:true });
	} catch (e) { return res.status(500).json({ error:"notification_read_failed" }); }
});

app.get("/api/notifications/preferences", requireAuth, async (req, res) => {
	const { rows } = await pool.query(`SELECT email_enabled FROM ysong_notification_preferences WHERE user_id=$1`, [req.user.id]);
	return res.json({ emailEnabled: !!rows[0]?.email_enabled });
});

app.post("/api/notifications/preferences", requireAuth, async (req, res) => {
	const emailEnabled = !!req.body?.emailEnabled;
	await pool.query(`INSERT INTO ysong_notification_preferences (user_id,email_enabled) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET email_enabled=$2,updated_at=now()`, [req.user.id, emailEnabled]);
	return res.json({ ok:true, emailEnabled });
});

// -------------------- Achievements --------------------
app.get("/api/achievements", requireAuth, async (req, res) => {
	try {
		const stats = await getAchievementStats(req.user.id);
		const unlockedRows = await pool.query(`SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id=$1`, [req.user.id]);
		const unlocked = new Map(unlockedRows.rows.map((r) => [r.achievement_key, r.unlocked_at]));
		const achievements = ACHIEVEMENT_DEFINITIONS.map((def) => {
			const raw = Number(stats[def.metric] || 0);
			return { ...def, progress: Math.min(raw, def.target), rawProgress: raw, unlocked: unlocked.has(def.key), unlockedAt: unlocked.get(def.key) || null };
		});
		const points = achievements.filter((a) => a.unlocked).reduce((sum,a) => sum + a.points, 0);
		return res.json({ achievements, points, unlockedCount: achievements.filter((a)=>a.unlocked).length, totalCount: achievements.length, stats });
	} catch (e) { console.error("GET achievements ERROR", e); return res.status(500).json({ error:"achievements_load_failed" }); }
});

async function streamWorldObject(req, res, objectKey, { cache = "public, max-age=3600" } = {}) {
	const filePath = objectPath(objectKey);
	const stat = await fs.promises.stat(filePath);
	if (!stat.isFile()) return res.status(404).end();
	const meta = await readObjectMetadata(objectKey);
	res.setHeader("Content-Type", meta.contentType || "application/octet-stream");
	res.setHeader("Cache-Control", cache);
	res.setHeader("Accept-Ranges", "bytes");
	const range = req.headers.range;
	if (!range) {
		res.setHeader("Content-Length", stat.size);
		return fs.createReadStream(filePath).pipe(res);
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
	if (!match) return res.status(416).end();
	let start = match[1] ? Number(match[1]) : 0;
	let end = match[2] ? Number(match[2]) : stat.size - 1;
	if (!match[1] && match[2]) {
		const suffix = Number(match[2]);
		start = Math.max(0, stat.size - suffix);
		end = stat.size - 1;
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
		res.setHeader("Content-Range", `bytes */${stat.size}`);
		return res.status(416).end();
	}
	end = Math.min(end, stat.size - 1);
	res.status(206);
	res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
	res.setHeader("Content-Length", end - start + 1);
	return fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get("/api/world/playlists/:id/artwork", async (req, res) => {
	try {
		const user = verifyTokenString(authFromHeader(req));
		const { rows } = await pool.query(
			`SELECT artwork_object_key, is_public, owner_user_id FROM world_playlists WHERE id=$1 LIMIT 1`,
			[String(req.params.id || "")]
		);
		const playlist = rows[0];
		if (!playlist) return res.status(404).end();
		if (!playlist.is_public && (!user?.id || String(user.id) !== String(playlist.owner_user_id))) return res.status(404).end();
		if (!playlist.artwork_object_key) return res.status(404).end();
		return streamWorldObject(req, res, playlist.artwork_object_key, { cache: "private, max-age=3600" });
	} catch (e) {
		if (e?.code === "ENOENT") return res.status(404).end();
		console.error("GET playlist artwork ERROR", e);
		return res.status(500).end();
	}
});

app.get("/api/world/media/:trackId/:kind", async (req, res) => {
	try {
		const kind = String(req.params.kind || "");
		if (kind !== "audio" && kind !== "cover") return res.status(404).end();
		const { rows } = await pool.query(
			`SELECT t.audio_object_key, r.artwork_object_key
			 FROM world_tracks t JOIN world_releases r ON r.id = t.release_id
			 WHERE t.id = $1 AND t.status = 'published' LIMIT 1`,
			[String(req.params.trackId || "")]
		);
		if (!rows[0]) return res.status(404).end();
		const objectKey = kind === "audio" ? rows[0].audio_object_key : rows[0].artwork_object_key;
		if (!objectKey) return res.status(404).end();
		return streamWorldObject(req, res, objectKey, { cache: kind === "cover" ? "public, max-age=86400" : "public, max-age=3600" });
	} catch (e) {
		if (e?.code === "ENOENT") return res.status(404).end();
		console.error("GET /api/world/media ERROR", e);
		return res.status(500).end();
	}
});


// -------------------- MiniMax Music 3 local generation bridge --------------------
// YSong keeps the browser isolated from the heavyweight model server. Today this
// normally points at a local SGLang-Omni instance; later the exact same route can
// point at a cloud GPU service without changing Create Song or DAW project data.
function miniMaxMusicBase() {
	return String(process.env.MINIMAX_MUSIC_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

function miniMaxMusicModel() {
	return String(process.env.MINIMAX_MUSIC_MODEL || "minimax_ttm");
}

async function probeMiniMaxMusic(timeoutMs = 1400) {
	const baseUrl = miniMaxMusicBase();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// SGLang exposes the OpenAI-compatible model list. A non-2xx HTTP reply still
		// proves that the process is reachable; only network/timeout failures are offline.
		const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
		return { reachable: true, httpStatus: response.status };
	} catch (error) {
		return { reachable: false, message: error?.name === "AbortError" ? "MiniMax Music server timed out." : String(error?.message || error) };
	} finally {
		clearTimeout(timer);
	}
}

app.get("/api/music/status", async (_req, res) => {
	const baseUrl = miniMaxMusicBase();
	const model = miniMaxMusicModel();
	const probe = await probeMiniMaxMusic();
	return res.json({
		configured: Boolean(baseUrl),
		reachable: probe.reachable,
		baseUrl,
		model,
		message: probe.reachable ? undefined : (probe.message || "MiniMax Music 3 is not running."),
	});
});

const MusicGenerateSchema = z.object({
	lyrics: z.string().max(120000).default("[Instrumental]"),
	instructions: z.string().trim().min(1).max(80000),
	seed: z.number().int().min(0).max(2147483647).optional(),
	maxNewTokens: z.number().int().min(256).max(9000).optional(),
});

app.post("/api/music/generate", async (req, res) => {
	try {
		const body = MusicGenerateSchema.parse(req.body || {});
		const baseUrl = miniMaxMusicBase();
		const controller = new AbortController();
		// Full songs are non-streaming and can take a while on local GPUs.
		const timeoutMs = Math.max(60_000, Number(process.env.MINIMAX_MUSIC_TIMEOUT_MS || 20 * 60_000));
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response;
		try {
			response = await fetch(`${baseUrl}/v1/audio/speech`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					model: miniMaxMusicModel(),
					input: body.lyrics || "[Instrumental]",
					instructions: body.instructions,
					response_format: "wav",
					seed: body.seed ?? 7,
					max_new_tokens: body.maxNewTokens ?? 9000,
					stream: false,
				}),
			});
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return res.status(502).json({ error: "minimax_generation_failed", message: detail.slice(0, 1200) || `MiniMax returned HTTP ${response.status}` });
		}
		const audio = Buffer.from(await response.arrayBuffer());
		if (!audio.length) return res.status(502).json({ error: "minimax_empty_audio" });
		res.setHeader("Content-Type", response.headers.get("content-type") || "audio/wav");
		res.setHeader("Content-Length", String(audio.length));
		res.setHeader("Cache-Control", "no-store");
		return res.status(200).send(audio);
	} catch (error) {
		if (error?.name === "ZodError") return res.status(400).json({ error: "invalid_music_request", message: error.message });
		if (error?.name === "AbortError") return res.status(504).json({ error: "minimax_timeout", message: "MiniMax Music 3 generation timed out." });
		console.error("POST /api/music/generate ERROR", error);
		return res.status(502).json({ error: "minimax_unreachable", message: error?.message || "Could not reach MiniMax Music 3." });
	}
});

// Optional AI bridge. A configured OPENAI_API_KEY is enough to enable the local
// assistant; AI_PROVIDER can still explicitly disable/override it. Secrets remain
// backend-only and are never returned to the browser.
app.get("/api/ai/status", (_req, res) => {
	const configured = Boolean(process.env.OPENAI_API_KEY);
	const provider = String(process.env.AI_PROVIDER || (configured ? "openai" : "none")).toLowerCase();
	return res.json({ configured: configured && provider === "openai", provider, model: process.env.OPENAI_MODEL || "gpt-5.6" });
});

app.post("/chat", async (req, res) => {
	try {
		const provider = String(process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "none")).toLowerCase();
		if (provider !== "openai") {
			return res.json({
				reply: "YSong AI is not configured on this server yet.",
				local: true,
			});
		}
		if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "openai_key_missing" });
		const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
		const input = messages
			.filter((m) => m && typeof m.content === "string")
			.map((m) => ({
				role: m.role === "system" ? "developer" : (m.role === "assistant" ? "assistant" : "user"),
				content: m.content,
			}));
		if (!input.length) return res.status(400).json({ error: "messages_required" });

		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: process.env.OPENAI_MODEL || "gpt-5.6",
				input,
			}),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message = data?.error?.message || `OpenAI HTTP ${response.status}`;
			throw new Error(message);
		}
		const reply = Array.isArray(data?.output)
			? data.output
					.flatMap((item) => (item?.type === "message" && Array.isArray(item.content) ? item.content : []))
					.filter((part) => part?.type === "output_text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("")
			: "";
		return res.json({ reply: reply || "…" });
	} catch (e) {
		console.error("POST /chat ERROR", e);
		return res.status(500).json({ error: "ai_failed", message: e?.message });
	}
});

// -------------------- API: Chats --------------------
app.get("/api/chats", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
		const { rows } = await pool.query(
			`SELECT id, title, pinned, is_cloud_saved, created_at, updated_at
			FROM chats
			WHERE user_id = $1
			ORDER BY created_at DESC
			LIMIT $2`,
			[userId, limit]
		);
		const chats = rows.map((r) => ({
			id: r.id,
			title: r.title || "",
			pinned: r.pinned,
			isCloudSaved: r.is_cloud_saved,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));
		res.json({ chats });
	} catch (err) {
		console.error("GET /api/chats failed:", err);
		res.status(500).json({ error: "failed_to_fetch_chats" });
	}
});

app.get("/api/chats/:id/messages", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const chatId = String(req.params.id);

		// Make sure the chat belongs to this user
		const { rows: chatRows } = await pool.query(`SELECT id FROM chats WHERE id = $1 AND user_id = $2 LIMIT 1`, [
			chatId,
			userId,
		]);
		if (chatRows.length === 0) {
			return res.status(404).json({ error: "chat_not_found" });
		}

		const { rows } = await pool.query(
			`SELECT id, role, content, attachments_json, created_at
       FROM messages
       WHERE chat_id = $1
       ORDER BY created_at ASC`,
			[chatId]
		);

		const messages = rows.map((r) => ({
			id: r.id,
			role: r.role,
			content: r.content,
			attachments: r.attachments_json,
			createdAt: r.created_at,
		}));

		res.json({ messages });
	} catch (e) {
		console.error("GET /api/chats/:id/messages", e);
		res.status(500).json({ error: "server_error" });
	}
});

app.post("/api/chats/:id/messages", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const chatId = String(req.params.id);

		console.log("DEBUG /api/chats/:id/messages body:", req.body);

		const { role, content, attachments } = req.body ?? {};
		const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
		const hasContent = typeof content === "string" && content.length > 0;

		if (!role || (!hasContent && !hasAttachments)) {
			return res.status(400).json({ error: "missing_role_or_content" });
		}

		if (!["user", "assistant"].includes(role)) {
			console.log("DEBUG -> invalid_role");
			return res.status(400).json({ error: "invalid_role" });
		}

		const safeContent = typeof content === "string" ? content : "";

		const normalizedAttachments = Array.isArray(attachments)
			? attachments.map((a) => ({
					name: typeof a.name === "string" ? a.name.slice(0, 512) : "",
					size: typeof a.size === "number" ? a.size : 0,
					type: typeof a.type === "string" ? a.type.slice(0, 200) : "",
					objectKey: typeof a.objectKey === "string" ? a.objectKey.slice(0, 2048) : "",
					publicUrl: typeof a.publicUrl === "string" ? a.publicUrl.slice(0, 2048) : "",
			  }))
			: null;

		console.log("DEBUG -> normalizedAttachments param:", normalizedAttachments);

		const attachmentsJson = normalizedAttachments !== null ? JSON.stringify(normalizedAttachments) : null;

		// Make sure chat exists for this user
		const { rows: chatRows } = await pool.query(`SELECT id FROM chats WHERE id = $1 AND user_id = $2 LIMIT 1`, [
			chatId,
			userId,
		]);

		if (chatRows.length === 0) {
			console.log("DEBUG -> creating chat shell for id", chatId);
			await pool.query(
				`INSERT INTO chats (id, user_id, title, pinned, is_cloud_saved)
         VALUES ($1, $2, $3, FALSE, TRUE)`,
				[chatId, userId, ""]
			);
		}

		const { rows } = await pool.query(
			`INSERT INTO messages (chat_id, role, content, attachments_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id, role, content, attachments_json, created_at`,
			[chatId, role, safeContent, attachmentsJson]
		);

		const m = rows[0];
		console.log("DEBUG -> inserted message id", m.id);

		// Single response only
		return res.status(201).json({
			id: m.id,
			role: m.role,
			content: m.content,
			attachments: m.attachments_json,
			createdAt: m.created_at,
		});
	} catch (e) {
		console.error("POST /api/chats/:id/messages ERROR", e);
		console.error("Request body that failed:", req.body);
		return res.status(500).json({ error: "server_error" });
	}
});

// Delete a chat (and its messages)
app.post("/api/chats/delete", requireAuth, async (req, res) => {
	const userId = req.user.id;
	const { chatId } = req.body ?? {};

	if (!chatId) {
		return res.status(400).json({ error: "chatId is required" });
	}

	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		// Make sure this chat belongs to the user
		const { rows: chatRows } = await client.query("SELECT id FROM chats WHERE id = $1 AND user_id = $2 LIMIT 1", [
			chatId,
			userId,
		]);

		if (chatRows.length === 0) {
			await client.query("ROLLBACK");
			return res.status(404).json({ error: "chat_not_found" });
		}

		// Delete all messages for this chat
		// (no user_id column on messages; ownership is enforced via chats.user_id)
		await client.query("DELETE FROM messages WHERE chat_id = $1", [chatId]);

		// Delete the chat row itself
		await client.query("DELETE FROM chats WHERE id = $1 AND user_id = $2", [chatId, userId]);

		await client.query("COMMIT");
		res.json({ ok: true });
	} catch (err) {
		await client.query("ROLLBACK");
		console.error("Error deleting chat", err);
		res.status(500).json({ error: "failed_to_delete_chat" });
	} finally {
		client.release();
	}
});

// Rename a chat (used by auto title and manual rename)
app.post("/api/chats/rename", requireAuth, async (req, res) => {
	const userId = req.user.id;
	const { chatId, title } = req.body ?? {};

	if (!chatId || typeof chatId !== "string") {
		return res.status(400).json({ error: "chatId_required" });
	}

	// Normalize and cap title length
	let safeTitle = typeof title === "string" ? title.trim() : "";
	if (!safeTitle) {
		return res.status(400).json({ error: "title_required" });
	}
	if (safeTitle.length > 200) {
		safeTitle = safeTitle.slice(0, 200);
	}

	try {
		const result = await pool.query(
			`UPDATE chats
		SET title = $1,
			updated_at = now()
		WHERE id = $2
			AND user_id = $3`,
			[safeTitle, chatId, userId]
		);

		if (result.rowCount === 0) {
			return res.status(404).json({ error: "chat_not_found" });
		}

		res.json({ ok: true, title: safeTitle });
	} catch (err) {
		console.error("POST /api/chats/rename", err);
		res.status(500).json({ error: "server_error" });
	}
});

// Remove a single attachment from a message; if none left, set attachments_json = NULL
app.post("/api/messages/remove-attachment", requireAuth, async (req, res) => {
	try {
		const userId = req.user.id;
		const { messageId, objectKey } = req.body || {};

		if (!messageId || !objectKey) {
			return res.status(400).json({ error: "missing_messageId_or_objectKey" });
		}

		const sql = `
      WITH owned AS (
        SELECT m.id, m.attachments_json
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        WHERE m.id = $1
          AND c.user_id = $2
        LIMIT 1
      ),
      filtered AS (
        SELECT
          owned.id AS mid,
          jsonb_agg(elem) FILTER (WHERE elem->>'objectKey' <> $3) AS kept
        FROM owned
        LEFT JOIN LATERAL jsonb_array_elements(
          COALESCE(owned.attachments_json, '[]'::jsonb)
        ) elem ON TRUE
        GROUP BY owned.id
      )
      UPDATE messages m
      SET attachments_json = CASE
        WHEN filtered.kept IS NULL OR filtered.kept = '[]'::jsonb THEN NULL
        ELSE filtered.kept
      END
      FROM filtered
      WHERE m.id = filtered.mid
      RETURNING m.id;
    `;

		const result = await pool.query(sql, [messageId, userId, objectKey]);

		if (!result.rowCount) {
			return res.status(404).json({ error: "not_found" });
		}

		return res.json({ ok: true });
	} catch (e) {
		console.error("POST /api/messages/remove-attachment ERROR", e);
		return res.status(500).json({ error: "remove_attachment_failed" });
	}
});

// -------------------- Health --------------------
app.get("/", (_req, res) => res.send("ysong-api"));
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/healthz/db", async (_req, res) => {
	try {
		await pool.query("SELECT 1");
		res.json({ ok: true });
	} catch {
		res.status(500).json({ ok: false, error: "db" });
	}
});

// -------------------- Auth --------------------
// Signup. In LOCAL_MODE the account is verified immediately; no email service is required.
app.post("/auth/signup", async (req, res) => {
	try {
		const { email, password, name } = SignupSchema.parse(req.body);
		const normalized = email.trim().toLowerCase();
		if (name) {
			const taken = await pool.query(`SELECT 1 FROM users WHERE lower(display_name)=lower($1) AND email<>$2 LIMIT 1`, [name, normalized]);
			if (taken.rows[0]) return res.status(409).json({ error: "username_taken" });
		}
		const password_hash = await argon2.hash(password, { type: argon2.argon2id });

		const { rows: existingRows } = await pool.query(
			`SELECT id, email_verified_at FROM users WHERE email = $1 LIMIT 1`,
			[normalized]
		);

		if (existingRows.length > 0) {
			const existing = existingRows[0];
			if (existing.email_verified_at) return res.status(409).json({ error: "account_exists" });
			if (LOCAL_MODE) {
				await pool.query(
					`UPDATE users SET password_hash = $2, display_name = COALESCE(NULLIF($3,''), display_name), email_verified_at = now(), updated_at = now() WHERE id = $1`,
					[existing.id, password_hash, name || ""]
				);
				return res.json({ message: "Local account ready. You can log in now.", local: true });
			}

			await pool.query(
				`UPDATE email_verifications SET consumed_at = now()
				 WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
				[existing.id]
			);
			const raw = crypto.randomBytes(32).toString("hex");
			await pool.query(
				`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
				[existing.id, sha256(raw), minutesFromNow(30)]
			);
			await sendVerifyEmail(normalized, raw);
			return res.json({ message: "If an account exists, check your email for a verification link." });
		}

		const { rows: newRows } = await pool.query(
			`INSERT INTO users (email, password_hash, display_name, email_verified_at)
			 VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() ELSE NULL END)
			 RETURNING id, email, display_name`,
			[normalized, password_hash, name || null, LOCAL_MODE]
		);
		const user_id = newRows[0].id;
		await pool.query(`INSERT INTO ysong_achievement_state (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user_id]).catch(() => {});

		if (LOCAL_MODE) {
			return res.json({ message: "Local account ready. You can log in now.", local: true });
		}

		const raw = crypto.randomBytes(32).toString("hex");
		await pool.query(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
			[user_id, sha256(raw), minutesFromNow(30)]
		);
		await sendVerifyEmail(normalized, raw);
		return res.json({ message: "If an account exists, check your email for a verification link." });
	} catch (err) {
		console.error(err);
		return res.status(400).json({ error: "invalid_request" });
	}
});

// Accept ToS (stores timestamp + version)
app.post("/auth/accept-tos", requireAuth, async (req, res) => {
	try {
		await pool.query(
			`UPDATE users
			SET tos_accepted_at = now(),
				tos_accepted_version = $2,
				updated_at = now()
			WHERE id = $1`,
			[req.user.id, CURRENT_TOS_VERSION]
		);
		res.json({ ok: true, version: CURRENT_TOS_VERSION });
	} catch (e) {
		console.error(e);
		res.status(500).json({ ok: false });
	}
});

// Verify email
app.get("/auth/verify", async (req, res) => {
	const token = String(req.query.token || "");
	const email = String(req.query.email || "")
		.trim()
		.toLowerCase();
	if (!token || !email) return res.status(400).json({ error: "missing_params" });

	const token_hash = sha256(token);

	try {
		const { rows } = await pool.query(
			`SELECT ev.id, ev.consumed_at,
				u.id AS user_id, u.email_verified_at
			FROM email_verifications ev
			JOIN users u ON u.id = ev.user_id
			WHERE u.email = $1
			AND ev.token_hash = $2
			AND ev.expires_at > now()
			ORDER BY ev.created_at DESC
			LIMIT 1`,
			[email, token_hash]
		);

		if (rows.length === 0) {
			const { rows: urows } = await pool.query(`SELECT email_verified_at FROM users WHERE email = $1 LIMIT 1`, [
				email,
			]);
			if (urows.length && urows[0].email_verified_at) {
				return res.json({ ok: true });
			}
			return res.status(400).json({ ok: false, reason: "invalid_or_expired" });
		}

		const { user_id, id: ev_id, consumed_at, email_verified_at } = rows[0];
		if (email_verified_at) return res.json({ ok: true });

		await pool.query("UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1", [user_id]);
		if (!consumed_at) {
			await pool.query("UPDATE email_verifications SET consumed_at = now() WHERE id = $1", [ev_id]);
		}
		res.json({ ok: true });
	} catch (e) {
		console.error(e);
		res.status(500).json({ ok: false });
	}
});

// Login (returns ToS acceptance info)
app.post("/auth/login", async (req, res) => {
	try {
		const { email, password } = LoginSchema.parse(req.body);
		const normalized = email.trim().toLowerCase();

		const { rows } = await pool.query(
			`SELECT id, email, display_name, password_hash, email_verified_at,
				tos_accepted_at, tos_accepted_version
			FROM users
			WHERE email = $1
			LIMIT 1`,
			[normalized]
		);

		const invalid = () => res.status(401).json({ error: "invalid_credentials" });
		if (rows.length === 0) return invalid();

		const user = rows[0];
		if (!user.email_verified_at) {
			return res.status(403).json({ error: "email_unverified" });
		}

		const ok = await argon2.verify(user.password_hash, password);
		if (!ok) return invalid();

		const token = signToken(user);

		res.json({
			token,
			user: {
				id: user.id,
				email: user.email,
				displayName: String(user.display_name || "").trim() || fallbackPublicName(user.id),
				tosAcceptedAt: user.tos_accepted_at,
				tosAcceptedVersion: user.tos_accepted_version,
				currentTosVersion: CURRENT_TOS_VERSION,
			},
		});
	} catch (err) {
		if (err instanceof z.ZodError) {
			return res.status(400).json({ error: "invalid_request" });
		}
		console.error(err);
		res.status(500).json({ error: "server_error" });
	}
});

// Me (returns ToS acceptance info)
app.get("/auth/me", async (req, res) => {
	try {
		const raw = authFromHeader(req);
		if (!raw) return res.status(401).json({ error: "missing_token" });

		let payload;
		try {
			payload = jwt.verify(raw, process.env.JWT_SECRET);
		} catch {
			return res.status(401).json({ error: "invalid_token" });
		}

		const { rows } = await pool.query(
			`SELECT id, email, display_name, email_verified_at,
				tos_accepted_at, tos_accepted_version
			FROM users
			WHERE id = $1
			LIMIT 1`,
			[payload.uid]
		);
		if (rows.length === 0) return res.status(401).json({ error: "invalid_token" });

		res.json({
			ok: true,
			user: {
				id: rows[0].id,
				email: rows[0].email,
				displayName: String(rows[0].display_name || "").trim() || fallbackPublicName(rows[0].id),
				tosAcceptedAt: rows[0].tos_accepted_at,
				tosAcceptedVersion: rows[0].tos_accepted_version,
				currentTosVersion: CURRENT_TOS_VERSION,
			},
		});
	} catch (e) {
		console.error(e);
		res.status(500).json({ error: "server_error" });
	}
});

// ---------- Public profile identity ----------
app.post("/api/profile", requireAuth, async (req, res) => {
	try {
		const displayName = String(req.body?.displayName || "").trim().replace(/\s+/g, " ").slice(0, 80);
		if (!displayName) return res.status(400).json({ error: "username_required" });
		const taken = await pool.query(`SELECT 1 FROM users WHERE lower(display_name)=lower($1) AND id<>$2 LIMIT 1`, [displayName, req.user.id]);
		if (taken.rows[0]) return res.status(409).json({ error: "username_taken" });
		await pool.query(`UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1`, [req.user.id, displayName]);
		return res.json({ ok: true, displayName });
	} catch (e) {
		console.error("POST /api/profile ERROR", e);
		return res.status(500).json({ error: "profile_update_failed" });
	}
});

// ---------- Settings (GET) ----------
app.get("/api/settings", requireAuth, async (req, res) => {
	const userId = req.user.id;
	console.log("GET /api/settings for user", userId);

	const { rows } = await pool.query(
		`SELECT save_chats, theme, show_timestamps, compact_mode
         FROM user_settings
         WHERE user_id = $1`,
		[userId]
	);

	const row = rows[0] || {};
	console.log("  DB row:", row);

	const saveChats = row.save_chats ?? true;

	let theme = row.theme;
	if (theme !== "light" && theme !== "dark") {
		theme = "dark"; // kill "system" / garbage values on read
	}

	const showTimestamps =
		row.show_timestamps === undefined || row.show_timestamps === null ? true : !!row.show_timestamps;

	const compactMode = row.compact_mode === undefined || row.compact_mode === null ? false : !!row.compact_mode;

	const payload = {
		saveChats,
		theme,
		showTimestamps,
		compactMode,
	};

	console.log("  GET /api/settings response:", payload);
	res.json(payload);
});

// ---------- Settings (POST) ----------
app.post("/api/settings", requireAuth, async (req, res) => {
	const userId = req.user.id;

	console.log("POST /api/settings raw body:", req.body);

	let { saveChats, theme, showTimestamps, compactMode } = req.body || {};

	if (typeof saveChats !== "boolean") saveChats = null;

	if (theme !== "light" && theme !== "dark") {
		theme = null; // don't overwrite with junk, keep existing
	}

	if (typeof showTimestamps !== "boolean") showTimestamps = null;
	if (typeof compactMode !== "boolean") compactMode = null;

	console.log("POST /api/settings normalized:", {
		saveChats,
		theme,
		showTimestamps,
		compactMode,
	});

	await pool.query(
		`
        INSERT INTO user_settings (
            user_id,
            save_chats,
            theme,
            show_timestamps,
            compact_mode
        )
        VALUES (
            $1,
            COALESCE($2, true),
            COALESCE($3, 'dark'),
            COALESCE($4, true),
            COALESCE($5, false)
        )
        ON CONFLICT (user_id) DO UPDATE SET
            save_chats      = COALESCE($2, user_settings.save_chats),
            theme           = COALESCE($3, user_settings.theme),
            show_timestamps = COALESCE($4, user_settings.show_timestamps),
            compact_mode    = COALESCE($5, user_settings.compact_mode)
        `,
		[userId, saveChats, theme, showTimestamps, compactMode]
	);

	console.log("POST /api/settings completed for user", userId);
	res.json({ ok: true });
});

// GET layout -> { tabs: TabRecord[], activeId: string|null }
app.get("/api/ui/layout", requireAuth, async (req, res) => {
	try {
		const { rows } = await pool.query(`SELECT tabs, active_id FROM ui_layouts WHERE user_id = $1 LIMIT 1`, [
			req.user.id,
		]);
		if (!rows[0]) return res.json({ tabs: [], activeId: null });
		res.json({
			tabs: Array.isArray(rows[0].tabs) ? rows[0].tabs : [],
			activeId: rows[0].active_id,
		});
	} catch (e) {
		console.error("GET /api/ui/layout", e);
		res.status(500).json({ error: "server_error" });
	}
});

// POST layout (upsert)
// Expect body: { tabs: [{id,type,title,pinned?,payload?}, ...], activeId: string|null }
app.post("/api/ui/layout", requireAuth, async (req, res) => {
	try {
		const { tabs, activeId } = req.body ?? {};
		if (!Array.isArray(tabs)) return res.status(400).json({ error: "tabs_must_be_array" });
		await pool.query(
			`INSERT INTO ui_layouts (user_id, tabs, active_id, updated_at)
		VALUES ($1, $2::jsonb, $3::uuid, now())
		ON CONFLICT (user_id)
		DO UPDATE SET
			tabs      = EXCLUDED.tabs,
			active_id = EXCLUDED.active_id,
			updated_at = now()`,
			[req.user.id, JSON.stringify(tabs), activeId || null]
		);
		res.json({ ok: true });
	} catch (e) {
		console.error("POST /api/ui/layout", e);
		res.status(500).json({ error: "server_error" });
	}
});

// -------------------- Start --------------------
if (!process.env.DATABASE_URL) {
	console.error("❌ DATABASE_URL is not set");
	process.exit(1);
}
if (!process.env.JWT_SECRET) {
	console.error("❌ JWT_SECRET is not set");
	process.exit(1);
}

const port = process.env.PORT || 8081;

async function startServer() {
	await ensureWorldSchema();
	await initializeAchievementBaselines();
	app.listen(port, () => console.log(`YSong API listening on ${port}`));
}

startServer().catch((e) => {
	console.error("❌ YSong startup failed", e);
	process.exit(1);
});
