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

export const env = {
  /** Base URL of the Glivt backend, e.g. https://api.example.com */
  backendBaseUrl,
  /** REST root: <backend>/api */
  apiBaseUrl: backendBaseUrl ? `${backendBaseUrl}/api` : '/api',
  geoapifyApiKey: process.env.EXPO_PUBLIC_GEOAPIFY_API_KEY || '',
  /** Production data is always authoritative; offline/demo routing is disabled. */
  demoMode: false,
};
