plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * The upload key a store release is signed with, from the environment the
 * "Mobile native release" workflow sets up. Without it a release build comes
 * out unsigned.
 */
val uploadKeystore: String? = System.getenv("WELD_UPLOAD_KEYSTORE")

/** A build setting from a Gradle property or the environment; empty without one. */
fun setting(name: String): String = (findProperty(name) as String?) ?: System.getenv(name) ?: ""

android {
    namespace = "com.weldsuite.weldcalendar"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.weldsuite.weldcalendar"
        minSdk = 24
        targetSdk = 36
        // Above the React Native app's version, which this replaces in the stores.
        // A release build gets a higher one from its workflow run (-PweldVersionCode).
        versionCode = (findProperty("weldVersionCode") as String?)?.toInt() ?: 200
        versionName = "2.0.0"
        // AppAuth's redirect activity: weldcalendar://sso-callback.
        manifestPlaceholders["appAuthRedirectScheme"] = "weldcalendar"
        buildConfigField("String", "EU_SERVER_URL", "\"https://app.weldsuite.eu\"")
        // Push: the Firebase project the apps share, and this app's id in it.
        // Without them the app runs without push.
        buildConfigField("String", "FCM_PROJECT_ID", "\"" + setting("WELD_FCM_PROJECT_ID") + "\"")
        buildConfigField("String", "FCM_API_KEY", "\"" + setting("WELD_FCM_API_KEY") + "\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"" + setting("WELD_FCM_SENDER_ID") + "\"")
        buildConfigField("String", "FCM_APP_ID", "\"" + setting("WELD_FCM_APP_ID_WELDCALENDAR") + "\"")
    }

    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storePassword = System.getenv("WELD_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WELD_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("WELD_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // Development builds start on the EU test cluster.
            buildConfigField("String", "EU_SERVER_URL", "\"https://app.test.weldsuite.eu\"")
            applicationIdSuffix = ".dev"
        }
        release {
            signingConfig = signingConfigs.findByName("upload")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":push"))
    implementation(project(":api:weldcalendar"))
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.process)
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
