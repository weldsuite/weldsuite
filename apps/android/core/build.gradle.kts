/**
 * What every native WeldSuite app shares, without UI: the server and its
 * `/config.json`, WeldID sign-in, the workspace, the API client, secure
 * storage and the app lock. The screens built on it live in `:ui`.
 */
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "org.weldsuite.core"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // java.time on API 24 and 25, as in the apps.
        isCoreLibraryDesugaringEnabled = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    api(project(":api"))
    api(libs.kotlinx.coroutines.android)
    api(libs.okhttp)
    api(libs.appauth)
    api(libs.biometric)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.browser)
    implementation(libs.lifecycle.process)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
