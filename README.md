# YSong Local API

This is the local Node/Express backend bundled with **YSong Local**.

Use the root-level `README-LOCAL.md` and `START-YSONG.bat` for setup. In local mode:

- PostgreSQL runs locally through Docker.
- uploads are stored under `../data/uploads`.
- email verification is bypassed.
- AI is disabled unless explicitly configured.
- Google Cloud Storage and Neon are not required.

## Pexels stock videos

Set `PEXELS_API_KEY` in the server environment (see `.env.example`). The key stays server-side. Authenticated clients can search `GET /api/tools/promotion/stock/videos?q=...` with optional `orientation` (`portrait`, `landscape`, `square`), `size` (`small`, `medium`, `large`), `page`, `perPage`, and `locale`. Portrait and medium are the defaults. Results include preview URLs, available MP4 file IDs, dimensions, attribution, and pagination. Use `POST /api/tools/promotion/stock/videos/import` with `{ "provider": "pexels", "id": "...", "fileId": "..." }` to import a chosen file. A Pexels rate limit returns HTTP 429 with `Retry-After`.
