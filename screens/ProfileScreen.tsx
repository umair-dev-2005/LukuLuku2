import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Modal,
  TextInput,
  ActivityIndicator,
  Dimensions,
  Platform,
} from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { Asset } from 'expo-asset';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { supabase, Profile, Channel, Video, Short, CommunityPost, WalletRow, WithdrawalRow, fetchWalletRow, fetchWalletWithdrawals, createWithdrawal } from '../lib/supabase';
import { formatTimeAgo, formatViews, formatDuration } from '../lib/utils';
import { t, getLanguage, setLanguage } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';
import LinkedText from '../components/LinkedText';
import CommunitySafetyTools from '../components/CommunitySafetyTools';
import { clearAuthCache, ensureSupabaseProfile, getCurrentSupabaseUserId, signInWithSupabaseGoogle, signInWithSupabaseApple } from '../lib/auth';
import { acceptCommunityTerms, hasAcceptedCommunityTerms } from '../lib/communitySafety';
import type { Session } from '@supabase/supabase-js';

declare const require: any;

const { width } = Dimensions.get('window');

interface ProfileScreenProps {
  onVideoPress: (video: Video) => void;
  onMomentiPress: (video: Video) => void;
  onChannelPress: (channelId: string) => void;
  onWebViewPress?: (url: string, title: string) => void;
  onAdvertisePress?: () => void;
  onPostPress?: (postId: string) => void;
  refreshToken?: number;
  initialAuthMode?: 'signin' | 'signup' | null;
  onAuthComplete?: () => void;
  isActive?: boolean;
}

type ProfileTab = 'videos' | 'momenti' | 'bangi';
type VerificationStatus = 'loading' | 'none' | 'pending' | 'approved' | 'rejected' | 'verified';
type ToastVariant = 'success' | 'error' | 'warning';

type WalletMethod = 'uni5pay' | 'usdt_bep20';
interface PostWithMeta extends CommunityPost {
  commentCount?: number;
}

interface VerificationFormState {
  about: string;
  message: string;
  tiktok_url: string;
  youtube_url: string;
  facebook_url: string;
  instagram_url: string;
  press_links: string;
}

interface ProfileLinksState {
  tiktok_url: string;
  youtube_url: string;
  facebook_url: string;
  instagram_url: string;
  press_links: string;
}

const initialVerificationForm: VerificationFormState = {
  about: '',
  message: '',
  tiktok_url: '',
  youtube_url: '',
  facebook_url: '',
  instagram_url: '',
  press_links: '',
};

const emptyProfileLinks: ProfileLinksState = {
  tiktok_url: '',
  youtube_url: '',
  facebook_url: '',
  instagram_url: '',
  press_links: '',
};

interface ToastState {
  message: string;
  variant: ToastVariant;
}

