# GLIVT Android release runbook

The Android package is `com.vehiclemoment.tracker`. Expo SDK 54 targets Android API 36, and the production profile builds an Android App Bundle (`.aab`) with automatic version-code increments. Production configuration fails closed if any of these are absent:

- `EXPO_PUBLIC_BACKEND_BASE_URL`: stable public HTTPS Spring Boot API
- `EXPO_PUBLIC_GEOAPIFY_API_KEY`: Geoapify key with Map Tiles enabled

Do not use an expiring tunnel URL for a Play release.

Road map matching is configured on the **backend**, not in the app. The app draws
the matched geometry the API returns and never calls a routing service itself, so
there is no routing variable to set here. The backend needs
`APP_MAP_MATCHING_BASE_URL` (and `APP_MAP_MATCHING_ENGINE`, `OSRM` or `VALHALLA`)
pointing at a self-hosted or contracted service under an appropriate SLA. Public
demo routing servers are rate-limited to roughly one request a second and are a
development convenience only — a fleet pointed at one will see history routes fall
back to raw GPS.

## First EAS setup

Choose the correct Expo account or organization before running `init`; this repository deliberately does not guess ownership.

```powershell
npx eas-cli whoami
npx eas-cli init
```

Add the two production variables to the EAS `production` environment. Public
Expo variables are embedded in the app bundle and must never be treated as
server secrets. Restrict Geoapify API access to the APIs the app uses and set
usage limits/alerts on the Geoapify project.

```powershell
npx eas-cli env:create --environment production --name EXPO_PUBLIC_BACKEND_BASE_URL --value https://api.example.com --visibility plaintext
npx eas-cli env:create --environment production --name EXPO_PUBLIC_GEOAPIFY_API_KEY --value YOUR_GEOAPIFY_KEY --visibility sensitive
```

## Verify and build

```powershell
npm ci
npm run lint
npx tsc --noEmit
npx expo-doctor
npx eas-cli build --platform android --profile production
```

The build profile produces an AAB. EAS can create and retain the Android signing keystore on the first build.

## Upload to Play internal testing

For the first release, create the app in Play Console and complete its store listing, app-content declarations, privacy-policy URL, data-safety form, and app-access instructions. Create a Google Play service-account key for EAS submission, then configure its path outside source control and run:

The required 1024 x 500 feature graphic is ready at `assets/store/feature-graphic.png`.

```powershell
npx eas-cli submit --platform android --profile production --latest
```

The configured submit profile targets **Internal testing** and creates a draft, preventing an accidental public rollout. Add testers and publish the internal release from Play Console after the pre-launch checks pass.

## Play Console declarations

- Location permission is foreground-only. Its purpose is to show the signed-in operator relative to vehicles and to help select a geofence center. The app does not use phone background location as a tracker.
- Tracked vehicle coordinates come from separately registered GPS devices, are tenant-scoped, and are used for live maps, trip history, geofences, speed alerts, distance, status, and reports.
- Declare account identifiers, authentication data, uploaded profile/document images, and precise location according to the production backend's actual collection, retention, sharing, and deletion practices.
- Supply reviewer credentials and a company code because the app is authentication-gated.
- Host [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) on a public HTTPS URL after replacing every placeholder.

## One-hour reality check

An internal-test build can usually be prepared in an hour once the EAS project, keys, HTTPS services, Play listing, and tester list already exist. Public production availability is controlled by Google review. Personal Play accounts created after 13 November 2023 may also have mandatory testing requirements before production access.

References: [Expo Android submission](https://docs.expo.dev/submit/android/), [Expo APK/AAB build profiles](https://docs.expo.dev/build-reference/apk/), [Google target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878), and [Play testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465).
