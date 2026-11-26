package org.weldsuite.core.server

import org.weldsuite.api.core.models.RuntimeConfig
import org.weldsuite.core.AppIdentity

/** Why the app can't use a server. */
enum class ServerProblem {
    /** No answer, a slow answer or a network error. */
    UNREACHABLE,

    /** It answered, but not as a WeldSuite server on the Rust backend. */
    NOT_WELDSUITE,

    /** It has no native client for the apps, or a sign-in this build can't do. */
    NO_MOBILE_SIGN_IN,

    /** It doesn't serve the app's module. */
    APP_UNAVAILABLE,
}

/** What the app signs in with on a server that passed [assessServer]. */
data class OidcSettings(
    val issuer: String,
    val clientId: String,
    val scopes: List<String>,
)

private val DEFAULT_SCOPES = listOf("openid", "profile", "email", "offline_access")

/**
 * Whether this app can use a server that answered with [config], and how it
 * signs in there. The native apps support WeldID's membership mode only
 * (`workspaceSource: header`): the token names no workspace and every request
 * names it in `X-Weld-Workspace`.
 */
fun assessServer(config: RuntimeConfig, app: AppIdentity): Result<OidcSettings, ServerProblem> {
    if (config.backend != "rust") return Result.Failure(ServerProblem.NOT_WELDSUITE)
    val auth = config.auth ?: return Result.Failure(ServerProblem.NO_MOBILE_SIGN_IN)
    val issuer = auth.issuer
    val clientId = auth.mobileClientId
    if (auth.provider != "oidc" || issuer.isNullOrBlank() || clientId.isNullOrBlank()) {
        return Result.Failure(ServerProblem.NO_MOBILE_SIGN_IN)
    }
    if (auth.workspaceSource != "header") return Result.Failure(ServerProblem.NO_MOBILE_SIGN_IN)
    val modules = config.modules
    if (modules != null && app.requiredModules.any { it !in modules }) {
        return Result.Failure(ServerProblem.APP_UNAVAILABLE)
    }
    val scopes = auth.scopes?.takeIf { it.isNotEmpty() } ?: DEFAULT_SCOPES
    return Result.Success(OidcSettings(issuer = issuer, clientId = clientId, scopes = scopes))
}

/**
 * Whether [installed] is below the minimum version the server names for the
 * app (`mobile.minVersions.<code>`). Dotted numbers, compared part by part;
 * anything after a `-` is ignored. No minimum, or one that doesn't parse,
 * means no gate.
 */
fun isBelowMinimumVersion(installed: String, minimum: String?): Boolean {
    if (minimum.isNullOrBlank()) return false
    val have = versionParts(installed) ?: return false
    val need = versionParts(minimum) ?: return false
    for (index in 0 until maxOf(have.size, need.size)) {
        val a = have.getOrElse(index) { 0 }
        val b = need.getOrElse(index) { 0 }
        if (a != b) return a < b
    }
    return false
}

private fun versionParts(version: String): List<Int>? {
    val core = version.substringBefore('-').trim()
    if (core.isEmpty()) return null
    return core.split('.').map { it.toIntOrNull() ?: return null }
}

/** A value or a reason, without exceptions. */
sealed interface Result<out T, out E> {
    data class Success<T>(val value: T) : Result<T, Nothing>
    data class Failure<E>(val error: E) : Result<Nothing, E>
}
