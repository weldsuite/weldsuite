package org.weldsuite.core

import android.content.Context
import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.weldsuite.api.core.apis.DefaultApi as CoreApi
import org.weldsuite.core.api.ApiAuth
import org.weldsuite.core.api.ApiClient
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.auth.AuthSnapshot
import org.weldsuite.core.auth.OidcSession
import org.weldsuite.core.auth.Person
import org.weldsuite.core.auth.SignInOutcome
import org.weldsuite.core.auth.WorkspaceRef
import org.weldsuite.core.auth.storageIdFor
import org.weldsuite.core.lock.AppLock
import org.weldsuite.core.server.ConfigResult
import org.weldsuite.core.server.Result
import org.weldsuite.core.server.ServerConfigLoader
import org.weldsuite.core.server.ServerProblem
import org.weldsuite.core.server.assessServer
import org.weldsuite.core.server.isBelowMinimumVersion
import org.weldsuite.core.storage.PreferencesStore
import org.weldsuite.core.storage.SecureStore
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Where the app is, from the server down to the workspace. The app shows one screen per state. */
sealed interface SessionState {
    data object Booting : SessionState

    data class ServerUnavailable(val problem: ServerProblem, val server: String) : SessionState

    data class UpdateRequired(val storeUrl: String) : SessionState

    data object SignedOut : SessionState

    /** Signed in without an active workspace: the list is loading, empty, or a choice is needed. */
    data class ChoosingWorkspace(val person: Person, val loading: Boolean, val workspaces: List<WorkspaceRef>) : SessionState

    data class Ready(val person: Person, val workspace: WorkspaceRef, val workspaces: List<WorkspaceRef>) : SessionState
}

/**
 * One per app process: the server, the session, the API client and the lock.
 * Built in the app's `Application.onCreate`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppEnvironment(context: Context, val app: AppIdentity, lockRequired: Boolean) {
    private val appContext = context.applicationContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val cache = PreferencesStore(appContext)
    private val secure = SecureStore(appContext)
    private val configLoader = ServerConfigLoader(http, cache)

    val lock = AppLock(appContext, required = lockRequired)

    /** The server this build starts on. A self-hosted choice comes later (plan native-mobile-apps.md). */
    val serverOrigin: String = app.euServerUrl.trimEnd('/')

    private val boot = MutableStateFlow<Boot>(Boot.Loading)
    private val sessionFlow = MutableStateFlow<OidcSession?>(null)

    /** The API client for the current server, once it has booted. */
    lateinit var api: ApiClient
        private set

    /** What the server says it doesn't offer (`unavailableFeatures` in `/config.json`). */
    var unavailableFeatures: Set<String> = emptySet()
        private set

    val state: StateFlow<SessionState> = combine(
        boot,
        sessionFlow.flatMapLatest { it?.snapshot ?: flowOf(AuthSnapshot()) },
    ) { boot, auth -> stateOf(boot, auth) }
        .stateIn(scope, SharingStarted.Eagerly, SessionState.Booting)

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = lock.onForeground()
            override fun onStop(owner: LifecycleOwner) = lock.onBackground()
        })
        start()
    }

    /** Load the server's `/config.json` and the stored session. Again after a failure: "Try again". */
    fun start() {
        scope.launch {
            boot.value = Boot.Loading
            when (val result = configLoader.load(serverOrigin)) {
                is ConfigResult.Problem -> boot.value = Boot.Failed(result.problem)
                is ConfigResult.Loaded -> {
                    unavailableFeatures = result.config.unavailableFeatures.orEmpty().toSet()
                    val minimum = result.config.mobile?.minVersions?.get(app.code)
                    if (isBelowMinimumVersion(app.versionName, minimum)) {
                        boot.value = Boot.Outdated
                        return@launch
                    }
                    when (val assessed = assessServer(result.config, app)) {
                        is Result.Failure -> boot.value = Boot.Failed(assessed.error)
                        is Result.Success -> {
                            if (sessionFlow.value == null) {
                                val session = OidcSession(
                                    context = appContext,
                                    settings = assessed.value,
                                    redirectUri = app.redirectUri,
                                    storageId = storageIdFor(serverOrigin),
                                    secure = secure,
                                    cache = cache,
                                    http = http,
                                    loadWorkspaces = ::loadWorkspaces,
                                    scope = scope,
                                )
                                api = ApiClient(serverOrigin, app.code, sessionAuth(session), http)
                                session.init()
                                sessionFlow.value = session
                            }
                            boot.value = Boot.Ready
                        }
                    }
                }
            }
        }
    }

    val session: OidcSession? get() = sessionFlow.value

    suspend fun signInIntent(createAccount: Boolean): kotlin.Result<Intent> {
        val session = sessionFlow.value ?: return kotlin.Result.failure(IllegalStateException("Not booted"))
        return session.signInIntent(createAccount, Locale.getDefault().language)
    }

    suspend fun completeSignIn(data: Intent?): SignInOutcome =
        sessionFlow.value?.completeSignIn(data) ?: SignInOutcome.Cancelled

    fun chooseWorkspace(id: String) {
        sessionFlow.value?.setActiveWorkspace(id)
    }

    suspend fun reloadWorkspaces() {
        sessionFlow.value?.reloadWorkspaces()
    }

    suspend fun signOut() {
        sessionFlow.value?.signOut()
        lock.lockNow()
    }

    private suspend fun loadWorkspaces(token: String): List<WorkspaceRef>? {
        if (!::api.isInitialized) return null
        return runCatching {
            apiCall { api.create<CoreApi>().listWorkspaces() }.data.map { WorkspaceRef(it.id, it.name, it.slug) }
        }.getOrNull()
    }

    private fun sessionAuth(session: OidcSession) = object : ApiAuth {
        override suspend fun token(): String? = session.getToken()
        override suspend fun refreshedToken(): String? = session.refreshToken()
        override val workspaceId: String? get() = session.activeWorkspaceId
    }

    private fun stateOf(boot: Boot, auth: AuthSnapshot): SessionState = when (boot) {
        Boot.Loading -> SessionState.Booting
        is Boot.Failed -> SessionState.ServerUnavailable(boot.problem, serverOrigin.removePrefix("https://"))
        Boot.Outdated -> SessionState.UpdateRequired(app.storeUrl)
        Boot.Ready -> {
            val person = auth.person
            val active = auth.workspaces.firstOrNull { it.id == auth.activeWorkspaceId }
            when {
                !auth.isLoaded -> SessionState.Booting
                person == null -> SessionState.SignedOut
                active != null -> SessionState.Ready(person, active, auth.workspaces)
                else -> SessionState.ChoosingWorkspace(person, auth.isLoadingWorkspaces, auth.workspaces)
            }
        }
    }

    private sealed interface Boot {
        data object Loading : Boot
        data class Failed(val problem: ServerProblem) : Boot
        data object Outdated : Boot
        data object Ready : Boot
    }
}
