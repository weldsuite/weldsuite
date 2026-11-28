package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChannelMemberInfo
import com.weldsuite.weldchat.ChannelRules
import com.weldsuite.weldchat.ChatMessage
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.MessageLayout
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.media.ImageViewer
import com.weldsuite.weldchat.media.ImageViewerState
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.LocalNotify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * A thread (the iOS `ThreadView`): the message it hangs off, "N replies",
 * the replies, and a reply box with mentions. [draft] is the text carried
 * over when a reply chain moves into the thread.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
    env: AppEnvironment,
    store: ChatStore,
    userId: String,
    messageId: String,
    channelId: String,
    draft: String?,
    nav: ChatNavigator,
) {
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val replyFailed = stringResource(R.string.weldchat_thread_reply_failed)
    var parent by remember { mutableStateOf<ChatMessage?>(null) }
    var replies by remember { mutableStateOf<List<ChatMessage>>(emptyList()) }
    var agents by remember { mutableStateOf<List<ChannelMemberInfo>>(emptyList()) }
    // Kept while a profile is pushed on top; the carried-over draft fills it the first time only.
    var input by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(draft.orEmpty(), TextRange(draft.orEmpty().length)))
    }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<Throwable?>(null) }
    var sending by remember { mutableStateOf(false) }
    var viewer by remember { mutableStateOf<ImageViewerState?>(null) }

    val names = remember(store.memberNames, agents) {
        store.memberNames + agents.mapNotNull { agent -> agent.name?.let { agent.userId to it } }
    }
    val rows = MessageLayout.chronological(replies)
    val listState = rememberLazyListState()

    /** The parent by id (it may be older than the channel's first page) and its replies. */
    suspend fun load() {
        try {
            val loadedParent = store.repository.message(messageId)
            val page = store.repository.messages(channelId, parentId = messageId, limit = 100)
            parent = loadedParent
            replies = page.items
            loadError = null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            loadError = error
        }
        loading = false
        store.loadRosterIfNeeded()
        if (agents.isEmpty()) {
            try {
                agents = store.repository.channelMembers(channelId).filter { it.isAgent && it.name != null }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Mentions of agents need them; the thread doesn't.
            }
        }
    }

    /** Cleared at once; the text comes back when the send fails. */
    fun send() {
        val body = input.text.trim()
        if (body.isEmpty() || sending) return
        sending = true
        input = TextFieldValue("")
        scope.launch {
            try {
                store.repository.send(channelId = channelId, body = body, parentId = messageId)
                try {
                    replies = store.repository.messages(channelId, parentId = messageId, limit = 100).items
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    // The reply went; the list catches up on the next load.
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (input.text.isEmpty()) input = TextFieldValue(body, TextRange(body.length))
                notify(replyFailed)
            } finally {
                sending = false
            }
        }
    }

    LaunchedEffect(messageId) { load() }
    LaunchedEffect(rows.lastOrNull()?.id) {
        if (rows.isNotEmpty()) listState.animateScrollToItem(0)
    }

    val actions = MessageRowActions(
        openImage = { url ->
            val all = listOfNotNull(parent) + replies
            viewer = ImageViewerState(ChannelRules.images(all), url)
        },
        openProfile = { id -> nav.openMember(id) },
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_thread_title)) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        load()
                        refreshing = false
                    }
                },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) {
                val root = parent
                when {
                    root == null && loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.tagged("thread-loading"))
                    }
                    root == null && loadError != null -> LoadErrorState(loadError, onRetry = { scope.launch { load() } })
                    else -> LazyColumn(
                        state = listState,
                        reverseLayout = true,
                        modifier = Modifier.fillMaxSize().tagged("thread-list"),
                    ) {
                        val drawn = rows.asReversed()
                        itemsIndexed(drawn, key = { _, reply -> reply.id }) { index, reply ->
                            val previous = rows.getOrNull(rows.size - 2 - index)
                            MessageRow(
                                message = reply,
                                compact = MessageLayout.isCompact(reply, previous),
                                names = names,
                                selfId = userId,
                                actions = actions,
                                interactive = false,
                            )
                        }
                        if (root != null) {
                            if (rows.isNotEmpty()) item(key = "count") { ReplyCountDivider(rows.size) }
                            // The thread link belongs to the channel, not here.
                            item(key = "parent") {
                                MessageRow(
                                    message = root.copy(threadReplyCount = 0),
                                    compact = false,
                                    names = names,
                                    selfId = userId,
                                    actions = actions,
                                    interactive = false,
                                )
                            }
                        }
                    }
                }
            }
            ThreadComposer(
                input = input,
                onInputChange = { input = it },
                candidates = MentionText.mentionQuery(input.text)?.let { ChannelRules.mentionCandidates(it, agents, store.roster) },
                onMention = { candidate ->
                    val next = MentionText.insertMention(input.text, candidate.userId)
                    input = TextFieldValue(next, TextRange(next.length))
                },
                sending = sending,
                onSend = ::send,
            )
        }
    }

    viewer?.let { state -> ImageViewer(state) { viewer = null } }
}

/** "N replies", between the parent and its replies. */
@Composable
private fun ReplyCountDivider(count: Int) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        HorizontalDivider(Modifier.weight(1f))
        Text(
            pluralStringResource(R.plurals.weldchat_channel_reply_count, count, count),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f))
    }
}

/** The reply box: the mention picker while `@…` is typed, the text, send. */
@Composable
private fun ThreadComposer(
    input: TextFieldValue,
    onInputChange: (TextFieldValue) -> Unit,
    candidates: List<com.weldsuite.weldchat.MentionCandidate>?,
    onMention: (com.weldsuite.weldchat.MentionCandidate) -> Unit,
    sending: Boolean,
    onSend: () -> Unit,
) {
    val canSend = !sending && input.text.isNotBlank()
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(vertical = Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            if (candidates != null) MentionPicker(candidates, onSelect = onMention)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.weight(1f)) {
                    ComposerField(
                        value = input,
                        onValueChange = onInputChange,
                        placeholder = stringResource(R.string.weldchat_thread_reply_placeholder),
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.m, vertical = 10.dp).tagged("thread-input"),
                    )
                }
                Surface(
                    onClick = onSend,
                    enabled = canSend,
                    shape = CircleShape,
                    color = if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f),
                    modifier = Modifier.size(40.dp).tagged("thread-send"),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (sending) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        } else {
                            Icon(
                                Icons.Filled.ArrowUpward,
                                contentDescription = stringResource(R.string.weldchat_composer_send),
                                tint = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                }
            }
        }
    }
}
