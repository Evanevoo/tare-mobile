// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const config = getDefaultConfig(__dirname);

/**
 * See metro-stubs/empty.js: src/scanx/core.js (the ScanX asm.js decoder) has
 * a Node-only branch, dead under Hermes/RN, that Metro still needs to
 * statically resolve `require('path')` / `require('fs')` inside. Without
 * this, every bundle that imports src/scanx (Settings' admin-only "Scanner
 * test" screen) fails to build on both platforms.
 */
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  path: path.resolve(__dirname, 'metro-stubs/empty.js'),
  fs: path.resolve(__dirname, 'metro-stubs/empty.js'),
};

module.exports = config;
