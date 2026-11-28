/**
 * Push for the apps that use it (not WeldPass): the FCM token, registered with
 * the server through `:core`'s `PushTokens`, the messaging service that shows
 * notifications and hands taps to the app, and the notification permission.
 *
 * Firebase is set up in code from the app's build settings (`FcmOptions`),
 * without the google-services plugin. Without them the app runs without push.
 */
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "org.weldsuite.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    api(project(":ui"))
    api(platform(libs.firebase.bom))
    api(libs.firebase.messaging)
}
