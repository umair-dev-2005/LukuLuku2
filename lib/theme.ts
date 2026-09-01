export const colors = {
  // Primary brand colors (light theme with white background)
  background: '#FFFFFF',
  surface: '#F9F9F9',
  surfaceLight: '#F5F5F5',
  surfaceHighlight: '#EEEEEE',
  
  // Brand accent (keep red)
  primary: '#FF4444',
  primaryDark: '#CC0000',
  primaryLight: '#FF6666',
  
  // Text
  text: '#000000',
  textSecondary: '#666666',
  textTertiary: '#999999',
  textInverse: '#FFFFFF',
  
  // Borders
  border: '#E0E0E0',
  borderLight: '#F0F0F0',
  
  // States
  success: '#4CAF50',
  error: '#FF4444',
  warning: '#FFC107',
  disabled: '#CCCCCC',
  
  // Verified badge (gold music note)
  verified: '#FFD700',
  gold: '#D4AF37',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
  
  // TAPIN button
  tapIn: '#5AC8FA',
};

export type PostBackgroundPreset = {
  key: string;
  backgroundColor: string;
  textColor: string;
  label: string;
};

export const postBackgroundPresets: PostBackgroundPreset[] = [
  {
    key: 'white',
    backgroundColor: colors.background,
    textColor: colors.text,
    label: 'Wit',
  },
  {
    key: 'blue',
    backgroundColor: colors.tapIn,
    textColor: colors.textInverse,
    label: 'Blauw',
  },
  {
    key: 'red',
    backgroundColor: colors.primary,
    textColor: colors.textInverse,
    label: 'Rood',
  },
  {
    key: 'dark',
    backgroundColor: '#1F2937',
    textColor: colors.textInverse,
    label: 'Donker',
  },
  {
    key: 'purple',
    backgroundColor: '#7C3AED',
    textColor: colors.textInverse,
    label: 'Paars',
  },
  {
    key: 'green',
    backgroundColor: '#22C55E',
    textColor: colors.textInverse,
    label: 'Groen',
  },
  {
    key: 'yellow',
    backgroundColor: '#FBBF24',
    textColor: colors.text,
    label: 'Geel',
  },
];

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const fontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 22,
  xxxl: 28,
};

export const borderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 999,
};