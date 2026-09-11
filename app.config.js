const appJson = require('./app.json');

module.exports = ({ config }) => {
  const easBuild = Boolean(process.env.EAS_BUILD_PROFILE);
  const backendBaseUrl = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || '';
  const googleMapsApiKey =
    process.env.GOOGLE_MAPS_API_KEY || process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY || '';

  // Any EAS build, not just production. A preview APK with no API host is the
  // exact failure this guard exists to prevent, and it used to sail through
  // because the check was scoped to the production profile: the build succeeded,
  // the APK installed, and every request inside it failed with an opaque network
  // error. Failing here costs a minute; shipping a disconnected build costs an
  // install-and-test cycle to discover.
  if (easBuild) {
    const missing = [];
    if (!/^https:\/\//i.test(backendBaseUrl)) {
      missing.push(
        'EXPO_PUBLIC_BACKEND_BASE_URL (an https:// URL). Set it in eas.json for ' +
          'this profile, or with `npx eas-cli env:create`. Note that .env is ' +
          'gitignored and is NOT uploaded to EAS.'
      );
    }
    // Road matching is configured on the backend, not here: the app no longer
    // calls a routing service directly, so there is nothing for a production
    // build to require on this side.
    if (missing.length > 0) {
      throw new Error(
        `${process.env.EAS_BUILD_PROFILE} build is missing:\n  - ${missing.join('\n  - ')}`
      );
    }
  }

  const expoConfig = {
    ...config,
    ...appJson.expo,
    android: {
      ...appJson.expo.android,
      ...config.android,
    },
  };

  if (!googleMapsApiKey) {
    return expoConfig;
  }

  return {
    ...expoConfig,
    android: {
      ...expoConfig.android,
      config: {
        ...expoConfig.android?.config,
        googleMaps: {
          ...expoConfig.android?.config?.googleMaps,
          apiKey: googleMapsApiKey,
        },
      },
    },
  };
};
