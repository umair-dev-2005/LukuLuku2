// UI-phase placeholder only. The real blocklist (599 rows, LDNOOBW-based) lives server-side
// in public.profanity_dictionaries and is deliberately never exposed to clients —
// stream_mod_contains_profanity() is not callable by anon/authenticated, only used inside
// stream_mod_chat_gate() itself (see APP_SCHEMA_OVERVIEW.md, migration 05). This tiny local
// list exists only so the chat input can demo "a bad word gets blocked, never masked" before
// that RPC is wired in during this feature's ZegoCloud integration plan.
const PLACEHOLDER_BLOCKLIST = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick'];

export function containsProfanity(text: string): boolean {
  const normalized = text.toLowerCase();
  return PLACEHOLDER_BLOCKLIST.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(normalized));
}

// Mirrors the real stream_mod_chat_gate() slow-mode rule exactly, so the UI-phase demo
// behaves like the eventual server check: more than 3 messages in 5s puts the sender in
// slow mode for 60s at 1 message per 10s. 500-char cap also matches the gate's own limit.
export const CHAT_RATE_LIMIT = {
  windowMs: 5000,
  maxInWindow: 3,
  slowModeMs: 60000,
  slowModeIntervalMs: 10000,
  maxLength: 500,
} as const;
