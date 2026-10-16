# Smart Link analytics privacy

New events retain campaign and destination IDs, event type, timestamp, verified attribution labels, referrer origin, and a coarse device class. The event writer stores empty visitor ID and user agent columns. Public event metadata is limited to verified attribution; arbitrary JSON is discarded. Fan records still retain consented email addresses for the fan feature, separately from analytics.

Campaign and destination clicks, daily counts, and attribution remain available. `referrers` and `deviceClasses` count clicks, with `unknown` for missing values. Referrer paths, query strings, and full user agents are unavailable. `regions` reports `unknown`: the API has no trusted geolocation source. Unique visitor and visitor counts are `null` because deduplication would require an identifier. Rates use event counts, not people.

Existing rows may contain visitor IDs, full user agents, and arbitrary event metadata from earlier versions. Deployment of this code does not erase those rows. An operator should plan a separately reviewed data cleanup and verify downstream consumers before deleting historical identifiers. No automatic event expiry or historical rollup exists yet; retention of aggregate event rows remains governed by database operations and policy.
