package com.weldsuite.weldchat.calls

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Videocam
import org.weldsuite.ui.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * The Calls tab (`app/(tabs)/calls.tsx`): ongoing calls with Join, then the
 * person's call history, a page at a time; tap a call for its conversation,
 * the phone icon to call back. Reloads when a call starts or ends in one of
 * their conversations.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallsScreen(
    env: AppEnvironment,
    manager: CallManager,
    onOpenConversation: (channelId: String, name: String, isDm: Boolean) -> Unit,
) {
    val api = remember(env) { CallApi(env) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val unknown = stringResource(R.string.weldchat_calls_unknown)

    var active by remember { mutableStateOf<List<ActiveCallSummary>>(emptyList()) }
    var history by remember { mutableStateOf<List<CallHistoryEntry>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var joiningId by remember { mutableStateOf<String?>(null) }
    var callingId by remember { mutableStateOf<String?>(null) }
    // A page that lands after a reload belongs to the old list: dropped.
    var generation by remember { mutableIntStateOf(0) }

    suspend fun load() {
        val mine = ++generation
        val activeResult = runCatching { api.active() }
        val historyResult = runCatching { api.history(cursor = null) }
        if (mine != generation) return
        activeResult.getOrNull()?.let { active = it }
        historyResult.getOrNull()?.let {
            history = it.items
            cursor = it.cursor
        }
        listOf(activeResult, historyResult).firstNotNullOfOrNull { it.exceptionOrNull() as? CancellationException }?.let { throw it }
        loading = false
        refreshing = false
    }

    suspend fun loadMore() {
        val next = cursor ?: return
        if (loadingMore) return
        loadingMore = true
        val mine = generation
        try {
            val page = api.history(cursor = next)
            if (mine == generation) {
                history = CallRules.appendPage(history, page.items)
                cursor = page.cursor
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
        } finally {
            loadingMore = false
        }
    }

    LaunchedEffect(manager) {
        load()
        manager.historyChanged.collect { load() }
    }

    val recent = remember(history, active) { CallRules.recent(history, active) }
    val byId = remember(history) { history.associateBy { it.id } }
    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 5
        }
    }
    LaunchedEffect(nearEnd, cursor) {
        if (nearEnd && cursor != null && !loading) loadMore()
    }

    fun callBack(item: CallHistoryEntry) {
        if (callingId != null) return
        callingId = item.id
        scope.launch {
            val peer = if (CallRules.isDm(item)) {
                CallPeer(
                    name = CallRules.title(item, unknown),
                    avatar = if (CallRules.isGroupDm(item)) null else item.counterpart?.avatar,
                    isDirect = true,
                )
            } else {
                null
            }
            try {
                manager.startCall(item.channelId, item.callType, peer)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                android.widget.Toast.makeText(context, context.getString(R.string.weldchat_channel_call_failed_body), android.widget.Toast.LENGTH_LONG).show()
            } finally {
                callingId = null
            }
        }
    }

    fun join(callId: String) {
        joiningId = callId
        scope.launch {
            try {
                manager.joinCall(callId, null)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                android.widget.Toast.makeText(context, context.getString(R.string.weldchat_channel_call_failed_body), android.widget.Toast.LENGTH_LONG).show()
            } finally {
                joiningId = null
            }
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldchat_tabs_calls)) }) }) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch { load() }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when {
                loading && recent.isEmpty() && active.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                recent.isEmpty() && active.isEmpty() -> LazyColumn(Modifier.fillMaxSize().tagged("calls-empty")) {
                    item {
                        EmptyState(
                            title = stringResource(R.string.weldchat_calls_empty_title),
                            description = stringResource(R.string.weldchat_calls_empty_hint),
                            icon = {
                                Icon(
                                    Icons.Filled.PhoneInTalk,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(36.dp),
                                )
                            },
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize().tagged("calls-list"), state = listState) {
                    if (active.isNotEmpty()) {
                        item("ongoing-header") { SectionLabel(stringResource(R.string.weldchat_calls_ongoing)) }
                        items(active, key = { "active-${it.callId}" }) { call ->
                            OngoingRow(call, byId[call.callId], unknown, joining = joiningId == call.callId, onJoin = { join(call.callId) })
                        }
                        if (recent.isNotEmpty()) item("recent-header") { SectionLabel(stringResource(R.string.weldchat_calls_recent)) }
                    }
                    items(recent, key = { it.id }) { item ->
                        HistoryRow(
                            item = item,
                            unknown = unknown,
                            calling = callingId == item.id,
                            callBackEnabled = callingId == null,
                            onOpen = { onOpenConversation(item.channelId, if (CallRules.isDm(item)) CallRules.title(item, unknown) else item.channelName.orEmpty(), CallRules.isDm(item)) },
                            onCallBack = { callBack(item) },
                        )
                        HorizontalDivider(Modifier.padding(start = 72.dp))
                    }
                    if (loadingMore) {
                        item("more") {
                            Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(24.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.l, bottom = Tokens.Spacing.xs),
    )
}

@Composable
private fun OngoingRow(call: ActiveCallSummary, known: CallHistoryEntry?, unknown: String, joining: Boolean, onJoin: () -> Unit) {
    val video = call.callType == CallType.VIDEO
    val participants = pluralStringResource(R.plurals.weldchat_calls_participant_count, call.participantCount, call.participantCount)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("calls-ongoing-${call.callId}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(44.dp).background(SuccessGreen.copy(alpha = 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (video) Icons.Filled.Videocam else Icons.Filled.Call, contentDescription = null, tint = SuccessGreen)
        }
        Column(Modifier.weight(1f).padding(horizontal = Tokens.Spacing.m)) {
            Text(
                stringResource(if (video) R.string.weldchat_calls_ongoing_video_call else R.string.weldchat_calls_ongoing_voice_call),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                known?.let { stringResource(R.string.weldchat_call_bar_title, CallRules.title(it, unknown), participants) } ?: participants,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Button(onClick = onJoin, enabled = !joining) {
            if (joining) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            } else {
                Text(stringResource(R.string.weldchat_calls_join))
            }
        }
    }
}

@Composable
private fun HistoryRow(
    item: CallHistoryEntry,
    unknown: String,
    calling: Boolean,
    callBackEnabled: Boolean,
    onOpen: () -> Unit,
    onCallBack: () -> Unit,
) {
    val title = CallRules.title(item, unknown)
    val incoming = item.direction == "incoming"
    val missed = CallRules.isMissedIncoming(item)
    val video = item.callType == CallType.VIDEO
    val outcome = when (CallRules.outcome(item)) {
        CallRules.Outcome.ONGOING -> stringResource(R.string.weldchat_calls_ongoing)
        CallRules.Outcome.MISSED -> stringResource(R.string.weldchat_calls_missed)
        CallRules.Outcome.NO_ANSWER -> stringResource(R.string.weldchat_calls_no_answer)
        CallRules.Outcome.DECLINED -> stringResource(R.string.weldchat_calls_declined)
        CallRules.Outcome.INCOMING -> stringResource(R.string.weldchat_calls_incoming)
        CallRules.Outcome.OUTGOING -> stringResource(R.string.weldchat_calls_outgoing)
    }
    val parts = buildList {
        add(outcome)
        add(stringResource(if (video) R.string.weldchat_calls_video_call else R.string.weldchat_calls_voice_call))
        val duration = item.duration
        if (item.outcome == "answered" && duration != null && duration > 0) add(CallRules.duration(duration))
    }
    val yesterday = stringResource(CoreR.string.core_common_yesterday)
    val time = item.createdAt?.let { CallRules.recentsTime(it, yesterday) }.orEmpty()
    val callBackLabel = stringResource(R.string.weldchat_calls_call_back)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.s, bottom = Tokens.Spacing.s)
            .tagged("calls-row-${item.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            !CallRules.isDm(item) -> IconTile(Icons.Filled.Tag, MaterialTheme.colorScheme.onSurfaceVariant)
            CallRules.isGroupDm(item) -> IconTile(Icons.Filled.Groups, MaterialTheme.colorScheme.primary)
            else -> Avatar(title, item.counterpart?.avatar, size = 44.dp)
        }
        Column(Modifier.weight(1f).padding(horizontal = Tokens.Spacing.m)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (incoming) Icons.AutoMirrored.Filled.CallReceived else Icons.AutoMirrored.Filled.CallMade,
                    contentDescription = null,
                    tint = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(Tokens.Spacing.xs))
                Text(
                    parts.joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(time, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        IconButton(
            onClick = onCallBack,
            enabled = callBackEnabled,
            modifier = Modifier.tagged("calls-callback-${item.id}"),
        ) {
            if (calling) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Icon(
                    if (video) Icons.Filled.Videocam else Icons.Filled.Call,
                    contentDescription = "$callBackLabel: $title",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@Composable
private fun IconTile(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color) {
    Box(
        Modifier.size(44.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint)
    }
}

private val SuccessGreen = Color(0xFF16A34A)
