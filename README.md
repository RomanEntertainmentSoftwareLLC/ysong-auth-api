# YSong Local API

This is the local Node/Express backend bundled with **YSong Local**.

Use the root-level `README-LOCAL.md` and `START-YSONG.bat` for setup. In local mode:

- PostgreSQL runs locally through Docker.
- uploads are stored under `../data/uploads`.
- email verification is bypassed.
- AI is disabled unless explicitly configured.
- Google Cloud Storage and Neon are not required.
