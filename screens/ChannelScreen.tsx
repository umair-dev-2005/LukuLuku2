import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Alert,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews, formatTimeAgo } from '../lib/utils';
import { supabase, Channel, Video, Short, CommunityPost, Profile } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';
import { getCurrentSupabaseUserId } from '../lib/auth';
import LinkedText from '../components/LinkedText';
import RankAuraAvatar from '../components/RankAuraAvatar';
import { useRankBadges, getAvatarBadge } from '../hooks/useRankBadges';
import { blockUser, loadBlockedUserIds, subscribeCommunitySafetyChanges } from '../lib/communitySafety';

const { width } = Dimensions.get('window');

interface ChannelScreenProps {
  channelId: string;
  onBack: () => void;
  onVideoPress: (video: Video) => void;
  onPostPress?: (postId: string) => void;
  onWebViewPress?: (url: string, title: string) => void;
}

type Tab = 'videos' | 'momenti' | 'bangi';

interface PostWithMeta extends CommunityPost {
  commentCount?: number;
}

interface ProfileLinksState {
  tiktok_url: string;
  youtube_url: string;
  facebook_url: string;
  instagram_url: string;
  press_links: string;
}

const emptyProfileLinks: ProfileLinksState = {
  tiktok_url: '',
  youtube_url: '',
  facebook_url: '',
  instagram_url: '',
  press_links: '',
};

