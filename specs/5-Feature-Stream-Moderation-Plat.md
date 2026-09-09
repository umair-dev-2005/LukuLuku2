# Feature 5: Stream Moderation, Platform Safety & User Reporting

Depends on Feature 1 (`live_streams`, `live_stream_viewer_sessions`), Feature 2 (`live_chat_messages`), and Feature 4 (`profiles`). Realtime transport: ZegoCloud in-room signaling or Supabase Realtime channel scoped per `live_stream_id` (mirrors Feature 2).

This doc covers: host and admin moderation controls (mute, kick, ban), synchronized moderation alerts, automated profanity filtering, anti-spam rate limiting (Slow Mode), and in-stream user reporting.

---

## Flow (behavior only)

1. **Moderator Assignment & Access**: The broadcaster (host) or platform admin can assign viewers as room moderators. Assigned moderators get access to a real-time moderation toolbar overlay during the stream.
2. **Host & Admin Control Actions**:
   * **Mute Chat User**: Host/Mod selects a user to mute for a set duration (e.g., 5 or 10 minutes). The user stays in the stream but their sent messages are rejected by the server/realtime channel.
   * **Kick Viewer**: Host/Mod kicks a user from the room. The viewer's media stream/playback is cut immediately, their active `live_stream_viewer_sessions` row is closed with `leave_reason='kicked'`, and they are redirected out of the stream.
   * **Issue Ban**: Host/Mod issues a temporary or permanent account ban. The user is kicked from the current stream and prevented from re-entering any future streams for the ban duration.
3. **Synchronized Moderation Alerts**: Whenever a host or moderator takes a moderation action (mute, kick, ban), a system-generated alert banner is broadcast across the room's realtime channel so all participants and co-moderators see the action in real time (e.g., "User XYZ was muted by Moderator ABC"), preventing duplicate enforcement.
4. **Automated Profanity Filtering**:
   * Before a message from `live_chat_messages` is rendered in public chat, it passes through a keyword filtering engine backed by a pre-built profanity dictionary (`profanity_dictionaries`).
   * Messages containing blocked keywords are either automatically masked (e.g., replacing words with `***`) or rejected before broadcast, marked as `moderation_status='hidden'` or `'deleted'`.
5. **Anti-Spam Rate Limiting (Slow Mode)**:
   * The system monitors chat frequency per user using an in-memory/Edge cooldown window.
   * If a user sends messages faster than the allowed rate (e.g., more than 3 messages in 5 seconds), an automatic "Slow Mode" cooldown is applied to that specific user (e.g., restricting them to 1 message every 10 seconds) rather than instantly banning them.
6. **In-Stream User Reporting**: Viewers can tap a report button on any stream or chat message to report rule-breaking content or broadcasters. The report records the reported stream, offender, reason category, and optional notes into `stream_reports` for administrative review.

---

## Entities

### `stream_moderators` — maps users who have moderator privileges for a specific stream/channel
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| live_stream_id | uuid FK → live_streams | null if global platform moderator |
| user_id | uuid FK → profiles | the assigned moderator |
| assigned_by_user_id | uuid FK → profiles | the broadcaster or admin who granted the role |
| created_at | timestamptz | |

### `stream_moderation_actions` — permanent audit log of all manual host/mod enforcement actions
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| live_stream_id | uuid FK → live_streams | |
| moderator_user_id | uuid FK → profiles | host or mod taking the action |
| target_user_id | uuid FK → profiles | user receiving the penalty |
| action_type | enum: mute, kick, ban | |
| duration_seconds | int null | duration for temporary mutes/bans; null if permanent ban or kick |
| reason | text null | optional reason note from moderator |
| created_at | timestamptz | |

### `user_punishments` — active enforcement state (mutes/bans) per user
Enforced at the client/API gateway level before processing chat messages or stream joins.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → profiles | punished user |
| live_stream_id | uuid FK → live_streams, nullable | null = platform-wide ban; set = stream-specific mute/ban |
| punishment_type | enum: mute, stream_ban, platform_ban | |
| expires_at | timestamptz null | null if permanent |
| created_at | timestamptz | |

