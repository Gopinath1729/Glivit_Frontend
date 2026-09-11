/**
 * Design tokens for the Glivt fleet platform.
 *
 * A single semantic colour contract is defined twice — once for `light`, once
 * for `dark` — with IDENTICAL keys, so any component can switch themes just by
 * reading colours from the active scheme. Legacy exports (`palette`,
 * `defaultColors`, `stateColors`) resolve to the light scheme for backwards
 * compatibility; new/redesigned components pull colours from `useTheme()`.
 *
 * Design language: Material 3, in the register Google uses for its own
 * first-party products — a single blue accent carried on true-neutral greys,
 * tonal containers instead of tinted shadows, hairline outlines, and generous
 * type. There is deliberately no green anywhere in the brand or status
 * vocabulary: an active vehicle reads blue, a stopped one red, an unreachable
 * one grey, which keeps vehicle state legible against a map whose own
 * landcover is green. Tenant branding overrides `primary`/`secondary` at
 * runtime.
 */

export type Scheme = 'light' | 'dark';

/** The full semantic colour contract shared by both themes. */
export type ThemeColors = {
  // Brand
  primary: string;
  /** One step darker than `primary`: pressed states, and text on tonal fills. */
  primaryStrong: string;
  /** Darkest brand step. Reserved for outlines that must survive on colour. */
  primaryDeep: string;
  secondary: string;
  onPrimary: string;
  accent: string;
  /** Tonal container — a wash of the accent, for chips and selected rows. */
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
  primary: '#1A73E8',
  primaryStrong: '#1B66C9',
  primaryDeep: '#174EA6',
  secondary: '#5F6368',
  onPrimary: '#FFFFFF',
  accent: '#1A73E8',
  accentSoft: '#E8F0FE',

  pageBackground: '#F8F9FA',
  cardBackground: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F3F4',
  surfaceElevated: '#FFFFFF',
  loginBackground: '#202124',

  divider: '#E8EAED',
  border: '#DADCE0',
  borderStrong: '#BDC1C6',

  textPrimary: '#202124',
  textSecondary: '#3C4043',
  textMuted: '#5F6368',

  blue: '#1A73E8',
  info: '#1A73E8',
  success: '#1A73E8',
  warning: '#F29900',
  warningOrange: '#F29900',
  danger: '#D93025',
  errorRed: '#D93025',

  white: '#FFFFFF',
  black: '#202124',
  overlay: 'rgba(32, 33, 36, 0.55)',
  shadowColor: '#202124',
};

export const darkColors: ThemeColors = {
  // Material 3 desaturates the accent for dark surfaces rather than reusing the
  // light-mode hue, which would vibrate against a near-black background.
  primary: '#8AB4F8',
  primaryStrong: '#A8C7FA',
  primaryDeep: '#D2E3FC',
  secondary: '#9AA0A6',
  onPrimary: '#202124',
  accent: '#8AB4F8',
  accentSoft: 'rgba(138, 180, 248, 0.16)',

  pageBackground: '#131314',
  cardBackground: '#1E1F20',
  surface: '#1E1F20',
  surfaceAlt: '#282A2C',
  surfaceElevated: '#303134',
  loginBackground: '#131314',

  divider: '#2E2F31',
  border: '#3C4043',
  borderStrong: '#5F6368',

  textPrimary: '#E8EAED',
  textSecondary: '#BDC1C6',
  textMuted: '#9AA0A6',

  blue: '#8AB4F8',
  info: '#8AB4F8',
  success: '#8AB4F8',
  warning: '#FDD663',
  warningOrange: '#FDD663',
  danger: '#F28B82',
  errorRed: '#F28B82',

  white: '#FFFFFF',
  black: '#000000',
  overlay: 'rgba(0, 0, 0, 0.62)',
  shadowColor: '#000000',
};

export const schemes: Record<Scheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

