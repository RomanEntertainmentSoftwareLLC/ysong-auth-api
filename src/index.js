import 'dotenv/config';
import express from "express";
import cors from "cors";
import crypto from "crypto";
import argon2 from "argon2";
import { z } from "zod";
import { pool } from "./db.js";
import { sendVerifyEmail } from "./email.js";
import jwt from "jsonwebtoken";

const app = express();

// ---- ToS version (server-driven) ----
const CURRENT_TOS_VERSION = process.env.TOS_VERSION || "2025-11-05-v1";

// -------------------- CORS --------------------
const allowedOrigins = [
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"https://ysong.ai",
	"https://www.ysong.ai",
	/\.vercel\.app$/,
];

const corsOptions = {
	origin(origin, cb) {
		if (!origin) return cb(null, true);
		const ok = allowedOrigins.some(o => o instanceof RegExp ? o.test(origin) : o === origin);
		return ok ? cb(null, true) : cb(new Error("Not allowed by CORS"));
	},
	methods: ["GET", "POST", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization"],
	credentials: true,
	maxAge: 86400,
};

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

app.set("trust proxy", 1);
app.use((_, res, next) => { res.header("Vary", "Origin"); next(); });
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// -------------------- Helpers --------------------
const SignupSchema = z.object({
	email: z.string().email().max(320),
	password: z.string().min(8).max(200),
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
	return jwt.sign(
		{ uid: user.id, email: user.email },
		process.env.JWT_SECRET,
		{ algorithm: "HS256", expiresIn: "7d" }
	);
}
function authFromHeader(req) {
	const h = req.headers.authorization || "";
	const m = /^Bearer (.+)$/.exec(h);
	return m ? m[1] : null;
}

// -------------------- API: Chats (read-only for now) --------------------
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
		const chats = rows.map(r => ({
		id: r.id,
		title: r.title || "",
		messages: [],
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
// Signup (with email verification bootstrap)
app.post("/auth/signup", async (req, res) => {
	try {
		const { email, password } = SignupSchema.parse(req.body);
		const normalized = email.trim().toLowerCase();
		const password_hash = await argon2.hash(password, { type: argon2.argon2id });

		const { rows: existingRows } = await pool.query(
		`SELECT id, email_verified_at FROM users WHERE email = $1 LIMIT 1`,
		[normalized]
		);

		if (existingRows.length > 0) {
		const existing = existingRows[0];
		if (existing.email_verified_at) {
			return res.status(409).json({ error: "account_exists" });
		}
		await pool.query(
			`UPDATE email_verifications
				SET consumed_at = now()
			WHERE user_id = $1
				AND consumed_at IS NULL
				AND expires_at > now()`,
			[existing.id]
		);

		const raw = crypto.randomBytes(32).toString("hex");
		const token_hash = sha256(raw);
		const expires_at = minutesFromNow(30);

		await pool.query(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at)
			VALUES ($1, $2, $3)`,
			[existing.id, token_hash, expires_at]
		);

		await sendVerifyEmail(normalized, raw);
		return res.json({
			message: "If an account exists, check your email for a verification link.",
		});
		}

		const { rows: newRows } = await pool.query(
		`INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id, email`,
		[normalized, password_hash]
		);
		const user_id = newRows[0].id;

		const raw = crypto.randomBytes(32).toString("hex");
		const token_hash = sha256(raw);
		const expires_at = minutesFromNow(30);

		await pool.query(
		`INSERT INTO email_verifications (user_id, token_hash, expires_at)
		VALUES ($1, $2, $3)`,
		[user_id, token_hash, expires_at]
		);

		await sendVerifyEmail(normalized, raw);

		res.json({
		message: "If an account exists, check your email for a verification link.",
		});
	} catch (err) {
		console.error(err);
		res.status(400).json({ error: "invalid_request" });
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
	const email = String(req.query.email || "").trim().toLowerCase();
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
		const { rows: urows } = await pool.query(
			`SELECT email_verified_at FROM users WHERE email = $1 LIMIT 1`,
			[email]
		);
		if (urows.length && urows[0].email_verified_at) {
			return res.json({ ok: true });
		}
		return res.status(400).json({ ok: false, reason: "invalid_or_expired" });
		}

		const { user_id, id: ev_id, consumed_at, email_verified_at } = rows[0];
		if (email_verified_at) return res.json({ ok: true });

		await pool.query(
		"UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1",
		[user_id]
		);
		if (!consumed_at) {
		await pool.query(
			"UPDATE email_verifications SET consumed_at = now() WHERE id = $1",
			[ev_id]
		);
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
		`SELECT id, email, password_hash, email_verified_at,
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
		`SELECT id, email, email_verified_at,
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


// GET settings  -> { saveChats:boolean, theme:'light'|'dark'|'system' }
app.get("/api/settings", requireAuth, async (req, res) => {
	try {
		const { rows } = await pool.query(
		`SELECT save_chats, theme FROM user_settings WHERE user_id = $1 LIMIT 1`,
		[req.user.id]
		);
		if (!rows[0]) return res.json({ saveChats: true, theme: "system" }); // defaults
		res.json({ saveChats: rows[0].save_chats, theme: rows[0].theme || "system" });
	} catch (e) {
		console.error("GET /api/settings", e);
		res.status(500).json({ error: "server_error" });
	}
});

// POST settings (upsert)
app.post("/api/settings", requireAuth, async (req, res) => {
	try {
		const { saveChats, theme } = req.body ?? {};
		if (theme && !["light", "dark", "system"].includes(theme)) {
		return res.status(400).json({ error: "invalid_theme" });
		}
		await pool.query(
		`INSERT INTO user_settings (user_id, save_chats, theme, updated_at)
		VALUES ($1, COALESCE($2,true), COALESCE($3,'system'), now())
		ON CONFLICT (user_id)
		DO UPDATE SET
			save_chats = COALESCE(EXCLUDED.save_chats, user_settings.save_chats),
			theme      = COALESCE(EXCLUDED.theme, user_settings.theme),
			updated_at = now()`,
		[req.user.id, saveChats, theme]
		);
		res.json({ ok: true });
	} catch (e) {
		console.error("POST /api/settings", e);
		res.status(500).json({ error: "server_error" });
	}
});

// GET layout -> { tabs: TabRecord[], activeId: string|null }
app.get("/api/ui/layout", requireAuth, async (req, res) => {
	try {
		const { rows } = await pool.query(
		`SELECT tabs, active_id FROM ui_layouts WHERE user_id = $1 LIMIT 1`,
		[req.user.id]
		);
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
app.listen(port, () => console.log(`YSong API listening on ${port}`));
