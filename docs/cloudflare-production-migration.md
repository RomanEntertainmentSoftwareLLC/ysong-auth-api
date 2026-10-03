# Cloudflare production migration — October 1, 2026

Storage wiring and Cloudflare API deployment are complete. The public workers.dev API passes health, Neon, login rejection, production CORS, and non-billable music status checks. Vercel production now uses the deployed Cloudflare API. Custom API DNS cutover, production Git commits/pushes, and Autopilot restart remain pending. The production completion gate has not passed.

## Verified current topology

| Component | Actual observed state |
| --- | --- |
| Frontend | `https://ysong.ai` redirects to `https://www.ysong.ai`; Vercel serves the site successfully. |
| API | The production bundle references `https://api.ysong.ai`. DNS points to `35.199.8.89`; public health requests timed out. No running production API was verified. |
| Legacy service | The production bundle also contains `https://ysong-api-173369253567.us-east1.run.app`; health/status requests returned 404. |
| DNS | Still authoritative on `ns-cloud-c1` through `ns-cloud-c4.googledomains.com`. Apex A is `76.76.21.21`; www CNAME is `d63375ffe596205e.vercel-dns-017.com`. No records or nameservers were changed. |
| Cloudflare | Workers Paid enabled by the owner. API deployed at https://ysong-auth-api.psychopathetica.workers.dev with one maximum Container instance. The ysong.ai zone and custom domain cutover remain pending. |
| R2 | `ysong-assets`: 17 objects after migration. Six original recovered objects are unchanged; nine local assets were copied under their original keys; two small validation objects were retained. |
| Database | Existing Neon/Postgres connection and route queries pass. No database records or object-key references were rewritten. |
| Email | The authorized saved key returns restricted_api_key: it has Sending access and cannot list domains. This does not establish an invalid key. Email delivery remains untested; no credential was replaced or email sent. |
| Native tools | Bridge/VST host, local audio.cpp/Music 3 weights, and heavy local audio services stay local. The auth API's existing Node/Express/native argon2/ffmpeg runtime stays in its Docker image. |

The old auth API GitHub workflow still deploys to a VM on main pushes. It was inspected and left unchanged. Do not push migration changes until the replacement is validated and the deployment workflow is deliberately switched away from the old VM. Google Workspace mail DNS remains required; it is separate from the retired API/storage hosting. The optional YouTube provider also retains its Google API dependency.

## Implemented wiring

- `LOCAL_MODE=0` makes R2 authoritative and refuses startup without R2 credentials. Default local mode retains disk storage.
- Upload, copy, delete, signed-url, and signed-file routes use R2 in production mode. Ownership and published-asset deletion guards remain intact.
- World, playlist, persona, and public Promotion media resolve the existing object keys through R2. Range reads and Content-Type are preserved.
- Native media processing materializes R2 inputs into temporary disk storage and uploads completed files through the existing metadata-writing hook.
- R2 metadata encodes Unicode-safe JSON. Copies preserve metadata, and missing objects map to existing not-found behavior.
- Cloudflare music still uses the existing binary-audio contract. Production generation now requires the existing JWT; the web helper sends that token. Local mode retains its existing generation behavior. Status verification does not generate music.
- `.dockerignore` excludes server environment files, local upload manifests, Wrangler state, and nested deployment dependencies.
- `cloudflare/` supplies an isolated, pinned Wrangler/Containers package, a singleton Node API container, and an explicit runtime environment allowlist. Deployment credentials are not forwarded into the application.
- The deployment helper requires server configuration, checks the Resend sender domain when permissions allow, recognizes restricted sending keys without rejecting them, passes selected runtime secrets through a temporary secrets file, redacts them from command output, and removes that temporary file afterward.
- The web environment example documents the intended Vercel production API origin, `https://api.ysong.ai`. Live Vercel settings were not changed to an unvalidated API.

The container configuration caps incoming uploads at 90 MB to fit the normal Cloudflare edge request limit. Local upload limits are unchanged. Existing larger R2 media remain readable; raising the production upload limit requires a separately supported upload path or plan limit.

## Validation results

