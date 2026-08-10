const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.blockList =
  /.*[\/\\](?:android[\/\\](?:\.cxx|app[\/\\]build)|node_modules[\/\\].*[\/\\]android[\/\\]\.cxx)[\/\\].*/;

if (!config.resolver.assetExts.includes('fbx')) {
  config.resolver.assetExts.push('fbx');
}

if (!config.resolver.assetExts.includes('glb')) {
  config.resolver.assetExts.push('glb');
}

module.exports = config;
