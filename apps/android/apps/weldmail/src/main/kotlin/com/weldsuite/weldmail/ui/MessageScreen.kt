package com.weldsuite.weldmail.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Forward
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.ReplyAll
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Done
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.Attachments
import com.weldsuite.weldmail.ComposeMode
import com.weldsuite.weldmail.ComposePrefill
import com.weldsuite.weldmail.MailAttachment
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.MailSubscription
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.UnsubscribeMethod
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.MessageAction
import org.weldsuite.ui.MessageScreen as FullMessage
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** How opening a message went when there is nothing to show. */
private enum class Outcome { GONE, FAILED }

/**
 * One message, with its conversation under it: cache first (so it opens
 * offline), then the server. Opening it marks it read.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageScreen(
    store: MailStore,
    attachments: Attachments,
    messageId: String,
    preview: MessagePreview?,
    onBack: () -> Unit,
    onOpenOther: (String) -> Unit,
    onCompose: (ComposePrefill) -> Unit,
    onContact: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val context = LocalContext.current
    val pinned by store.pinned.collectAsStateWithLifecycle()
    val labelState by store.labels.collectAsStateWithLifecycle()
    var message by remember(messageId) { mutableStateOf(preview?.let { stub(messageId, it) }) }
    var thread by remember(messageId) { mutableStateOf<List<MailMessage>>(emptyList()) }
    var bodyLoading by remember(messageId) { mutableStateOf(true) }
    var outcome by remember(messageId) { mutableStateOf<Outcome?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var snoozing by remember { mutableStateOf(false) }
    var choosingLabels by remember { mutableStateOf(false) }
    var reported by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(messageId, reload) {
        outcome = null
        val cached = store.cachedMessage(messageId)
        if (cached != null) {
            message = cached
            store.cachedThread(messageId)?.let { list -> thread = list.filterNot { it.id == messageId } }
            bodyLoading = false
        }
        var fetched: MailMessage? = null
        var gone = false
        for (attempt in 0 until 3) {
            try {
                fetched = store.repository.message(messageId)
                break
            } catch (error: Exception) {
                if ((error as? ApiException)?.status == 404) {
                    gone = true
                    break
                }
                if (attempt < 2) delay(300L * (attempt + 1))
            }
        }
        if (fetched != null) {
            message = fetched
            bodyLoading = false
            store.remember(fetched)
            if (!fetched.isRead) store.setRead(fetched.id, true)
        } else if (cached == null && preview == null) {
            outcome = if (gone) Outcome.GONE else Outcome.FAILED
            if (gone) store.refresh()
        }
        // The conversation is a bonus: it never holds up the message.
        runCatching { store.repository.thread(messageId) }.getOrNull()?.let { list ->
            store.rememberThread(messageId, list)
            thread = list.filterNot { it.id == messageId }
        }
        bodyLoading = false
    }

    val current = message
    if (current == null) {
        when (outcome) {
            null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            Outcome.GONE -> FullMessage(
                title = stringResource(R.string.weldmail_message_not_found),
                description = null,
                primary = MessageAction(stringResource(CoreR.string.core_common_close), "message-close", onBack),
            )
            Outcome.FAILED -> FullMessage(
                title = stringResource(R.string.weldmail_message_load_failed),
                description = null,
                primary = MessageAction(stringResource(CoreR.string.core_common_try_again), "retry") { reload++ },
                secondary = MessageAction(stringResource(CoreR.string.core_common_close), "message-close", onBack),
            )
        }
        return
    }

    val isPinned = current.id in pinned
    val next = { MailLogic.nextId(store.visibleIds, current.id) }
    fun leave(goNext: Boolean) {
        val nextId = if (goNext) next() else null
        if (nextId != null) onOpenOther(nextId) else onBack()
    }
    fun reply(of: MailMessage, mode: ComposeMode) {
        onCompose(MailLogic.prefill(of, mode, store.ownAddresses, context.getString(R.string.weldmail_common_unknown)))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.tagged("message-back")) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(CoreR.string.core_common_close))
                    }
                },
                actions = {
                    IconButton(
                        onClick = {
                            scope.launch { store.archive(current.id) }
                            leave(goNext = true)
                        },
                        modifier = Modifier.tagged("archive-next"),
                    ) { Icon(Icons.Outlined.Done, contentDescription = stringResource(R.string.weldmail_message_archive_and_next)) }
                    IconButton(onClick = {
                        message = current.copy(isStarred = !current.isStarred)
                        scope.launch { store.setStarred(current.id, !current.isStarred) }
                    }, modifier = Modifier.tagged("message-star")) {
                        if (current.isStarred) {
                            Icon(Icons.Filled.Star, contentDescription = stringResource(R.string.weldmail_message_unstar), tint = MailColors.star)
                        } else {
                            Icon(Icons.Outlined.StarOutline, contentDescription = stringResource(R.string.weldmail_message_star))
                        }
                    }
                    IconButton(onClick = { store.togglePin(current.id) }, modifier = Modifier.tagged("message-pin")) {
                        if (isPinned) {
                            Icon(Icons.Filled.PushPin, contentDescription = stringResource(R.string.weldmail_message_unpin), tint = MailColors.pin)
                        } else {
                            Icon(Icons.Outlined.PushPin, contentDescription = stringResource(R.string.weldmail_message_pin))
                        }
                    }
                    IconButton(onClick = {
                        scope.launch { store.archive(current.id) }
                        onBack()
                    }, modifier = Modifier.tagged("message-archive")) {
                        Icon(Icons.Outlined.Archive, contentDescription = stringResource(R.string.weldmail_message_archive))
                    }
                    IconButton(onClick = { menu = true }, modifier = Modifier.tagged("message-more")) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.weldmail_message_more))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.weldmail_message_snooze)) },
                            leadingIcon = { Icon(Icons.Outlined.AccessTime, contentDescription = null) },
                            onClick = {
                                menu = false
                                snoozing = true
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.weldmail_message_labels)) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Label, contentDescription = null) },
                            onClick = {
                                menu = false
                                choosingLabels = true
                            },
                        )
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_message_mark_unread)) }, onClick = {
                            menu = false
                            scope.launch { store.setRead(current.id, false) }
                            onBack()
                        })
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_message_next)) }, onClick = {
                            menu = false
                            leave(goNext = true)
                        })
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_message_delete), color = MaterialTheme.colorScheme.error) }, onClick = {
                            menu = false
                            scope.launch { store.delete(current.id) }
                            onBack()
                        }, modifier = Modifier.tagged("message-delete"))
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_message_mark_spam), color = MaterialTheme.colorScheme.error) }, onClick = {
                            menu = false
                            scope.launch { store.markSpam(current.id) }
                            onBack()
                        })
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_message_report_phishing)) }, onClick = {
                            menu = false
                            scope.launch { store.markSpam(current.id) }
                            reported = true
                        })
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 2.dp) {
                Row(
                    Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    OutlinedButton(onClick = { reply(current, ComposeMode.REPLY) }, modifier = Modifier.weight(1f).tagged("reply")) {
                        Icon(Icons.AutoMirrored.Outlined.Reply, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text(stringResource(R.string.weldmail_message_reply), modifier = Modifier.padding(start = Tokens.Spacing.xs))
                    }
                    if (current.to.size + current.cc.size > 1) {
                        OutlinedButton(onClick = { reply(current, ComposeMode.REPLY_ALL) }, modifier = Modifier.weight(1f).tagged("reply-all")) {
                            Icon(Icons.AutoMirrored.Outlined.ReplyAll, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.weldmail_message_reply_all), maxLines = 1, modifier = Modifier.padding(start = Tokens.Spacing.xs))
                        }
                    }
                    OutlinedButton(onClick = { reply(current, ComposeMode.FORWARD) }, modifier = Modifier.weight(1f).tagged("forward")) {
                        Icon(Icons.AutoMirrored.Outlined.Forward, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text(stringResource(R.string.weldmail_message_forward), modifier = Modifier.padding(start = Tokens.Spacing.xs))
                    }
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .tagged("message-screen"),
        ) {
            MessageHeader(current, thread.size + 1, onContact)
            UnsubscribeChip(store, current)
            Box(Modifier.padding(vertical = Tokens.Spacing.s)) {
                val html = current.htmlBody
                val text = current.textBody ?: current.preview
                when {
                    !html.isNullOrBlank() -> EmailWebView(html, fontSize = 14, lineHeight = 1.625, initialHeight = 300)
                    bodyLoading && text.isNullOrBlank() -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(24.dp))
                    }
                    else -> Text(
                        text?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_content),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                    )
                }
            }
            if (current.attachments.isNotEmpty()) AttachmentsBlock(current.attachments, attachments)
            // Earlier messages of the conversation, newest first, collapsed.
            thread.reversed().forEach { older ->
                ThreadMessage(
                    message = older,
                    onReply = { mode -> reply(older, mode) },
                    onContact = onContact,
                )
            }
            Spacer(Modifier.size(Tokens.Spacing.xl))
        }
    }

    if (snoozing) {
        SnoozeSheet(onDismiss = { snoozing = false }) { at ->
            snoozing = false
            scope.launch { store.snooze(current, WeldDate.timestampString(at.toInstant())) }
            onBack()
        }
    }
    if (choosingLabels) {
        LabelPickerDialog(labels = labelState.custom, current = current.labels, onDismiss = { choosingLabels = false }) { add, remove ->
            runCatching { store.repository.changeLabels(current.id, add, remove, current.labels) }
                .onSuccess { labels ->
                    message = current.copy(labels = labels)
                    store.labelsChanged(current.id, labels)
                    choosingLabels = false
                }
                .onFailure { error -> notify.show(context.getString(org.weldsuite.core.apiErrorMessage(error))) }
        }
    }
    if (reported) {
        AlertDialog(
            onDismissRequest = {
                reported = false
                onBack()
            },
            title = { Text(stringResource(R.string.weldmail_message_reported_title)) },
            text = { Text(stringResource(R.string.weldmail_message_reported_message)) },
            confirmButton = {
                TextButton(onClick = {
                    reported = false
                    onBack()
                }) { Text(stringResource(CoreR.string.core_common_done)) }
            },
        )
    }
}

/** A message to paint from a notification before the real one loads. */
private fun stub(id: String, preview: MessagePreview): MailMessage? {
    if (preview.fromName == null && preview.fromEmail == null && preview.subject == null && preview.preview == null) return null
    val now = WeldDate.timestampString(java.time.Instant.now())
    return MailMessage(
        id = id,
        accountId = "",
        from = com.weldsuite.weldmail.MailAddress(preview.fromEmail.orEmpty(), preview.fromName),
        subject = preview.subject,
        preview = preview.preview,
        sentDate = now,
        createdAt = now,
        isRead = false,
    )
}

