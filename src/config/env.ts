import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Environment configuration. Only EXPO_PUBLIC_* values are readable on the
 * client. Secrets (Firebase admin, Razorpay secret, DB) live on the backend.
 */

/** Port the Spring Boot backend listens on (see backend server.port). */
const BACKEND_PORT = 8085;

/**
 * The dev machine's address, taken from whoever served this bundle.
 *
 * In development the backend runs on the same machine as Metro, so its host is
 * already known and does not need to be written down. Hardcoding a LAN IP is
 * what breaks the app every time DHCP hands out a new lease — the symptom being
 * that every request fails while a restored session still looks signed in.
 */
function metroDerivedBaseUrl(): string {
  if (!__DEV__ || Platform.OS === 'web') return '';
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    '';
  const host = hostUri.split(':')[0]?.trim();
  if (!host || host === 'localhost' || host === '127.0.0.1') return '';
  return `http://${host}:${BACKEND_PORT}`;
}

const configuredBackendBaseUrl = (process.env.EXPO_PUBLIC_BACKEND_BASE_URL || '').replace(
  /\/+$/,
  ''
);
// An explicit value always wins, so pointing at a remote backend still works.
const rawBackendBaseUrl = configuredBackendBaseUrl || metroDerivedBaseUrl();



function normalizeBackendBaseUrl(value: string): string {
  if (!value) return '';
  if (Platform.OS === 'web') return value;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      if (Platform.OS === 'android') {
        url.hostname = '10.0.2.2';
        return url.toString().replace(/\/+$/, '');
      }
      console.warn(
        '[api-config] EXPO_PUBLIC_BACKEND_BASE_URL uses localhost on a mobile target. Use the computer LAN IP, for example http://192.168.x.x:8085.'
      );
    }
  } catch {
    console.warn('[api-config] Invalid EXPO_PUBLIC_BACKEND_BASE_URL. Expected http(s)://host:port.');
  }
  return value;
}

const backendBaseUrl = normalizeBackendBaseUrl(rawBackendBaseUrl);

if (__DEV__ && Platform.OS !== 'web' && !backendBaseUrl) {
  console.warn(
    '[api-config] Missing EXPO_PUBLIC_BACKEND_BASE_URL. Android emulator should use http://10.0.2.2:8085; physical devices should use the computer LAN IP.'
  );
}

/**
 * Whether this build actually knows where its backend is.
 *
 * False in a build that was bundled without `EXPO_PUBLIC_BACKEND_BASE_URL` --
 * which is what happens when the value lives only in `.env`, because `.env` is
 * gitignored and therefore never uploaded to EAS. The app used to fall back to
 * the relative path `/api`, which React Native cannot resolve, so every request
 * failed with a bare "Network request failed" and the real cause (a build-time
 * configuration mistake) was invisible from inside the app.
 */
export const isBackendConfigured = backendBaseUrl.length > 0;

/**
 * Why the backend is unreachable, or null when it is configured.
 *
 * Surfaced to the user rather than logged: in a release build there is no
 * console to read, and "Network request failed" is indistinguishable from a
 * genuine outage.
 */
export const backendConfigurationError = isBackendConfigured
  ? null
  : 'This build has no backend URL. It was compiled without ' +
    'EXPO_PUBLIC_BACKEND_BASE_URL - set it in eas.json (or via eas env:create) ' +
    'and rebuild. A value in .env alone does not reach an EAS build.';

/**
 * Headers every outbound request carries.
 *
 * `ngrok-skip-browser-warning` suppresses the interstitial HTML page an ngrok
 * free tunnel returns for requests it takes to be a browser. Without it the app
 * receives a page of HTML where it expected JSON, and the failure looks like a
 * malformed API rather than a tunnel. The header is meaningless to any other
 * host, and the backend allows all headers in its CORS policy, so it is safe to
 * send unconditionally rather than sniffing the URL for "ngrok".
 */
export const COMMON_API_HEADERS: Record<string, string> = {
  'ngrok-skip-browser-warning': 'true',
};

export const env = {
  /** Base URL of the Glivt backend, e.g. https://api.example.com */
  backendBaseUrl,
  /**
   * REST root: `<backend>/api`.
   *
   * Empty, not `/api`, when unconfigured. A relative URL looks like a valid
   * value to every caller and then fails deep inside the network layer; an empty
   * one lets {@link isBackendConfigured} be checked once, up front, and reported
   * for what it is.
   */
  apiBaseUrl: backendBaseUrl ? `${backendBaseUrl}/api` : '',
  isBackendConfigured,
  backendConfigurationError,
  geoapifyApiKey: process.env.EXPO_PUBLIC_GEOAPIFY_API_KEY || '',
};
