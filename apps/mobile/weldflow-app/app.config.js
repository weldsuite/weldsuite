const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

// Match weldchat's committed android/gradle.properties. Fresh prebuild defaults to
// 2 GiB heap / 512 MiB Metaspace, which OOMs mid-lintVital on GitHub runners
// (`:react-native-keyboard-controller:lintVitalAnalyzeRelease FAILED`).
const GRADLE_JVMARGS =
  '-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8';

const withIncreasedGradleMemory = (config) => {
  return withGradleProperties(config, (config) => {
    const items = config.modResults;
    const existing = items.find(
      (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs',
    );
    if (existing) {
      existing.value = GRADLE_JVMARGS;
    } else {
      items.push({ type: 'property', key: 'org.gradle.jvmargs', value: GRADLE_JVMARGS });
    }
    return config;
  });
};

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
  config = withIncreasedGradleMemory(config);
  config = withAndroidPackagingExcludes(config);
  return config;
};
