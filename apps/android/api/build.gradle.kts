import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

/**
 * The API clients, generated at build time from the OpenAPI files in
 * `apps/mobile-shared/openapi`: Retrofit interfaces with suspend functions and
 * kotlinx.serialization models. Nothing generated is committed.
 *
 * `:api` itself is the core client (`core.yaml`, used by `:core`); each app
 * has its own project, `:api:<app>` (`<app>.yaml`, package
 * `org.weldsuite.api.<app>`), so one app's half-written file never stops
 * another from building.
 */
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

/** The client libraries, from this project: the children have no `libs` of their own. */
val retrofit = libs.retrofit
val serializationJson = libs.kotlinx.serialization.json

/** Generate the client for `<spec>.yaml` into this project's build folder and compile it. */
fun Project.openApiClient(spec: String) {
    val pkg = "org.weldsuite.api.$spec"
    val generatedRoot = layout.buildDirectory.dir("generated/openapi")
    val generate = tasks.register<GenerateTask>("generate${spec.replaceFirstChar { it.uppercase() }}Api") {
        group = "openapi"
        generatorName.set("kotlin")
        library.set("jvm-retrofit2")
        inputSpec.set(rootProject.layout.projectDirectory.file("../mobile-shared/openapi/$spec.yaml").asFile.absolutePath)
        outputDir.set(generatedRoot.get().asFile.absolutePath)
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
    extensions.configure<KotlinJvmProjectExtension> {
        jvmToolchain(17)
        sourceSets.getByName("main").kotlin.srcDir(generatedRoot.map { it.dir("src/main/kotlin") })
    }
    tasks.named("compileKotlin") { dependsOn(generate) }
    dependencies {
        "api"(retrofit)
        "api"(serializationJson)
    }
}

openApiClient("core")

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.serialization")
    apply(plugin = "org.openapi.generator")
    openApiClient(name)
}
