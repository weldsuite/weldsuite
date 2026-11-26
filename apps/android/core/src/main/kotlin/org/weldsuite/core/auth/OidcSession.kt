package org.weldsuite.core.auth

import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.GrantTypeValues
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.TokenRequest
import net.openid.appauth.TokenResponse
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.weldsuite.core.WeldJson
import org.weldsuite.core.server.OidcSettings
import org.weldsuite.core.storage.KeyValueStore
import kotlin.coroutines.resume

/** What the session knows right now. */
data class AuthSnapshot(
    val isLoaded: Boolean = false,
    val person: Person? = null,
    val workspaces: List<WorkspaceRef> = emptyList(),
    val activeWorkspaceId: String? = null,
    /** No workspace list has been read for this person yet, and one is being read. */
    val isLoadingWorkspaces: Boolean = false,
)

/** How a sign-in ended. */
sealed interface SignInOutcome {
    data object SignedIn : SignInOutcome
    data object Cancelled : SignInOutcome
    data class Failed(val reason: Reason) : SignInOutcome {
        enum class Reason { UNREACHABLE, FAILED }
    }
}

/**
 * WeldID sign-in for the native apps, through AppAuth: authorization code
 * with PKCE in a Custom Tab, the public client from `/config.json`
 * (`mobileClientId`), redirect `<scheme>://sso-callback`.
 *
 * WeldID runs in membership mode: the token names no workspace. The
 * workspace list is WeldSuite's own (`GET /api/workspaces`), read after
 * sign-in and at start, and cached with the profile; the active workspace is
 * a choice made here and sent in `X-Weld-Workspace`.
 *
 * The refresh token is kept in [secure]; the access token only in memory.
 * After a sign-out, the next sign-in asks WeldID for its form
 * (`prompt=login`), so WeldID's own session in the browser can't sign the
 * same account straight back in.
 */
