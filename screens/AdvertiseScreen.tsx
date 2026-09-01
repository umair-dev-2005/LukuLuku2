import React, { useEffect } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';

interface AdvertiseScreenProps {
  onBack: () => void;
}

const LUKULUKU_ADVERTISE_URL = 'https://lukuluku.online/advertise';

export default function AdvertiseScreen({ onBack }: AdvertiseScreenProps) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    void Linking.openURL(LUKULUKU_ADVERTISE_URL).catch(() => {
      Alert.alert('Open website', 'Kan de advertentiepagina niet openen.');
      onBack();
    });
  }, [onBack]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ActivityIndicator size="large" color={colors.tapIn} />
      <Text style={styles.text}>LukuLuku Ads openen…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  text: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});