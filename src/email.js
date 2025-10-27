import { Resend } from "resend";

const BRAND = "ysong";
const BRAND_URL = "https://www.ysong.ai";
const SUPPORT_EMAIL = "support@ysong.ai";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;
const APP_URL = process.env.APP_URL;

if (!RESEND_API_KEY || !EMAIL_FROM || !APP_URL) {
  throw new Error("Missing RESEND_API_KEY or EMAIL_FROM or APP_URL");
}

const resend = new Resend(RESEND_API_KEY);

function buildVerifyEmail(verifyUrl, toEmail) {
	const subject = `Verify your ${BRAND} account`;

	// --- Plaintext fallback (important for deliverability & accessibility) ---
	const text = [
		`Verify your ${BRAND} account`,
		``,
		`Thanks for signing up! Please confirm your email by opening this link:`,
		verifyUrl,
		``,
		`This link expires in ~30 minutes.`,
		``,
		`If you didn’t create this account, you can ignore this email.`,
		``,
		`${BRAND} • ${BRAND_URL}`,
	].join("\n");

	// --- HTML version (tables + inline CSS for maximum compatibility) ---
	const html = `
	<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8">
			<!-- Helps some clients pick the right theme colors -->
			<meta name="color-scheme" content="light dark">
			<meta name="supported-color-schemes" content="light dark">
			<!-- Preheader (the gray preview line next to subject in inbox) -->
			<title>${subject}</title>
			<style>
				/* Dark mode tweaks for clients that support it */
				@media (prefers-color-scheme: dark) {
				.bg-body { background:#0b0b0b !important; }
				.bg-card { background:#121212 !important; }
				.text-main { color:#f2f6fc !important; }
				.text-muted { color:#98a2b3 !important; }
				.btn { background:#0ea5e9 !important; }
				}
				/* Hover states for clients that allow it */
				a.btn:hover { filter:brightness(1.05); }
				a.link:hover { text-decoration:underline !important; }
			</style>
		</head>
		<body class="bg-body" style="margin:0;padding:0;background:#f5f7fb;">
			<!-- Full width background -->
			<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f7fb;" class="bg-body">
				<tr>
				<td align="center" style="padding:24px;">
					<!-- Card -->
					<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,0.08);" class="bg-card">
					<!-- Header / Logo -->
					<tr>
						<td align="center" style="padding:28px 24px 12px;">
						<a href="${BRAND_URL}" target="_blank" style="text-decoration:none;">
							<img src="https://www.ysong.ai/ysong-logo-with-title-darkmode-no-transparency.png" width="123" height="44" alt="${BRAND} logo" style="display:block;border:0;outline:none;">
						</a>
						</td>
					</tr>

					<!-- Title -->
					<tr>
						<td align="center" style="padding:4px 24px 0;">
						<h1 class="text-main" style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:24px;line-height:1.25;color:#0b1220;">
							Verify your ${BRAND} account
						</h1>
						</td>
					</tr>

					<!-- Copy -->
					<tr>
						<td align="center" style="padding:12px 32px 4px;">
						<p class="text-muted" style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#475467;">
							Tap the button below to confirm <strong style="color:inherit;">${toEmail}</strong>.  
							The link expires in about <strong>30 minutes</strong>.
						</p>
						</td>
					</tr>

					<!-- CTA Button -->
					<tr>
						<td align="center" style="padding:22px 24px 6px;">
						<a href="${verifyUrl}"
							class="btn"
							style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
									font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
									font-weight:600;font-size:15px;line-height:1;border-radius:10px;
									padding:14px 22px;">
							Verify my email
						</a>
						</td>
					</tr>

					<!-- Fallback link -->
					<tr>
						<td style="padding:18px 32px 6px;">
						<p class="text-muted" style="margin:0 0 8px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#667085;">
							If the button doesn’t work, copy and paste this URL into your browser:
						</p>
						<p style="margin:0;">
							<a href="${verifyUrl}" class="link"
							style="word-break:break-all;color:#0ea5e9;text-decoration:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;">
							${verifyUrl}
							</a>
						</p>
						</td>
					</tr>

					<!-- Divider -->
					<tr>
						<td style="padding:20px 24px 0;">
						<hr style="border:0;border-top:1px solid #e5e7eb;margin:0;">
						</td>
					</tr>

					<!-- Footer / Safety note -->
					<tr>
						<td style="padding:16px 24px 26px;">
						<p class="text-muted" style="margin:0 0 6px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a2b3;">
							Didn’t create this account? You can safely ignore this message.  
							Need help? <a href="mailto:${SUPPORT_EMAIL}" class="link" style="color:#0ea5e9;text-decoration:none;">Contact support</a>.
						</p>
						<p class="text-muted" style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a2b3;">
							© ${new Date().getFullYear()} ${BRAND}. All rights reserved.
						</p>
						</td>
					</tr>
					</table>

					<!-- Preheader spacer for nicer top/bottom breathing room -->
					<div style="height:24px;line-height:24px">&nbsp;</div>
				</td>
				</tr>
			</table>

			<!-- Hidden inbox preview text -->
			<div style="display:none;max-height:0;overflow:hidden;">
				Confirm your email to finish creating your ${BRAND} account. Link expires in ~30 minutes.
			</div>
		</body>
	</html>`;

	return { subject, html, text };
}

export async function sendVerifyEmail(toEmail, token) {
  const verifyUrl = `${process.env.APP_URL}/verify?token=${encodeURIComponent(
    token
  )}&email=${encodeURIComponent(toEmail)}`;

  const { subject, html, text } = buildVerifyEmail(verifyUrl, toEmail);

  await resend.emails.send({
    from: process.env.EMAIL_FROM,     // e.g. "YSong <noreply@ysong.ai>"
    to: toEmail,
    subject,
    html,
    text,                              // always include plaintext
  });
}
