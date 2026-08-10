/**
 * Design tokens for the Glivt fleet platform.
 *
 * A single semantic colour contract is defined twice — once for `light`, once
 * for `dark` — with IDENTICAL keys, so any component can switch themes just by
 * reading colours from the active scheme. Legacy exports (`palette`,
 * `defaultColors`, `stateColors`) resolve to the light scheme for backwards
 * compatibility; new/redesigned components pull colours from `useTheme()`.
 *
 * Design language: "command-centre" — deep slate surfaces, one energetic brand
 * green accent, semantic status colours, generous spacing, tabular figures.
 * Tenant branding overrides `primary`/`secondary` at runtime.
 */

export type Scheme = 'light' | 'dark';

/** The full semantic colour contract shared by both themes. */
export type ThemeColors = {
  // Brand
  primary: string;
  secondary: string;
  onPrimary: string;
  primaryGreen: string;
  darkGreen: string;
  accent: string;
  accentSoft: string;
  // Surfaces
  pageBackground: string;
  cardBackground: string;
  surface: string;
  surfaceAlt: string;
  surfaceElevated: string;
  loginBackground: string;
  // Lines
  divider: string;
  border: string;
  borderStrong: string;
  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  // Status / semantic
  blue: string;
  info: string;
  success: string;
  warning: string;
  warningOrange: string;
  danger: string;
  errorRed: string;
  // Utility
  white: string;
  black: string;
  overlay: string;
  shadowColor: string;
};

export const lightColors: ThemeColors = {
  primary: '#22C55E',
  secondary: '#3B82F6',
  onPrimary: '#FFFFFF',
  primaryGreen: '#22C55E',
  darkGreen: '#16A34A',
  accent: '#22C55E',
  accentSoft: '#DCFCE7',

  pageBackground: '#F8FAFC',
  cardBackground: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FAFC',
  surfaceElevated: '#FFFFFF',
  loginBackground: '#0F172A',

  divider: '#E2E8F0',
  border: '#CBD5E1',
  borderStrong: '#94A3B8',

  textPrimary: '#0F172A',
  textSecondary: '#334155',
  textMuted: '#64748B',

  blue: '#3B82F6',
  info: '#3B82F6',
  success: '#22C55E',
  warning: '#F59E0B',
  warningOrange: '#F59E0B',
  danger: '#EF4444',
  errorRed: '#EF4444',

  white: '#FFFFFF',
  black: '#0F172A',
  overlay: 'rgba(15, 23, 42, 0.55)',
  shadowColor: '#0F172A',
};

export const darkColors: ThemeColors = {
  primary: '#22C55E',
  secondary: '#3B82F6',
  onPrimary: '#FFFFFF',
  primaryGreen: '#22C55E',
  darkGreen: '#16A34A',
  accent: '#22C55E',
  accentSoft: 'rgba(34, 197, 94, 0.14)',

  pageBackground: '#0F172A',
  cardBackground: '#1E293B',
  surface: '#1E293B',
  surfaceAlt: '#0F172A',
  surfaceElevated: '#334155',
  loginBackground: '#0F172A',

  divider: '#334155',
  border: '#475569',
  borderStrong: '#64748B',

  textPrimary: '#F8FAFC',
  textSecondary: '#E2E8F0',
  textMuted: '#94A3B8',

  blue: '#3B82F6',
  info: '#3B82F6',
  success: '#22C55E',
  warning: '#F59E0B',
  warningOrange: '#F59E0B',
  danger: '#EF4444',
  errorRed: '#EF4444',

  white: '#FFFFFF',
  black: '#000000',
  overlay: 'rgba(0,0,0,0.62)',
  shadowColor: '#000000',
};

export const schemes: Record<Scheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

/** Vehicle/device state colours, resolved per scheme. White text sits on top. */
export function stateColorsFor(colors: ThemeColors): Record<string, string> {
  return {
    RUNNING: colors.primaryGreen,
    MOVING: colors.primaryGreen,
    STOPPED: '#EF4444',
    IDLE: '#F59E0B',
    INACTIVE: colors.textMuted,
    OFFLINE: '#6B7280',
    NO_DATA: colors === darkColors ? '#475569' : '#94A3B8',
    EXPIRED: colors === darkColors ? '#334155' : '#64748B',
    SUSPENDED: colors === darkColors ? '#334155' : '#64748B',
    IMMOBILISED: '#EF4444',
    GPS_INVALID: '#F59E0B',
    POWER_DISCONNECTED: '#F59E0B',
    HEALTHY: colors.primaryGreen,
    WARNING: '#F59E0B',
    CRITICAL: '#EF4444',
    MAINTENANCE: colors.secondary,
    TOTAL: colors.secondary,
  };
}

/** Elevation presets. Dark mode leans on borders + lighter surfaces, not shadow. */
export function elevation(colors: ThemeColors, level: 1 | 2 | 3 = 1) {
  const dark = colors === darkColors;
  const map = {
    1: { radius: 6, opacity: dark ? 0.28 : 0.08, y: 2, e: 2 },
    2: { radius: 14, opacity: dark ? 0.36 : 0.12, y: 6, e: 5 },
    3: { radius: 24, opacity: dark ? 0.44 : 0.18, y: 12, e: 10 },
  } as const;
  const m = map[level];
  return {
    shadowColor: colors.shadowColor,
    shadowOpacity: m.opacity,
    shadowRadius: m.radius,
    shadowOffset: { width: 0, height: m.y },
    elevation: m.e,
  };
}

/** 8-point spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const typography = {
  h1: 26,
  h2: 20,
  title: 18,
  body: 15,
  label: 14,
  caption: 12,
} as const;

export const layout = {
  appBarHeight: 56,
  fabSize: 48,
  inputHeight: 52,
  buttonHeight: 52,
} as const;

// ---------------------------------------------------------------------------
// Backwards-compatible exports (resolve to the LIGHT scheme). Screens that have
// not yet migrated to useTheme() keep compiling and render the improved light
// theme; migrated screens pull colours from the active scheme instead.
// ---------------------------------------------------------------------------

export const palette = lightColors;

export const stateColors: Record<string, string> = stateColorsFor(lightColors);

function isGrayColor(hex?: string): boolean {
  if (!hex) return false;
  const cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0], 16);
    const g = parseInt(cleanHex[1], 16);
    const b = parseInt(cleanHex[2], 16);
    return Math.abs(r - g) < 2 && Math.abs(g - b) < 2;
  }
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return Math.abs(r - g) < 15 && Math.abs(g - b) < 15;
  }
  return false;
}

/** Builds the active colour set, applying tenant overrides when present. */
export function buildColors(
  scheme: Scheme = 'light',
  overrides?: { primary?: string; secondary?: string }
): ThemeColors {
  const base = schemes[scheme];
  const isValidPrimary = overrides?.primary && !isGrayColor(overrides.primary);
  return {
    ...base,
    primary: isValidPrimary ? (overrides?.primary || base.primary) : base.primary,
    primaryGreen: isValidPrimary ? (overrides?.primary || base.primaryGreen) : base.primaryGreen,
    secondary: overrides?.secondary || base.secondary,
  };
}

export const defaultColors = lightColors;
