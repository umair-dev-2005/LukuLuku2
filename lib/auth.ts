import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { supabase } from './supabase';

const OAUTH_REDIRECT_TO = 'lukuluku://auth/callback';

function parseAuthCallbackUrl(url: string): { access_token?: string; refresh_token?: string; code?: string; error_code?: string } {
  try {
    // React Native's built-in URL throws "not implemented" for .search/.hash,
    // so parse the query and fragment manually.
    const queryStart = url.indexOf('?');
    const hashStart = url.indexOf('#');
    const queryEnd = hashStart === -1 ? url.length : hashStart;
    const query = queryStart === -1 || queryStart > queryEnd ? '' : url.slice(queryStart + 1, queryEnd);
    const hash = hashStart === -1 ? '' : url.slice(hashStart + 1);

    const parsePairs = (raw: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
        const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
        out[key] = value;
      }
      return out;
    };

    const params = parsePairs(query);
    const hashParams = parsePairs(hash);
    const getParam = (key: string) => params[key] || hashParams[key] || undefined;

    return {
      access_token: getParam('access_token') || undefined,
      refresh_token: getParam('refresh_token') || undefined,
      code: getParam('code') || undefined,
      error_code: getParam('error_code') || getParam('error') || undefined,
    };
  } catch {
    return {};
  }
}

export async function signInWithSupabaseGoogle() {
  const WebBrowser = await import('expo-web-browser');

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: OAUTH_REDIRECT_TO,
      skipBrowserRedirect: true,
    },
  });

  if (error) throw error;

  const result = await (WebBrowser as any).openAuthSessionAsync(data?.url ?? '', OAUTH_REDIRECT_TO);
  if (result.type !== 'success' || !result.url) {
    return null;
  }

  const { access_token: accessToken, refresh_token: refreshToken, code, error_code: errorCode } = parseAuthCallbackUrl(result.url);
  if (errorCode) throw new Error(errorCode);

  if (accessToken && refreshToken) {
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (sessionError) throw sessionError;
    return sessionData.session;
  }

  if (code) {
    const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
    return exchangeData.session;
  }

  return null;
}

export async function signInWithSupabaseApple() {
  if (Platform.OS !== 'ios') {
    throw new Error('Apple Sign In is only available on iOS devices.');
  }

  const available = await AppleAuthentication.isAvailableAsync();
  if (!available) {
    throw new Error('Apple Sign In is not available on this device.');
  }

  let credential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (e: any) {
    // User tapped "Cancel" on the native Apple sheet.
    if (e?.code === 'ERR_REQUEST_CANCELED' || e?.code === 'ERR_CANCELED') return null;
    throw e;
  }

  const identityToken = credential.identityToken;
  if (!identityToken) {
    throw new Error('Apple did not return an identity token.');
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: identityToken,
  });
  if (error) throw error;

  // Apple only sends the full name on the FIRST authorization. Persist it onto
  // the user metadata so the profile/channel get a real display name, since
  // every later sign-in returns a null name.
  const fullName = credential.fullName;
  const composedName = [fullName?.givenName, fullName?.familyName].filter(Boolean).join(' ').trim();
  if (composedName && data.user && !data.user.user_metadata?.full_name) {
    await supabase.auth.updateUser({ data: { full_name: composedName } });
  }

  return data.session;
}

let _cachedUserKey: string | null = null;
let _cachedUserId: string | null = null;

type SupabaseSessionUser = {
  id: string;
  email?: string | null;
  user_metadata?: {
    full_name?: string | null;
    name?: string | null;
    avatar_url?: string | null;
    picture?: string | null;
  };
};

type ProfileRow = {
  user_id: string;
  is_verified?: boolean | null;
  verification_type?: string | null;
  is_monetized?: boolean | null;
  standard_share_pct?: number | null;
  bonus_share_pct?: number | null;
  is_founder_team?: boolean | null;
};

const FOUNDER_ENTITLED_USER_IDS = new Set([
  '6d0fcd40-3aab-4dfa-b34a-312419340a8b',
  '9aa6b00f-6583-4b9e-af73-c68161261eee',
  '8e1a913f-87eb-4606-b074-a9299a50000d',
  '9cb047bf-ebfa-4344-a7a2-590d395d6a91',
  'b3da9eff-0cae-4c39-b423-e0012f931dbb',
  'c457ee41-9857-4ed0-bb59-89db1fd796b9',
  'd218c9b1-2821-4fbd-8f8e-9f80252231e5',
  "0457cf49-ba55-40f7-b551-5594812a0fa2"

]);

const FOUNDER_STANDARD_SHARE_PCT = 70;
const FOUNDER_BONUS_SHARE_PCT = 1;
const FOUNDER_PLATFORM_RESERVE_PCT = 30;

