// Single source of truth for the app's visual styling.
// Change tokens here to retheme; components import from this file.

export const colors = {
  background: '#FFFFFF',
  surface: '#FAFAFA',
  surfaceElevated: '#FFFFFF',

  text: '#0A0A0A',
  textMuted: '#6B7280',
  textSubtle: '#9CA3AF',
  textInverse: '#FFFFFF',

  accent: '#5B6CFF',
  accentPressed: '#4856E5',
  accentMuted: '#EEF0FF',

  success: '#10B981',
  successMuted: '#ECFDF5',
  warning: '#F59E0B',
  warningMuted: '#FFFBEB',
  error: '#EF4444',
  errorMuted: '#FEF2F2',

  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
};

export const typography = {
  display: 30,
  title: 22,
  heading: 18,
  body: 15,
  caption: 13,
  small: 11,
  weightRegular: '400',
  weightMedium: '500',
  weightSemibold: '600',
  weightBold: '700',
};

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
};
