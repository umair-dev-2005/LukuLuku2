import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';

interface WebViewScreenProps {
  url: string;
  title: string;
  onBack: () => void;
}

export default function WebViewScreen({ url, title, onBack }: WebViewScreenProps) {
  const insets = useSafeAreaInsets();
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        <View style={{ width: 40 }} />
      </View>
      {loadFailed ? (
        <View style={styles.errorState}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.errorTitle}>Kan de pagina niet laden</Text>
          <Text style={styles.errorText}>Controleer je internetverbinding en probeer het opnieuw.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => setLoadFailed(false)}>
            <Text style={styles.retryText}>Opnieuw proberen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          source={{ uri: url }}
          style={styles.webview}
          startInLoadingState
          onError={() => setLoadFailed(true)}
          onHttpError={() => setLoadFailed(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: { width: 40 },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
  errorState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  retryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});