### `profanity_dictionaries` — static/managed dictionary table for automated content filtering
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| word_or_pattern | text | forbidden word or pattern |
| category | enum: profanity, hate_speech, spam_link, sexual_content | |
| is_active | boolean default true | toggle rule active/inactive |

### `stream_reports` — durable user-submitted reports for admin review
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| reporter_user_id | uuid FK → profiles | user submitting the flag |
| live_stream_id | uuid FK → live_streams | reported stream |
| reported_user_id | uuid FK → profiles, nullable | optional offender target (broadcaster or specific viewer) |
| message_id | uuid FK → live_chat_messages, nullable | optional specific message linked to report |
| reason_category | enum: inappropriate_content, harassment, spam, violence, copyright, other | |
| details | text null | optional viewer description |
| status | enum: pending, reviewed, resolved, dismissed, default pending | admin review workflow state |
| created_at | timestamptz | |

---

## ZegoCloud / Realtime Mapping
* **Kicking**: Taking a `kick` action triggers a targeted kick/revoke token signal via ZegoCloud SDK/Realtime server APIs to immediately terminate the target user's RTC stream connection and close their session row with `leave_reason='kicked'`.
* **Muting/System Alerts**: Mute events and system alert banners are pushed over the stream's existing ZegoCloud/Supabase realtime channel so all UI clients instantly show the system alert banner without reloading.

---

## Real-time vs Historical

1. **Real-time only (no DB write per event)**:
   * Anti-spam rate limiting enforcement — calculated using transient/in-memory rate counters per client/socket session.
   * Profanity filter match evaluation — evaluated synchronously at message submission before inserting into `live_chat_messages`.
   * Live broadcast banner notifications — transient system alerts pushed directly to channel viewers.
2. **Historical / durable**:
   * `stream_moderators` — persistent assignment of moderator roles.
   * `stream_moderation_actions` — immutable moderation audit log for legal and administrative accountability.
   * `user_punishments` — durable active restriction records checked upon chat submission or stream re-entry.
   * `stream_reports` — permanent report queue for backend/admin portal review.

---

## Actions/events → writes

| Event | Trigger | Writes |
|---|---|---|
| Moderator assigned | Broadcaster grants mod role | INSERT `stream_moderators` |
| Mute action taken | Host/Mod mutes user | INSERT `stream_moderation_actions` (action_type='mute'); INSERT `user_punishments` (punishment_type='mute'); broadcast system alert |
| Kick action taken | Host/Mod kicks viewer | INSERT `stream_moderation_actions` (action_type='kick'); UPDATE `live_stream_viewer_sessions` (`left_at=now()`, `leave_reason='kicked'`); trigger RTC kick signal; broadcast system alert |
| Ban action taken | Host/Mod bans user | INSERT `stream_moderation_actions` (action_type='ban'); INSERT `user_punishments` (punishment_type='stream_ban' or 'platform_ban'); UPDATE `live_stream_viewer_sessions` (`leave_reason='kicked'`); trigger RTC kick signal |
| Profanity detected | Viewer submits forbidden text | Reject message OR INSERT `live_chat_messages` (`moderation_status='hidden'`/`'deleted'`) |
| Report submitted | Viewer flags stream/user | INSERT `stream_reports` (status='pending') |
| Report processed | Admin updates report | UPDATE `stream_reports` (`status='resolved'` or `'dismissed'`) |

---

## Relationships

* `live_streams` 1→many `stream_moderators`.
* `live_streams` 1→many `stream_moderation_actions`.
* `live_streams` 1→many `stream_reports`.
* `profiles` 1→many `stream_moderation_actions` (as moderator and separately as target).
* `profiles` 1→many `user_punishments`.
* `profiles` 1→many `stream_reports` (as reporter and separately as reported user).
* `live_chat_messages` 1→many `stream_reports` (optional link to flagged chat message).

---

## Open questions for client

1. **Push Notifications**: Should account/IP ban alerts be delivered via Push Notifications when the user is offline, or only as in-app system alerts when active?
2. **Global vs. Local Mods**: Are assigned moderators limited purely to that specific `live_stream_id`, or does moderator status persist across all streams hosted by the same broadcaster channel?
3. **Profanity Action**: Should messages containing profanity be blocked entirely with an error to the sender, or silently masked with asterisks (`***`) and delivered to chat?