export default function ChannelScreen({ channelId, onBack, onVideoPress, onPostPress, onWebViewPress }: ChannelScreenProps) {
  const insets = useSafeAreaInsets();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [shorts, setShorts] = useState<Short[]>([]);
  const [posts, setPosts] = useState<PostWithMeta[]>([]);
  const [tips, setTips] = useState<{ id: string; from_name: string | null; amount_srd: number; message: string | null; created_at: string }[]>([]);
  const [tiers, setTiers] = useState<{ id: string; tier_name: string; monthly_amount_srd: number; perks: string | null; enabled: boolean }[]>([]);
  const [activeMembership, setActiveMembership] = useState<{ status: string; tier_id: string } | null>(null);
  const [tipAmount, setTipAmount] = useState('25');
  const [tipName, setTipName] = useState('');
  const [tipMessage, setTipMessage] = useState('');
  const [tipReference, setTipReference] = useState('');
  const [tierReference, setTierReference] = useState('');
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [showTipForm, setShowTipForm] = useState(false);
  const [showMembershipForm, setShowMembershipForm] = useState(false);
  const [tipSubmitting, setTipSubmitting] = useState(false);
  const [membershipSubmitting, setMembershipSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('videos');
  const [hasTapped, setHasTapped] = useState(false);
  const [tapinTotal, setTapinTotal] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tapinAnimating, setTapinAnimating] = useState(false);
  const [profileLinks, setProfileLinks] = useState<ProfileLinksState>(emptyProfileLinks);
  const { badgeByUserId, badgeByChannelId } = useRankBadges();
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const currentUserId = await getCurrentSupabaseUserId();
        setCurrentUserId(currentUserId);
        const { data: ch } = await supabase
          .from('channels')
          .select('*')
          .eq('id', channelId)
          .single();

        if (ch) {
          setChannel(ch);

          // Fetch profile for verified status
          const { data: prof } = await supabase
            .from('profiles')
            .select('*')
            .eq('user_id', ch.user_id)
            .single();
          if (prof) setProfile(prof);

          const { data: verificationRows } = await supabase
            .from('verification_requests')
            .select('tiktok_url, youtube_url, facebook_url, instagram_url, press_links, created_at')
            .eq('user_id', ch.user_id)
            .order('created_at', { ascending: false });

          const socialField = (key: 'tiktok_url' | 'youtube_url' | 'facebook_url' | 'instagram_url') =>
            verificationRows?.find((row: { [key: string]: string | null }) => row[key]?.trim())?.[key] || '';
          const pressLinks = [...new Set((verificationRows || []).flatMap((row: { press_links: string | null }) => {
            const value = row.press_links || '';
            return value
              .split(/\n|,/)
              .map((link: string) => link.trim())
              .filter(Boolean);
          }))].join('\n');

          setProfileLinks({
            tiktok_url: socialField('tiktok_url'),
            youtube_url: socialField('youtube_url'),
            facebook_url: socialField('facebook_url'),
            instagram_url: socialField('instagram_url'),
            press_links: pressLinks,
          });

          // Tapin count comes from the channel's trigger-maintained `tapiners` column —
          // counting the `tapins` table directly returns 0 here because RLS only exposes a
          // user's own tapins. Using the column keeps this identical everywhere in the app.
          setTapinTotal(ch.tapiners ?? 0);

          if (currentUserId) {
            const { data: tapin } = await supabase
              .from('tapins')
              .select('id')
              .eq('user_id', currentUserId)
              .eq('channel_id', ch.id)
              .maybeSingle();
            setHasTapped(!!tapin);
          } else {
            setHasTapped(false);
          }

          const [vRes, sRes, pRes, tipsRes, tiersRes, membershipRes] = await Promise.all([
            supabase
              .from('videos')
              .select('*')
              .eq('channel_id', channelId)
              .eq('status', 'published')
              .order('created_at', { ascending: false }),
            supabase
              .from('shorts')
              .select('*')
              .eq('channel_id', channelId)
              .eq('status', 'published')
              .order('created_at', { ascending: false }),
            supabase
              .from('community_posts')
              .select('*')
              .eq('channel_id', channelId)
              .order('created_at', { ascending: false }),
            supabase
              .from('channel_tips')
              .select('id, from_name, amount_srd, message, created_at')
              .eq('channel_id', channelId)
              .eq('status', 'confirmed')
              .order('created_at', { ascending: false })
              .limit(5),
            supabase
              .from('channel_memberships')
              .select('id, tier_name, monthly_amount_srd, perks, enabled')
              .eq('channel_id', channelId)
              .eq('enabled', true)
              .order('monthly_amount_srd', { ascending: true }),
            currentUserId
              ? supabase
                  .from('channel_members')
                  .select('status, membership_id')
                  .eq('channel_id', channelId)
                  .eq('user_id', currentUserId)
                  .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
          ]);

          const allVideos = (vRes.data || []) as Video[];
          const shortsData = (sRes.data || []) as Short[];
          setVideos(allVideos.filter((v: Video) => !v.is_short));
          const videoMomenti = allVideos
            .filter((v: Video) => v.is_short)
            .map((v: Video) => ({
              id: v.id,
              channel_id: v.channel_id,
              user_id: v.user_id,
              title: v.title,
              description: v.description,
              video_url: v.video_url,
              thumbnail_url: v.thumbnail_url,
              views: v.views,
              likes: v.likes,
              dislikes: v.dislikes,
              status: v.status,
              created_at: v.created_at,
            }));

          const seenMomentiKeys = new Set<string>();
          setShorts(
            [...videoMomenti, ...shortsData]
              .filter((item) => {
                const key = `${item.user_id || ''}|${item.channel_id || ''}|${(item.video_url || '').trim().toLowerCase()}|${(item.title || '').trim().toLowerCase()}|${(item.thumbnail_url || '').trim().toLowerCase()}`;
                if (seenMomentiKeys.has(key)) return false;
                seenMomentiKeys.add(key);
                return true;
              })
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          );

          setTips((tipsRes.data || []) as any);
          setTiers((tiersRes.data || []) as any);
          setActiveMembership(membershipRes.data ? { status: (membershipRes.data as any).status, tier_id: (membershipRes.data as any).membership_id } : null);

          if (pRes.data) {
            // For auto-generated posts without images, use video thumbnail
            const postsWithVideoIds = pRes.data.filter((p: CommunityPost) => p.video_id && !p.image_url);
            const videoIds = postsWithVideoIds.map((p: CommunityPost) => p.video_id);
            
            let videoThumbMap = new Map<string, string>();
            if (videoIds.length > 0) {
              const { data: videoData } = await supabase
                .from('videos')
                .select('id, thumbnail_url')
                .in('id', videoIds);
              videoData?.forEach((v: { id: string; thumbnail_url: string | null }) => {
                if (v.thumbnail_url) videoThumbMap.set(v.id, v.thumbnail_url);
              });
            }

            // Fetch comment counts for all posts
            const postIds = pRes.data.map((p: CommunityPost) => p.id);
            let commentCountMap = new Map<string, number>();
            if (postIds.length > 0) {
              const { data: commentData } = await supabase
                .from('comments')
                .select('post_id')
                .in('post_id', postIds);
              commentData?.forEach((c: { post_id: string | null }) => {
                if (c.post_id) {
                  commentCountMap.set(c.post_id, (commentCountMap.get(c.post_id) || 0) + 1);
                }
              });
            }

            const enrichedPosts: PostWithMeta[] = pRes.data.map((p: CommunityPost) => ({
              ...p,
              image_url: p.image_url || (p.video_id ? videoThumbMap.get(p.video_id) : null) || null,
              commentCount: commentCountMap.get(p.id) || 0,
            }));
            setPosts(enrichedPosts);
          }
        }
      } catch (error) {
        console.warn('Channel failed to load:', error);
        setChannel(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [channelId]);

  useEffect(() => {
    void loadBlockedUserIds().then(setBlockedUserIds);
    return subscribeCommunitySafetyChanges(() => {
      void loadBlockedUserIds().then(setBlockedUserIds);
    });
  }, []);

  const handleDeletePost = (post: PostWithMeta) => {
    if (!currentUserId || post.user_id !== currentUserId) return;

    Alert.alert(
      'Post verwijderen',
      'Weet je zeker dat je deze Bangi-post wilt verwijderen?',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Verwijderen',
          style: 'destructive',
          onPress: async () => {
            const { error: commentsError } = await supabase.from('comments').delete().eq('post_id', post.id);
            if (commentsError) {
              Alert.alert('Fout', commentsError.message);
              return;
            }

            const { error: likesError } = await supabase.from('post_likes').delete().eq('post_id', post.id);
            if (likesError) {
              Alert.alert('Fout', likesError.message);
              return;
            }

            const { error: postError } = await supabase.from('community_posts').delete().eq('id', post.id).eq('user_id', currentUserId);
            if (postError) {
              Alert.alert('Fout', postError.message);
              return;
            }

            setPosts((currentPosts: PostWithMeta[]) => currentPosts.filter((item: PostWithMeta) => item.id !== post.id));
          },
        },
      ]
    );
  };

  const handleTapIn = async () => {
    if (!channel) return;
    try {
      const currentUserId = await getCurrentSupabaseUserId();
      if (!currentUserId) {
        Alert.alert(t('video.signInToLike'));
        return;
      }

      if (hasTapped) return;

      const { data: existingTap } = await supabase
        .from('tapins')
        .select('id')
        .eq('user_id', currentUserId)
        .eq('channel_id', channel.id)
        .maybeSingle();

      if (existingTap) {
        setHasTapped(true);
        return;
      }

      const { error } = await supabase.from('tapins').insert({
        user_id: currentUserId,
        channel_id: channel.id,
      });

      if (error) {
        Alert.alert('Error', error.message);
        return;
      }

      // The DB trigger bumps channels.tapiners; reflect it optimistically here (re-counting
      // the tapins table would return 0 under RLS).
      const nextTapiners = tapinTotal + 1;
      setTapinAnimating(true);
      setChannel((prev: Channel | null) => (prev ? { ...prev, tapiners: nextTapiners } : prev));
      setTapinTotal(nextTapiners);
      setHasTapped(true);
      setTimeout(() => setTapinAnimating(false), 700);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Kon de tap niet opslaan.');
    }
  };

  const handleBlockChannelUser = async () => {
    if (!channel) return;
    await blockUser(channel.user_id);
    setBlockedUserIds((current: string[]) => (current.includes(channel.user_id) ? current : [...current, channel.user_id]));
    Alert.alert('Blocked', 'This creator is now blocked and hidden from your feed.');
  };

  const submitTip = async () => {
    if (!channel || !currentUserId) return;
    const amount = Number(tipAmount);
    if (!Number.isFinite(amount) || amount < 1) {
      Alert.alert('Fout', 'Voer een geldig bedrag in.');
      return;
    }
    setTipSubmitting(true);
    const { error } = await supabase.from('channel_tips').insert({
      channel_id: channel.id,
      from_user_id: currentUserId,
      from_name: tipName.trim() || null,
      amount_srd: amount,
      message: tipMessage.trim() || null,
      uni5pay_reference: tipReference.trim() || null,
      status: tipReference.trim() ? 'pending' : 'confirmed',
      confirmed_at: tipReference.trim() ? null : new Date().toISOString(),
    });
    setTipSubmitting(false);
    if (error) {
      Alert.alert('Fout', error.message);
      return;
    }
    setShowTipForm(false);
    setTipMessage('');
    setTipReference('');
    Alert.alert('Dank je!', 'Je fooi is opgeslagen.');
  };

  const submitMembership = async () => {
    if (!channel || !currentUserId || !selectedTierId) {
      Alert.alert('Fout', 'Kies eerst een lidmaatschap.');
      return;
    }
    const selectedTier = tiers.find((tier: { id: string; tier_name: string; monthly_amount_srd: number; perks: string | null; enabled: boolean }) => tier.id === selectedTierId);
    if (!selectedTier) return;
    setMembershipSubmitting(true);
    const { error } = await supabase.from('channel_members').upsert(
      {
        membership_id: selectedTier.id,
        channel_id: channel.id,
        user_id: currentUserId,
        uni5pay_reference: tierReference.trim() || null,
        status: tierReference.trim() ? 'pending' : 'active',
        amount_srd: selectedTier.monthly_amount_srd,
        starts_at: new Date().toISOString(),
        expires_at: null,
      },
      { onConflict: 'channel_id,user_id' }
    );
    setMembershipSubmitting(false);
    if (error) {
      Alert.alert('Fout', error.message);
      return;
    }
    setShowMembershipForm(false);
    setTierReference('');
    Alert.alert('Bedankt!', 'Je lidmaatschapsaanvraag is opgeslagen.');
  };

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!channel) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={styles.errorText}>{t('channel.notFound')}</Text>
      </View>
    );
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'videos', label: t('channel.videos'), count: videos.length },
    { key: 'momenti', label: t('channel.momenti'), count: shorts.length },
    { key: 'bangi', label: t('channel.community'), count: posts.length },
  ];

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

    if (socialLinks.length === 0 && pressLinks.length === 0) {
      return null;
    }

    return (
      <View style={styles.profileLinksSection}>
        <Text style={styles.profileLinksTitle}>Links</Text>
        <View style={styles.profileLinkChips}>
          {socialLinks.map((link: { label: string; url: string; icon: string }) => (
            <TouchableOpacity
              key={link.label}
              style={styles.profileLinkChip}
              onPress={() => onWebViewPress?.(link.url, link.label)}
              activeOpacity={0.8}
            >
              <Ionicons name={link.icon as any} size={16} color={colors.tapIn} />
              <Text style={styles.profileLinkChipText}>{link.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {pressLinks.length > 0 && (
          <View style={styles.profilePressLinksList}>
            <Text style={styles.profilePressLinksLabel}>Shared links</Text>
            {pressLinks.map((link: string, index: number) => (
              <TouchableOpacity
                key={`${link}-${index}`}
                style={styles.profilePressLinkRow}
                onPress={() => onWebViewPress?.(link, `Link ${index + 1}`)}
                activeOpacity={0.8}
              >
                <Ionicons name="link-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.profilePressLinkText} numberOfLines={1}>{link}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{channel.name}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Banner / Channel info */}
        {channel.banner_url && (
          <Image source={{ uri: channel.banner_url }} style={styles.banner} contentFit="cover" />
        )}

        <View style={styles.channelInfo}>
          {channel.avatar_url ? (
            <RankAuraAvatar
              uri={channel.avatar_url}
              size={72}
              badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel.user_id, channel.id)}
              fallbackLabel={channel.name}
            />
          ) : (
            <RankAuraAvatar
              size={72}
              badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel.user_id, channel.id)}
              fallbackLabel={channel.name}
            />
          )}
          <View style={styles.nameVerifiedRow}>
            <Text style={styles.channelName}>{channel.name}</Text>
            <VerifiedBadge
              isVerified={profile?.is_verified || false}
              verificationType={profile?.verification_type}
              size={20}
            />
          </View>
          <Text style={styles.channelHandle}>@{channel.handle}</Text>
          <Text style={styles.channelStats}>
            {tapinTotal} tapins · {videos.length} {t('channel.videos').toLowerCase()}
          </Text>
          <Text style={[styles.tapinGrowthBadge, tapinAnimating && styles.tapinGrowthBadgeActive]}>
            {hasTapped ? '+1 tapin toegevoegd' : 'Tap om te groeien'}
          </Text>
          <TouchableOpacity style={styles.blockUserBtn} onPress={handleBlockChannelUser}>
            <Ionicons name="ban-outline" size={16} color={colors.error} />
            <Text style={styles.blockUserText}>Block User</Text>
          </TouchableOpacity>
          {channel.description && (
            <LinkedText style={styles.channelDesc}>{channel.description}</LinkedText>
          )}
          {renderProfileLinks()}
          <TouchableOpacity
            style={[styles.tapInBtn, hasTapped && styles.tapInBtnActive]}
            onPress={handleTapIn}
            disabled={hasTapped}
          >
            <Text style={[styles.tapInText, hasTapped && styles.tapInTextActive]}>
              {hasTapped ? 'TAPINED' : t('video.tapIn')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tabs */}
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

        {/* Tab content */}
        {activeTab === 'videos' && (
          <View style={styles.videosList}>
            {videos.map((video: Video) => (
              <TouchableOpacity
                key={video.id}
                style={styles.videoRow}
                onPress={() => onVideoPress(video)}
              >
                {video.thumbnail_url ? (
                  <Image source={{ uri: video.thumbnail_url }} style={styles.videoThumb} contentFit="cover" />
                ) : (
                  <View style={[styles.videoThumb, styles.thumbPlaceholder]}>
                    <Ionicons name="play-circle" size={24} color={colors.textTertiary} />
                  </View>
                )}
                <View style={styles.videoInfo}>
                  <Text style={styles.videoTitle} numberOfLines={2}>{video.title}</Text>
                  <Text style={styles.videoMeta}>
                    {formatViews(video.views)} weergaven | {formatTimeAgo(video.created_at)}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
            {videos.length === 0 && (
              <Text style={styles.emptyText}>{t('channel.noVideos')}</Text>
            )}
          </View>
        )}

        {activeTab === 'momenti' && (
          <View style={styles.shortsGrid}>
            {shorts.map((short: Short) => (
              <TouchableOpacity
                key={short.id}
                style={styles.shortCard}
                onPress={() => onVideoPress({ ...short, is_short: true } as Video)}
                activeOpacity={0.8}
              >
                {short.thumbnail_url ? (
                  <Image source={{ uri: short.thumbnail_url }} style={styles.shortThumb} contentFit="cover" />
                ) : (
                  <View style={[styles.shortThumb, styles.thumbPlaceholder]}>
                    <Ionicons name="play" size={24} color={colors.textTertiary} />
                  </View>
                )}
                <Text style={styles.shortTitle} numberOfLines={2}>{short.title}</Text>
                <Text style={styles.shortMeta}>{formatViews(short.views)} {t('video.views')}</Text>
              </TouchableOpacity>
            ))}
            {shorts.length === 0 && (
              <Text style={styles.emptyText}>{t('channel.noMomenti')}</Text>
            )}
          </View>
        )}

        {activeTab === 'bangi' && (
          <View style={styles.postsList}>
            {posts.map((post: PostWithMeta) => (
              <TouchableOpacity
                key={post.id}
                style={styles.postCard}
                onPress={() => onPostPress?.(post.id)}
                activeOpacity={0.7}
              >
                <View style={styles.postHeader}>
                  {(channel.avatar_url) ? (
                    <RankAuraAvatar
                      uri={channel.avatar_url}
                      size={36}
                      badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel.user_id, channel.id)}
                      fallbackLabel={channel.name}
                    />
                  ) : (
                    <RankAuraAvatar
                      size={36}
                      badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel.user_id, channel.id)}
                      fallbackLabel={channel.name}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={styles.postAuthorName}>{channel.name}</Text>
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
                  <LinkedText style={styles.postContent}>{post.content}</LinkedText>
                ) : (
                  <View style={[styles.textOnlyPostCard, { backgroundColor: post.background_color || colors.surface }]}>
                    <Text style={[styles.textOnlyPostText, { color: post.text_color || colors.text }]}>
                      {post.content}
                    </Text>
                  </View>
                )}
                {post.poll_question && post.poll_options?.length ? (
                  <View style={styles.postPollCard}>
                    <Text style={styles.postPollQuestion}>{post.poll_question}</Text>
                    {post.poll_options.map((option) => {
                      const totalVotes = post.poll_options?.reduce((sum, item) => sum + item.votes, 0) || 0;
                      const percent = totalVotes > 0 ? Math.round((option.votes / totalVotes) * 100) : 0;
                      return (
                        <View key={option.id} style={styles.postPollOption}>
                          <View style={styles.postPollOptionRow}>
                            <Text style={styles.postPollOptionLabel}>{option.label}</Text>
                            <Text style={styles.postPollOptionVotes}>{percent}%</Text>
                          </View>
                          <View style={styles.postPollTrack}>
                            <View style={[styles.postPollFill, { width: `${percent}%` }]} />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                {post.image_url ? (
                  <Image
                    source={{ uri: post.image_url }}
                    style={styles.postImage}
                    contentFit="cover"
                    transition={200}
                  />
                ) : null}
                <View style={styles.postFooter}>
                  <Ionicons name="heart-outline" size={16} color={colors.textSecondary} />
                  <Text style={styles.postLikes}>{post.likes}</Text>
                  <View style={{ width: spacing.sm }} />
                  <Ionicons name="chatbubble-outline" size={14} color={colors.textSecondary} />
                  <Text style={styles.postLikes}>{post.commentCount || 0}</Text>
                  <TouchableOpacity style={styles.postBlockBtn} onPress={handleBlockChannelUser}>
                    <Ionicons name="ban-outline" size={14} color={colors.error} />
                    <Text style={styles.postBlockText}>Block User</Text>
                  </TouchableOpacity>
                  {post.user_id === currentUserId && (
                    <TouchableOpacity
                      style={styles.postDeleteBtn}
                      onPress={() => handleDeletePost(post)}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.tapIn} />
                      <Text style={styles.postDeleteText}>Verwijderen</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </TouchableOpacity>
            ))}
            {posts.length === 0 && (
              <Text style={styles.emptyText}>{t('channel.noPosts')}</Text>
            )}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

const shortCardWidth = (width - spacing.lg * 3) / 2;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: { padding: spacing.sm },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  banner: { width, height: 120 },
  channelInfo: { alignItems: 'center', paddingVertical: spacing.xl },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameVerifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
  },
  channelName: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  channelHandle: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: 2 },
  channelStats: { color: colors.textTertiary, fontSize: fontSize.sm, marginTop: 4 },
  tapinGrowthBadge: {
    marginTop: 8,
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  tapinGrowthBadgeActive: {
    color: colors.success,
    transform: [{ scale: 1.04 }],
  },
  channelDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xxl,
    lineHeight: 22,
  },
  tapInBtn: {
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    marginTop: spacing.lg,
  },
  tapInBtnActive: {
    backgroundColor: colors.surfaceLight,
  },
  tapInText: { color: '#FFFFFF', fontSize: fontSize.md, fontWeight: '700' },
  tapInTextActive: {
    color: colors.textSecondary,
  },
  blockUserBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  blockUserText: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  studioCardDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  profileLinksSection: {
    width: '100%',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  profileLinksTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  profileLinkChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  profileLinkChip: {
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
  profileLinkChipText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  profilePressLinksList: {
    gap: spacing.xs,
  },
  profilePressLinksLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  profilePressLinkRow: {
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
  profilePressLinkText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  },
  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '500' },
  tabTextActive: { color: colors.text },
  videosList: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  videoRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  videoThumb: { width: 160, height: 90, borderRadius: borderRadius.md },
  thumbPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoInfo: { flex: 1, justifyContent: 'center' },
  videoTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '500', lineHeight: 20 },
  videoMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },
  shortsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },
  shortCard: { width: shortCardWidth },
  shortThumb: {
    width: shortCardWidth,
    height: shortCardWidth * 1.5,
    borderRadius: borderRadius.md,
  },
  shortTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '500', marginTop: 4 },
  shortMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  postsList: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  postCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  postAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  postAuthorName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  postContent: { color: colors.text, fontSize: fontSize.md, lineHeight: 22 },
  textOnlyPostCard: {
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginTop: spacing.md,
    minHeight: 160,
    justifyContent: 'center',
  },
  textOnlyPostText: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    lineHeight: 28,
  },
  postPollCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  postPollQuestion: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  postPollOption: {
    marginBottom: spacing.sm,
  },
  postPollOptionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  postPollOptionLabel: {
    color: colors.text,
    fontSize: fontSize.xs,
    flex: 1,
    paddingRight: spacing.sm,
  },
  postPollOptionVotes: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  postPollTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden',
  },
  postPollFill: {
    height: '100%',
    backgroundColor: colors.tapIn,
    borderRadius: 999,
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
  postDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  postBlockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  postBlockText: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  postDeleteText: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  postLikes: { color: colors.textSecondary, fontSize: fontSize.sm },
  postDate: { color: colors.textTertiary, fontSize: fontSize.xs },
  emptyText: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
  },
  errorText: { color: colors.textSecondary, fontSize: fontSize.md },
});