/**
 * Status colours, fixed across devices so a platform theme can never restyle
 * them. Deliberately green-free: the map's own parks and landcover are green,
 * so a green "running" pin competes with the basemap it sits on. Blue reads as
 * live, red as halted, grey as unreachable — and every surface that uses these
 * pairs them with a label or icon, never colour alone.
 */
export const CENTRALIZED_STATUS_COLORS = {
  RUNNING: '#1A73E8',
  MOVING: '#1A73E8',
  IDLE: '#F29900',
  STOPPED: '#D93025',
  LOW_ACCURACY: '#F29900',
  INACTIVE: '#9AA0A6',
  OFFLINE: '#80868B',
  // The phone's own location switch is off: actionable by the user, so it is
  // warned about rather than greyed out like an unreachable tracker.
  LOCATION_DISABLED: '#F29900',
  NO_DATA: '#5F6368',
  EXPIRED: '#3C4043',
  IMMOBILISED: '#D93025',
  GPS_INVALID: '#F29900',
  POWER_DISCONNECTED: '#F29900',
  HEALTHY: '#1A73E8',
  WARNING: '#F29900',
  CRITICAL: '#D93025',
  MAINTENANCE: '#7B61FF',
  TOTAL: '#1A73E8',
  SUCCESS: '#1A73E8',
  DANGER: '#D93025',
} as const;

