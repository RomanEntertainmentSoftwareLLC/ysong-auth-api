# Content Rights Gate contract (v1)

`src/contentRights/gate.mjs` is the shared server-side contract for deciding whether a specific upload can proceed to **public**, **promoted**, or **monetized** use. Call `evaluateContentRightsGate(record, use)` at the action boundary and proceed only when `allowed` is `true`. The function has no network or database dependency, so World publishing, Promotion, and future monetization flows can use the same decision rules.

This contract records evidence and a workflow decision. Acoustic matches, reference matches, ISRCs, titles, artists, durations, provider records, and user statements can support a review; none proves legal copyright ownership. `clear` means the evidence package has a current approval for the requested use, not that YSong has established ownership or granted a legal license.

## Record

`ContentRightsRecordSchema` validates `{ evidence, review }`:

- `evidence.subject`: owner user ID and upload object key. Store and load this record with the owned upload; verify the authenticated owner when reading or writing it.
- `evidence.claimedRelease`: nullable claimed ISRC, title, artist, and duration. These are claims, not verified identity. ISRC is the normalized 12-character form used by World.
- `evidence.matches`: acoustic or reference results with outcome (`possible`, `confirmed`, `no_match`), reference ID, optional confidence, and provenance.
- `evidence.identitySupport`: per-field ISRC, title, artist, or duration result (`supports`, `conflicts`, `inconclusive`) and provenance.
- `evidence.sources`: additional source/provider provenance. Every provenance entry has a provider, source type, optional provider reference ID, and observation time. Do not put provider credentials or raw response bodies in this contract.
- `evidence.attestation`: nullable owner statement version, covered uses, assertion time, and optional revocation time. A statement covers only listed uses.
- `review`: nullable `pending`, `approved`, or `rejected` decision, covered uses, reviewer identity and decision time for final decisions, and `evidenceHash`. The hash is produced by `contentRightsEvidenceHash(evidence)` when the reviewer sees the evidence package. Review decisions must be written by a trusted server-side review workflow, never accepted from an upload request.

The record may be stored as JSON alongside an upload or in a future shared rights table. This module defines the validated shape and evaluation only; it does not introduce a provider integration or a persistence migration.

## Decision states

| State | When returned | Action |
| --- | --- | --- |
| `clear` | Current approved review covers the use and the owner has a live attestation for it. | May proceed for this use. |
| `needs-review` | A possible/confirmed match, conflicting identity evidence, pending/stale/out-of-scope review, or approval without a live attestation needs human attention. | Hold the action. |
| `blocked` | A current rejected review covers the use. | Hold the action. |
| `unverified` | No current review or attestation establishes a clear decision and no review signal is present. | Hold the action. |

The result contains `{ state, allowed, use, reason, evidenceHash }`; `allowed` is true only for `clear`. A changed evidence package produces a different hash and makes an earlier review stale. Use-specific decisions prevent an approval for public posting from silently authorizing ads or monetization.

Existing World `rightsConfirmed` and Ads `rightsConfirmed` acknowledgements remain separate legacy inputs until those action boundaries store and evaluate this shared record. Do not treat either acknowledgement, an ISRC, or a reference match as an automatic `clear` decision. Adoption at each boundary needs a trusted review path and persisted records; simply requiring this contract now would hold every existing upload without a way to clear it.
