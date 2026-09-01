import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getCurrentSupabaseUserId } from './auth';

export const COMMUNITY_TERMS_VERSION = '2026-05-14';
const ACCEPTED_TERMS_KEY = 'lukuluku_community_terms_v1';
const BLOCKED_USERS_KEY = 'lukuluku_blocked_users_v1';
const DELETION_REQUEST_KEY = 'lukuluku_deletion_request_v1';
const REPORT_QUEUE_KEY = 'lukuluku_report_queue_v1';

const DEFAULT_SUPPORT_EMAIL = 'support@lukuluku.online';

type CommunitySafetyListener = () => void;

const communitySafetyListeners = new Set<CommunitySafetyListener>();

function notifyCommunitySafetyChanged() {
  communitySafetyListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore listener failures so one screen does not break the others.
    }
  });
}

async function persistBlockRelationship(blockedUserId: string) {
  try {
    const blockerUserId = await getCurrentSupabaseUserId();
    await supabase.from('user_blocks').insert({
      blocker_user_id: blockerUserId,
      blocked_user_id: blockedUserId,
    });
  } catch {
    // Best-effort only; local blocking still applies instantly.
  }
}

async function logContentReport(report: {
  contentType: string;
  contentId: string;
  targetUserId: string;
  reporterUserId?: string | null;
  reason: string;
  details?: string;
}) {
  try {
    await supabase.from('content_reports').insert({
      content_type: report.contentType,
      content_id: report.contentId,
      target_user_id: report.targetUserId,
      reporter_user_id: report.reporterUserId || null,
      reason: report.reason,
      details: report.details || null,
    });
  } catch {
    // Best-effort only; the local queue remains the fallback record.
  }
}

export function subscribeCommunitySafetyChanges(listener: CommunitySafetyListener): () => void {
  communitySafetyListeners.add(listener);
  return () => {
    communitySafetyListeners.delete(listener);
  };
}

export async function hasAcceptedCommunityTerms(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ACCEPTED_TERMS_KEY)) === COMMUNITY_TERMS_VERSION;
  } catch {
    return false;
  }
}

export async function acceptCommunityTerms(): Promise<void> {
  await AsyncStorage.setItem(ACCEPTED_TERMS_KEY, COMMUNITY_TERMS_VERSION);
  notifyCommunitySafetyChanged();
}

export async function loadBlockedUserIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(BLOCKED_USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export async function blockUser(userId: string): Promise<string[]> {
  const current = new Set(await loadBlockedUserIds());
  current.add(userId);
  const blocked = [...current];
  await AsyncStorage.setItem(BLOCKED_USERS_KEY, JSON.stringify(blocked));
  await persistBlockRelationship(userId);
  notifyCommunitySafetyChanged();
  return blocked;
}

export async function unblockUser(userId: string): Promise<string[]> {
  const current = new Set(await loadBlockedUserIds());
  current.delete(userId);
  const blocked = [...current];
  await AsyncStorage.setItem(BLOCKED_USERS_KEY, JSON.stringify(blocked));
  notifyCommunitySafetyChanged();
  return blocked;
}

export async function saveDeletionRequest(userId: string): Promise<void> {
  await AsyncStorage.setItem(DELETION_REQUEST_KEY, JSON.stringify({ userId, requestedAt: new Date().toISOString() }));
  notifyCommunitySafetyChanged();
}

export async function saveReportDraft(report: {
  contentType: string;
  contentId: string;
  targetUserId: string;
  reporterUserId?: string | null;
  reason: string;
  details?: string;
}) {
  const queueRaw = await AsyncStorage.getItem(REPORT_QUEUE_KEY);
  const queue = queueRaw ? (JSON.parse(queueRaw) as unknown) : [];
  const reports = Array.isArray(queue) ? queue : [];
  const nextEntry = {
    ...report,
    createdAt: new Date().toISOString(),
  };
  const nextQueue = [...reports, nextEntry].slice(-50);
  await AsyncStorage.setItem(REPORT_QUEUE_KEY, JSON.stringify(nextQueue));
  try {
    await supabase.from('content_reports').insert({
      content_type: report.contentType,
      content_id: report.contentId,
      target_user_id: report.targetUserId,
      reporter_user_id: report.reporterUserId || null,
      reason: report.reason,
      details: report.details || null,
    });
  } catch {
    // Best-effort only; the local queue remains the fallback record.
  }
  notifyCommunitySafetyChanged();
  return nextEntry;
}

export function getSupportEmail() {
  return DEFAULT_SUPPORT_EMAIL;
}

export function buildReportEmail({
  contentType,
  contentId,
  creatorId,
  creatorName,
  reason,
  details,
}: {
  contentType: string;
  contentId: string;
  creatorId?: string | null;
  creatorName?: string | null;
  reason?: string;
  details?: string;
}) {
  const subject = encodeURIComponent(`Report ${contentType} ${contentId}`);
  const body = encodeURIComponent(
    [
      `Content type: ${contentType}`,
      `Content ID: ${contentId}`,
      creatorId ? `Creator ID: ${creatorId}` : null,
      creatorName ? `Creator name: ${creatorName}` : null,
      reason ? `Reason: ${reason}` : null,
      details ? `Details: ${details}` : null,
      '',
      'Please review within 24 hours per community guidelines.',
    ]
      .filter(Boolean)
      .join('\n')
  );

  return `mailto:${DEFAULT_SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}