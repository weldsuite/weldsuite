plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.weldsuite.weldpass"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.weldsuite.weldpass"
        minSdk = 24
        targetSdk = 36
        // Above the React Native app's 1.x, which this replaces in the stores.
        versionCode = 200
        versionName = "2.0.0"
        // AppAuth's redirect activity: weldpass://sso-callback.
        manifestPlaceholders["appAuthRedirectScheme"] = "weldpass"
        buildConfigField("String", "EU_SERVER_URL", "\"https://app.weldsuite.eu\"")
    }

    buildTypes {
        debug {
            // Development builds start on the EU test cluster.
            buildConfigField("String", "EU_SERVER_URL", "\"https://app.test.weldsuite.eu\"")
            applicationIdSuffix = ".dev"
        }
        release {
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
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
}
