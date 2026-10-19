# Rooms roles and controls

The API stores `owner`, `admin`, and `member` roles. An admin is the room host; a member is a participant. The room creator is the owner and cannot leave or be removed. Only the owner can delete the room or assign and revoke host status. Hosts can invite members, remove participants, mute participants, manage personas, and control venue settings. Participants can join public rooms, leave, send messages while unmuted, request a mute, and set their own recording consent.

Private room membership is granted by an owner or host through the invite endpoint. Public room membership is granted by the join endpoint. Neither endpoint accepts a caller supplied role. Hosts cannot remove or mute an owner or another host. Removal clears a removed member's venue host assignment.

Every member starts with recording consent set to false. Members can only set their own consent. An owner or host can enable the room's recording flag only while all current members consent. A withdrawal of consent, a new public join, or an invite disables the flag. This flag is API state; it does not itself capture or store audio. Any recorder must check the flag and consent before starting and stop immediately when the flag becomes false.

`POST /api/rooms/:id/members/:userId/role` accepts `admin` or `member` and requires the owner. `POST /api/rooms/:id/members/:userId/remove` and `/mute` require an owner or host; mute accepts a boolean `muted`. `POST /api/rooms/:id/mute-request` records the caller's request for hosts. `POST /api/rooms/:id/recording-consent` accepts a boolean `consent`. `POST /api/rooms/:id/recording` accepts a boolean `enabled` and requires an owner or host.