type FounderEntitlements = {
  is_verified: boolean;
  verification_type: string;
  is_monetized: boolean;
  standard_share_pct: number;
  bonus_share_pct: number;
  is_founder_team: boolean;
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getFounderEntitlements(userId?: string | null): FounderEntitlements | null {
  if (!userId) return null;
  if (!FOUNDER_ENTITLED_USER_IDS.has(userId)) return null;

  return {
    is_verified: true,
    verification_type: 'music',
    is_monetized: true,
    standard_share_pct: FOUNDER_STANDARD_SHARE_PCT,
    bonus_share_pct: FOUNDER_BONUS_SHARE_PCT,
    is_founder_team: true,
  };
}

function needsFounderEntitlementPatch(profile: ProfileRow | null | undefined, entitlements: FounderEntitlements | null): boolean {
  if (!entitlements) return false;
  if (!profile) return true;

  return (
    profile.is_verified !== entitlements.is_verified ||
    profile.verification_type !== entitlements.verification_type ||
    profile.is_monetized !== entitlements.is_monetized ||
    profile.standard_share_pct !== entitlements.standard_share_pct ||
    profile.bonus_share_pct !== entitlements.bonus_share_pct ||
    profile.is_founder_team !== entitlements.is_founder_team
  );
}

async function upsertFounderEntitlements(userId: string): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id, is_verified, verification_type, is_monetized, standard_share_pct, bonus_share_pct, is_founder_team')
    .eq('user_id', userId)
    .maybeSingle();

  const entitlements = getFounderEntitlements(userId);

  if (entitlements) {
    if (needsFounderEntitlementPatch(profile, entitlements)) {
      await supabase.from('profiles').update(entitlements).eq('user_id', userId);
    }
    return;
  }

  // User is NOT (or no longer) in the founder list — revoke if previously granted.
  if (profile?.is_founder_team) {
    await supabase.from('profiles').update({
      is_monetized: false,
      is_founder_team: false,
      standard_share_pct: 0,
      bonus_share_pct: 0,
      is_verified: false,
      verification_type: 'none',
    }).eq('user_id', userId);
  }
}

function buildDisplayName(user: SupabaseSessionUser): string {
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name;
  if (fullName?.trim()) return fullName.trim();
  if (user.email?.includes('@')) return user.email.split('@')[0];
  return 'User';
}

function buildHandle(user: SupabaseSessionUser): string {
  const seed = (user.email?.split('@')[0] || buildDisplayName(user) || 'user').toLowerCase();
  const cleaned = seed.replace(/[^a-z0-9]/g, '') || 'user';
  return cleaned;
}

function getCacheKey(user: SupabaseSessionUser): string {
  return `${user.id}:${normalizeText(user.email || '')}`;
}

function resolveSessionUser(): Promise<SupabaseSessionUser | null> {
  return supabase.auth.getSession().then(({ data }: { data: { session: { user: any } | null } }) => {
    const sessionUser = data.session?.user;
    if (!sessionUser) return null;
    return {
      id: sessionUser.id,
      email: sessionUser.email,
      user_metadata: sessionUser.user_metadata as SupabaseSessionUser['user_metadata'] | undefined,
    };
  });
}

async function ensureChannelExists(user: SupabaseSessionUser, userId: string): Promise<void> {
  const { data: existingChannel } = await supabase
    .from('channels')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existingChannel?.id) return;

  await supabase.from('channels').insert({
    user_id: userId,
    name: buildDisplayName(user),
    handle: buildHandle(user),
    description: null,
    avatar_url: user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
    banner_url: null,
    tapiners: 0,
  });
}

async function resolveExistingUserId(user: SupabaseSessionUser): Promise<string> {
  // Identity must be deterministic: the session's auth UID is the user id.
  // The previous fuzzy matching (scoring display names/handles across all
  // profiles, channels and content) could resolve the same person to
  // different accounts between sessions — scattering their uploads across
  // identities — and could even attach a session to someone else's account.
  return user.id;
}

export async function getCurrentSupabaseUserId(): Promise<string | null> {
  const user = await resolveSessionUser();
  if (!user?.id) return null;

  const cacheKey = getCacheKey(user);
  if (cacheKey === _cachedUserKey && _cachedUserId) {
    await ensureSupabaseProfile(_cachedUserId, user);
    return _cachedUserId;
  }

  const userId = await resolveExistingUserId(user);
  await ensureSupabaseProfile(userId, user);
  _cachedUserKey = cacheKey;
  _cachedUserId = userId;
  return userId;
}

export async function ensureSupabaseProfile(existingUserId?: string, currentUser?: SupabaseSessionUser): Promise<string | null> {
  const user = currentUser || (await resolveSessionUser());
  if (!user?.id) return null;

  const userId = existingUserId || (await resolveExistingUserId(user));
  const founderEntitlements = getFounderEntitlements(userId);

  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!profile) {
    const { error } = await supabase.from('profiles').insert({
      user_id: userId,
      display_name: buildDisplayName(user),
      username: buildHandle(user),
      avatar_url: user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
      bio: null,
      is_verified: founderEntitlements?.is_verified ?? false,
      verification_type: founderEntitlements?.verification_type ?? 'none',
      is_monetized: founderEntitlements?.is_monetized ?? false,
      standard_share_pct: founderEntitlements?.standard_share_pct ?? 0,
      bonus_share_pct: founderEntitlements?.bonus_share_pct ?? 0,
      is_founder_team: founderEntitlements?.is_founder_team ?? false,
    });

    if (error) {
      console.error('Error creating profile:', error.message);
      return null;
    }
  }

  await upsertFounderEntitlements(userId);
  await ensureChannelExists(user, userId);
  return userId;
}

export function clearAuthCache() {
  _cachedUserKey = null;
  _cachedUserId = null;
}