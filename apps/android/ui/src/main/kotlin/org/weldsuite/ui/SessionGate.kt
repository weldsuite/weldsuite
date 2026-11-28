package org.weldsuite.ui

import android.content.Intent
import androidx.core.net.toUri
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R
import org.weldsuite.core.SessionState
import org.weldsuite.core.auth.SignInOutcome
import org.weldsuite.core.auth.WorkspaceRef
import org.weldsuite.core.server.ServerProblem

/** How the app presents itself on the screens around it. */
data class AppBranding(
    val name: String,
    val subtitle: String,
    val logo: Int,
)

/**
 * Everything between launch and the app's own screens: the server check, the
 * update gate, WeldID sign-in, the workspace choice and the app lock. Calls
 * [content] only with a signed-in person in a workspace, unlocked.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SessionGate(
    env: AppEnvironment,
    branding: AppBranding,
    content: @Composable (SessionState.Ready) -> Unit,
) {
    val state by env.state.collectAsStateWithLifecycle()
    val locked by env.lock.locked.collectAsStateWithLifecycle()
    Surface(
        modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
        color = MaterialTheme.colorScheme.background,
    ) {
        when (val current = state) {
            SessionState.Booting -> CenteredProgress()
            is SessionState.ServerUnavailable -> ServerProblemScreen(current, branding, onRetry = env::start)
            is SessionState.UpdateRequired -> UpdateScreen(current.storeUrl, branding)
            SessionState.SignedOut -> SignInScreen(env, branding)
            is SessionState.ChoosingWorkspace -> WorkspaceScreen(env, current)
            is SessionState.Ready -> when {
                env.lock.isRequired && !env.lock.hasScreenLock() -> NoScreenLockScreen(branding)
                locked -> LockScreen(env, branding)
                else -> {
                    LaunchedEffect(current.workspace.id) { env.didEnterWorkspace(current.workspace.id) }
                    content(current)
                }
            }
        }
    }
}

@Composable
private fun ServerProblemScreen(state: SessionState.ServerUnavailable, branding: AppBranding, onRetry: () -> Unit) {
    val description = when (state.problem) {
        ServerProblem.UNREACHABLE -> stringResource(R.string.core_server_unreachable, state.server)
        ServerProblem.NOT_WELDSUITE -> stringResource(R.string.core_server_not_weldsuite, state.server)
        ServerProblem.NO_MOBILE_SIGN_IN -> stringResource(R.string.core_server_no_mobile_sign_in, state.server)
        ServerProblem.APP_UNAVAILABLE -> stringResource(R.string.core_server_app_unavailable, branding.name, state.server)
    }
    MessageScreen(
        title = branding.name,
        description = description,
        primary = MessageAction(stringResource(R.string.core_common_try_again), "retry", onRetry),
    )
}

@Composable
private fun UpdateScreen(storeUrl: String, branding: AppBranding) {
    val context = LocalContext.current
    MessageScreen(
        title = stringResource(R.string.core_update_title, branding.name),
        description = stringResource(R.string.core_update_description, branding.name),
        primary = MessageAction(stringResource(R.string.core_update_button), "open-store") {
            context.startActivity(Intent(Intent.ACTION_VIEW, storeUrl.toUri()))
        },
    )
}

@Composable
private fun SignInScreen(env: AppEnvironment, branding: AppBranding) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Int?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        scope.launch {
            error = when (val outcome = env.completeSignIn(result.data)) {
                SignInOutcome.SignedIn, SignInOutcome.Cancelled -> null
                is SignInOutcome.Failed -> when (outcome.reason) {
                    SignInOutcome.Failed.Reason.UNREACHABLE -> R.string.core_sign_in_unreachable
                    SignInOutcome.Failed.Reason.FAILED -> R.string.core_sign_in_failed
                }
            }
            busy = false
        }
    }
    val start: (Boolean) -> Unit = { createAccount ->
        busy = true
        error = null
        scope.launch {
            env.signInIntent(createAccount)
                .onSuccess { launcher.launch(it) }
                .onFailure {
                    error = R.string.core_sign_in_unreachable
                    busy = false
                }
        }
    }

    Box(Modifier.fillMaxSize().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Image(painterResource(branding.logo), contentDescription = null, modifier = Modifier.size(88.dp))
            Text(branding.name, style = MaterialTheme.typography.headlineMedium)
            Text(
                branding.subtitle,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            error?.let {
                Text(stringResource(it), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            }
            Button(
                onClick = { start(false) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(top = Tokens.Spacing.l).tagged("sign-in"),
            ) { Text(stringResource(R.string.core_sign_in_button)) }
            TextButton(onClick = { start(true) }, enabled = !busy, modifier = Modifier.tagged("create-account")) {
                Text(stringResource(R.string.core_sign_in_create_account))
            }
            Text(
                stringResource(R.string.core_sign_in_server, env.serverOrigin.removePrefix("https://")),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun WorkspaceScreen(env: AppEnvironment, state: SessionState.ChoosingWorkspace) {
    val scope = rememberCoroutineScope()
    when {
        state.loading && state.workspaces.isEmpty() -> MessageScreen(
            title = stringResource(R.string.core_workspace_loading),
            description = null,
            header = { CenteredProgress(Modifier.size(48.dp)) },
        )
        state.workspaces.isEmpty() -> MessageScreen(
            title = stringResource(R.string.core_workspace_none_title),
            description = stringResource(R.string.core_workspace_none_description),
            primary = MessageAction(stringResource(R.string.core_workspace_check_again), "check-again") {
                scope.launch { env.reloadWorkspaces() }
            },
            secondary = MessageAction(stringResource(R.string.core_common_sign_out), "sign-out") {
                scope.launch { env.signOut() }
            },
        )
        else -> WorkspacePicker(state.workspaces, onChoose = env::chooseWorkspace)
    }
}

/** The person's workspaces, to pick one. Also used from an app's settings to switch. */
@Composable
fun WorkspacePicker(workspaces: List<WorkspaceRef>, onChoose: (String) -> Unit, modifier: Modifier = Modifier) {
    Scaffold(modifier = modifier) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            item {
                Text(
                    stringResource(R.string.core_workspace_choose),
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(Tokens.Spacing.l),
                )
            }
            items(workspaces, key = { it.id }) { workspace ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onChoose(workspace.id) }
                        .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.l)
                        .tagged("workspace-${workspace.name}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(workspace.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun LockScreen(env: AppEnvironment, branding: AppBranding) {
    val activity = LocalActivity.current as FragmentActivity
    val scope = rememberCoroutineScope()
    val title = stringResource(R.string.core_lock_title, branding.name)
    val unlock: () -> Unit = { scope.launch { env.lock.unlock(activity, title) } }
    // Ask straight away; the button is for when the person dismissed the prompt.
    LaunchedEffect(Unit) { unlock() }
    MessageScreen(
        title = title,
        description = null,
        primary = MessageAction(stringResource(R.string.core_lock_unlock), "unlock", unlock),
        header = {
            Icon(Icons.Filled.Lock, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.primary)
        },
    )
}

@Composable
private fun NoScreenLockScreen(branding: AppBranding) {
    val context = LocalContext.current
    MessageScreen(
        title = stringResource(R.string.core_lock_no_screen_lock_title),
        description = stringResource(R.string.core_lock_no_screen_lock_description, branding.name),
        primary = MessageAction(stringResource(R.string.core_lock_open_settings), "open-security-settings") {
            context.startActivity(Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS))
        },
    )
}
