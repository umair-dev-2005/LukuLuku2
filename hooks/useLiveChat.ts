import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { containsProfanity, CHAT_RATE_LIMIT } from '../lib/liveChatModeration';
import { getCurrentSupabaseUserId } from '../lib/auth';

export type ChatMessageType = 'chat' | 'system';

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  senderId: string;
  name: string;
  text: string;
  avatarUrl?: string | null;
}

// A viewer joining is shown as a floating toast over the chat, not a line in it (see
// LiveJoinToast.tsx) — this is that toast's data, separate from ChatMessage entirely.
export interface JoinToast {
  id: string;
  name: string;
}

// A message's role is derived at display time from `hostSenderId` / `moderatorSenderIds`
// (not stored on the message itself) — so promoting/demoting someone, or the host's id
// resolving after the initial render, instantly relabels every message they've already
// sent without having to rewrite history.
export type SenderRole = 'viewer' | 'moderator' | 'host';

export type ModerationAction = 'mute' | 'kick' | 'ban' | 'report' | 'promote' | 'demote' | 'pin' | 'unpin';

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `msg-${Date.now()}-${idCounter}`;
}

// Small, fixed pool used only to make the chat feel alive in the UI phase — not real
// viewers. Kept short on purpose (CLAUDE.md: minimal dummy data, not a big fake dataset).
const MOCK_VIEWERS = ['Lisa', 'petermorales', 'Sara arora', 'Alex thomas', 'nadia_k'];
const MOCK_MESSAGES = ['Nice 👏', 'Lovely Song ❤️', 'Keep it up! 👏🙌❤️', 'Vocals on point let gooo', 'You are so talented! ❤️', '🔥🔥🔥'];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// "James" ships pre-assigned as a moderator (SEED_MODERATOR_IDS below) purely so the
// mute/kick/ban-highlighted-differently-from-host styling is visible immediately on a
// fresh stream, without the host first having to promote someone themselves.
const SEED_MESSAGES: ChatMessage[] = [
  { id: nextId(), type: 'chat', senderId: 'seed-lisa', name: 'Lisa', text: 'Nice 👏' },
  { id: nextId(), type: 'chat', senderId: 'seed-james', name: 'James', text: 'Lovely Song ❤️' },
  { id: nextId(), type: 'chat', senderId: 'seed-sara', name: 'Sara arora', text: 'Keep it up! 👏🙌❤️' },
  { id: nextId(), type: 'chat', senderId: 'seed-alex', name: 'Alex thomas', text: 'You are so talented! ❤️' },
];

// Max join toasts visible at once — extras stay queued out rather than piling up on screen.
const MAX_VISIBLE_JOIN_TOASTS = 3;

const SEED_MODERATOR_IDS = ['seed-james'];

const SEED_PINNED: ChatMessage = {
  id: nextId(),
  type: 'chat',
  senderId: 'host',
  name: t('liveHost.live' as any),
  text: '🎉 Welcome to the stream — be kind, have fun!',
};

export interface UseLiveChatOptions {
  // The stream's actual broadcaster id, so getRole() can tell "this is the host" apart from
  // "this is just whoever's using this device". Omit on the broadcaster's OWN screen — there,
  // the device's own signed-in id IS the host, resolved automatically below. Pass it in on
  // the viewer's screen (from useLiveViewerStream's live_streams.host_user_id), otherwise a
  // viewer's own sent messages would wrongly get labelled HOST (their device id would equal
  // whatever this hook privately treats as "the host").
  hostUserId?: string;
  // Shown as the name/avatar on messages the CURRENT device's user sends. Without these the
  // hook falls back to the generic "LIVE" label — pass the real signed-in name/avatar
  // (host.name/avatarUrl on the broadcast screen, the viewer's own profile on the viewer
  // screen) so people see their own name on what they type, not a placeholder.
  currentUserName?: string;
  currentUserAvatarUrl?: string | null;
}

