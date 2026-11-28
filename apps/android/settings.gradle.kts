pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "weldsuite-android"

include(":api")
include(":core")
include(":ui")
include(":push")

// The apps, and the API client each generates from apps/mobile-shared/openapi/<app>.yaml.
val apps = listOf("weldpass", "weldbooks", "weldmail", "weldcalendar", "weldchat", "welddesk", "weldhr")
for (app in apps) {
    include(":api:$app")
    include(":apps:$app")
}