| Check | Result |
| --- | --- |
| JavaScript syntax | Passed for changed API/deployment modules. |
| API tests with native ffmpeg | 71 tests passed in Docker using the latest source mounted read-only. The host-only suite previously failed its ffmpeg test because the host did not supply that binary. |
| Wrangler deployment dry run | Passed; worker bundled and final container image built. Nothing deployed. |
| Native argon2 and image secret exclusions | Passed. |
| Web TypeScript/Vite build | Passed; existing large-chunk warning remains. |
| Web tests | 91 passed. |
| Scoped web lint versus HEAD | No new diagnostics. Existing errors remain: musicGeneration.ts has 2, CreateSong.tsx has 10. Earlier full-repo lint reported 301 errors and 30 warnings. |
| Frontend secret-value scan | Passed against configured local server/web secrets. |
| Live production-mode route harness | Passed on loopback using actual R2, Neon, JWT verification, CORS, invalid-login rejection, upload, copy, signed download, signed file ranges, and World audio/cover reads. This is not public deployed API validation. |
| Recovered objects | All six signed range reads passed; original ETags remain unchanged. |
| Migrated local media | Nine copied assets verified by SHA-256; six are the previously missing World assets. No local files were moved or deleted. |
| R2 browser CORS | Signed GET range reads passed for localhost, 127.0.0.1, ysong.ai, and www.ysong.ai. Management API CORS inspection was denied; actual browser-origin behavior was verified instead. |
| Neon | SELECT 1 and actual route queries passed. |
| Resend | Delivery untested: the saved key has restricted sending access; the domains endpoint cannot validate sending-only keys. Public Google mail, Resend send SPF/MX, Resend DKIM, and DMARC records resolve and were preserved. |
| Git | Auth API/web/Bridge origins fetched; branches match upstream with no divergence. Autopilot has no origin remote. No canonical repo commit or push was performed. |
| Autopilot safety tests | 30 assertions passed using fake workers/disposable local repos. |
| Autopilot models | gpt-6-luna, gpt-6-sol, and gpt-6-astra are present in the installed catalog; no compatibility edits required. |
| Autopilot -Once / recurring | Neither launched: the requested production/Git prerequisite is unmet. No existing launcher instance or runner lock was active. |

The unchanged application dependency installation also reported 14 npm audit vulnerabilities (2 moderate, 11 high, 1 critical). No unrelated dependency upgrade was attempted during this migration.

Detailed local evidence is saved outside Git in `D:\YSong\.logs\cloudflare-production-audit.json` and `D:\YSong\.logs\cloudflare-storage-validation.json`. The latter records the two deliberately retained validation keys. No paid AI generation was performed and no R2 object was deleted.

## Files edited or created in this migration turn

In `D:\YSong\ysong-auth-api`:

- `.dockerignore`
- `.env.example`
- `.gitignore`
- `src/index.js`
- `src/storage/r2.js`
- `src/promotion/routes.mjs`
- `cloudflare/package.json`
- `cloudflare/package-lock.json`
- `cloudflare/wrangler.jsonc`
- `cloudflare/worker.js`
- `cloudflare/deploy.mjs`
- `test/storage_routes.test.mjs`
- `test/cloudflare_music.test.mjs`
- `docs/cloudflare-production-migration.md`

In `D:\YSong\ysong-web\ysong`:

- `.env.example`
- `src/lib/musicGeneration.ts`

The prior CreateSong.tsx Music 2.6 heading change remains intact. The existing auth package.json/package-lock.json R2 SDK edits remain intact. Existing Bridge and Autopilot dirty work was preserved; their source/config files were not edited in this turn. No retired Foreman/control-plane was operated on.

## Remaining owner actions and completion sequence

1. In Cloudflare, select the existing account, then Workers & Pages → Plans. Enable Workers Paid if its billing is approved. Open Workers & Pages to initialize the workers.dev subdomain. The browser dashboard is currently signed out; Wrangler CLI login already works.
2. Verify the sender domain through the Resend dashboard and perform an explicitly authorized delivery test when appropriate. The saved key returned restricted_api_key from the domains API because it has Sending access; replacement is not required on that evidence. No email was sent.
3. Obtain the complete authoritative DNS export from the current Squarespace/Google Domains zone. Public lookups above are only a subset. Prepare/import the full Cloudflare zone and preserve unfamiliar records, Vercel records, Google mail, Resend, and all verification records. Do not change nameservers yet.
4. After those prerequisites, use `npm ci` in the auth API and `cloudflare/`, then `npm run deploy` from `cloudflare/`. The checked-in configuration must remain secret-free; reuse production JWT/Neon/email settings rather than generating replacements.
5. Validate the new workers.dev HTTPS API: health, Neon, authenticated login/session, R2 routes, World media, CORS, email configuration, and non-billable music status. Verify any prior production session/JWT requirements before changing the public API origin.
6. Bind the validated API to `api.ysong.ai`. Configure Full (strict) TLS where proxying applies. Keep Vercel frontend hosting, Neon, and Resend. Finalize the full-zone import before any registrar nameserver action; only then provide the exact assigned Cloudflare nameservers for the owner to enter.
7. Confirm Vercel production `VITE_AUTH_API_URL` and `VITE_API_BASE_URL` are `https://api.ysong.ai`, and `VITE_LOCAL_MODE=0`; rebuild and revalidate both production domains. Only frontend-safe values belong there.
8. Deliberately migrate the old push-triggered VM deployment workflow, review exact migration diffs, fetch again, and commit/push only verified migration files to the existing main branches. Stop on divergence and preserve all unrelated work.
9. Run the existing `D:\YSong\ysong-autopilot\Start-YSongAutopilot.ps1 -Once`. Only if that cycle succeeds, start the same launcher normally in a hidden process and verify its single-instance lock. Keep all existing validation-before-push and forbidden-operation rules.