// Everything the live chat panel needs, in one hook — kept separate from
// LiveBroadcastScreen.tsx/LiveViewerScreen.tsx so its logic (rate limit, profanity, mock
// activity, roles) can be swapped for real ZegoCloud ZIM messages + stream_mod_* RPCs later
// without touching either screen.
//
// Product decision (schema, migration 02): live chat messages are never stored in the
// database — a message only ever exists on screen, delivered over realtime. So this hook's
// message list stays 100% local/ephemeral even after the ZegoCloud integration — only the
// *transport* changes (local mock → ZIM realtime), not the storage model.
export function useLiveChat(options: UseLiveChatOptions = {}) {
  const { hostUserId: knownHostUserId, currentUserName, currentUserAvatarUrl } = options;
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
  const [pinnedMessage, setPinnedMessage] = useState<ChatMessage | null>(SEED_PINNED);
  const [likes, setLikes] = useState(0);
  const [chats, setChats] = useState(SEED_MESSAGES.filter((m) => m.type !== 'system').length);
  const [shares, setShares] = useState(0);
  const [slowModeUntil, setSlowModeUntil] = useState<number | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [joinToasts, setJoinToasts] = useState<JoinToast[]>([]);
  const [mutedSenderIds, setMutedSenderIds] = useState<Set<string>>(new Set());
  const [moderatorSenderIds, setModeratorSenderIds] = useState<Set<string>>(new Set(SEED_MODERATOR_IDS));
  // Who is USING this device right now — used to attribute messages this device sends and to
  // resolve "isSelf". Defaults to a stable placeholder until the real id resolves.
  const [currentUserId, setCurrentUserId] = useState('me');
  const hostSenderId = knownHostUserId ?? currentUserId;
  const mutedSenderIdsRef = useRef(mutedSenderIds);
  mutedSenderIdsRef.current = mutedSenderIds;
  const sentTimestampsRef = useRef<number[]>([]);

  useEffect(() => {
    (async () => {
      const userId = await getCurrentSupabaseUserId();
      if (userId) setCurrentUserId(userId);
    })();
  }, []);

  // Adds a floating "X joined" toast (LiveJoinToast.tsx owns the actual show/hide
  // animation and calls removeJoinToast() itself once it's done) — capped so a burst of
  // joins queues briefly instead of piling up on screen.
  const pushJoinToast = useCallback((name: string) => {
    setJoinToasts((prev) => [...prev.slice(-(MAX_VISIBLE_JOIN_TOASTS - 1)), { id: nextId(), name }]);
  }, []);

  const removeJoinToast = useCallback((id: string) => {
    setJoinToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // One join toast shortly after mount so the effect is visible immediately, without
  // waiting for the first random tick of the background activity below.
  useEffect(() => {
    const timeout = setTimeout(() => pushJoinToast(randomFrom(MOCK_VIEWERS)), 1500);
    return () => clearTimeout(timeout);
  }, [pushJoinToast]);

  const getRole = useCallback((senderId: string): SenderRole => {
    if (senderId === hostSenderId) return 'host';
    if (moderatorSenderIds.has(senderId)) return 'moderator';
    return 'viewer';
  }, [hostSenderId, moderatorSenderIds]);

  // Clears a transient input error a couple seconds after it's shown.
  useEffect(() => {
    if (!inputError) return;
    const timeout = setTimeout(() => setInputError(null), 2500);
    return () => clearTimeout(timeout);
  }, [inputError]);

  // Background "the room is alive" activity: an occasional mock viewer message or join,
  // from the small fixed pool above — never more than one in flight, never accumulating
  // into a large dataset (older messages are trimmed). Joins are toasts, not chat lines —
  // they never touch `messages` at all, so they can't push or disturb real chat content.
  useEffect(() => {
    const interval = setInterval(() => {
      const name = randomFrom(MOCK_VIEWERS);
      // A muted mock viewer just doesn't get to "speak" this tick — mirrors what a real mute
      // does server-side (the chat gate rejects their messages before they're ever seen).
      if (mutedSenderIdsRef.current.has(`mock-${name}`)) return;

      if (Math.random() < 0.25) {
        pushJoinToast(name);
        return;
      }

      setMessages((prev) => [...prev.slice(-49), { id: nextId(), type: 'chat', senderId: `mock-${name}`, name, text: randomFrom(MOCK_MESSAGES) }]);
      setChats((prev) => prev + 1);
    }, 6000 + Math.random() * 4000);

    return () => clearInterval(interval);
  }, [pushJoinToast]);

  const sendMessage = useCallback(async (rawText: string): Promise<boolean> => {
    const text = rawText.trim();
    if (!text) return false;

    if (text.length > CHAT_RATE_LIMIT.maxLength) {
      setInputError(t('liveChat.tooLong' as any));
      return false;
    }

    const now = Date.now();
    if (slowModeUntil && now < slowModeUntil) {
      const secondsLeft = Math.ceil((slowModeUntil - now) / 1000);
      setInputError(`${t('liveChat.slowModePrefix' as any)} ${secondsLeft}${t('liveChat.slowModeSuffix' as any)}`);
      return false;
    }

    if (containsProfanity(text)) {
      setInputError(t('liveChat.blocked' as any));
      return false;
    }

    // Same window/threshold as the real stream_mod_chat_gate() slow-mode rule.
    const recent = sentTimestampsRef.current.filter((ts) => now - ts < CHAT_RATE_LIMIT.windowMs);
    recent.push(now);
    sentTimestampsRef.current = recent;
    if (recent.length > CHAT_RATE_LIMIT.maxInWindow) {
      setSlowModeUntil(now + CHAT_RATE_LIMIT.slowModeMs);
      setInputError(`${t('liveChat.slowModePrefix' as any)} ${Math.ceil(CHAT_RATE_LIMIT.slowModeMs / 1000)}${t('liveChat.slowModeSuffix' as any)}`);
      return false;
    }
    if (slowModeUntil) {
      const sinceLast = sentTimestampsRef.current.length > 1
        ? now - sentTimestampsRef.current[sentTimestampsRef.current.length - 2]
        : Infinity;
      if (sinceLast < CHAT_RATE_LIMIT.slowModeIntervalMs) {
        const secondsLeft = Math.ceil((CHAT_RATE_LIMIT.slowModeIntervalMs - sinceLast) / 1000);
        setInputError(`${t('liveChat.slowModePrefix' as any)} ${secondsLeft}${t('liveChat.slowModeSuffix' as any)}`);
        return false;
      }
      if (now >= slowModeUntil) setSlowModeUntil(null);
    }

    setMessages((prev) => [
      ...prev.slice(-49),
      { id: nextId(), type: 'chat', senderId: currentUserId, name: currentUserName || t('liveHost.live' as any), text, avatarUrl: currentUserAvatarUrl },
    ]);
    setChats((prev) => prev + 1);
    return true;
  }, [slowModeUntil, currentUserId, currentUserName, currentUserAvatarUrl]);

  const pinMessage = useCallback((message: ChatMessage) => {
    setPinnedMessage(message);
  }, []);

  const unpinMessage = useCallback(() => {
    setPinnedMessage(null);
  }, []);

  const likeStream = useCallback(() => {
    setLikes((prev) => prev + 1);
  }, []);

  const shareStream = useCallback(() => {
    setShares((prev) => prev + 1);
  }, []);

  // UI-phase only: locally mutes/removes/promotes so the demo shows a visible effect.
  // The real stream_mod_mute/kick/ban/stream_mod_assign_moderator RPCs (already deployed)
  // get wired in during this feature's ZegoCloud integration plan — see LiveModerationMenu.tsx.
  const moderateViewer = useCallback((senderId: string, action: ModerationAction) => {
    if (action === 'mute') {
      setMutedSenderIds((prev) => new Set(prev).add(senderId));
      return;
    }
    if (action === 'kick' || action === 'ban') {
      setMessages((prev) => prev.filter((m) => m.senderId !== senderId));
      setModeratorSenderIds((prev) => {
        if (!prev.has(senderId)) return prev;
        const next = new Set(prev);
        next.delete(senderId);
        return next;
      });
      return;
    }
    if (action === 'promote') {
      setModeratorSenderIds((prev) => new Set(prev).add(senderId));
      return;
    }
    if (action === 'demote') {
      setModeratorSenderIds((prev) => {
        const next = new Set(prev);
        next.delete(senderId);
        return next;
      });
      return;
    }
    // 'report' has nothing to change locally — it's a submission, not a state change.
    // 'pin'/'unpin' aren't handled here at all — they act on a specific message, not a
    // sender, so LiveBroadcastScreen calls pinMessage()/unpinMessage() directly for those.
  }, []);

  return {
    messages,
    joinToasts,
    removeJoinToast,
    pinnedMessage,
    likes,
    chats,
    shares,
    sendMessage,
    likeStream,
    shareStream,
    inputError,
    slowModeUntil,
    mutedSenderIds,
    moderatorSenderIds,
    hostSenderId,
    currentUserId,
    getRole,
    moderateViewer,
    pinMessage,
    unpinMessage,
  };
}
