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

android {
    namespace = "com.weldsuite.weldpass"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.weldsuite.weldpass"
        minSdk = 24
        targetSdk = 36
        // Above the React Native app's 1.x, which this replaces in the stores.
        // A release build gets a higher one from its workflow run (-PweldVersionCode).
        versionCode = (findProperty("weldVersionCode") as String?)?.toInt() ?: 200
        versionName = "2.0.0"
        // AppAuth's redirect activity: weldpass://sso-callback.
        manifestPlaceholders["appAuthRedirectScheme"] = "weldpass"
        buildConfigField("String", "EU_SERVER_URL", "\"https://app.weldsuite.eu\"")
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
    implementation(project(":ui"))
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.process)
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
