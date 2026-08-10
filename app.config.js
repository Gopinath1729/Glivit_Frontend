const appJson = require('./app.json');

module.exports = ({ config }) => {
  const googleMapsApiKey =
    process.env.GOOGLE_MAPS_API_KEY || process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY || '';
  const allowCleartextHttp =
    (process.env.EXPO_PUBLIC_DEMO_MODE || '').toLowerCase() === 'true' ||
    (process.env.EXPO_PUBLIC_ALLOW_CLEARTEXT_HTTP || '').toLowerCase() === 'true';

  const expoConfig = {
    ...config,
    ...appJson.expo,
    android: {
      ...appJson.expo.android,
      ...config.android,
      usesCleartextTraffic: allowCleartextHttp
        ? true
        : appJson.expo.android?.usesCleartextTraffic,
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