Production cutover and Autopilot restoration are not complete until this sequence passes.

## Public deployment follow-up

Deployed version e5ee509f-166f-4f55-8476-e2fc31d7a196. Public health and Neon health return 200; non-billable Cloudflare Music status is configured/reachable for minimax/music-2.6. Invalid login returns 401 invalid_credentials. Production origin CORS passes. Actual account login and email delivery remain untested. Vercel owner sign-in completed; production VITE_AUTH_API_URL and VITE_API_BASE_URL now point to the workers.dev API. Shared variables were split and Preview/Development values restored to https://api.ysong.ai. No DNS records, nameservers, canonical Git commits/pushes, or Autopilot launch changed.

Vercel deployment dpl_5un7BbX5RMR5KjFHVi1eFiPBez1R was built, inspected through authorized deployment protection, scanned for configured server secret values (none found), and promoted. Both https://ysong.ai/login and https://www.ysong.ai/login serve the Cloudflare-connected build with HTTP 200. Login CORS preflight returns 204 for www.ysong.ai. Owner was asked to refresh and retry their actual login. Nameservers and DNS records remain unchanged. Preview/Development environment values remain https://api.ysong.ai.

Owner screenshot confirms successful sign-in. World playback advanced silently because its visualizer-attached audio decks loaded cross-origin media without a CORS mode. Added crossOrigin=anonymous to both playback decks in ysong-web/src/components/WorldPlayer.tsx. Web build and 91 tests passed; affected track returned valid RIFF/WAVE bytes with HTTP 206 and production CORS. Deployed frontend dpl_4Jmpytnz6PeyG9RryGqu6F7XvUHN; public bundle confirms both corrected decks. Audible playback awaits owner reload/check.

Create Song follow-up: manifest assembly duplicated every pending track, causing the existing project contract to reject duplicate IDs. Corrected assembly in src/tabs/CreateSong.tsx to retain one completed entry per planned track and preserve stable session identity. Added tests/createSongGeneration.test.mjs executing the actual generation handler with mocked paid calls for first generation and partial retry. Web build, 93 tests, and diff checks passed. Deployed dpl_5RyC4XJjxzVYUhLZoTbmF8ujG1Xm; public bundle confirms corrected assembly. Read-only R2 check still finds 17 objects and no new audio saved since the prior audit. No paid generation or deletion performed by the agent.

Bridge follow-up: health GET worked while POST Open Bridge/VST3 load failed because the global device-sync fetch hook appended X-YSong-Client-Id to native Bridge requests; Bridge CORS permits only Content-Type. Scoped sync headers and mutation notifications to the configured YSong API origin and /api/ path in src/lib/devCrossWindowSync.ts. Added tests/deviceSyncFetch.test.mjs covering Bridge UI/instrument POSTs, YSong API mutation, and third-party requests. Build, 97 tests, and diff check passed. Deployed dpl_GdvWWNQtooXrioxn1AcrDoJ65aTh. Native Bridge health, CORS, and UI-open action checked successfully; no native Bridge code/configuration/restart required. Owner DAW audio confirmation remains pending.

Generated DAW follow-up: removed the reload override that changed E=17 to E=65; saved custom end markers now persist. Create Song saves approved blueprints and partial recovery synchronously before navigating to DAW and restores the blueprint on tab remount. Failed generated parts retain empty channels with their exact error, and saved older Create Song projects restore omitted failed channels from their persisted generation result. Successful saved vocals still import as audio clips. Changed src/tabs/DAW.tsx, src/tabs/CreateSong.tsx, tests/createSongGeneration.test.mjs; added tests/generatedDawImport.test.mjs. Build, 102 tests, and diff checks passed. Deployed dpl_22jWyqUCLWTydPFv2uGMGRMSNGDV; public bundle verifies blueprint persistence and failure message. Read-only R2 check remains 17 objects, no new saved vocals; actual Cloudflare generation failure reason awaits persisted/user-visible diagnostics, no paid calls made. Already-saved E=65 values are preserved; owner can move an affected old project's E to its intended end once. Existing lost in-memory blueprint cannot be reconstructed automatically from unsaved browser state.

Owner authorized overnight follow-up using this chat and PowerShell. Created active thread heartbeat continue-ysong-migration-overnight at 30-minute intervals, preserving original production/Git/Autopilot gates and stopping repeated unchanged blocker probing. Actual Autopilot remains unlaunched pending gates. Full authoritative DNS export and custom-domain cutover remain unresolved.