function ProfileScreen({
  onVideoPress,
  onMomentiPress,
  onChannelPress,
  onWebViewPress,
  onAdvertisePress,
  onPostPress,
  refreshToken,
  initialAuthMode,
  onAuthComplete,
  isActive,
}: ProfileScreenProps) {
    const insets = useSafeAreaInsets();
  const [user, setUser] = useState<any>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState<'signin' | 'signup' | 'resend' | 'google' | 'apple' | null>(null);
  // Only true once the native ExpoAppleAuthentication module is actually present
  // in the running binary. Guards against the "Unimplemented component" crash
  // when running a build that predates the module (Expo Go / stale dev build).
  const [appleAuthAvailable, setAppleAuthAvailable] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [myVideos, setMyVideos] = useState<Video[]>([]);
  const [myShorts, setMyShorts] = useState<(Short & { duration?: number | null })[]>([]);
  const [myPosts, setMyPosts] = useState<PostWithMeta[]>([]);
  const [contentCounts, setContentCounts] = useState({ videos: 0, momenti: 0, bangi: 0 });
  const [tappedChannels, setTappedChannels] = useState<Channel[]>([]);
  const [tapinTotal, setTapinTotal] = useState(0);
  const [activeTab, setActiveTab] = useState<ProfileTab>('videos');
  const [profileLinks, setProfileLinks] = useState<ProfileLinksState>(emptyProfileLinks);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>('loading');
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationForm, setVerificationForm] = useState<VerificationFormState>(initialVerificationForm);
  const [verificationSubmitting, setVerificationSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [communityTermsAccepted, setCommunityTermsAccepted] = useState(false);
  const [communityTermsLoading, setCommunityTermsLoading] = useState(true);

  // Monetization state
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [walletType, setWalletType] = useState<WalletMethod>('uni5pay');
  const [walletNumber, setWalletNumber] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [walletSaving, setWalletSaving] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);
  const [lastInvoiceNumber, setLastInvoiceNumber] = useState('');
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const [walletData, setWalletData] = useState<WalletRow | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);

  const receiptRecipientEmail = profile?.email || user?.email || '';
  const logoAsset = Asset.fromModule(require('../assets/luku_luku_512.png'));
  const emailRedirectTo = 'https://lukuluku.online/';

  const normalizeEmail = (value: string) => value.trim().toLowerCase();
  const normalizeOptionalField = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };
  const normalizeLinkUrl = (value: string) => {
    const trimmed = value.trim().replace(/[),.]+$/, '');
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed.replace(/^\/+/, '')}`;
  };
  const extractUrls = (value?: string | null) => {
    if (!value) return [] as string[];
    const matches =
      value.match(/(?:https?:\/\/|www\.)[^\s<>"]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^^\s<>"]*)?/gi) || [];
    return matches
      .map((link) => normalizeLinkUrl(link))
      .filter(Boolean);
  };

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    void hasAcceptedCommunityTerms().then((accepted) => {
      setCommunityTermsAccepted(accepted);
      setCommunityTermsLoading(false);
    });
  }, []);

  const showToast = (message: string, variant: ToastVariant = 'success') => {
    setToast({ message, variant });
  };

  const requestConfirmationEmail = async (rawEmail?: string) => {
    const targetEmail = normalizeEmail(rawEmail || email);
    if (!targetEmail) {
      Alert.alert(t('common.error' as any), t('auth.emailRequired' as any));
      return false;
    }

    try {
      setAuthSubmitting('resend');
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: targetEmail,
        options: {
          emailRedirectTo,
        },
      });

      if (error) {
        Alert.alert('Error', error.message);
        return false;
      }

      Alert.alert(
        t('auth.confirmationSentTitle' as any),
        t('auth.confirmationSentDesc' as any)
      );
      return true;
    } finally {
      setAuthSubmitting(null);
    }
  };

  const buildInvoiceHtml = (invoiceNumber: string, amount: number) => {
    const logoUri = logoAsset.localUri || logoAsset.uri;
    const formattedDate = new Intl.DateTimeFormat('nl-SR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date());

    return `
      <html>
        <body style="font-family: Arial, sans-serif; background:#F6F8FB; color:#111827; padding:24px;">
          <div style="max-width:640px; margin:0 auto; background:#fff; border-radius:18px; overflow:hidden; border:1px solid #E5E7EB; box-shadow:0 10px 30px rgba(15,23,42,0.08);">
            <div style="background:linear-gradient(180deg, #0EA5E9 0%, #0284C7 100%); padding:28px; text-align:center; color:#fff;">
              <img src="${logoUri}" alt="LukuLuku NV" style="width:104px; height:104px; border-radius:52px; object-fit:cover; background:#fff; border:4px solid rgba(255,255,255,0.2);" />
              <h1 style="margin:16px 0 8px; font-size:26px; letter-spacing:0.2px;">LukuLuku NV</h1>
              <p style="margin:0; font-size:14px; opacity:0.95;">Official withdrawal invoice</p>
            </div>
            <div style="padding:24px;">
              <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
                <div>
                  <p style="margin:0; font-size:12px; color:#6B7280; text-transform:uppercase; letter-spacing:0.08em;">Invoice number</p>
                  <p style="margin:4px 0 0; font-size:18px; font-weight:700;">${invoiceNumber}</p>
                </div>
                <div style="text-align:right;">
                  <p style="margin:0; font-size:12px; color:#6B7280; text-transform:uppercase; letter-spacing:0.08em;">Date</p>
                  <p style="margin:4px 0 0; font-size:16px; font-weight:600;">${formattedDate}</p>
                </div>
              </div>
              <table style="width:100%; border-collapse:collapse; font-size:14px;">
                <tr><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; color:#6B7280;">Company</td><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; text-align:right; font-weight:600;">LukuLuku NV</td></tr>
                <tr><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; color:#6B7280;">Subject</td><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; text-align:right; font-weight:600;">Withdrawal from wallet</td></tr>
                <tr><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; color:#6B7280;">Recipient email</td><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; text-align:right; font-weight:600;">${receiptRecipientEmail || 'Not available'}</td></tr>
                <tr><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; color:#6B7280;">Gross amount</td><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; text-align:right; font-weight:600;">SRD ${amount.toFixed(2)}</td></tr>
                <tr><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; color:#6B7280;">Net amount</td><td style="padding:12px 0; border-bottom:1px solid #E5E7EB; text-align:right; font-weight:600;">SRD ${amount.toFixed(2)}</td></tr>
                <tr><td style="padding:12px 0; color:#6B7280;">Status</td><td style="padding:12px 0; text-align:right; font-weight:700; color:#0284C7;">Paid out by LukuLuku NV</td></tr>
              </table>
              <div style="margin-top:20px; padding:16px; border-radius:14px; background:#F8FAFC; border:1px solid #E5E7EB;">
                <p style="margin:0; font-size:12px; color:#6B7280; line-height:1.5;">
                  This invoice is for a withdrawal request in the LukuLuku wallet.
                  The PDF will be attached to the registered email address once the withdrawal is requested.
                </p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  };

  const sendReceiptPdf = async (invoiceNumber: string, amount: number) => {
    if (!receiptRecipientEmail) {
      return;
    }

    try {
      setSendingReceipt(true);
      Alert.alert(
        'Invoice',
        `Invoice ${invoiceNumber} is voorbereid voor ${receiptRecipientEmail}.`
      );
    } catch (error: any) {
      Alert.alert('Invoice', error?.message || 'The invoice could not be created.');
    } finally {
      setSendingReceipt(false);
    }
  };

  const uni5payLabel = walletData
    ? `${walletData.walletType === 'bep20_usdt' ? 'USDT BEP20' : 'Uni5Pay'} · ${walletData.accountHolder || 'Unknown'}`
    : 'Southern Commercial Bank - Uni5Pay';

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    try {
      AppleAuthentication.isAvailableAsync()
        .then(setAppleAuthAvailable)
        .catch(() => setAppleAuthAvailable(false));
    } catch {
      setAppleAuthAvailable(false);
    }
  }, []);

  useEffect(() => {
    const syncAuth = async () => {
      const { data } = await supabase.auth.getSession();
      const sessionUser = data.session?.user;
      if (sessionUser) {
        setUser({
          ...sessionUser,
          name: sessionUser.user_metadata?.full_name || sessionUser.user_metadata?.name || sessionUser.email,
          picture: sessionUser.user_metadata?.avatar_url || sessionUser.user_metadata?.picture || null,
        });
        loadProfile();
      } else {
        setUser(null);
      }
      setAuthReady(true);
    };

    syncAuth();

    const { data: sub } = supabase.auth.onAuthStateChange((_event: string, session: any) => {
      const sessionUser = session?.user;
      if (sessionUser) {
        setUser({
          ...sessionUser,
          name: sessionUser.user_metadata?.full_name || sessionUser.user_metadata?.name || sessionUser.email,
          picture: sessionUser.user_metadata?.avatar_url || sessionUser.user_metadata?.picture || null,
        });
        loadProfile();
      } else {
        clearAuthCache();
        setUser(null);
        setProfile(null);
        setChannel(null);
        setMyVideos([]);
        setMyShorts([]);
        setMyPosts([]);
        setTappedChannels([]);
        setProfileLinks(emptyProfileLinks);
        setVerificationStatus('loading');
        setVerificationForm(initialVerificationForm);
        setToast(null);
      }
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (user) {
      loadProfile();
    }
  }, [refreshToken, user]);

  const profileCacheKey = (userId: string) => `profile_cache_v1:${userId}`;
  const cacheHydratedRef = useRef(false);

  // Paint the last known profile instantly while fresh data loads over the
  // network. Runs once per mount; fresh results overwrite it right after.
  const hydrateFromCache = async (userId: string) => {
    if (cacheHydratedRef.current) return;
    cacheHydratedRef.current = true;
    try {
      const raw = await AsyncStorage.getItem(profileCacheKey(userId));
      if (!raw) return;
      const snap = JSON.parse(raw);
      if (snap.profile) setProfile(snap.profile);
      if (snap.channel) {
        setChannel(snap.channel);
        setTapinTotal(snap.channel.tapiners || 0);
      }
      if (snap.contentCounts) setContentCounts(snap.contentCounts);
      if (snap.myVideos) setMyVideos(snap.myVideos);
      if (snap.myShorts) setMyShorts(snap.myShorts);
      if (snap.myPosts) setMyPosts(snap.myPosts);
      if (snap.tappedChannels) setTappedChannels(snap.tappedChannels);
      if (snap.profileLinks) setProfileLinks(snap.profileLinks);
    } catch {
      // a stale or corrupt cache is never fatal
    }
  };

  const loadProfile = async () => {
    const activeUserId = (await getCurrentSupabaseUserId()) || (await ensureSupabaseProfile());
    if (!activeUserId) return;

    await hydrateFromCache(activeUserId);

    setVerificationStatus('loading');

    try {
      // Everything keyed on the user id loads as one parallel batch — the
      // previous sequential waterfall paid a network round trip per step.
      const [
        profileRes,
        channelRes,
        verificationRes,
        videosRes,
        legacyShortsRes,
        momentiRes,
        postsRes,
        tapinRowsRes,
        walletRow,
        withdrawalRows,
      ] = await Promise.all([
        supabase
          .from('profiles')
         .select('id, user_id, display_name, username, avatar_url, bio, created_at, updated_at, verification_type, is_admin, is_founder_team, is_verified, notify_telegram, notify_push, notify_new_video_from_tapins, is_monetized, standard_share_pct, bonus_share_pct')
          .eq('user_id', activeUserId)
          .maybeSingle(),
        supabase.from('channels').select('*').eq('user_id', activeUserId).maybeSingle(),
        supabase
          .from('verification_requests')
          .select('status, tiktok_url, youtube_url, facebook_url, instagram_url, press_links, created_at')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: false }),
        supabase
          .from('videos')
          .select('*')
          .eq('user_id', activeUserId)
          .eq('is_short', false)
          .order('created_at', { ascending: false }),
        supabase
          .from('shorts')
          .select('*')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: false }),
        supabase
          .from('videos')
          .select('*')
          .eq('user_id', activeUserId)
          .eq('is_short', true)
          .order('created_at', { ascending: false }),
        supabase
          .from('community_posts')
          .select('*')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: false }),
        supabase
          .from('tapins')
          .select('channel_id, created_at')
          .eq('user_id', activeUserId)
          .order('created_at', { ascending: false })
          .limit(20),
        // Wallet tables may be missing columns on the live database;
        // never let a wallet failure block the rest of the profile.
        fetchWalletRow(activeUserId).catch(() => null),
        fetchWalletWithdrawals(activeUserId).catch(() => [] as WithdrawalRow[]),
      ]);

      const profileData = profileRes.data;
      if (!profileData) {
        setProfile(null);
        setVerificationStatus('none');
        return;
      }

      setProfile(profileData);

      const channelData = channelRes.data as Channel | null;
      const posts = (postsRes.data || []) as CommunityPost[];
      const postVideoIds = posts.filter((p) => p.video_id && !p.image_url).map((p) => p.video_id as string);
      const postIds = posts.map((p) => p.id);
      const tappedChannelIds = [...new Set((tapinRowsRes.data || []).map((row: { channel_id: string }) => row.channel_id))];

      // Second batch: only the lookups that depend on the first batch.
      const [, tappedChannelsRes, postVideoThumbsRes, postCommentsRes] = await Promise.all([
        // Tapin total comes from the channel's trigger-maintained `tapiners` column below —
        // counting the tapins table returns 0 under RLS (a user can't read tapins their own
        // channel received). Placeholder keeps the batch shape.
        Promise.resolve({ count: null as number | null }),
        tappedChannelIds.length > 0
          ? supabase.from('channels').select('*').in('id', tappedChannelIds)
          : Promise.resolve({ data: [] as Channel[] }),
        postVideoIds.length > 0
          ? supabase.from('videos').select('id, thumbnail_url').in('id', postVideoIds)
          : Promise.resolve({ data: [] as { id: string; thumbnail_url: string | null }[] }),
        postIds.length > 0
          ? supabase.from('comments').select('post_id').in('post_id', postIds)
          : Promise.resolve({ data: [] as { post_id: string | null }[] }),
      ]);

      let channelWithCount: Channel | null = null;
      if (channelData) {
        const tapinTotalValue = channelData.tapiners ?? 0;
        channelWithCount = { ...channelData, tapiners: tapinTotalValue };
        setChannel(channelWithCount);
        setTapinTotal(tapinTotalValue);
      }

      const verificationRows = verificationRes.data || [];
      const latestVerification = verificationRows[0];
      const socialField = (key: 'tiktok_url' | 'youtube_url' | 'facebook_url' | 'instagram_url') =>
        verificationRows.find((row: { [key: string]: string | null }) => row[key]?.trim())?.[key] || '';
      const pressLinks = [...new Set(verificationRows.flatMap((row: { press_links: string | null }) => {
        const value = row.press_links || '';
        return value
          .split(/\n|,/)
          .map((link: string) => link.trim())
          .filter(Boolean);
      }))].join('\n');

      const nextProfileLinks = {
        tiktok_url: socialField('tiktok_url'),
        youtube_url: socialField('youtube_url'),
        facebook_url: socialField('facebook_url'),
        instagram_url: socialField('instagram_url'),
        press_links: pressLinks,
      };
      setProfileLinks(nextProfileLinks);

      if (profileData.is_verified) {
        setVerificationStatus('verified');
      } else if (latestVerification?.status === 'pending') {
        setVerificationStatus('pending');
      } else if (latestVerification?.status === 'approved') {
        setVerificationStatus('approved');
      } else if (latestVerification?.status === 'rejected') {
        setVerificationStatus('rejected');
      } else {
        setVerificationStatus('none');
      }

      const myVideosData = (videosRes.data || []) as Video[];
      const videoMomenti = (momentiRes.data || []).map((item: Video) => ({
        id: item.id,
        channel_id: item.channel_id,
        user_id: item.user_id,
        title: item.title,
        description: item.description,
        video_url: item.video_url,
        thumbnail_url: item.thumbnail_url,
        duration: item.duration,
        views: item.views,
        likes: item.likes,
        dislikes: item.dislikes,
        status: item.status,
        created_at: item.created_at,
      }));
      const legacyShortMomenti = (legacyShortsRes.data || []) as Short[];
      const seenShortIds = new Set<string>();
      const mergedMomenti = [...videoMomenti, ...legacyShortMomenti]
        .filter((item) => {
          const signature = `${item.user_id || ''}|${item.channel_id || ''}|${(item.video_url || '').trim().toLowerCase()}|${(item.title || '').trim().toLowerCase()}|${(item.thumbnail_url || '').trim().toLowerCase()}`;
          if (seenShortIds.has(signature)) return false;
          seenShortIds.add(signature);
          return true;
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setMyVideos(myVideosData);
      setMyShorts(mergedMomenti);

      const nextContentCounts = {
        videos: myVideosData.length,
        momenti: videoMomenti.length + legacyShortMomenti.length,
        bangi: posts.length,
      };
      setContentCounts(nextContentCounts);

      const nextTappedChannels = ((tappedChannelsRes as { data: Channel[] | null }).data || []) as Channel[];
      setTappedChannels(nextTappedChannels);

      setWalletData(walletRow);
      setWalletBalance(Number(walletRow?.balance || 0));
      setWithdrawals(withdrawalRows);

      const videoThumbMap = new Map<string, string>();
      ((postVideoThumbsRes as { data: { id: string; thumbnail_url: string | null }[] | null }).data || []).forEach((v) => {
        if (v.thumbnail_url) videoThumbMap.set(v.id, v.thumbnail_url);
      });
      const commentCountMap = new Map<string, number>();
      (((postCommentsRes as { data: { post_id: string | null }[] | null }).data) || []).forEach((c) => {
        if (c.post_id) {
          commentCountMap.set(c.post_id, (commentCountMap.get(c.post_id) || 0) + 1);
        }
      });

      const enrichedPosts: PostWithMeta[] = posts.map((p) => ({
        ...p,
        image_url: p.image_url || (p.video_id ? videoThumbMap.get(p.video_id) : null) || null,
        commentCount: commentCountMap.get(p.id) || 0,
      }));
      setMyPosts(enrichedPosts);

      // Snapshot for the instant paint on next open.
      AsyncStorage.setItem(
        profileCacheKey(activeUserId),
        JSON.stringify({
          profile: profileData,
          channel: channelWithCount,
          contentCounts: nextContentCounts,
          myVideos: myVideosData,
          myShorts: mergedMomenti,
          myPosts: enrichedPosts,
          tappedChannels: nextTappedChannels,
          profileLinks: nextProfileLinks,
        })
      ).catch(() => {});
    } catch (error) {
      console.warn('Profile failed to load:', error);
      setVerificationStatus('none');
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      setAuthSubmitting('google');
      await signInWithSupabaseGoogle();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Google sign-in failed');
    } finally {
      setAuthSubmitting(null);
    }
  };

  const handleAppleSignIn = async () => {
    if (!communityTermsAccepted) {
      Alert.alert('Terms required', 'Please accept the community terms before signing in.');
      return;
    }
    try {
      setAuthSubmitting('apple');
      await signInWithSupabaseApple();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Apple sign-in failed');
    } finally {
      setAuthSubmitting(null);
    }
  };

  const handleEmailSignIn = async () => {
    const targetEmail = normalizeEmail(email);

    if (!communityTermsAccepted) {
      Alert.alert('Terms required', 'Please accept the community terms before signing in.');
      return;
    }

    if (!targetEmail || !password.trim()) {
      Alert.alert(t('common.error' as any), t('auth.emailRequired' as any));
      return;
    }

    try {
      setAuthSubmitting('signin');
      const { error } = await supabase.auth.signInWithPassword({
        email: targetEmail,
        password,
      });

      if (error) {
              Alert.alert('Error', error.message);
              return;
            }

            setPassword('');
            onAuthComplete?.();
          } finally {
            setAuthSubmitting(null);
          }
        };

  const handleEmailSignUp = async () => {
    const targetEmail = normalizeEmail(email);

    if (!communityTermsAccepted) {
      Alert.alert('Terms required', 'Please accept the community terms before creating an account.');
      return;
    }

    if (!targetEmail || !password.trim()) {
      Alert.alert(t('common.error' as any), t('auth.emailRequired' as any));
      return;
    }

    try {
      setAuthSubmitting('signup');
      const { error } = await supabase.auth.signUp({
        email: targetEmail,
        password,
        options: {
          emailRedirectTo,
        },
      });

      if (error) {
        const message = error.message.toLowerCase();
        if (
          message.includes('already registered') ||
          message.includes('already exists') ||
          message.includes('user already')
        ) {
          await requestConfirmationEmail(targetEmail);
          return;
        }

        Alert.alert('Error', error.message);
        return;
      }

      Alert.alert(
        'Account created',
        'We have sent a confirmation email. Check your inbox and spam, and tap the confirmation link afterwards.'
      );
    } finally {
      setAuthSubmitting(null);
    }
  };

  const handleSignOut = async () => {
    clearAuthCache();
    setUser(null);
    setProfile(null);
    setChannel(null);
    setMyVideos([]);
    setMyShorts([]);
    setMyPosts([]);
    setTappedChannels([]);
    setProfileLinks(emptyProfileLinks);
    setVerificationStatus('loading');
    setShowVerificationModal(false);
    setVerificationForm(initialVerificationForm);
    setToast(null);
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  };

  const handleVerificationRequest = async () => {
    if (!profile?.user_id) return;

    if (!verificationForm.about.trim()) {
      showToast(t('profile.verificationToastAboutRequired'), 'warning');
      return;
    }

    if (!verificationForm.message.trim()) {
      showToast(t('profile.verificationToastMessageRequired'), 'warning');
      return;
    }

    setVerificationSubmitting(true);
    try {
      const payload = {
        user_id: profile.user_id,
        status: 'pending',
        about: verificationForm.about.trim(),
        message: verificationForm.message.trim(),
        tiktok_url: normalizeOptionalField(verificationForm.tiktok_url),
        youtube_url: normalizeOptionalField(verificationForm.youtube_url),
        facebook_url: normalizeOptionalField(verificationForm.facebook_url),
        instagram_url: normalizeOptionalField(verificationForm.instagram_url),
        press_links: normalizeOptionalField(verificationForm.press_links),
      };

      const { error } = await supabase.from('verification_requests').insert(payload);
      if (error) throw error;

      setVerificationStatus('pending');
      setVerificationForm(initialVerificationForm);
      setShowVerificationModal(false);
      showToast(t('profile.verificationSubmitted'), 'success');
    } catch (error: any) {
      console.error('Verification request failed:', error);
      showToast(t('profile.verificationToastFailed'), 'error');
    } finally {
      setVerificationSubmitting(false);
    }
  };

  const isMonetized = profile?.is_monetized || false;
  const tapinCount = tapinTotal;
  const tapinGoal = 1000;
  const tapinProgress = Math.min(tapinCount / tapinGoal, 1);
  const canAccessWallet = isMonetized || tapinCount >= tapinGoal;
  const creatorSharePct = profile?.standard_share_pct ?? 70;
  const founderBonusPct = profile?.bonus_share_pct ?? 0;
  const platformReservePct = Math.max(0, 100 - creatorSharePct);
  const platformNetPct = Math.max(0, platformReservePct - founderBonusPct);
  const canRequestWithdrawal = canAccessWallet && walletBalance >= 100;
  const parsedWithdrawAmount = Number(withdrawAmount.replace(',', '.'));
  const hasWithdrawPreview = Number.isFinite(parsedWithdrawAmount) && parsedWithdrawAmount >= 100;
  const previewInvoiceNumber = hasWithdrawPreview
    ? `LKU-${profile?.user_id?.slice(-4).toUpperCase() || '0000'}-${Math.round(parsedWithdrawAmount * 100)
        .toString()
        .padStart(4, '0')}`
    : 'LKU-PREVIEW-0000-0000';

  const previewNetAmount = hasWithdrawPreview ? parsedWithdrawAmount : 0;
  const previewAmount = hasWithdrawPreview ? parsedWithdrawAmount : 100;

  const handleSaveWallet = async () => {
    const isBep20 = walletType === 'bep20_usdt';
    const resolvedWalletNumber = isBep20 ? walletAddress.trim() : walletNumber.trim();
    if (!profile?.user_id || !resolvedWalletNumber || !accountHolder.trim()) return;
    setWalletSaving(true);
    try {
      const payload = {
        user_id: profile.user_id,
        walletType,
        walletNumber: isBep20 ? null : resolvedWalletNumber,
        walletAddress: isBep20 ? resolvedWalletNumber : null,
        accountHolder: accountHolder.trim(),
      };
      const { error } = await supabase.from('wallets').upsert(payload, { onConflict: 'user_id' });
      if (error) throw error;
      setWalletData({ id: profile.user_id, balance: walletBalance, ...payload });
      setShowWalletModal(false);
      Alert.alert(t('monetization.walletSaved' as any), t('monetization.walletSavedDesc' as any));
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not save wallet');
    }
    setWalletSaving(false);
  };

  const handleWithdraw = async () => {
    if (!profile?.user_id) return;
    const amount = parseFloat(withdrawAmount.replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Error', 'Enter a valid amount');
      return;
    }
    if (amount > walletBalance) {
      Alert.alert('Error', 'Insufficient balance');
      return;
    }
    if (!walletData) {
      Alert.alert('Error', 'Save your wallet first');
      return;
    }
    const destination = walletData.walletType === 'bep20_usdt'
      ? (walletData.walletAddress || walletData.walletNumber || '')
      : (walletData.walletNumber || '');
    if (!destination) {
      Alert.alert('Error', 'No withdrawal destination found');
      return;
    }
    setWithdrawing(true);
    try {
      await createWithdrawal({
        amount,
method: walletData.walletType === 'bep20_usdt' ? 'usdt_bep20' : 'uni5pay',
     destination,
      });
      const refreshed = await fetchWalletWithdrawals(profile.user_id);
      setWithdrawals(refreshed);
      setShowWithdrawModal(false);
      setWithdrawAmount('');
      const invoiceNumber = `LKU-${profile.user_id.slice(-4).toUpperCase()}-${Math.round(amount * 100).toString().padStart(4, '0')}`;
      setLastInvoiceNumber(invoiceNumber);
      Alert.alert(
        t('monetization.withdrawSuccess' as any),
        `Withdrawal requested for SRD ${amount.toFixed(2)}.`
      );
      await sendReceiptPdf(invoiceNumber, amount);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not process withdrawal');
    }
    setWithdrawing(false);
  };

  // Legal links component
  const LegalLinks = () => (
    <View style={styles.legalSection}>
      <Text style={styles.legalTitle}>{t('profile.language' as any)}</Text>
      <Text style={styles.languageDesc}>{t('profile.languageDesc' as any)}</Text>
      <View style={styles.languageRow}>
        {([
          { code: 'en' as const, label: t('profile.languageEnglish' as any) },
          { code: 'nl' as const, label: t('profile.languageDutch' as any) },
          { code: 'srn' as const, label: t('profile.languageSranan' as any) },
        ] as const).map((lang) => {
          const active = getLanguage() === lang.code;
          return (
            <TouchableOpacity
              key={lang.code}
              style={[styles.languagePill, active && styles.languagePillActive]}
              onPress={() => setLanguage(lang.code)}
            >
              <Text style={[styles.languagePillText, active && styles.languagePillTextActive]}>
                {lang.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.legalTitle}>{t('settings.legal')}</Text>
      <TouchableOpacity
        style={styles.legalRow}
        onPress={() => onWebViewPress?.('https://lukuluku.online/terms', t('legal.terms'))}
      >
        <Ionicons name="document-text-outline" size={20} color={colors.textSecondary} />
        <Text style={styles.legalText}>{t('legal.terms')}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.legalRow}
        onPress={() => onWebViewPress?.('https://lukuluku.online/privacy', t('legal.privacy'))}
      >
        <Ionicons name="shield-checkmark-outline" size={20} color={colors.textSecondary} />
        <Text style={styles.legalText}>{t('legal.privacy')}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.legalRow}
        onPress={() => onWebViewPress?.('https://lukuluku.online', t('legal.about'))}
      >
        <Ionicons name="information-circle-outline" size={20} color={colors.textSecondary} />
        <Text style={styles.legalText}>{t('legal.about')}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
    </View>
  );

  const TermsGate = () => (
    <View style={styles.termsGateCard}>
      <TouchableOpacity
        style={styles.termsGateRow}
        onPress={async () => {
          await acceptCommunityTerms();
          setCommunityTermsAccepted(true);
        }}
        activeOpacity={0.85}
        disabled={communityTermsLoading}
      >
        <Ionicons
          name={communityTermsAccepted ? 'checkbox' : 'square-outline'}
          size={20}
          color={communityTermsAccepted ? colors.tapIn : colors.textSecondary}
        />
        <Text style={styles.termsGateText}>
          I agree to the Terms of Use (EULA) and understand that objectionable or abusive content is strictly prohibited.
        </Text>
      </TouchableOpacity>
      <Text style={styles.termsGateNote}>
        You must accept this before logging in or creating an account.
      </Text>
    </View>
  );

  const renderProfileLinks = () => {
    const socialLinks: Array<{ label: string; url: string; icon: string }> = [
      { label: 'TikTok', url: profileLinks.tiktok_url, icon: 'logo-tiktok' },
      { label: 'YouTube', url: profileLinks.youtube_url, icon: 'logo-youtube' },
      { label: 'Facebook', url: profileLinks.facebook_url, icon: 'logo-facebook' },
      { label: 'Instagram', url: profileLinks.instagram_url, icon: 'logo-instagram' },
    ].filter((item) => item.url.trim().length > 0);

    const pressLinks = profileLinks.press_links
      .split(/\n|,/)
      .map((link: string) => link.trim())
      .filter(Boolean);

    const textLinks = [...new Set([
      ...extractUrls(profile?.bio),
      ...extractUrls(channel?.description),
    ])];

    if (socialLinks.length === 0 && pressLinks.length === 0 && textLinks.length === 0) {
      return null;
    }

    return (
      <View style={styles.linksSection}>
        <Text style={styles.linksTitle}>{t('profile.linksTitle' as any)}</Text>
        <View style={styles.linkChips}>
          {socialLinks.map((link: { label: string; url: string; icon: string }) => (
            <TouchableOpacity
              key={link.label}
              style={styles.linkChip}
              onPress={() => onWebViewPress?.(link.url, link.label)}
              activeOpacity={0.8}
            >
              <Ionicons name={link.icon as any} size={16} color={colors.tapIn} />
              <Text style={styles.linkChipText}>{link.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {pressLinks.length > 0 && (
          <View style={styles.pressLinksList}>
            <Text style={styles.pressLinksLabel}>{t('profile.sharedLinks' as any)}</Text>
            {pressLinks.map((link: string, index: number) => (
              <TouchableOpacity
                key={`${link}-${index}`}
                style={styles.pressLinkRow}
                onPress={() => onWebViewPress?.(link, `Link ${index + 1}`)}
                activeOpacity={0.8}
              >
                <Ionicons name="link-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.pressLinkText} numberOfLines={1}>{link}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {textLinks.length > 0 && (
          <View style={styles.pressLinksList}>
            <Text style={styles.pressLinksLabel}>{t('profile.linksFromBio' as any)}</Text>
            {textLinks.map((link: string, index: number) => (
              <TouchableOpacity
                key={`${link}-${index}`}
                style={styles.pressLinkRow}
                onPress={() => onWebViewPress?.(link, `Link ${index + 1}`)}
                activeOpacity={0.8}
              >
                <Ionicons name="link-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.pressLinkText} numberOfLines={1}>{link}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  };

  // NOT LOGGED IN
  if (!user) {
    if (!authReady) {
      return (
        <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    }

    return (
      <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.contentContainer}>
        <View style={styles.logoContainer}>
          <View style={styles.logoFallback}>
            <Image source={require('../assets/luku_luku_512.png')} style={styles.logo} contentFit="cover" />
          </View>
        </View>
        <Text style={styles.title}>{t('auth.welcome')}</Text>
        <Text style={styles.subtitle}>{t('auth.subtitle')}</Text>

        <TextInput
          style={styles.loginInput}
          placeholder={t('auth.emailPlaceholder' as any)}
          placeholderTextColor={colors.textTertiary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
        />
        <TextInput
          style={styles.loginInput}
          placeholder={t('auth.passwordPlaceholder' as any)}
          placeholderTextColor={colors.textTertiary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
        />

        <TermsGate />

        <TouchableOpacity style={styles.appleBtn} onPress={handleEmailSignIn} disabled={authSubmitting !== null || !communityTermsAccepted}>
          <Ionicons name="log-in-outline" size={20} color="#FFFFFF" />
          <Text style={styles.appleBtnText}>{authSubmitting === 'signin' ? t('auth.signingIn' as any) : t('auth.signIn' as any)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.googleBtn, { marginTop: 0 }]}
          onPress={handleGoogleSignIn}
          disabled={authSubmitting !== null || !communityTermsAccepted}
        >
          <Ionicons name="logo-google" size={20} color={colors.text} />
          <Text style={styles.googleBtnText}>{authSubmitting === 'google' ? 'Google...' : 'Sign in with Google'}</Text>
        </TouchableOpacity>

        {Platform.OS === 'ios' && appleAuthAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={borderRadius.full}
            style={styles.appleSignInBtn}
            onPress={handleAppleSignIn}
          />
        )}

        <TouchableOpacity
          style={[styles.resendBtn, { marginTop: spacing.sm }]}
          onPress={handleEmailSignUp}
          disabled={authSubmitting !== null || !communityTermsAccepted}
        >
          <Ionicons name="person-add-outline" size={20} color={colors.tapIn} />
          <Text style={styles.resendBtnText}>{authSubmitting === 'signup' ? t('auth.signingUp' as any) : t('auth.signUp' as any)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.forgotBtn}
          onPress={async () => {
            const targetEmail = normalizeEmail(email);
            if (!targetEmail) {
              Alert.alert(t('common.error' as any), t('auth.emailRequired' as any));
              return;
            }
            const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
              redirectTo: 'https://lukuluku.online/reset-password',
            });
            if (error) {
              Alert.alert(t('common.error' as any), error.message);
              return;
            }
            Alert.alert(t('auth.resetPassword' as any), t('auth.resetPasswordDesc' as any));
          }}
        >
          <Text style={styles.forgotBtnText}>{t('auth.forgotPassword' as any)}</Text>
        </TouchableOpacity>

        <LegalLinks />
        <View style={{ height: 40 }} />
      </ScrollView>
    );
  }

  // LOGGED IN
  const tabs: { key: ProfileTab; label: string; count: number }[] = [
    { key: 'videos', label: t('profile.videosTab' as any), count: contentCounts.videos },
    { key: 'momenti', label: t('profile.momentiTab' as any), count: contentCounts.momenti },
    { key: 'bangi', label: t('profile.bangiTab' as any), count: contentCounts.bangi },
  ];

  const shortCardWidth = (width - spacing.lg * 3) / 2;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
          <Ionicons name="log-out-outline" size={20} color={colors.textSecondary} />
          <Text style={styles.signOutText}>{t('settings.signOut' as any)}</Text>
        </TouchableOpacity>
      </View>

      {toast ? (
        <View
          style={[
            styles.toast,
            toast.variant === 'success' && styles.toastSuccess,
            toast.variant === 'error' && styles.toastError,
            toast.variant === 'warning' && styles.toastWarning,
            { top: insets.top + spacing.md },
          ]}
        >
          <Text style={styles.toastText}>{toast.message}</Text>
        </View>
      ) : null}

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Profile Info */}
        <View style={styles.profileSection}>
          {(profile?.avatar_url || user?.picture) ? (
            <Image source={{ uri: profile?.avatar_url || user?.picture }} style={styles.profileAvatar} contentFit="cover" />
          ) : (
            <View style={[styles.profileAvatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={40} color={colors.textTertiary} />
            </View>
          )}
          <View style={styles.nameRow}>
            <Text style={styles.profileName}>{profile?.display_name || user?.name || t('profile.user')}</Text>
            <VerifiedBadge
              isVerified={profile?.is_verified || false}
              verificationType={profile?.verification_type}
              size={18}
            />
          </View>
          <Text style={styles.profileHandle}>@{profile?.username || channel?.handle || ''}</Text>
          <Text style={styles.profileStats}>
            {tapinCount} tapiners · {contentCounts.videos} video's · {contentCounts.momenti} momenti
          </Text>
          {profile?.bio && (
            <LinkedText style={styles.profileBio}>{profile.bio}</LinkedText>
          )}
          {renderProfileLinks()}
        </View>

        {/* LukuLuku Studio Section */}
        <View style={styles.studioSection}>
          <View style={styles.studioHeader}>
            <View style={styles.studioIconContainer}>
              <Ionicons name="videocam" size={20} color={colors.tapIn} />
            </View>
            <Text style={styles.studioTitle}>{t('profile.studioSection' as any)}</Text>
          </View>

          <View style={styles.studioCards}>
            {channel && (
              <TouchableOpacity
                style={styles.studioCard}
                onPress={() => onChannelPress(channel.id)}
              >
                <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                  <Ionicons name="eye" size={22} color="#FF9800" />
                </View>
                <View style={styles.studioCardInfo}>
                  <Text style={styles.studioCardTitle}>{t('profile.channelSettings' as any)}</Text>
                  <Text style={styles.studioCardDesc}>{t('profile.studioDesc')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            )}

            {/* Monetization Status */}
            <View style={styles.studioCard}>
              <View style={[styles.studioCardIcon, { backgroundColor: isMonetized ? colors.surfaceLight : colors.surfaceLight }]}>
                <Ionicons
                  name={isMonetized ? 'cash' : 'lock-closed'}
                  size={22}
                  color={isMonetized ? colors.success : colors.warning}
                />
              </View>
              <View style={styles.studioCardInfo}>
                <Text style={styles.studioCardTitle}>{t('monetization.status' as any)}</Text>
                <Text style={[styles.studioCardDesc, isMonetized && { color: colors.success }]}>
                  {isMonetized ? t('monetization.active' as any) : t('monetization.inactive' as any)}
                </Text>
              </View>
              {isMonetized && (
                <View style={styles.monetizedBadge}>
                  <Text style={styles.monetizedBadgeText}>LIVE</Text>
                </View>
              )}
            </View>

            <TouchableOpacity
              style={styles.studioCard}
              onPress={() => {
                if (!canAccessWallet) {
                  Alert.alert(t('monetization.walletLockedTitle' as any), t('monetization.walletLockedDesc' as any));
                  return;
                }
                setShowWalletModal(true);
              }}
            >
              <View style={[styles.studioCardIcon, { backgroundColor: canAccessWallet ? colors.surfaceLight : colors.surfaceLight }]}>
                <Ionicons name={canAccessWallet ? 'card-outline' : 'lock-closed-outline'} size={22} color={canAccessWallet ? colors.tapIn : colors.textTertiary} />
              </View>
              <View style={styles.studioCardInfo}>
                <Text style={styles.studioCardTitle}>
                  {canAccessWallet
                    ? (walletData
                        ? (walletData.walletType === 'bep20_usdt'
                            ? t('monetization.walletTypeBep20' as any)
                            : t('monetization.walletTypeUni5Pay' as any))
                        : t('monetization.walletTitle' as any))
                    : t('monetization.walletLockedTitle' as any)}
                </Text>
                <Text style={styles.studioCardDesc}>
                  {canAccessWallet
                    ? (walletData
                        ? (walletData.walletType === 'bep20_usdt'
                            ? `${walletData.walletAddress || walletData.walletNumber} · ${walletData.accountHolder}`
                            : `Uni5Pay ****${walletData.walletNumber?.slice(-4) || '----'} · ${walletData.accountHolder}`)
                        : t('monetization.walletDesc' as any))
                    : t('monetization.walletLockedUntil' as any)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.studioCard}
              onPress={() => onAdvertisePress?.()}
            >
              <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                <Ionicons name="megaphone" size={22} color={colors.tapIn} />
              </View>
              <View style={styles.studioCardInfo}>
                <Text style={styles.studioCardTitle}>{t('create.advertise' as any)}</Text>
                <Text style={styles.studioCardDesc}>{t('create.advertiseDesc' as any)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Tapin Progress */}
            {!isMonetized && (
              <View style={styles.studioCard}>
                <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                  <Ionicons name="trending-up" size={22} color={colors.tapIn} />
                </View>
                <View style={[styles.studioCardInfo, { gap: 6 }]}>
                  <Text style={styles.studioCardTitle}>{t('monetization.tapinProgress' as any)}</Text>
                  <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${tapinProgress * 100}%` }]} />
                  </View>
                  <Text style={styles.studioCardDesc}>
                    {tapinCount} / {tapinGoal} tapins
                    {tapinCount >= tapinGoal ? ` - ${t('monetization.tapinReached' as any)}` : ''}
                  </Text>
                </View>
              </View>
            )}

            {/* Revenue Share (only when monetized) */}
            {isMonetized && (
              <View style={styles.studioCard}>
                <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                  <Ionicons name="pie-chart" size={22} color="#9C27B0" />
                </View>
                <View style={styles.studioCardInfo}>
                  <Text style={styles.studioCardTitle}>{t('monetization.revenueShare' as any)}</Text>
                  <Text style={styles.studioCardDesc}>
                    Creator share: {creatorSharePct}%
                  </Text>
                  <Text style={[styles.studioCardDesc, { marginTop: 2 }]}>
                    Platform/admin reserve: {platformReservePct}%
                  </Text>
                  {founderBonusPct > 0 && (
                    <Text style={[styles.studioCardDesc, { marginTop: 2 }]}>
                      Founder bonus: {founderBonusPct}% uit de platform reserve
                    </Text>
                  )}
                  <Text style={[styles.studioCardDesc, { marginTop: 2, fontWeight: '600', color: colors.text }]}>
                    Netto platform/admin na founder bonus: {platformNetPct}%
                  </Text>
                </View>
              </View>
            )}

            {/* Balance (only when monetized) */}
            {canAccessWallet && (
              <View style={styles.studioCard}>
                <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                  <Ionicons name="wallet" size={22} color={colors.success} />
                </View>
                <View style={styles.studioCardInfo}>
                  <Text style={styles.studioCardTitle}>{t('monetization.balance' as any)}</Text>
                  <Text style={[styles.studioCardDesc, { fontSize: fontSize.lg, fontWeight: '700', color: colors.text }]}>
                    SRD {walletBalance.toFixed(2)}
                  </Text>
                  <Text style={[styles.studioCardDesc, { marginTop: 2 }]}>
                    {t('profile.withdrawThreshold' as any)}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.withdrawInlineBtn, !canRequestWithdrawal && styles.withdrawInlineBtnDisabled]}
                  onPress={() => {
                    if (!canRequestWithdrawal) {
                      Alert.alert('Withdraw', 'You can withdraw once your balance reaches SRD 100 or more.');
                      return;
                    }
                    setShowWithdrawModal(true);
                  }}
                  disabled={!canRequestWithdrawal}
                >
                  <Ionicons name="download-outline" size={16} color={colors.textInverse} />
                  <Text style={styles.withdrawInlineBtnText}>Withdraw</Text>
                </TouchableOpacity>
              </View>
            )}

            {canAccessWallet && withdrawals && withdrawals.length > 0 && (
              <View style={styles.withdrawalHistory}>
                <Text style={styles.withdrawalHistoryTitle}>{t('profile.withdrawalHistory' as any)}</Text>
                {withdrawals.slice(0, 3).map((withdrawal: WithdrawalRow) => (
                  <View key={withdrawal.id} style={styles.withdrawalRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.withdrawalAmount}>
                      SRD {Number(withdrawal.amount ?? 0).toFixed(2)}
                     </Text>
                      <Text style={styles.withdrawalDate}>
                        Invoice {withdrawal.invoice_number || '—'} · {withdrawal.status}
                      </Text>
                      <Text style={styles.withdrawalDate}>
                        Methode: {withdrawal.method}
                      </Text>
                    </View>
                    <View style={styles.withdrawalStatusBadge}>
                      <Text style={styles.withdrawalStatusText}>{withdrawal.status}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <TouchableOpacity
              style={styles.studioCard}
              activeOpacity={0.85}
              onPress={() => setShowVerificationModal(true)}
            >
              <View style={[styles.studioCardIcon, { backgroundColor: colors.surfaceLight }]}>
                <Ionicons name="checkmark-circle" size={22} color={colors.tapIn} />
              </View>
              <View style={styles.studioCardInfo}>
                <Text style={styles.studioCardTitle}>{t('profile.verificationTitle' as any)}</Text>
                <Text style={styles.studioCardDesc} numberOfLines={2}>
                  {t('profile.verificationCardDesc')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            <View style={styles.verificationSafetySection}>
              <Text style={styles.verificationSafetyLabel}>Verification & safety</Text>
              <CommunitySafetyTools userId={profile?.user_id || user?.id || null} />
            </View>

          </View>
        </View>

        {/* Verification Modal */}
        <Modal
          visible={showVerificationModal}
          transparent
          animationType="slide"
          onRequestClose={() => setShowVerificationModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { paddingBottom: 40 + insets.bottom }]}>
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.lg }}>
                <View style={styles.modalHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
                    <View style={styles.verificationHeaderIcon}>
                      <Ionicons name="checkmark-circle" size={20} color={colors.tapIn} />
                    </View>
                    <View style={styles.verificationHeaderText}>
                      <Text style={styles.verificationHeaderTitle}>{t('profile.verificationTitle' as any)}</Text>
                      <Text style={styles.verificationHeaderSubtitle}>{t('profile.verificationIntro' as any)}</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => setShowVerificationModal(false)}>
                    <Ionicons name="close" size={24} color={colors.text} />
                  </TouchableOpacity>
                </View>

                {verificationStatus === 'verified' ? (
                  <View style={[styles.verificationStatusGrid, styles.verificationStatusVerifiedCard]}>
                    <View style={[styles.verificationStatusIcon, styles.verificationStatusVerifiedIcon]}>
                      <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                    </View>
                    <View style={styles.verificationStatusContent}>
                      <Text style={styles.verificationStatusTitle}>{t('profile.verificationVerifiedTitle' as any)}</Text>
                      <Text style={styles.verificationStatusText}>{t('profile.verificationVerifiedDesc' as any)}</Text>
                    </View>
                  </View>
                ) : (
                  <>
                    {verificationStatus !== 'none' && (
                      <View
                        style={[
                          styles.verificationStatusGrid,
                          verificationStatus === 'pending' && styles.verificationStatusPendingCard,
                          verificationStatus === 'approved' && styles.verificationStatusApprovedCard,
                          verificationStatus === 'rejected' && styles.verificationStatusRejectedCard,
                        ]}
                      >
                        <View
                          style={[
                            styles.verificationStatusIcon,
                            verificationStatus === 'pending' && styles.verificationStatusPendingIcon,
                            verificationStatus === 'approved' && styles.verificationStatusApprovedIcon,
                            verificationStatus === 'rejected' && styles.verificationStatusRejectedIcon,
                          ]}
                        >
                          <Ionicons
                            name="checkmark-circle"
                            size={22}
                            color={
                              verificationStatus === 'pending'
                                ? colors.warning
                                : verificationStatus === 'approved'
                                  ? colors.success
                                  : colors.error
                            }
                          />
                        </View>
                        <View style={styles.verificationStatusContent}>
                          <Text style={styles.verificationStatusTitle}>
                            {verificationStatus === 'pending'
                              ? t('profile.verificationPendingTitle' as any)
                              : verificationStatus === 'approved'
                                ? t('profile.verificationApprovedTitle' as any)
                                : t('profile.verificationRejectedTitle' as any)}
                          </Text>
                          <Text style={styles.verificationStatusText}>
                            {verificationStatus === 'pending'
                              ? t('profile.verificationPendingDesc' as any)
                              : verificationStatus === 'approved'
                                ? t('profile.verificationApprovedDesc' as any)
                                : t('profile.verificationRejectedDesc' as any)}
                          </Text>
                        </View>
                      </View>
                    )}

                    {verificationStatus !== 'pending' && verificationStatus !== 'approved' && verificationStatus !== 'verified' && (
                      <View style={styles.verificationFormCard}>
                        <View style={styles.verificationSectionHeader}>
                          <Text style={styles.verificationSectionTitle}>{t('profile.verificationAboutLabel' as any)}</Text>
                          <Text style={styles.verificationSectionHelp}>{t('profile.verificationAboutPlaceholder' as any)}</Text>
                        </View>

                        <View style={styles.verificationFieldGroup}>
                          <Text style={styles.verificationFieldLabel}>{t('profile.verificationAboutLabel' as any)}</Text>
                          <TextInput
                            style={[styles.verificationInput, styles.verificationTextarea]}
                            value={verificationForm.about}
                            onChangeText={(value: string) =>
                              setVerificationForm((prev: VerificationFormState) => ({ ...prev, about: value }))
                            }
                            placeholder={t('profile.verificationAboutPlaceholder' as any)}
                            placeholderTextColor={colors.textTertiary}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                          />
                        </View>

                        <View style={styles.verificationFieldGroup}>
                          <Text style={styles.verificationFieldLabel}>{t('profile.verificationMessageLabel' as any)}</Text>
                          <TextInput
                            style={[styles.verificationInput, styles.verificationTextarea]}
                            value={verificationForm.message}
                            onChangeText={(value: string) =>
                              setVerificationForm((prev: VerificationFormState) => ({ ...prev, message: value }))
                            }
                            placeholder={t('profile.verificationMessagePlaceholder' as any)}
                            placeholderTextColor={colors.textTertiary}
                            multiline
                            numberOfLines={3}
                            textAlignVertical="top"
                          />
                        </View>

                        <View style={styles.verificationSectionHeader}>
                          <Text style={styles.verificationSectionTitle}>{t('profile.verificationSocialSection' as any)}</Text>
                          <Text style={styles.verificationSectionHelp}>{t('profile.verificationSocialHelp' as any)}</Text>
                        </View>

                        <View style={styles.verificationGrid}>
                          <View style={styles.verificationGridItem}>
                            <Text style={styles.verificationFieldLabel}>{t('profile.verificationTikTok' as any)}</Text>
                            <TextInput
                              style={styles.verificationInput}
                              value={verificationForm.tiktok_url}
                              onChangeText={(value: string) =>
                                setVerificationForm((prev: VerificationFormState) => ({ ...prev, tiktok_url: value }))
                              }
                              placeholder={t('profile.verificationTiktokPlaceholder' as any)}
                              placeholderTextColor={colors.textTertiary}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </View>
                          <View style={styles.verificationGridItem}>
                            <Text style={styles.verificationFieldLabel}>{t('profile.verificationYouTube' as any)}</Text>
                            <TextInput
                              style={styles.verificationInput}
                              value={verificationForm.youtube_url}
                              onChangeText={(value: string) =>
                                setVerificationForm((prev: VerificationFormState) => ({ ...prev, youtube_url: value }))
                              }
                              placeholder={t('profile.verificationYoutubePlaceholder' as any)}
                              placeholderTextColor={colors.textTertiary}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </View>
                          <View style={styles.verificationGridItem}>
                            <Text style={styles.verificationFieldLabel}>{t('profile.verificationFacebook' as any)}</Text>
                            <TextInput
                              style={styles.verificationInput}
                              value={verificationForm.facebook_url}
                              onChangeText={(value: string) =>
                                setVerificationForm((prev: VerificationFormState) => ({ ...prev, facebook_url: value }))
                              }
                              placeholder={t('profile.verificationFacebookPlaceholder' as any)}
                              placeholderTextColor={colors.textTertiary}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </View>
                          <View style={styles.verificationGridItem}>
                            <Text style={styles.verificationFieldLabel}>{t('profile.verificationInstagram' as any)}</Text>
                            <TextInput
                              style={styles.verificationInput}
                              value={verificationForm.instagram_url}
                              onChangeText={(value: string) =>
                                setVerificationForm((prev: VerificationFormState) => ({ ...prev, instagram_url: value }))
                              }
                              placeholder={t('profile.verificationInstagramPlaceholder' as any)}
                              placeholderTextColor={colors.textTertiary}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          </View>
                        </View>

                        <View style={styles.verificationFieldGroup}>
                          <Text style={styles.verificationFieldLabel}>{t('profile.verificationPressSection' as any)}</Text>
                          <Text style={styles.verificationSectionHelp}>{t('profile.verificationPressHelp' as any)}</Text>
                          <TextInput
                            style={[styles.verificationInput, styles.verificationTextarea]}
                            value={verificationForm.press_links}
                            onChangeText={(value: string) =>
                              setVerificationForm((prev: VerificationFormState) => ({ ...prev, press_links: value }))
                            }
                            placeholder={t('profile.verificationPressPlaceholder' as any)}
                            placeholderTextColor={colors.textTertiary}
                            multiline
                            numberOfLines={3}
                            textAlignVertical="top"
                          />
                        </View>

                        <TouchableOpacity
                          style={[styles.verificationSubmitBtn, verificationSubmitting && styles.verificationSubmitBtnDisabled]}
                          onPress={handleVerificationRequest}
                          disabled={verificationSubmitting}
                        >
                          {verificationSubmitting ? (
                            <ActivityIndicator size="small" color={colors.textInverse} />
                          ) : (
                            <>
                              <Ionicons name="send" size={18} color={colors.textInverse} />
                              <Text style={styles.verificationSubmitText}>{t('profile.verificationSubmit' as any)}</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {tappedChannels.length > 0 && (
          <View style={styles.tappedSection}>
            <Text style={styles.tappedTitle}>{t('profile.tappedChannels' as any)}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tappedScroll}>
              {tappedChannels.map((tappedChannel: Channel) => (
                <TouchableOpacity
                  key={tappedChannel.id}
                  style={styles.tappedCard}
                  onPress={() => onChannelPress(tappedChannel.id)}
                  activeOpacity={0.8}
                >
                  {tappedChannel.avatar_url ? (
                    <Image source={{ uri: tappedChannel.avatar_url }} style={styles.tappedAvatar} contentFit="cover" />
                  ) : (
                    <View style={[styles.tappedAvatar, styles.avatarPlaceholder]}>
                      <Ionicons name="person" size={18} color={colors.textTertiary} />
                    </View>
                  )}
                  <Text style={styles.tappedName} numberOfLines={1}>{tappedChannel.name}</Text>
                  <Text style={styles.tappedMeta}>
                    {(tappedChannel.tapiners ?? 0)} tapiners
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Content Tabs */}
        <View style={styles.tabs}>
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
                {tab.label} ({tab.count})
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab Content: Videos */}
        {activeTab === 'videos' && (
          <View style={styles.videosList}>
            {myVideos.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="videocam-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('profile.noVideos' as any)}</Text>
              </View>
            ) : (
              myVideos.map((video: Video) => (
                <TouchableOpacity
                  key={video.id}
                  style={styles.videoRow}
                  onPress={() => onVideoPress(video)}
                >
                  {video.thumbnail_url ? (
                    <Image source={{ uri: video.thumbnail_url }} style={styles.videoThumb} contentFit="cover" />
                  ) : (
                    <View style={[styles.videoThumb, styles.thumbPlaceholder]}>
                      <Ionicons name="play-circle" size={20} color={colors.textTertiary} />
                    </View>
                  )}
                  <View style={styles.videoRowInfo}>
                    <Text style={styles.videoRowTitle} numberOfLines={2}>{video.title}</Text>
                    <Text style={styles.videoRowMeta}>
                      {formatViews(video.views)} {t('video.views')} · {formatTimeAgo(video.created_at)}
                    </Text>
                    <View style={styles.videoRowStats}>
                      <Ionicons name="heart" size={12} color={colors.textTertiary} />
                      <Text style={styles.videoRowStatText}>{video.likes}</Text>
                      <Ionicons name="eye" size={12} color={colors.textTertiary} />
                      <Text style={styles.videoRowStatText}>{video.views}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* Tab Content: Momenti */}
        {activeTab === 'momenti' && (
          <View style={styles.shortsGrid}>
            {myShorts.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="flash-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('profile.noMomenti' as any)}</Text>
              </View>
            ) : (
              myShorts.map((short: Short & { duration?: number | null }) => {
                const durationText = short.duration ? formatDuration(short.duration) : '';
                return (
                  <TouchableOpacity
                    key={short.id}
                    style={{ width: shortCardWidth }}
                    onPress={() => onMomentiPress({ ...short, is_short: true } as Video)}
                    activeOpacity={0.8}
                  >
                    <View style={{ position: 'relative' }}>
                      {short.thumbnail_url ? (
                        <Image source={{ uri: short.thumbnail_url }} style={{ width: shortCardWidth, height: shortCardWidth * 1.5, borderRadius: borderRadius.md }} contentFit="cover" />
                      ) : (
                        <View style={{ width: shortCardWidth, height: shortCardWidth * 1.5, borderRadius: borderRadius.md, backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center' }}>
                          <Ionicons name="play" size={24} color={colors.textTertiary} />
                        </View>
                      )}
                      {durationText ? (
                        <View style={styles.shortDurationBadge}>
                          <Text style={styles.shortDurationText}>{durationText}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.shortTitle} numberOfLines={2}>{short.title}</Text>
                    <Text style={styles.shortMeta}>{formatViews(short.views)} {t('video.views')}</Text>
                  </TouchableOpacity>
                )
              })
            )}
          </View>
        )}

        {/* Tab Content: Bangi */}
        {activeTab === 'bangi' && (
          <View style={styles.postsList}>
            {myPosts.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="chatbubbles-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('profile.noBangi' as any)}</Text>
              </View>
            ) : (
              myPosts.map((post: PostWithMeta) => (
                <TouchableOpacity
                  key={post.id}
                  style={styles.postCard}
                  onPress={() => onPostPress?.(post.id)}
                  activeOpacity={0.7}
                >
                  <View style={styles.postHeader}>
                    {(profile?.avatar_url || channel?.avatar_url) ? (
                      <Image source={{ uri: profile?.avatar_url || channel?.avatar_url || '' }} style={styles.postAvatar} contentFit="cover" />
                    ) : (
                      <View style={[styles.postAvatar, styles.avatarPlaceholder]}>
                        <Ionicons name="person" size={14} color={colors.textTertiary} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Text style={styles.postAuthorName}>{channel?.name || profile?.display_name || ''}</Text>
                        <VerifiedBadge
                          isVerified={profile?.is_verified || false}
                          verificationType={profile?.verification_type}
                          size={14}
                        />
                      </View>
                      <Text style={styles.postDate}>{formatTimeAgo(post.created_at)}</Text>
                    </View>
                  </View>
                  {post.image_url ? (
                    <Text style={styles.postContent}>{post.content}</Text>
                  ) : (
                    <View style={[styles.textOnlyPostCard, { backgroundColor: post.background_color || colors.surface }]}>
                      <Text style={[styles.textOnlyPostText, { color: post.text_color || colors.text }]}>
                        {post.content}
                      </Text>
                    </View>
                  )}
                  {post.image_url ? (
                    <Image
                      source={{ uri: post.image_url }}
                      style={styles.postImage}
                      contentFit="cover"
                      transition={200}
                    />
                  ) : (
                    <View style={[styles.postImage, { backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center' }]}>
                      <Ionicons name="image-outline" size={32} color={colors.textTertiary} />
                    </View>
                  )}
                  <View style={styles.postFooter}>
                    <Ionicons name="heart-outline" size={16} color={colors.textSecondary} />
                    <Text style={styles.postLikes}>{post.likes}</Text>
                    <View style={{ width: spacing.md }} />
                    <Ionicons name="chatbubble-outline" size={14} color={colors.textSecondary} />
                    <Text style={styles.postLikes}>{post.commentCount || 0}</Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        <LegalLinks />
        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Wallet Modal */}
      <Modal
        visible={showWalletModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowWalletModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: 40 + insets.bottom }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('monetization.walletTitle' as any)}</Text>
              <TouchableOpacity onPress={() => setShowWalletModal(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalDesc}>{t('monetization.walletDesc' as any)}</Text>

            <View style={styles.bankInfoBanner}>
              <Ionicons name="business" size={20} color={colors.tapIn} />
              <Text style={styles.bankInfoText}>{uni5payLabel}</Text>
            </View>

            <Text style={styles.modalLabel}>{t('monetization.walletTypeLabel' as any)}</Text>
            <View style={styles.walletTypeRow}>
              <TouchableOpacity
                style={[styles.walletTypePill, walletType === 'uni5pay' && styles.walletTypePillActive]}
                onPress={() => setWalletType('uni5pay')}
              >
                <Text style={[styles.walletTypePillText, walletType === 'uni5pay' && styles.walletTypePillTextActive]}>
                  {t('monetization.walletTypeUni5Pay' as any)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.walletTypePill, walletType === 'bep20_usdt' && styles.walletTypePillActive]}
                onPress={() => setWalletType('bep20_usdt')}
              >
                <Text style={[styles.walletTypePillText, walletType === 'bep20_usdt' && styles.walletTypePillTextActive]}>
                  {t('monetization.walletTypeBep20' as any)}
                </Text>
              </TouchableOpacity>
            </View>

            {walletType === 'uni5pay' ? (
              <>
                <Text style={styles.modalLabel}>{t('monetization.walletNumber' as any)}</Text>
                <TextInput
                  style={[styles.modalInput, { minHeight: 48 }]}
                  value={walletNumber}
                  onChangeText={setWalletNumber}
                  placeholder={t('monetization.walletNumberPlaceholder' as any)}
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="number-pad"
                />
              </>
            ) : (
              <>
                <Text style={styles.modalLabel}>{t('monetization.walletAddress' as any)}</Text>
                <TextInput
                  style={[styles.modalInput, { minHeight: 48 }]}
                  value={walletAddress}
                  onChangeText={setWalletAddress}
                  placeholder={t('monetization.walletAddressPlaceholder' as any)}
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            )}

            <Text style={styles.modalLabel}>{t('monetization.accountHolder' as any)}</Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 48 }]}
              value={accountHolder}
              onChangeText={setAccountHolder}
              placeholder={t('monetization.accountHolderPlaceholder' as any)}
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="words"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowWalletModal(false)}
              >
                <Text style={styles.modalCancelText}>{t('profile.cancel' as any)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalSubmitBtn,
                  (walletType === 'bep20_usdt' ? !walletAddress.trim() : !walletNumber.trim()) || !accountHolder.trim()
                    ? { opacity: 0.4 }
                    : null,
                ]}
                onPress={handleSaveWallet}
                disabled={walletSaving || !accountHolder.trim() || !(walletType === 'bep20_usdt' ? walletAddress.trim() : walletNumber.trim())}
              >
                {walletSaving ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={styles.modalSubmitText}>{t('monetization.saveWallet' as any)}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Withdraw Modal */}
      <Modal
        visible={showWithdrawModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowWithdrawModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: 40 + insets.bottom }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('monetization.withdrawTitle' as any)}</Text>
              <TouchableOpacity onPress={() => setShowWithdrawModal(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalDesc}>{t('monetization.withdrawDesc' as any)}</Text>

            <View style={styles.balanceDisplay}>
              <Text style={styles.balanceLabel}>{t('monetization.balance' as any)}</Text>
              <Text style={styles.balanceAmount}>SRD {walletBalance.toFixed(2)}</Text>
            </View>

            {lastInvoiceNumber ? (
              <View style={styles.bankInfoBanner}>
                <Ionicons name="document-text" size={20} color={colors.tapIn} />
                <Text style={styles.bankInfoText}>Latest invoice: {lastInvoiceNumber}</Text>
              </View>
            ) : null}

            {walletData && (
              <View style={styles.bankInfoBanner}>
                <Ionicons name="card" size={20} color={colors.tapIn} />
                <Text style={styles.bankInfoText}>
                  {walletData.walletType === 'bep20_usdt'
                    ? `${walletData.walletAddress || walletData.walletNumber} · ${walletData.accountHolder}`
                    : `Uni5Pay ****${walletData.walletNumber?.slice(-4) || '----'} · ${walletData.accountHolder}`}
                </Text>
              </View>
            )}

            <View style={styles.withdrawPreviewCard}>
              <View style={styles.withdrawPreviewHeader}>
                <Image source={require('../assets/luku_luku_512.png')} style={styles.withdrawPreviewLogo} contentFit="cover" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.withdrawPreviewTitle}>Invoice preview</Text>
                  <Text style={styles.withdrawPreviewSubText}>Paid out by LukuLuku NV</Text>
                </View>
              </View>
              <Text style={styles.withdrawPreviewText}>Invoice number: {previewInvoiceNumber}</Text>
              <Text style={styles.withdrawPreviewText}>Company: LukuLuku NV</Text>
              <Text style={styles.withdrawPreviewText}>Gross: SRD {previewAmount.toFixed(2)}</Text>
              <Text style={styles.withdrawPreviewText}>Net: SRD {previewNetAmount.toFixed(2)}</Text>
              <Text style={styles.withdrawPreviewText}>Recipient: {receiptRecipientEmail || 'after withdrawal to the registered email'}</Text>
              <Text style={styles.withdrawPreviewText}>Status: withdrawal invoice being prepared</Text>
              <Text style={styles.withdrawPreviewText}>Threshold: SRD 100.00</Text>
            </View>

            <Text style={styles.modalLabel}>{t('monetization.withdrawAmount' as any)}</Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 48 }]}
              value={withdrawAmount}
              onChangeText={setWithdrawAmount}
              placeholder={t('monetization.withdrawAmountPlaceholder' as any)}
              placeholderTextColor={colors.textTertiary}
              keyboardType="decimal-pad"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowWithdrawModal(false)}
              >
                <Text style={styles.modalCancelText}>{t('profile.cancel' as any)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, (!withdrawAmount.trim()) && { opacity: 0.4 }]}
                onPress={handleWithdraw}
                disabled={!withdrawAmount.trim() || withdrawing || sendingReceipt}
              >
                {withdrawing || sendingReceipt ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={styles.modalSubmitText}>{t('monetization.withdrawSubmit' as any)}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  headerTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  signOutText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 50,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  toastSuccess: {
    borderColor: colors.success,
  },
  toastError: {
    borderColor: colors.error,
  },
  toastWarning: {
    borderColor: colors.warning,
  },
  toastText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  contentContainer: {
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingTop: 60,
    gap: spacing.lg,
  },
  logoContainer: { alignItems: 'center', marginBottom: 20 },
  logo: { width: 120, height: 120, borderRadius: 60 },
  logoFallback: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '700', textAlign: 'center' },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: spacing.xxl,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    width: '100%',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  googleBtnText: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  resendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.xxl,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    width: '100%',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  resendBtnText: { color: colors.tapIn, fontSize: fontSize.md, fontWeight: '600' },
  loginInput: {
    width: '100%',
    backgroundColor: colors.surfaceLight,
    color: colors.text,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    fontSize: fontSize.md,
  },
  appleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.xxl,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    width: '100%',
    justifyContent: 'center',
  },
  appleBtnText: { color: '#000000', fontSize: fontSize.md, fontWeight: '600' },
  appleSignInBtn: { width: '100%', height: 48, marginTop: spacing.lg },
  profileSection: { alignItems: 'center', paddingVertical: spacing.xl },
  profileAvatar: { width: 80, height: 80, borderRadius: 40 },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  profileName: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  profileHandle: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: 4 },
  profileStats: { color: colors.textSecondary, fontSize: fontSize.sm, marginTop: 4 },
  profileBio: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xxl,
    lineHeight: 22,
  },
  verificationSection: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  verificationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  verificationHeaderIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verificationHeaderText: {
    flex: 1,
  },
  verificationHeaderTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  verificationHeaderSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  verificationLoadingCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verificationStatusGrid: {
    gap: spacing.sm,
  },
  verificationStatusContent: {
    gap: spacing.sm,
  },
  verificationStatusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
  },
  verificationStatusPendingCard: {
    borderColor: colors.warning,
  },
  verificationStatusApprovedCard: {
    borderColor: colors.success,
  },
  verificationStatusRejectedCard: {
    borderColor: colors.error,
  },
  verificationStatusVerifiedCard: {
    borderColor: colors.success,
  },
  verificationStatusIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verificationStatusPendingIcon: {
    backgroundColor: colors.surfaceLight,
  },
  verificationStatusApprovedIcon: {
    backgroundColor: colors.tapIn,
  },
  verificationStatusRejectedIcon: {
    backgroundColor: '#E54B4B',
  },
  verificationStatusVerifiedIcon: {
    backgroundColor: colors.tapIn,
  },
  verificationStatusTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  verificationStatusText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  verificationFormCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    gap: spacing.md,
  },
  verificationFieldGroup: {
    gap: spacing.sm,
  },
  verificationSectionHeader: {
    gap: 4,
  },
  verificationSectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  verificationSectionHelp: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  verificationFieldLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  verificationInput: {
    backgroundColor: colors.surfaceLight,
    color: colors.text,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
  },
  verificationTextarea: {
    minHeight: 120,
  },
  verificationGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  verificationGridItem: {
    width: '48%',
    gap: spacing.sm,
  },
  verificationSubmitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.tapIn,
    borderRadius: borderRadius.full,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  verificationSubmitBtnDisabled: {
    opacity: 0.7,
  },
  verificationSubmitText: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  // Studio section
  studioSection: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  studioHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  studioIconContainer: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
  },
  studioTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  studioCards: {
    gap: spacing.sm,
  },
  tappedSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    marginBottom: spacing.sm,
  },
  tappedTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  tappedScroll: {
    gap: spacing.md,
  },
  tappedCard: {
    width: 92,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
  },
  tappedAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    marginBottom: spacing.xs,
  },
  tappedName: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
  },
  tappedMeta: {
    color: colors.textTertiary,
    fontSize: 10,
    textAlign: 'center',
    marginTop: 2,
  },
  studioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  studioCardIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  studioCardInfo: { flex: 1 },
  studioCardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  studioCardDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    marginTop: spacing.sm,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.tapIn,
  },
  tabText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '500' },
  tabTextActive: { color: colors.text, fontWeight: '700' },
  // Videos
  videosList: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  videoRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  videoThumb: { width: 140, height: 79, borderRadius: borderRadius.md },
  thumbPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoRowInfo: { flex: 1, justifyContent: 'center' },
  videoRowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '500', lineHeight: 20 },
  videoRowMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },
  videoRowStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  videoRowStatText: { color: colors.textTertiary, fontSize: fontSize.xs },
  // Shorts
  shortsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },
  shortTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '500', marginTop: 4 },
  shortMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  shortDurationBadge: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  shortDurationText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  // Posts
  postsList: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  postCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  postAvatar: { width: 36, height: 36, borderRadius: 18 },
  postAuthorName: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  postDate: { color: colors.textTertiary, fontSize: fontSize.xs },
  postContent: { color: colors.text, fontSize: fontSize.md, lineHeight: 22 },
  textOnlyPostCard: {
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginTop: spacing.md,
    minHeight: 180,
    justifyContent: 'center',
  },
  textOnlyPostText: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    lineHeight: 28,
  },
  postPollCard: {
    marginTop: spacing.md,
    padding: spacing.md,
  },
  postImage: {
    width: '100%',
    height: 200,
    borderRadius: borderRadius.md,
    marginTop: spacing.md,
  },
  postFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  postLikes: { color: colors.textSecondary, fontSize: fontSize.sm },
  // Empty state
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
    gap: spacing.md,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    textAlign: 'center',
  },
  // Legal
  legalSection: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, marginTop: spacing.md },
  legalTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', marginBottom: spacing.sm },
  languageDesc: { color: colors.textSecondary, fontSize: fontSize.sm, marginBottom: spacing.sm },
  languageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  languagePill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  languagePillActive: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  languagePillText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  languagePillTextActive: { color: '#FFFFFF' },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  legalText: { color: colors.textSecondary, fontSize: fontSize.md, flex: 1 },
  termsGateCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    gap: spacing.sm,
  },
  termsGateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  termsGateText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
    lineHeight: 20,
  },
  termsGateNote: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  linksSection: {
    width: '100%',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  linksTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  linkChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  linkChipText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  pressLinksList: {
    gap: spacing.xs,
  },
  pressLinksLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  pressLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressLinkText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.xl,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  modalDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  modalLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  modalInput: {
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
    minHeight: 120,
    marginBottom: spacing.lg,
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
  },
  modalCancelText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  modalSubmitBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
    alignItems: 'center',
  },
  modalSubmitText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  // Monetization
  monetizedBadge: {
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  monetizedBadgeText: {
    color: colors.success,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  progressBarContainer: {
    height: 8,
    backgroundColor: colors.surfaceLight,
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  progressBar: {
    height: 8,
    backgroundColor: colors.tapIn,
    borderRadius: 4,
  },
  bankInfoBanner: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.sm,
    backgroundColor: colors.surfaceLight,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.lg,
  },
  bankInfoText: {
    color: colors.tapIn,
    fontSize: fontSize.md,
    fontWeight: '600',
    flex: 1,
  },
  balanceDisplay: {
    alignItems: 'center' as const,
    padding: spacing.lg,
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.lg,
  },
  balanceLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  balanceAmount: {
    color: colors.text,
    fontSize: fontSize.xxxl,
    fontWeight: '700',
    marginTop: 4,
  },
  withdrawPreviewCard: {
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  withdrawPreviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  withdrawPreviewLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  withdrawPreviewTitle: {
    color: colors.tapIn,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  withdrawPreviewSubText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  withdrawPreviewText: {
    color: colors.text,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  withdrawalHistory: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  withdrawalHistoryTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  withdrawalRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  withdrawalAmount: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  withdrawalDate: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  withdrawalStatusBadge: {
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  withdrawalStatusText: {
    color: colors.warning,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  withdrawInlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
  },
  withdrawInlineBtnDisabled: {
    backgroundColor: colors.textTertiary,
  },
  withdrawInlineBtnText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  forgotBtn: {
    backgroundColor: colors.surfaceLight,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  forgotBtnText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  walletTypeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  walletTypePill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surfaceLight,
  },
  walletTypePillActive: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  walletTypePillText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  walletTypePillTextActive: {
    color: colors.textInverse,
  },
  verificationSafetySection: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  verificationSafetyLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    letterSpacing: 0.2,
    paddingHorizontal: spacing.xs,
  },
});

export default React.memo(ProfileScreen);
