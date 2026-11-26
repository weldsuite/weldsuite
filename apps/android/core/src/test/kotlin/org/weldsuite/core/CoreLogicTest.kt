package org.weldsuite.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.core.models.RuntimeAuth
import org.weldsuite.api.core.models.RuntimeConfig
import org.weldsuite.core.auth.WorkspaceRef
import org.weldsuite.core.auth.chooseActiveWorkspace
import org.weldsuite.core.auth.storageIdFor
import org.weldsuite.core.server.Result
import org.weldsuite.core.server.ServerProblem
import org.weldsuite.core.server.assessServer
import org.weldsuite.core.server.isBelowMinimumVersion

class CoreLogicTest {
    private val app = AppIdentity(
        code = "weldpass",
        name = "WeldPass",
        scheme = "weldpass",
        requiredModules = listOf("pass"),
        euServerUrl = "https://app.weldsuite.eu",
        versionName = "2.0.0",
        storeUrl = "https://play.google.com/store/apps/details?id=com.weldsuite.weldpass",
    )

    private val weldId = RuntimeAuth(
        provider = "oidc",
        issuer = "https://auth.weldsuite.eu",
        mobileClientId = "weldsuite-mobile",
        scopes = listOf("openid", "profile", "email", "offline_access"),
        workspaceSource = "header",
    )

    private val eu = RuntimeConfig(backend = "rust", modules = listOf("core", "pass"), auth = weldId)

    @Test
    fun `a WeldID server that runs WeldPass is accepted`() {
        val result = assessServer(eu, app)
        assertTrue(result is Result.Success)
        val settings = (result as Result.Success).value
        assertEquals("weldsuite-mobile", settings.clientId)
        assertEquals("https://auth.weldsuite.eu", settings.issuer)
    }

    @Test
    fun `a server without a mobile client can't be signed in to`() {
        val result = assessServer(eu.copy(auth = weldId.copy(mobileClientId = null)), app)
        assertEquals(Result.Failure(ServerProblem.NO_MOBILE_SIGN_IN), result)
    }

    @Test
    fun `claim-mode providers aren't supported yet`() {
        val result = assessServer(eu.copy(auth = weldId.copy(workspaceSource = "claim")), app)
        assertEquals(Result.Failure(ServerProblem.NO_MOBILE_SIGN_IN), result)
    }

    @Test
    fun `a server without the pass module is unavailable to WeldPass`() {
        val result = assessServer(eu.copy(modules = listOf("core", "crm")), app)
        assertEquals(Result.Failure(ServerProblem.APP_UNAVAILABLE), result)
    }

    @Test
    fun `the TypeScript backend isn't a server the native apps use`() {
        assertEquals(Result.Failure(ServerProblem.NOT_WELDSUITE), assessServer(eu.copy(backend = "workers"), app))
    }

    @Test
    fun `missing scopes fall back to the standard ones`() {
        val result = assessServer(eu.copy(auth = weldId.copy(scopes = null)), app) as Result.Success
        assertEquals(listOf("openid", "profile", "email", "offline_access"), result.value.scopes)
    }

    @Test
    fun `the version gate compares dotted numbers`() {
        assertTrue(isBelowMinimumVersion("2.0.0", "2.0.1"))
        assertTrue(isBelowMinimumVersion("2.9", "2.10"))
        assertFalse(isBelowMinimumVersion("2.10.0", "2.9.9"))
        assertFalse(isBelowMinimumVersion("2.0.0", "2.0"))
        assertFalse(isBelowMinimumVersion("2.0.0-beta.1", "2.0.0"))
        assertFalse(isBelowMinimumVersion("2.0.0", null))
        assertFalse(isBelowMinimumVersion("2.0.0", "soon"))
    }

    @Test
    fun `a sole workspace is chosen without asking`() {
        val only = listOf(WorkspaceRef("ws_1", "Acme"))
        assertEquals("ws_1", chooseActiveWorkspace(only, current = null, chosenAfterReadStarted = false))
    }

    @Test
    fun `a listed choice is kept and an unlisted one dropped`() {
        val two = listOf(WorkspaceRef("ws_1", "Acme"), WorkspaceRef("ws_2", "Beta"))
        assertEquals("ws_2", chooseActiveWorkspace(two, current = "ws_2", chosenAfterReadStarted = false))
        assertNull(chooseActiveWorkspace(two, current = "ws_gone", chosenAfterReadStarted = false))
    }

    @Test
    fun `a choice made while the list was loading is kept`() {
        val two = listOf(WorkspaceRef("ws_1", "Acme"), WorkspaceRef("ws_2", "Beta"))
        assertEquals("ws_new", chooseActiveWorkspace(two, current = "ws_new", chosenAfterReadStarted = true))
    }

    @Test
    fun `storage ids are safe keys`() {
        assertEquals("app.weldsuite.eu", storageIdFor("https://app.weldsuite.eu"))
        assertEquals("example.com_8443", storageIdFor("https://example.com:8443"))
    }
}