class OidcSession(
    context: Context,
    private val settings: OidcSettings,
    private val redirectUri: String,
    storageId: String,
    private val secure: KeyValueStore,
    private val cache: KeyValueStore,
    private val http: OkHttpClient,
    private val loadWorkspaces: suspend (token: String) -> List<WorkspaceRef>?,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val appContext = context.applicationContext
    private val authService by lazy { AuthorizationService(appContext) }
    private val secureKey = "weldsuite.oidc.$storageId"
    private val profileKey = "weldsuite:oidc-profile:$storageId"
    private val promptLoginKey = "weldsuite:oidc-prompt-login:$storageId"

    private val state = MutableStateFlow(AuthSnapshot())
    val snapshot: StateFlow<AuthSnapshot> = state.asStateFlow()

    private val tokenLock = Mutex()
    private var stored: StoredSession? = null
    private var profile: CachedProfile? = null
    private var access: AccessToken? = null
    private var configuration: AuthorizationServiceConfiguration? = null
    private var activeChosenAt = 0L
    private var directoryRead: Deferred<Unit>? = null

    /** The active workspace (`workspaces.id`), for `X-Weld-Workspace`. */
    val activeWorkspaceId: String? get() = state.value.activeWorkspaceId

    /** Read the stored session. Never waits for the network. */
    fun init() {
        if (state.value.isLoaded) return
        val session = secure.get(secureKey)?.let { decode<StoredSession>(it) }
        val cached = cache.get(profileKey)?.let { decode<CachedProfile>(it) }
        if (session != null && cached != null && session.sub == cached.person.id) {
            stored = session
            profile = cached
        } else {
            clearStorage()
        }
        publish()
        if (profile != null) readDirectory(force = false)
    }

    /** The access token for API calls, refreshed when it's about to run out. Null when signed out. */
    suspend fun getToken(): String? = tokenLock.withLock {
        val session = stored ?: return@withLock null
        access?.takeIf { it.expiresAt - EXPIRY_MARGIN_MS > now() }?.let { return@withLock it.token }
        refresh(session)
    }

    /** Refresh now, whatever the expiry says (after a 401). */
    suspend fun refreshToken(): String? = tokenLock.withLock {
        val session = stored ?: return@withLock null
        access = null
        refresh(session)
    }

    /**
     * The Custom Tab intent for WeldID's sign-in page. Start it for a result
     * and hand the result to [completeSignIn].
     */
    suspend fun signInIntent(createAccount: Boolean, locale: String): Result<Intent> {
        val config = try {
            serviceConfiguration()
        } catch (_: Exception) {
            return Result.failure(SignInUnreachable())
        }
        val promptLogin = cache.get(promptLoginKey) == "1"
        val request = AuthorizationRequest.Builder(
            config,
            settings.clientId,
            ResponseTypeValues.CODE,
            redirectUri.toUri(),
        )
            .setScopes(settings.scopes)
            .setUiLocales(locale)
            .apply {
                when {
                    createAccount -> setPrompt("create")
                    promptLogin -> setPrompt("login")
                }
            }
            .build()
        return Result.success(authService.getAuthorizationRequestIntent(request))
    }

    /** Finish a sign-in with the result of [signInIntent]'s activity. */
    suspend fun completeSignIn(data: Intent?): SignInOutcome {
        if (data == null) return SignInOutcome.Cancelled
        val error = AuthorizationException.fromIntent(data)
        val response = AuthorizationResponse.fromIntent(data)
        if (response == null) {
            val cancelled = error == null ||
                error.code == AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW.code ||
                error.code == AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW.code
            return if (cancelled) SignInOutcome.Cancelled else SignInOutcome.Failed(SignInOutcome.Failed.Reason.FAILED)
        }
        val token = try {
            performTokenRequest(response.createTokenExchangeRequest())
        } catch (exception: AuthorizationException) {
            val reason = if (exception.type == AuthorizationException.TYPE_GENERAL_ERROR &&
                exception.code == AuthorizationException.GeneralErrors.NETWORK_ERROR.code
            ) {
                SignInOutcome.Failed.Reason.UNREACHABLE
            } else {
                SignInOutcome.Failed.Reason.FAILED
            }
            return SignInOutcome.Failed(reason)
        }
        val person = personFromClaims(jwtClaims(token.idToken) ?: jwtClaims(token.accessToken))
            ?: return SignInOutcome.Failed(SignInOutcome.Failed.Reason.FAILED)
        tokenLock.withLock {
            val samePerson = profile?.person?.id == person.id
            stored = StoredSession(sub = person.id, refresh = token.refreshToken.orEmpty())
            profile = CachedProfile(
                person = person,
                workspaces = if (samePerson) profile?.workspaces.orEmpty() else emptyList(),
                activeWorkspaceId = if (samePerson) profile?.activeWorkspaceId else null,
                directoryAt = if (samePerson) profile?.directoryAt else null,
            )
            access = token.accessToken?.let { AccessToken(it, token.accessTokenExpirationTime ?: (now() + DEFAULT_EXPIRES_MS)) }
            persist()
        }
        cache.remove(promptLoginKey)
        publish()
        readDirectory(force = true)
        return SignInOutcome.SignedIn
    }

    /** Choose the active workspace. A local choice: one token serves every workspace. */
    fun setActiveWorkspace(id: String) {
        val current = profile ?: return
        activeChosenAt = now()
        profile = current.copy(activeWorkspaceId = id)
        persist()
        publish()
    }

    /** Read the workspace list again (after creating or joining one). */
    suspend fun reloadWorkspaces() {
        readDirectory(force = true)
        directoryRead?.await()
    }

    /**
     * Forget the session here and revoke its refresh token at WeldID. The next
     * sign-in asks for WeldID's form.
     */
    suspend fun signOut() {
        val refresh = tokenLock.withLock {
            val token = stored?.refresh
            forget()
            token
        }
        cache.set(promptLoginKey, "1")
        publish()
        if (!refresh.isNullOrEmpty()) revoke(refresh)
    }

    fun dispose() {
        authService.dispose()
    }

    // ── tokens ────────────────────────────────────────────────────────────────

    /** Called with [tokenLock] held. */
    private suspend fun refresh(session: StoredSession): String? {
        if (session.refresh.isEmpty()) {
            forget()
            publish()
            return null
        }
        val config = try {
            serviceConfiguration()
        } catch (_: Exception) {
            return null
        }
        val request = TokenRequest.Builder(config, settings.clientId)
            .setGrantType(GrantTypeValues.REFRESH_TOKEN)
            .setRefreshToken(session.refresh)
            .build()
        val token = try {
            performTokenRequest(request)
        } catch (exception: AuthorizationException) {
            if (exception == AuthorizationException.TokenRequestErrors.INVALID_GRANT ||
                exception == AuthorizationException.TokenRequestErrors.INVALID_CLIENT
            ) {
                forget()
                publish()
            }
            return null
        }
        val accessToken = token.accessToken ?: return null
        token.refreshToken?.let { stored = session.copy(refresh = it) }
        personFromClaims(jwtClaims(token.idToken))?.takeIf { it.id == session.sub }?.let { person ->
            profile = profile?.copy(person = person)
        }
        access = AccessToken(accessToken, token.accessTokenExpirationTime ?: (now() + DEFAULT_EXPIRES_MS))
        persist()
        publish()
        return accessToken
    }

    private suspend fun performTokenRequest(request: TokenRequest): TokenResponse =
        suspendCancellableCoroutine { continuation ->
            authService.performTokenRequest(request) { response, exception ->
                when {
                    response != null -> continuation.resume(response)
                    else -> continuation.resumeWith(
                        kotlin.Result.failure(exception ?: AuthorizationException.GeneralErrors.SERVER_ERROR),
                    )
                }
            }
        }

    private suspend fun serviceConfiguration(): AuthorizationServiceConfiguration {
        configuration?.let { return it }
        val fetched = suspendCancellableCoroutine { continuation ->
            AuthorizationServiceConfiguration.fetchFromIssuer(settings.issuer.toUri()) { config, exception ->
                if (config != null) {
                    continuation.resume(config)
                } else {
                    continuation.resumeWith(
                        kotlin.Result.failure(exception ?: AuthorizationException.GeneralErrors.NETWORK_ERROR),
                    )
                }
            }
        }
        configuration = fetched
        return fetched
    }

    private suspend fun revoke(refreshToken: String) {
        val endpoint = try {
            serviceConfiguration().discoveryDoc?.docJson?.optString("revocation_endpoint")?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        } ?: return
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(endpoint)
                .post(
                    FormBody.Builder()
                        .add("token", refreshToken)
                        .add("token_type_hint", "refresh_token")
                        .add("client_id", settings.clientId)
                        .build(),
                )
                .build()
            // Best effort: offline, the token expires at WeldID on its own.
            runCatching { http.newCall(request).execute().close() }
        }
    }

    // ── workspace directory ───────────────────────────────────────────────────

    /**
     * Read WeldSuite's workspace list in the background. A first read that
     * fails is tried a few times; later failures keep the cached list.
     */
    private fun readDirectory(force: Boolean) {
        val person = profile?.person ?: return
        if (directoryRead?.isActive == true && !force) return
        val startedAt = now()
        directoryRead = scope.async {
            for ((attempt, wait) in (listOf(0L) + DIRECTORY_RETRY_MS).withIndex()) {
                if (attempt > 0) delay(wait)
                if (profile?.person?.id != person.id) return@async
                val token = getToken()
                val list = token?.let { runCatching { loadWorkspaces(it) }.getOrNull() }
                if (profile?.person?.id != person.id) return@async
                if (list != null) {
                    acceptDirectory(list, startedAt)
                    return@async
                }
                if (token == null || profile?.directoryAt != null) return@async
            }
        }
        publish()
        scope.launch {
            directoryRead?.join()
            publish()
        }
    }

    private fun acceptDirectory(list: List<WorkspaceRef>, startedAt: Long) {
        val current = profile ?: return
        val active = chooseActiveWorkspace(list, current.activeWorkspaceId, activeChosenAt >= startedAt)
        profile = current.copy(workspaces = list, activeWorkspaceId = active, directoryAt = now())
        persist()
        publish()
    }

    // ── storage ───────────────────────────────────────────────────────────────

    private fun persist() {
        stored?.let { secure.set(secureKey, WeldJson.encodeToString(StoredSession.serializer(), it)) }
        profile?.let { cache.set(profileKey, WeldJson.encodeToString(CachedProfile.serializer(), it)) }
    }

    private fun forget() {
        stored = null
        profile = null
        access = null
        directoryRead?.cancel()
        directoryRead = null
        clearStorage()
    }

    private fun clearStorage() {
        secure.remove(secureKey)
        cache.remove(profileKey)
    }

    private fun publish() {
        val current = profile
        val signedIn = stored != null && current != null
        state.update {
            AuthSnapshot(
                isLoaded = true,
                person = if (signedIn) current?.person else null,
                workspaces = if (signedIn) current?.workspaces.orEmpty() else emptyList(),
                activeWorkspaceId = if (signedIn) current?.activeWorkspaceId else null,
                isLoadingWorkspaces = signedIn && current?.directoryAt == null && directoryRead?.isActive == true,
            )
        }
    }

    private inline fun <reified T> decode(json: String): T? =
        runCatching { WeldJson.decodeFromString<T>(json) }.getOrNull()

    @Serializable
    private data class StoredSession(val v: Int = 1, val sub: String, val refresh: String)

    @Serializable
    private data class CachedProfile(
        val person: Person,
        val workspaces: List<WorkspaceRef>,
        val activeWorkspaceId: String? = null,
        val directoryAt: Long? = null,
    )

    private data class AccessToken(val token: String, val expiresAt: Long)

    private companion object {
        const val EXPIRY_MARGIN_MS = 30_000L
        const val DEFAULT_EXPIRES_MS = 300_000L
        val DIRECTORY_RETRY_MS = listOf(1_000L, 3_000L, 9_000L)
    }
}

/** WeldID's discovery document couldn't be read. */
class SignInUnreachable : Exception("The sign-in server could not be reached")
