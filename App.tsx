import React, { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react';
import { View, StyleSheet, StatusBar, TouchableOpacity, Text, BackHandler, ActivityIndicator } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from './lib/theme';
import { t, useLanguage, loadSavedLanguage } from './lib/i18n';
import { Video, supabase } from './lib/supabase';
import { isMomentiDuration } from './lib/utils';
import { requestTrackingPermission } from './lib/tracking';
import * as Linking from 'expo-linking';

const HomeScreen = lazy(() => import('./screens/HomeScreen'));
const ShortsScreen = lazy(() => import('./screens/ShortsScreen'));
const SearchScreen = lazy(() => import('./screens/SearchScreen'));
const ProfileScreen = lazy(() => import('./screens/ProfileScreen'));
const VideoPlayerScreen = lazy(() => import('./screens/VideoPlayerScreen'));
const ChannelScreen = lazy(() => import('./screens/ChannelScreen'));
const WebViewScreen = lazy(() => import('./screens/WebViewScreen'));
const CreateScreen = lazy(() => import('./screens/CreateScreen'));
const CreatePostScreen = lazy(() => import('./screens/CreatePostScreen'));
const BangiPostScreen = lazy(() => import('./screens/BangiPostScreen'));
const NotificationsScreen = lazy(() => import('./screens/NotificationsScreen'));
const GamesScreen = lazy(() => import('./screens/GamesScreen'));
const GamePlayScreen = lazy(() => import('./screens/GamePlayScreen'));
const LeaderboardsScreen = lazy(() => import('./screens/LeaderboardsScreen'));

const LUKULUKU_ADVERTISE_URL = 'https://lukuluku.online/advertise';

type Screen =
  | { type: 'tabs' }
  | { type: 'video'; video: Video }
  | { type: 'momentiVideo'; video: Video }
  | { type: 'channel'; channelId: string }
  | { type: 'webview'; url: string; title: string }
  | { type: 'create' }
  | { type: 'createVideo' }
  | { type: 'createMomenti' }
  | { type: 'createPost' }
  | { type: 'bangiPost'; postId: string }
  | { type: 'notifications' }
  | { type: 'games' }
  | { type: 'gameplay'; gameUrl: string; gameName: string }
  | { type: 'leaderboards' }
  | { type: 'advertise' };

type Tab = 'home' | 'momenti' | 'search' | 'profile';

const TAB_CONFIG: { key: Tab; icon: string; iconActive: string; labelKey: string }[] = [
  { key: 'home', icon: 'home-outline', iconActive: 'home', labelKey: 'tab.home' },
  { key: 'momenti', icon: 'flash-outline', iconActive: 'flash', labelKey: 'tab.momenti' },
  // + button is rendered separately in the middle
  { key: 'search', icon: 'search-outline', iconActive: 'search', labelKey: 'tab.search' },
  { key: 'profile', icon: 'person-outline', iconActive: 'person', labelKey: 'tab.profile' },
];

class AppErrorBoundary extends React.Component<{ children?: any }, { hasError: boolean }> {
  constructor(props: { children?: any }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('AppErrorBoundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Er is iets misgegaan</Text>
          <Text style={styles.errorText}>Sluit de app volledig af en open opnieuw.</Text>
          <TouchableOpacity
            style={styles.errorRetryBtn}
            onPress={() => this.setState({ hasError: false })}
            activeOpacity={0.85}
          >
            <Text style={styles.errorRetryText}>Opnieuw proberen</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const withAppBoundary = (node: any) => (
  <AppErrorBoundary>
    {node}
  </AppErrorBoundary>
);

function AppInner() {
  useLanguage();
  const [screen, setScreen] = useState<Screen>({ type: 'tabs' });
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [screenStack, setScreenStack] = useState<Screen[]>([]);
  const [contentRefreshToken, setContentRefreshToken] = useState(0);
  const screenRef = useRef(screen);
  const activeTabRef = useRef(activeTab);
  const previousTabRef = useRef<Tab>('home');
  const [pendingAuthMode, setPendingAuthMode] = useState<'signin' | 'signup' | null>(null);

  useEffect(() => {
    void loadSavedLanguage();
  }, []);

  // Ask for App Tracking Transparency permission once on launch. The app shows
  // third-party network ads (HilltopAds VAST), so per App Store Guideline 5.1.2(i)
  // we must request permission before any ad-tracking pixels fire.
  useEffect(() => {
    void requestTrackingPermission();
  }, []);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const refreshContent = useCallback(() => {
    setContentRefreshToken((value: number) => value + 1);
  }, []);

  const navigateTo = useCallback((newScreen: Screen) => {
    setScreenStack((prev: Screen[]) => [...prev, screenRef.current]);
    setScreen(newScreen);
  }, []);

  // Navigate to a video. If the user is already watching a video, REPLACE the current one
  // instead of pushing — so watching one video after another never piles screens onto the
  // stack. The stack then only holds whatever opened the first video (usually Home), so a
  // single back press takes the user straight back there.
  const navigateToVideo = useCallback((newScreen: Screen) => {
    const current = screenRef.current;
    if (current.type === 'video' || current.type === 'momentiVideo') {
      setScreen(newScreen);
    } else {
      navigateTo(newScreen);
    }
  }, [navigateTo]);
const navigateToAuth = useCallback((mode: 'signin' | 'signup') => {
  previousTabRef.current = activeTabRef.current;
  setPendingAuthMode(mode);
  navigateTo({ type: 'tabs' });
  setActiveTab('profile');
}, [navigateTo]);
// Deep linking: handle both cold-start (app opened directly via link) and
// warm-start (app already running, link received while active).
useEffect(() => {
  const parseAndNavigate = async (url: string | null) => {
    if (!url) return;

    const videoMatch = url.match(/\/watch\/([a-zA-Z0-9-]+)/);
    const momentiMatch = url.match(/\/momenti\/([a-zA-Z0-9-]+)/);
    const postMatch = url.match(/\/post\/([a-zA-Z0-9-]+)/);

    try {
      if (videoMatch) {
        const { data } = await supabase.from('videos').select('*').eq('id', videoMatch[1]).single();
        if (data) navigateToVideo({ type: 'video', video: data as Video });
      } else if (momentiMatch) {
        const { data } = await supabase.from('videos').select('*').eq('id', momentiMatch[1]).single();
        if (data) navigateToVideo({ type: 'momentiVideo', video: data as Video });
      } else if (postMatch) {
        navigateTo({ type: 'bangiPost', postId: postMatch[1] });
      }
    } catch (err) {
      console.warn('Deep link navigation failed:', err);
    }
  };

  // Cold start: app opened directly via a link
  Linking.getInitialURL().then(parseAndNavigate);

  // Warm start: app already running, link received in background
  const subscription = Linking.addEventListener('url', ({ url }) => {
    parseAndNavigate(url);
  });

  return () => subscription.remove();
}, []);

  const goBack = useCallback(() => {
    setScreenStack((prev: Screen[]) => {
      if (prev.length === 0) {
        setScreen({ type: 'tabs' });
        setActiveTab('home');
        return [];
      }
      const newStack = [...prev];
      const last = newStack.pop()!;
      setScreen(last);
      return newStack;
    });
  }, []);

const handleAuthComplete = useCallback(() => {
  setPendingAuthMode(null);
  goBack();
  setActiveTab(previousTabRef.current);
}, [goBack]);

  const goHome = useCallback(() => {
    setScreenStack([]);
    setActiveTab('home');
    setScreen({ type: 'tabs' });
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const currentScreen = screenRef.current;
      const currentTab = activeTabRef.current;

      if (currentScreen.type !== 'tabs') {
        goBack();
        return true;
      }

      if (currentTab !== 'home') {
        setActiveTab('home');
        return true;
      }

      return true;
    });

    return () => subscription.remove();
  }, [goBack]);

  const handleVideoPress = useCallback((video: Video) => {
    if (isMomentiDuration(video.duration, video.is_short)) {
      navigateToVideo({ type: 'momentiVideo', video });
      return;
    }

    navigateToVideo({ type: 'video', video });
  }, [navigateToVideo]);

  const handleMomentiPress = useCallback((video: Video) => {
    navigateToVideo({ type: 'momentiVideo', video });
  }, [navigateToVideo]);

  const handleChannelPress = useCallback((channelId: string) => {
    navigateTo({ type: 'channel', channelId });
  }, [navigateTo]);

  const handleWebViewPress = useCallback((url: string, title: string) => {
    navigateTo({ type: 'webview', url, title });
  }, [navigateTo]);

  const handleCreatePress = useCallback(() => {
    navigateTo({ type: 'create' });
  }, [navigateTo]);

  const handleCreateVideoPress = useCallback(() => {
    navigateTo({ type: 'createVideo' });
  }, [navigateTo]);

  const handleCreateMomentiPress = useCallback(() => {
    navigateTo({ type: 'createMomenti' });
  }, [navigateTo]);

  const handleCreatePostPress = useCallback(() => {
    navigateTo({ type: 'createPost' });
  }, [navigateTo]);

  const handleAdvertisePress = useCallback(() => {
    navigateTo({ type: 'webview', url: LUKULUKU_ADVERTISE_URL, title: t('create.advertise') });
  }, [navigateTo]);

  const handleBangiPostPress = useCallback((postId: string) => {
    navigateTo({ type: 'bangiPost', postId });
  }, [navigateTo]);

  const handleNotificationsPress = useCallback(() => {
    navigateTo({ type: 'notifications' });
  }, [navigateTo]);

  const handleGamesPress = useCallback(() => {
    navigateTo({ type: 'games' });
  }, [navigateTo]);

  const handleLeaderboardsPress = useCallback(() => {
    navigateTo({ type: 'leaderboards' });
  }, [navigateTo]);

  const handlePlayGame = useCallback((gameUrl: string, gameType: string, gameName: string) => {
    navigateTo({ type: 'gameplay', gameUrl, gameName });
  }, [navigateTo]);

  // Render overlays
  if (screen.type === 'video') {
    return withAppBoundary(
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <VideoPlayerScreen
            video={screen.video}
            onBack={goBack}
            onHomePress={goHome}
            onChannelPress={handleChannelPress}
            onVideoPress={handleVideoPress}
            onSignIn={() => navigateToAuth('signin')}
            onSignUp={() => navigateToAuth('signup')}
          />
        </Suspense>
      </GestureHandlerRootView>
    );
  }

  if (screen.type === 'momentiVideo') {
    return withAppBoundary(
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <ShortsScreen
            onChannelPress={handleChannelPress}
            onVideoPress={handleVideoPress}
            isActive={true}
            onBack={goBack}
            initialVideoId={screen.video.id}
            initialVideo={screen.video}
            onSignIn={() => navigateToAuth('signin')}
            onSignUp={() => navigateToAuth('signup')}
          />
        </Suspense>
      </GestureHandlerRootView>
    );
  }

  if (screen.type === 'channel') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <ChannelScreen
            channelId={screen.channelId}
            onBack={goBack}
            onVideoPress={handleVideoPress}
            onPostPress={handleBangiPostPress}
            onWebViewPress={handleWebViewPress}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'webview') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <WebViewScreen
            url={screen.url}
            title={screen.title}
            onBack={goBack}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'create') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <CreateScreen
            onBack={goBack}
            onCreateVideo={handleCreateVideoPress}
            onCreateMomenti={handleCreateMomentiPress}
            onCreatePost={handleCreatePostPress}
            onAdvertise={handleAdvertisePress}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'createVideo') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <CreatePostScreen onBack={goBack} mode="video" onPublished={refreshContent} />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'createMomenti') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <CreatePostScreen onBack={goBack} mode="momenti" onPublished={refreshContent} />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'createPost') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <CreatePostScreen onBack={goBack} mode="post" onPublished={refreshContent} />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'bangiPost') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <BangiPostScreen
            postId={screen.postId}
            onBack={goBack}
            onHomePress={goHome}
            onChannelPress={handleChannelPress}
            onPostPress={handleBangiPostPress}
            onSignIn={() => navigateToAuth('signin')}
            onSignUp={() => navigateToAuth('signup')}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'notifications') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <NotificationsScreen
            onBack={goBack}
            onVideoPress={handleVideoPress}
            onPostPress={handleBangiPostPress}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'games') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <GamesScreen
            onBack={goBack}
            onPlayGame={handlePlayGame}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'gameplay') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <GamePlayScreen
            gameUrl={screen.gameUrl}
            gameName={screen.gameName}
            onBack={goBack}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'leaderboards') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <LeaderboardsScreen
            onBack={goBack}
            onChannelPress={handleChannelPress}
          />
        </Suspense>
      </>
    );
  }

  if (screen.type === 'advertise') {
    return withAppBoundary(
      <>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <Suspense fallback={<StartupFallback />}>
          <WebViewScreen
            url={LUKULUKU_ADVERTISE_URL}
            title={t('create.advertise')}
            onBack={goBack}
          />
        </Suspense>
      </>
    );
  }

  return withAppBoundary(
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={activeTab === 'momenti' ? '#000000' : colors.background}
      />
      <View style={[styles.container, activeTab === 'momenti' && { backgroundColor: '#000000' }]}>
        {/* Tab content */}
        <View style={[styles.content, activeTab === 'momenti' && { backgroundColor: '#000000' }]}>
          <Suspense fallback={<StartupFallback />}>
            <View style={[styles.content, activeTab !== 'home' && { display: 'none' }]}>
              <HomeScreen
                onVideoPress={handleVideoPress}
                onMomentiPress={handleMomentiPress}
                onChannelPress={handleChannelPress}
                onPostPress={handleBangiPostPress}
                onNotificationsPress={handleNotificationsPress}
                onGamesPress={handleGamesPress}
                onLeaderboardsPress={handleLeaderboardsPress}
                onPlayGame={handlePlayGame}
                refreshToken={contentRefreshToken}
                isActive={activeTab === 'home'}
              />
            </View>
            <View style={[styles.content, activeTab !== 'momenti' && { display: 'none' }]}>
              <ShortsScreen
                onChannelPress={handleChannelPress}
                onVideoPress={handleVideoPress}
                isActive={activeTab === 'momenti'}
                onSignIn={() => navigateToAuth('signin')}
                onSignUp={() => navigateToAuth('signup')}
              />
            </View>
            <View style={[styles.content, activeTab !== 'search' && { display: 'none' }]}>
              <SearchScreen
                onVideoPress={handleVideoPress}
                onChannelPress={handleChannelPress}
                isActive={activeTab === 'search'}
              />
            </View>
            <View style={[styles.content, activeTab !== 'profile' && { display: 'none' }]}>
              <ProfileScreen
                refreshToken={contentRefreshToken}
                onVideoPress={handleVideoPress}
                onMomentiPress={handleMomentiPress}
                onChannelPress={handleChannelPress}
                onWebViewPress={handleWebViewPress}
                onAdvertisePress={handleAdvertisePress}
                onPostPress={handleBangiPostPress}
                initialAuthMode={pendingAuthMode}
                onAuthComplete={handleAuthComplete}
                isActive={activeTab === 'profile'}
              />
            </View>
          </Suspense>
        </View>

        {/* Tab bar with center + button */}
        <TabBar activeTab={activeTab} onTabPress={setActiveTab} onCreatePress={handleCreatePress} />
      </View>
    </GestureHandlerRootView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function TabBar({
  activeTab,
  onTabPress,
  onCreatePress,
}: {
  activeTab: Tab;
  onTabPress: (tab: Tab) => void;
  onCreatePress: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(20, insets.bottom) }]}>
      {/* Left tabs: Home, Momenti */}
      {TAB_CONFIG.slice(0, 2).map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tabItem}
            onPress={() => onTabPress(tab.key)}
          >
            <Ionicons
              name={(isActive ? tab.iconActive : tab.icon) as any}
              size={24}
              color={isActive ? colors.text : colors.textTertiary}
            />
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
              {t(tab.labelKey as any)}
            </Text>
          </TouchableOpacity>
        );
      })}

      {/* Center + button */}
      <TouchableOpacity
        style={styles.createBtnContainer}
        onPress={onCreatePress}
        activeOpacity={0.8}
      >
        <View style={styles.createBtn}>
          <Ionicons name="add" size={32} color="#FFFFFF" />
        </View>
      </TouchableOpacity>

      {/* Right tabs: Search, Profile */}
      {TAB_CONFIG.slice(2).map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tabItem}
            onPress={() => onTabPress(tab.key)}
          >
            <Ionicons
              name={(isActive ? tab.iconActive : tab.icon) as any}
              size={24}
              color={isActive ? colors.text : colors.textTertiary}
            />
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
              {t(tab.labelKey as any)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function StartupFallback() {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.loadingText}>LukuLuku...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
  },
  tabBar: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
      paddingTop: spacing.sm,
      alignItems: 'flex-end',
    },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    gap: 2,
  },
  tabLabel: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: colors.text,
  },
  createBtnContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -20,
  },
  createBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.tapIn,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.tapIn,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  errorTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  errorRetryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
  },
  errorRetryText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});