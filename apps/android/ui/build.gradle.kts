/**
 * The look every native WeldSuite app shares: the Material 3 theme seeded
 * from the app's brand colour, the generated design tokens, and the screens
 * around an app (sign-in, workspace, lock, server problems) in [SessionGate].
 */
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "org.weldsuite.ui"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":core"))
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.material3)
    api(libs.compose.material.icons)
    api(libs.compose.ui.tooling.preview)
    api(libs.activity.compose)
    api(libs.lifecycle.runtime.compose)
    debugImplementation(libs.compose.ui.tooling)
}
