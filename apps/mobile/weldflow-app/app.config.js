const { withAppBuildGradle } = require('@expo/config-plugins');

const withAndroidPackagingExcludes = (config) => {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;

    let contents = config.modResults.contents;
    if (contents.includes('META-INF/versions/9/OSGI-INF/MANIFEST.MF')) return config;

    const packagingBlock = `    packaging {\n        resources {\n            excludes += [\n                'META-INF/versions/9/OSGI-INF/MANIFEST.MF',\n                'META-INF/versions/9/OSGI-INF/**',\n            ]\n        }\n    }\n`;

    contents = contents.replace(/android\s*\{/, (match) => `${match}\n${packagingBlock}`);
    config.modResults.contents = contents;
    return config;
  });
};

module.exports = ({ config }) => {
  config = withAndroidPackagingExcludes(config);
  return config;
};