/** Converts a hex color code (e.g. #D93025) to standard rgba format for consistent cross-platform rendering. */
export function hexToRgba(hex: string, alpha: number): string {
  const cleanHex = (hex ?? '').trim().replace('#', '');
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

/**
 * Material 3 state layers: a translucent scrim of the content colour laid over
 * a surface to show hover/focus/press, rather than swapping the fill for a
 * different colour. Keeping press feedback as a layer is what stops a pressed
 * button from changing size or shifting the layout around it.
 */
export const stateLayerOpacity = {
  hover: 0.08,
  focus: 0.1,
  pressed: 0.1,
  dragged: 0.16,
  selected: 0.12,
} as const;

export function stateLayer(color: string, state: keyof typeof stateLayerOpacity = 'pressed') {
  return hexToRgba(color, stateLayerOpacity[state]);
}

/** Disabled emphasis, per Material 3. */
export const disabledOpacity = { content: 0.38, container: 0.12 } as const;

/** Vehicle/device state colours, resolved per scheme. White text sits on top. */
export function stateColorsFor(colors: ThemeColors): Record<string, string> {
  return {
    ...CENTRALIZED_STATUS_COLORS,
  };
}

/**
 * Elevation presets, following Material 3's five levels.
 *
 * Dark mode leans on lighter surfaces and borders rather than shadow, because a
 * black shadow on a near-black background conveys nothing.
 */
export function elevation(colors: ThemeColors, level: 1 | 2 | 3 | 4 | 5 = 1) {
  const dark = colors === darkColors;
  const map = {
    1: { radius: 3, opacity: dark ? 0.3 : 0.1, y: 1, e: 1 },
    2: { radius: 6, opacity: dark ? 0.34 : 0.12, y: 2, e: 3 },
    3: { radius: 10, opacity: dark ? 0.38 : 0.14, y: 4, e: 6 },
    4: { radius: 16, opacity: dark ? 0.42 : 0.16, y: 8, e: 8 },
    5: { radius: 24, opacity: dark ? 0.46 : 0.18, y: 12, e: 12 },
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

/** Material 3 shape scale. `pill` is the fully-rounded "stadium" shape. */
export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 28,
  pill: 999,
} as const;

export const typography = {
  h1: 28,
  h2: 22,
  title: 16,
  body: 16,
  label: 14,
  caption: 12,
} as const;

/**
 * Material 3 type roles. Sizes are in points with their paired line height and
 * tracking, so a caller never has to guess leading. Body starts at 16 so mobile
 * text stays readable and iOS does not auto-zoom form fields.
 */
export const typeScale = {
  displayLarge: { fontSize: 45, lineHeight: 52, letterSpacing: 0 },
  headlineLarge: { fontSize: 32, lineHeight: 40, letterSpacing: 0 },
  headlineMedium: { fontSize: 28, lineHeight: 36, letterSpacing: 0 },
  headlineSmall: { fontSize: 24, lineHeight: 32, letterSpacing: 0 },
  titleLarge: { fontSize: 22, lineHeight: 28, letterSpacing: 0 },
  titleMedium: { fontSize: 16, lineHeight: 24, letterSpacing: 0.15 },
  titleSmall: { fontSize: 14, lineHeight: 20, letterSpacing: 0.1 },
  bodyLarge: { fontSize: 16, lineHeight: 24, letterSpacing: 0.5 },
  bodyMedium: { fontSize: 14, lineHeight: 20, letterSpacing: 0.25 },
  bodySmall: { fontSize: 12, lineHeight: 16, letterSpacing: 0.4 },
  labelLarge: { fontSize: 14, lineHeight: 20, letterSpacing: 0.1 },
  labelMedium: { fontSize: 12, lineHeight: 16, letterSpacing: 0.5 },
  labelSmall: { fontSize: 11, lineHeight: 16, letterSpacing: 0.5 },
} as const;

/** Font weights, named so call sites stop scattering raw numeric strings. */
export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const layout = {
  appBarHeight: 64,
  fabSize: 56,
  inputHeight: 56,
  buttonHeight: 48,
  /** Material's minimum touch target. Never ship a control smaller than this. */
  touchTarget: 48,
} as const;

/** Motion durations and easing, per Material 3. Exits are quicker than entrances. */
export const motion = {
  durationShort: 150,
  durationMedium: 250,
  durationLong: 400,
  exitFactor: 0.7,
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

/**
 * The greens this product used to brand itself with.
 *
 * A tenant's brand colour is persisted server-side and in SecureStore, so
 * retiring green in code is not enough on its own — every existing account is
 * still carrying one of these and would drag the old theme back the moment it
 * loaded. They are rejected the same way flat greys are, which lets a tenant
 * who deliberately chose some other colour keep it.
 */
const RETIRED_BRAND_COLORS = new Set([
  '#22C55E', '#16A34A', '#27D34D', '#2BE69E', '#2BE6A6', '#18B77B',
  '#087C73', '#118A36', '#0F9D58', '#0B8043', '#10B981', '#1E8E3E',
]);

/**
 * Rejects the retired greens by hue rather than only by exact value, because
 * the stored colour varies per account and an unlisted shade would walk the old
 * theme straight back in. The named teal is caught by the set above, since its
 * blue channel is too close to its green one for the hue test to fire.
 */
function isRetiredBrandColor(hex?: string): boolean {
  if (!hex) return false;
  const clean = hex.trim().toUpperCase();
  if (RETIRED_BRAND_COLORS.has(clean)) return true;
  const body = clean.replace('#', '');
  if (body.length !== 6) return false;
  const r = parseInt(body.substring(0, 2), 16);
  const g = parseInt(body.substring(2, 4), 16);
  const b = parseInt(body.substring(4, 6), 16);
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return false;
  return g > r + 18 && g > b + 18;
}

/** Builds the active colour set, applying tenant overrides when present. */
export function buildColors(
  scheme: Scheme = 'light',
  overrides?: { primary?: string; secondary?: string }
): ThemeColors {
  const base = schemes[scheme];
  const isValidPrimary =
    overrides?.primary &&
    !isGrayColor(overrides.primary) &&
    !isRetiredBrandColor(overrides.primary);
  const primary = isValidPrimary ? (overrides?.primary || base.primary) : base.primary;
  return {
    ...base,
    primary,
    // A tenant that overrides its brand colour must carry the accent with it,
    // or chips and selected rows keep rendering in the stock blue.
    accent: primary,
    secondary: overrides?.secondary || base.secondary,
  };
}

export const defaultColors = lightColors;
