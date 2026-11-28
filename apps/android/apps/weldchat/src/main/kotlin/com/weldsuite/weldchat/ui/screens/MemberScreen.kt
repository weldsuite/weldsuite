package com.weldsuite.weldchat.ui.screens

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MemberLogic
import com.weldsuite.weldchat.MemberPresence
import com.weldsuite.weldchat.MemberProfileInfo
import com.weldsuite.weldchat.PresenceStatus
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.calls.CallManager
import com.weldsuite.weldchat.calls.CallPeer
import com.weldsuite.weldchat.calls.CallType
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.EmptyIcon
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.LocalNotify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * A team member, laid out like the platform's member panel: the avatar
 * with presence, the name and custom status, "⋮" (e-mail, call, video call,
 * open chat), and the Overview / Common / Activity tabs. [userId] is the
 * signed-in person, [memberId] the one shown.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemberScreen(
    env: AppEnvironment,
    store: ChatStore,
    calls: CallManager,
    userId: String,
    memberId: String,
    nav: ChatNavigator,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val notify = LocalNotify.current
    var profile by remember(memberId) { mutableStateOf<MemberProfileInfo?>(null) }
    var presence by remember(memberId) { mutableStateOf<MemberPresence?>(null) }
    var state by remember(memberId) { mutableStateOf(MemberLoadState.LOADING) }
    var tab by rememberSaveable { mutableStateOf(MemberTab.OVERVIEW) }
    var actionsOpen by remember { mutableStateOf(false) }
    val isSelf = userId == memberId
    val tabs = MemberScreenRules.tabs(isSelf)
    val callFailed = stringResource(R.string.weldchat_member_start_call_failed)

    /** A gone member (404) and a failure read differently: only the failure offers a retry. */
    suspend fun load() {
        if (profile == null) state = MemberLoadState.LOADING
        coroutineScope {
            val presenceLoad = async { quietly { store.repository.presence(memberId) } }
            try {
                profile = store.repository.memberProfile(memberId)
                state = MemberLoadState.READY
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                profile = null
                state = if ((error as? ApiException)?.status == 404) MemberLoadState.NOT_FOUND else MemberLoadState.FAILED
            }
            presence = presenceLoad.await()
        }
        if (tab !in tabs) tab = MemberTab.OVERVIEW
    }

    LaunchedEffect(memberId) { load() }

    val name = MemberScreenRules.headerName(profile, state).text()

    fun call(type: CallType) {
        store.env.scope.launch {
            try {
                val dm = store.ensureDm(memberId)
                calls.startCall(dm.id, type, CallPeer(name = name, avatar = profile?.picture, isDirect = true))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(callFailed)
            }
        }
    }

    fun openChat() {
        scope.launch {
            try {
                val dm = store.ensureDm(memberId)
                nav.openConversation(dm.id, name, "dm")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                notify(context.getString(apiErrorMessage(error)))
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
                actions = {
                    val current = profile
                    if (current != null) {
                        Box {
                            IconButton(onClick = { actionsOpen = true }, modifier = Modifier.tagged("member-actions")) {
                                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.weldchat_member_more_actions))
                            }
                            DropdownMenu(expanded = actionsOpen, onDismissRequest = { actionsOpen = false }) {
                                val email = current.email
                                if (!email.isNullOrEmpty()) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.weldchat_member_compose_email)) },
                                        leadingIcon = { Icon(Icons.Filled.Email, contentDescription = null) },
                                        onClick = {
                                            actionsOpen = false
                                            openLink(context, "mailto:$email")
                                        },
                                        modifier = Modifier.tagged("member-email"),
                                    )
                                }
                                if (!isSelf) {
                                    if (env.isAvailable("chat-calls")) {
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.weldchat_member_call)) },
                                            leadingIcon = { Icon(Icons.Filled.Call, contentDescription = null) },
                                            onClick = {
                                                actionsOpen = false
                                                call(CallType.VOICE)
                                            },
                                            modifier = Modifier.tagged("member-call"),
                                        )
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.weldchat_member_video_call)) },
                                            leadingIcon = { Icon(Icons.Filled.Videocam, contentDescription = null) },
                                            onClick = {
                                                actionsOpen = false
                                                call(CallType.VIDEO)
                                            },
                                            modifier = Modifier.tagged("member-video-call"),
                                        )
                                    }
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.weldchat_member_open_chat)) },
                                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null) },
                                        onClick = {
                                            actionsOpen = false
                                            openChat()
                                        },
                                        modifier = Modifier.tagged("member-open-chat"),
                                    )
                                }
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(Tokens.Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
        ) {
            MemberHeader(profile, presence, state, name)
            val current = profile
            if (current != null) {
                MemberTabBar(tabs, tab) { tab = it }
                when (tab) {
                    MemberTab.OVERVIEW -> MemberOverviewTab(store, current) { profile = it }
                    MemberTab.COMMON -> MemberCommonTab(store, current.userId, nav)
                    MemberTab.ACTIVITY -> MemberActivityTab(store, current.userId, current.name)
                }
            } else {
                when (state) {
                    MemberLoadState.LOADING, MemberLoadState.READY -> Box(Modifier.fillMaxWidth().padding(top = Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.CircularProgressIndicator()
                    }
                    MemberLoadState.NOT_FOUND -> EmptyState(
                        stringResource(R.string.weldchat_member_not_found_title),
                        stringResource(R.string.weldchat_member_not_found_description),
                        icon = { EmptyIcon(Icons.Filled.PersonOff) },
                    )
                    MemberLoadState.FAILED -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        EmptyState(
                            stringResource(R.string.weldchat_member_profile_load_failed_title),
                            stringResource(R.string.weldchat_member_profile_load_failed_description),
                            icon = { EmptyIcon(Icons.Filled.Warning) },
                        )
                        TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.tagged("retry")) {
                            Text(stringResource(CoreR.string.core_common_try_again))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MemberHeader(profile: MemberProfileInfo?, presence: MemberPresence?, state: MemberLoadState, name: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        if (profile != null) {
            Box {
                ChatAvatar(name, profile.picture, 56.dp)
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(14.dp)
                        .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
                        .background(presenceColor(presence?.status ?: PresenceStatus.OFFLINE), CircleShape),
                )
            }
        }
        if (state != MemberLoadState.LOADING) {
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                MemberScreenRules.customStatus(presence)?.let { status ->
                    Text(status, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** Overview / Common / Activity, the chosen one underlined. */
@Composable
private fun MemberTabBar(tabs: List<MemberTab>, selected: MemberTab, onSelect: (MemberTab) -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth()) {
            tabs.forEach { option ->
                val chosen = option == selected
                Column(
                    Modifier
                        .weight(1f)
                        .clickable { onSelect(option) }
                        .tagged("member-tab-${option.key}"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.padding(vertical = Tokens.Spacing.s),
                    ) {
                        val tint = if (chosen) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
                        Icon(tabIcon(option), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
                        Text(
                            stringResource(option.label),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal,
                            color = tint,
                            textAlign = TextAlign.Center,
                        )
                    }
                    Box(Modifier.fillMaxWidth().height(2.dp).background(if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent))
                }
            }
        }
        HorizontalDivider()
    }
}

private fun tabIcon(tab: MemberTab): ImageVector = when (tab) {
    MemberTab.OVERVIEW -> Icons.Filled.Assessment
    MemberTab.COMMON -> Icons.Filled.Group
    MemberTab.ACTIVITY -> Icons.Filled.MonitorHeart
}

/** The presence dot's colour, as the platform's status dot. */
internal fun presenceColor(status: PresenceStatus): Color = Color(0xFF000000L or MemberLogic.presenceColor(status))

/** Opens a `mailto:`, `tel:` or web address; nothing when no app takes it. */
internal fun openLink(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        // No app on the phone handles it.
    }
}

/** A best-effort read: null when it failed (cancellation still cancels). */
internal suspend fun <T> quietly(block: suspend () -> T): T? = try {
    block()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    null
}
