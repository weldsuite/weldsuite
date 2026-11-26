import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

/**
 * The API clients, generated at build time from the OpenAPI files in
 * `apps/mobile-shared/openapi` (one package per file): Retrofit interfaces
 * with suspend functions and kotlinx.serialization models. Nothing generated
 * is committed.
 */
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

kotlin {
    jvmToolchain(17)
}

val specs = mapOf(
    "core" to "org.weldsuite.api.core",
    "weldpass" to "org.weldsuite.api.weldpass",
)
val generatedRoot = layout.buildDirectory.dir("generated/openapi")

val generateTasks = specs.map { (name, pkg) ->
    tasks.register<GenerateTask>("generate${name.replaceFirstChar { it.uppercase() }}Api") {
        group = "openapi"
        generatorName.set("kotlin")
        library.set("jvm-retrofit2")
        inputSpec.set(rootProject.layout.projectDirectory.file("../mobile-shared/openapi/$name.yaml").asFile.absolutePath)
        outputDir.set(generatedRoot.get().dir(name).asFile.absolutePath)
        packageName.set(pkg)
        apiPackage.set("$pkg.apis")
        modelPackage.set("$pkg.models")
        // APIs and models only (plus the helper the APIs import): the
        // Retrofit instance is built in :core.
        globalProperties.set(
            mapOf(
                "apis" to "",
                "models" to "",
                "supportingFiles" to "CollectionFormats.kt",
                "apiDocs" to "false",
                "modelDocs" to "false",
            ),
        )
        generateApiTests.set(false)
        generateModelTests.set(false)
        validateSpec.set(true)
        configOptions.set(
            mapOf(
                "serializationLibrary" to "kotlinx_serialization",
                "useCoroutines" to "true",
                "dateLibrary" to "string",
                "enumPropertyNaming" to "UPPERCASE",
                "sourceFolder" to "src/main/kotlin",
            ),
        )
    }
}

sourceSets.main {
    specs.keys.forEach { name -> kotlin.srcDir(generatedRoot.map { it.dir("$name/src/main/kotlin") }) }
}

tasks.named("compileKotlin") { dependsOn(generateTasks) }

dependencies {
    api(libs.retrofit)
    api(libs.kotlinx.serialization.json)
}