@Composable
private fun MessageHeader(message: MailMessage, conversationSize: Int, onContact: (String) -> Unit) {
    var details by remember { mutableStateOf(false) }
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_no_sender)
    val senderEmail = message.from?.email.orEmpty()
    val recipients = message.to.joinToString(", ") { it.label }
    Column(Modifier.padding(horizontal = Tokens.Spacing.l)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(
                message.subject?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_subject),
                style = MaterialTheme.typography.headlineSmall,
                modifier = Modifier.weight(1f).tagged("message-subject"),
            )
            if (conversationSize > 1) {
                Text(
                    conversationSize.toString(),
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier
                        .padding(start = Tokens.Spacing.s, top = 6.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        Row(Modifier.padding(top = Tokens.Spacing.m), verticalAlignment = Alignment.CenterVertically) {
            SenderAvatar(
                sender,
                modifier = Modifier
                    .clickable { onContact(senderEmail.ifBlank { sender }) }
                    .tagged("open-contact"),
            )
            Column(Modifier.weight(1f).padding(start = Tokens.Spacing.m)) {
                Text(
                    sender,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.clickable { onContact(senderEmail.ifBlank { sender }) },
                )
                Row(Modifier.clickable { details = !details }.tagged("toggle-details"), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (recipients.isBlank()) stringResource(R.string.weldmail_message_to_me) else stringResource(R.string.weldmail_message_to, recipients),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Icon(
                        if (details) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                        contentDescription = stringResource(if (details) R.string.weldmail_message_hide_details else R.string.weldmail_message_show_details),
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
            Text(messageTime(message.listDate), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (details) {
            Column(
                Modifier
                    .padding(top = Tokens.Spacing.m)
                    .fillMaxWidth()
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(Tokens.Radius.small))
                    .padding(Tokens.Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                DetailRow(stringResource(R.string.weldmail_message_from), "$sender\n$senderEmail")
                DetailRow(stringResource(R.string.weldmail_message_to_label), message.to.joinToString(", ") { it.email.ifBlank { it.label } })
                if (message.cc.isNotEmpty()) DetailRow(stringResource(R.string.weldmail_message_cc), message.cc.joinToString(", ") { it.email.ifBlank { it.label } })
                DetailRow(stringResource(R.string.weldmail_message_date), fullTime(message.listDate))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Lock, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(stringResource(R.string.weldmail_message_encryption), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(56.dp))
        Text(value, style = MaterialTheme.typography.bodySmall)
    }
}

/** Unsubscribe under the sender of a mailing list's email; nothing for ordinary mail. */
@Composable
private fun UnsubscribeChip(store: MailStore, message: MailMessage) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var subscription by remember(message.id) { mutableStateOf<MailSubscription?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(message.id, message.accountId) {
        if (store.sendableAccounts.none { it.id == message.accountId }) return@LaunchedEffect
        subscription = runCatching { store.subscriptionsCached(message.accountId) }.getOrNull()
            ?.let { MailLogic.subscriptionFor(it, message.from?.email) }
    }
    val current = subscription ?: return
    if (current.active && !MailLogic.canUnsubscribe(current)) return
    val sender = current.senderLabel
    Box(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)) {
        if (current.active) {
            OutlinedButton(onClick = { confirming = true }, enabled = !busy, modifier = Modifier.tagged("unsubscribe")) {
                Text(stringResource(R.string.weldmail_unsubscribe_button))
            }
        } else {
            Text(stringResource(R.string.weldmail_unsubscribe_unsubscribed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (confirming) {
        UnsubscribeDialog(
            subscription = current,
            busy = busy,
            onDismiss = { if (!busy) confirming = false },
            onConfirm = {
                busy = true
                scope.launch {
                    try {
                        val result = store.repository.unsubscribe(current.id)
                        store.forgetSubscriptions(current.accountId)
                        subscription = current.copy(active = false, unsubscribedAt = WeldDate.timestampString(java.time.Instant.now()))
                        announceUnsubscribe(context, notify, result.method, result.url, sender)
                    } catch (_: Exception) {
                        notify.show(context.getString(R.string.weldmail_unsubscribe_failed, sender))
                    } finally {
                        busy = false
                        confirming = false
                    }
                }
            },
        )
    }
}

/** "Unsubscribe from …?" with what will happen. */
@Composable
fun UnsubscribeDialog(subscription: MailSubscription, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val sender = subscription.senderLabel
    val message = when {
        subscription.oneClick && subscription.unsubscribeUrl != null -> stringResource(R.string.weldmail_unsubscribe_confirm_one_click, sender)
        subscription.unsubscribeMailto != null -> stringResource(R.string.weldmail_unsubscribe_confirm_mailto, sender)
        else -> stringResource(R.string.weldmail_unsubscribe_confirm_link, sender)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.weldmail_unsubscribe_confirm_title, sender)) },
        text = { Text(message) },
        confirmButton = {
            Button(onClick = onConfirm, enabled = !busy, modifier = Modifier.tagged("confirm-unsubscribe")) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(if (MailLogic.isLinkOnly(subscription)) R.string.weldmail_unsubscribe_open_page else R.string.weldmail_unsubscribe_button))
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

/** Tells how the unsubscribe went, and opens the sender's page when that is still needed. */
fun announceUnsubscribe(context: android.content.Context, notify: Notify, method: UnsubscribeMethod, url: String?, sender: String) {
    when (method) {
        UnsubscribeMethod.ONE_CLICK -> notify.show(context.getString(R.string.weldmail_unsubscribe_done_one_click, sender))
        UnsubscribeMethod.MAILTO -> notify.show(context.getString(R.string.weldmail_unsubscribe_done_mailto, sender))
        UnsubscribeMethod.LINK -> {
            notify.show(context.getString(R.string.weldmail_unsubscribe_done_link, sender))
            url?.let { openInTab(context, it) }
        }
    }
}

@Composable
private fun AttachmentsBlock(list: List<MailAttachment>, attachments: Attachments) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var opening by remember { mutableStateOf<String?>(null) }
    Column(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AttachFile, contentDescription = null, modifier = Modifier.size(14.dp))
            Text(
                pluralStringResource(R.plurals.weldmail_message_attachments, list.size, list.size),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
        list.forEach { attachment ->
            val name = attachment.fileName.ifBlank { stringResource(R.string.weldmail_message_attachment) }
            val kind = MailLogic.attachmentKind(name)
            val color = rgb(MailLogic.attachmentColor(kind))
            Row(
                Modifier
                    .padding(top = Tokens.Spacing.s)
                    .fillMaxWidth()
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(Tokens.Radius.medium))
                    .clickable(enabled = opening == null) {
                        opening = attachment.id
                        scope.launch {
                            try {
                                val file = attachments.download(attachment)
                                if (!attachments.open(file, attachment.contentType)) {
                                    notify.show(context.getString(R.string.weldmail_message_open_failed, name))
                                }
                            } catch (error: Exception) {
                                val status = (error as? ApiException)?.status
                                notify.show(
                                    context.getString(
                                        if (status == 404 || status == 403) R.string.weldmail_message_attachment_unavailable else R.string.weldmail_message_download_failed,
                                        name,
                                    ),
                                )
                            } finally {
                                opening = null
                            }
                        }
                    }
                    .padding(Tokens.Spacing.m)
                    .tagged("attachment-$name"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(36.dp).background(color.copy(alpha = 0.1f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Description, contentDescription = null, tint = color)
                }
                Column(Modifier.weight(1f).padding(horizontal = Tokens.Spacing.m)) {
                    Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOf(MailLogic.extensionLabel(name), if (attachment.size > 0) MailLogic.fileSize(attachment.size) else "").filter { it.isNotEmpty() }.joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (opening == attachment.id) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Outlined.Download, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** An earlier message of the conversation: collapsed to its sender, or open with its own actions. */
@Composable
private fun ThreadMessage(message: MailMessage, onReply: (ComposeMode) -> Unit, onContact: (String) -> Unit) {
    var expanded by remember(message.id) { mutableStateOf(false) }
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_no_sender)
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
            .tagged("thread-message"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SenderAvatar(sender, size = 32.dp, modifier = Modifier.clickable { onContact(message.from?.email?.ifBlank { sender } ?: sender) })
        Column(Modifier.weight(1f).padding(start = Tokens.Spacing.m)) {
            Text(sender, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (expanded) {
                val to = message.to.joinToString(", ") { it.label }
                Text(
                    if (to.isBlank()) stringResource(R.string.weldmail_message_to_me) else stringResource(R.string.weldmail_message_to, to),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(rowTime(message.listDate), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.size(16.dp))
    }
    if (expanded) {
        val html = message.htmlBody
        if (!html.isNullOrBlank()) {
            EmailWebView(html, hideQuotes = true)
        } else {
            Text(
                message.textBody ?: message.preview ?: stringResource(R.string.weldmail_common_no_content),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
            )
        }
        Row(Modifier.padding(Tokens.Spacing.l), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            OutlinedButton(onClick = { onReply(ComposeMode.REPLY) }) { Text(stringResource(R.string.weldmail_message_reply)) }
            if (message.to.size + message.cc.size > 1) {
                OutlinedButton(onClick = { onReply(ComposeMode.REPLY_ALL) }) { Text(stringResource(R.string.weldmail_message_reply_all)) }
            }
            OutlinedButton(onClick = { onReply(ComposeMode.FORWARD) }) { Text(stringResource(R.string.weldmail_message_forward)) }
        }
    }
}
