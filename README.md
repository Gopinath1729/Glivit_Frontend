# GLIVT mobile app

Expo/React Native client for GPS-device vehicle tracking. The product surface is intentionally limited to live vehicle maps, trip playback, geofences, speed and connectivity alerts, reports, vehicle profiles, and GPS-device administration.

## Local development

```powershell
Copy-Item .env.example .env
npm ci
npx expo start
```

Set `EXPO_PUBLIC_BACKEND_BASE_URL` to the Spring Boot API and set
`EXPO_PUBLIC_GEOAPIFY_TILES_API_KEY` to a restricted, Map-Tiles-only Geoapify
key. Never reuse the backend `GEOAPIFY_API_KEY` here. Android
emulators reach the host at `http://10.0.2.2:8085`; production releases require
HTTPS.

The legacy public tile variable `EXPO_PUBLIC_GEOAPIFY_API_KEY` remains accepted
during migration, but new environments should use the tiles-specific name.

## Quality gate

```powershell
npm run lint
npx tsc --noEmit
npx expo-doctor
npx expo export --platform android
```

## Android release

Use [the Play Store release runbook](./docs/PLAY_STORE_RELEASE.md). Production
builds are configured in [eas.json](./eas.json) and reject a missing HTTPS
backend or Geoapify key. Road matching remains a separately monitored backend
service.
