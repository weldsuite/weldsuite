package org.weldsuite.core

/**
 * Who the app is, and what its build bakes in. The rest comes from the
 * server's `/config.json`.
 *
 * @property code the app code, sent as `X-Weld-App` (`weldpass`).
 * @property scheme the URL scheme WeldID redirects to (`<scheme>://sso-callback`).
 * @property requiredModules modules a server must serve for the app to work there.
 * @property euServerUrl the WeldSuite EU server this build starts on.
 * @property versionName the app's version, for the server's minimum-version gate.
 * @property storeUrl the app's store page, for "Update".
 */
data class AppIdentity(
    val code: String,
    val name: String,
    val scheme: String,
    val requiredModules: List<String>,
    val euServerUrl: String,
    val versionName: String,
    val storeUrl: String,
) {
    val redirectUri: String get() = "$scheme://sso-callback"
}
