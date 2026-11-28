package com.weldsuite.weldmail.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Forward
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.ReplyAll
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Done
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FolderZip
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Slideshow
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.AttachmentKind
import com.weldsuite.weldmail.Attachments
import com.weldsuite.weldmail.ComposeMode
import com.weldsuite.weldmail.ComposePrefill
import com.weldsuite.weldmail.MailAddress
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
import org.weldsuite.ui.Button
import org.weldsuite.ui.MessageAction
import org.weldsuite.ui.MessageScreen as FullMessage
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** How opening a message went when there is nothing to show. */
private enum class Outcome { GONE, FAILED }

/**
 * One conversation, as the platform's message view: the subject, the earlier
 * messages collapsed to one line (oldest first), the newest open at the
 * bottom with its sender, recipients, body and files, and Reply, Reply all and
 * Forward under it. Cache first (so it opens offline), then the server.
 * Opening it marks it read.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
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
    val labelState by store.labels.collectAsStateWithLifecycle()
    var message by remember(messageId) { mutableStateOf(preview?.let { stub(messageId, it) }) }
    var thread by remember(messageId) { mutableStateOf<List<MailMessage>>(emptyList()) }
    var bodyLoading by remember(messageId) { mutableStateOf(true) }
    var outcome by remember(messageId) { mutableStateOf<Outcome?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var snoozing by remember { mutableStateOf(false) }
    var choosingLabels by remember { mutableStateOf(false) }
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
            null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
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

    val isPinned = MailLogic.isPinned(current)
    val conversation = MailLogic.conversation(current, thread)
    val newest = conversation.last()
    val older = conversation.dropLast(1)
    val next = { MailLogic.nextId(store.visibleIds, current.id) }
    fun leave(goNext: Boolean) {
        val nextId = if (goNext) next() else null
        if (nextId != null) onOpenOther(nextId) else onBack()
    }
    fun reply(of: MailMessage, mode: ComposeMode) {
        onCompose(MailLogic.prefill(of, mode, store.ownAddresses, context.getString(R.string.weldmail_common_unknown)))
    }
    fun star(of: MailMessage, on: Boolean) {
        if (of.id == current.id) message = current.copy(isStarred = on)
        thread = thread.map { if (it.id == of.id) it.copy(isStarred = on) else it }
        scope.launch { store.setStarred(of.id, on) }
    }
    val canReplyAll = newest.to.size + newest.cc.size > 1

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
                    IconButton(onClick = { star(current, !current.isStarred) }, modifier = Modifier.tagged("message-star")) {
                        if (current.isStarred) {
                            Icon(Icons.Filled.Star, contentDescription = stringResource(R.string.weldmail_message_unstar), tint = MailColors.star)
                        } else {
                            Icon(Icons.Outlined.StarOutline, contentDescription = stringResource(R.string.weldmail_message_star))
                        }
                    }
                    IconButton(onClick = {
                        scope.launch { store.archive(current.id) }
                        onBack()
                    }, modifier = Modifier.tagged("message-archive")) {
                        Icon(Icons.Outlined.Archive, contentDescription = stringResource(R.string.weldmail_message_archive))
                    }
                    IconButton(onClick = {
                        scope.launch { store.delete(current.id) }
                        onBack()
                    }, modifier = Modifier.tagged("message-delete")) {
                        Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.weldmail_message_delete), tint = Tokens.Status.danger.current())
                    }
                    IconButton(onClick = { menu = true }, modifier = Modifier.tagged("message-more")) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.weldmail_message_more))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        MenuItem(R.string.weldmail_message_mark_unread, Icons.Outlined.MarkEmailUnread) {
                            menu = false
                            scope.launch { store.setRead(current.id, false) }
                            onBack()
                        }
                        MenuItem(R.string.weldmail_message_mark_done, Icons.Outlined.Done, Modifier.tagged("archive-next")) {
                            menu = false
                            scope.launch { store.archive(current.id) }
                            leave(goNext = true)
                        }
                        MenuItem(if (isPinned) R.string.weldmail_message_unpin else R.string.weldmail_message_pin, Icons.Outlined.PushPin, Modifier.tagged("message-pin")) {
                            menu = false
                            val before = current.labels
                            message = current.copy(labels = MailLogic.withPinned(before, !isPinned))
                            scope.launch {
                                try {
                                    val labels = store.setPinned(current.id, before, !isPinned)
                                    message = message?.copy(labels = labels)
                                } catch (error: Exception) {
                                    message = message?.copy(labels = before)
                                    notify.show(context.getString(org.weldsuite.core.apiErrorMessage(error)))
                                }
                            }
                        }
                        MenuItem(R.string.weldmail_message_snooze, Icons.Outlined.AccessTime) {
                            menu = false
                            snoozing = true
                        }
                        MenuItem(R.string.weldmail_message_label_as, Icons.AutoMirrored.Outlined.Label) {
                            menu = false
                            choosingLabels = true
                        }
                        MenuItem(R.string.weldmail_message_next, Icons.Outlined.ExpandMore) {
                            menu = false
                            leave(goNext = true)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        MenuItem(R.string.weldmail_message_mark_spam, Icons.Outlined.WarningAmber) {
                            menu = false
                            scope.launch { store.markSpam(current.id) }
                            onBack()
                        }
                    }
                },
            )
        },
        bottomBar = {
            Column(Modifier.navigationBarsPadding()) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    ActionButton(R.string.weldmail_message_reply, Icons.AutoMirrored.Outlined.Reply, Modifier.weight(1f).tagged("reply")) {
                        reply(newest, ComposeMode.REPLY)
                    }
                    if (canReplyAll) {
                        ActionButton(R.string.weldmail_message_reply_all, Icons.AutoMirrored.Outlined.ReplyAll, Modifier.weight(1f).tagged("reply-all")) {
                            reply(newest, ComposeMode.REPLY_ALL)
                        }
                    }
                    ActionButton(R.string.weldmail_message_forward, Icons.AutoMirrored.Outlined.Forward, Modifier.weight(1f).tagged("forward")) {
                        reply(newest, ComposeMode.FORWARD)
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
            // The subject, with the conversation's size and the message's own labels.
            Row(Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.xs, bottom = Tokens.Spacing.m), verticalAlignment = Alignment.Top) {
                Text(
                    current.subject?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_subject),
                    style = MaterialTheme.typography.titleLarge.copy(fontSize = 18.sp, lineHeight = 26.sp),
                    modifier = Modifier.weight(1f, fill = false).tagged("message-subject"),
                )
                if (conversation.size > 1) CountBadge(conversation.size, Modifier.padding(start = Tokens.Spacing.s, top = 4.dp), height = 18.dp)
            }
            val shown = MailLogic.displayLabels(current.labels)
            if (shown.isNotEmpty()) {
                val colors = labelState.custom.associate { it.name to it.color }
                FlowRow(
                    Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, bottom = Tokens.Spacing.m),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) { shown.forEach { label -> LabelChip(label, labelTint(label, colors[label])) } }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            // Earlier messages, oldest first and collapsed to one line.
            older.forEach { earlier ->
                ThreadMessage(
                    message = earlier,
                    selfAddresses = store.ownAddresses,
                    onReply = { mode -> reply(earlier, mode) },
                    onStar = { on -> star(earlier, on) },
                    onContact = onContact,
                )
            }
            // The newest message, open at the bottom of the conversation.
            NewestHeader(newest, store.ownAddresses, onStar = { star(newest, !newest.isStarred) }, onReply = { reply(newest, ComposeMode.REPLY) }, onContact = onContact)
            UnsubscribeChip(store, newest)
            Box(Modifier.padding(top = Tokens.Spacing.s, bottom = Tokens.Spacing.l)) {
                val html = newest.htmlBody
                val text = newest.textBody ?: newest.preview
                when {
                    !html.isNullOrBlank() -> EmailWebView(
                        html,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                        fontSize = 14,
                        lineHeight = 1.625,
                        initialHeight = 300,
                    )
                    bodyLoading && text.isNullOrBlank() -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    else -> Text(
                        text?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_content),
                        style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 22.sp),
                        color = if (text.isNullOrBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                    )
                }
            }
            if (newest.attachments.isNotEmpty()) AttachmentsBlock(newest.attachments, attachments)
            Spacer(Modifier.size(Tokens.Spacing.l))
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
}

@Composable
private fun MenuItem(label: Int, icon: ImageVector, modifier: Modifier = Modifier, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(stringResource(label)) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp)) },
        onClick = onClick,
        modifier = modifier,
    )
}

/** Reply, Reply all, Forward: the platform's bordered, muted `rounded-lg` buttons under the message. */
@Composable
private fun ActionButton(label: Int, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        contentPadding = PaddingValues(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
        Text(
            stringResource(label),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = Tokens.Spacing.s),
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
        from = MailAddress(preview.fromEmail.orEmpty(), preview.fromName),
        subject = preview.subject,
        preview = preview.preview,
        sentDate = now,
        createdAt = now,
        isRead = false,
    )
}

/** "to Sanne Bakker, me", or "to me" when the message names nobody. */
@Composable
private fun toLine(message: MailMessage, selfAddresses: List<String>): String {
    val names = MailLogic.recipientsLine(message, selfAddresses, stringResource(R.string.weldmail_common_me))
    return if (names.isEmpty()) stringResource(R.string.weldmail_message_to_me) else stringResource(R.string.weldmail_message_to, names.joinToString(", "))
}

@Composable
private fun SmallIconButton(icon: ImageVector, description: String, onClick: () -> Unit, tint: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    IconButton(onClick = onClick, modifier = Modifier.size(36.dp)) {
        Icon(icon, contentDescription = description, tint = tint, modifier = Modifier.size(18.dp))
    }
}

/**
 * The newest message's header: the sender (name, then the address) with who
 * it went to, the date, star and reply. The recipients line opens the list of
 * every recipient, as the platform's recipients popover.
 */
@Composable
private fun NewestHeader(message: MailMessage, selfAddresses: List<String>, onStar: () -> Unit, onReply: () -> Unit, onContact: (String) -> Unit) {
    var details by remember(message.id) { mutableStateOf(false) }
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_no_sender)
    val senderEmail = message.from?.email.orEmpty()
    val contactKey = senderEmail.ifBlank { sender }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.l)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MailAvatar(
                sender,
                url = message.from?.avatarUrl,
                modifier = Modifier.clickable { onContact(contactKey) }.tagged("open-contact"),
            )
            Column(Modifier.weight(1f).padding(start = Tokens.Spacing.m)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        sender,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).clickable { onContact(contactKey) },
                    )
                    if (senderEmail.isNotBlank() && senderEmail != sender) {
                        Text(
                            "<$senderEmail>",
                            style = MaterialTheme.typography.bodySmall,
                            color = muted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false),
                        )
                    }
                }
                Row(Modifier.clickable { details = !details }.tagged("toggle-details"), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        toLine(message, selfAddresses),
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp),
                        color = muted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Icon(
                        if (details) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                        contentDescription = stringResource(if (details) R.string.weldmail_message_hide_details else R.string.weldmail_message_show_details),
                        tint = muted,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
            Text(dateText(message.listDate, withTime = true), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(start = Tokens.Spacing.s))
            if (message.isStarred) {
                SmallIconButton(Icons.Filled.Star, stringResource(R.string.weldmail_message_unstar), onStar, MailColors.star)
            } else {
                SmallIconButton(Icons.Outlined.StarOutline, stringResource(R.string.weldmail_message_star), onStar)
            }
            SmallIconButton(Icons.AutoMirrored.Outlined.Reply, stringResource(R.string.weldmail_message_reply), onReply)
        }
        if (details) RecipientsPanel(message, onContact)
    }
}

/** Every recipient, To then Cc, as the platform's "Recipients (n)" list. */
@Composable
private fun RecipientsPanel(message: MailMessage, onContact: (String) -> Unit) {
    val all = message.to.map { it to false } + message.cc.map { it to true }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        Modifier
            .padding(top = Tokens.Spacing.m, end = Tokens.Spacing.s)
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small),
    ) {
        Text(
            pluralStringResource(R.plurals.weldmail_message_recipients, all.size, all.size),
            style = MaterialTheme.typography.labelMedium,
            color = muted,
            modifier = Modifier.padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Column(Modifier.padding(vertical = Tokens.Spacing.xs)) {
            all.forEach { (address, isCc) ->
                val name = address.name?.takeIf { it.isNotBlank() } ?: MailLogic.displayName(address.email)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onContact(address.email.ifBlank { name }) }
                        .padding(horizontal = Tokens.Spacing.m, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MailAvatar(name, url = address.avatarUrl)
                    Column(Modifier.weight(1f).padding(start = Tokens.Spacing.m)) {
                        Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(address.email, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (isCc) {
                                Text(
                                    stringResource(R.string.weldmail_compose_cc).uppercase(),
                                    fontSize = 10.sp,
                                    color = muted,
                                    modifier = Modifier
                                        .padding(start = Tokens.Spacing.xs)
                                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp))
                                        .padding(horizontal = 4.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
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
    // Under the sender's name, as the platform puts it beside the recipients.
    Box(Modifier.padding(start = Tokens.Spacing.l + 40.dp, top = Tokens.Spacing.xs)) {
        if (current.active) {
            OutlinedButton(
                onClick = { confirming = true },
                enabled = !busy,
                modifier = Modifier.height(28.dp).tagged("unsubscribe"),
                contentPadding = PaddingValues(horizontal = 10.dp),
            ) {
                Text(stringResource(R.string.weldmail_unsubscribe_button), style = MaterialTheme.typography.labelMedium)
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

/** A file's icon by its kind, as the platform's attachment chips (`lib/attachment-icon.ts`). */
private fun attachmentIcon(kind: AttachmentKind): ImageVector = when (kind) {
    AttachmentKind.IMAGE -> Icons.Outlined.Image
    AttachmentKind.DOC -> Icons.Outlined.Description
    AttachmentKind.SHEET -> Icons.Outlined.TableChart
    AttachmentKind.SLIDES -> Icons.Outlined.Slideshow
    AttachmentKind.ARCHIVE -> Icons.Outlined.FolderZip
    AttachmentKind.VIDEO -> Icons.Outlined.Movie
    AttachmentKind.AUDIO -> Icons.Outlined.MusicNote
    AttachmentKind.PDF, AttachmentKind.FILE -> Icons.AutoMirrored.Outlined.InsertDriveFile
}

/** The message's files as the platform's outlined chips: icon, name, size. Tapped, one downloads and opens. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachmentsBlock(list: List<MailAttachment>, attachments: Attachments) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var opening by remember { mutableStateOf<String?>(null) }
    FlowRow(
        Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        list.forEach { attachment ->
            val name = attachment.fileName.ifBlank { stringResource(R.string.weldmail_message_attachment) }
            Row(
                Modifier
                    .clip(MaterialTheme.shapes.small)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
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
                    .padding(horizontal = Tokens.Spacing.m, vertical = 6.dp)
                    .tagged("attachment-$name"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (opening == attachment.id) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Icon(attachmentIcon(MailLogic.attachmentKind(name)), contentDescription = null, modifier = Modifier.size(16.dp))
                }
                Text(
                    name,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = Tokens.Spacing.s).widthIn(max = 200.dp),
                )
                if (attachment.size > 0) {
                    Text(
                        MailLogic.fileSize(attachment.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Tokens.Spacing.s),
                    )
                }
            }
        }
    }
}

/**
 * An earlier message of the conversation, as the platform's: collapsed, one
 * line (avatar, sender, snippet, date, star); open, the sender's address,
 * who it went to, reply and more, and the body.
 */
@Composable
private fun ThreadMessage(
    message: MailMessage,
    selfAddresses: List<String>,
    onReply: (ComposeMode) -> Unit,
    onStar: (Boolean) -> Unit,
    onContact: (String) -> Unit,
) {
    var expanded by remember(message.id) { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_no_sender)
    val senderEmail = message.from?.email.orEmpty()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.m, bottom = Tokens.Spacing.m)
            .tagged("thread-message"),
        verticalAlignment = if (expanded) Alignment.CenterVertically else Alignment.Top,
    ) {
        MailAvatar(
            sender,
            url = message.from?.avatarUrl,
            modifier = Modifier.padding(top = if (expanded) 0.dp else 2.dp).clickable { onContact(senderEmail.ifBlank { sender }) },
        )
        Column(Modifier.weight(1f).padding(start = Tokens.Spacing.m)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(sender, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (expanded && senderEmail.isNotBlank() && senderEmail != sender) {
                    Text("<$senderEmail>", style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false))
                }
            }
            Text(
                if (expanded) toLine(message, selfAddresses) else message.preview.orEmpty(),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp),
                color = muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(dateText(message.listDate, withTime = true), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(start = Tokens.Spacing.s))
        if (message.isStarred) {
            SmallIconButton(Icons.Filled.Star, stringResource(R.string.weldmail_message_unstar), { onStar(false) }, MailColors.star)
        } else {
            SmallIconButton(Icons.Outlined.StarOutline, stringResource(R.string.weldmail_message_star), { onStar(true) })
        }
        if (expanded) {
            SmallIconButton(Icons.AutoMirrored.Outlined.Reply, stringResource(R.string.weldmail_message_reply), { onReply(ComposeMode.REPLY) })
            Box {
                SmallIconButton(Icons.Outlined.MoreVert, stringResource(R.string.weldmail_message_more), { more = true })
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    MenuItem(R.string.weldmail_message_reply, Icons.AutoMirrored.Outlined.Reply) {
                        more = false
                        onReply(ComposeMode.REPLY)
                    }
                    if (message.to.size + message.cc.size > 1) {
                        MenuItem(R.string.weldmail_message_reply_all, Icons.AutoMirrored.Outlined.ReplyAll) {
                            more = false
                            onReply(ComposeMode.REPLY_ALL)
                        }
                    }
                    MenuItem(R.string.weldmail_message_forward, Icons.AutoMirrored.Outlined.Forward) {
                        more = false
                        onReply(ComposeMode.FORWARD)
                    }
                }
            }
        }
    }
    if (expanded) {
        val html = message.htmlBody
        Box(Modifier.padding(bottom = Tokens.Spacing.l)) {
            if (!html.isNullOrBlank()) {
                EmailWebView(html, modifier = Modifier.padding(horizontal = Tokens.Spacing.l), fontSize = 14, lineHeight = 1.625, hideQuotes = true)
            } else {
                Text(
                    message.textBody ?: message.preview ?: stringResource(R.string.weldmail_common_no_content),
                    style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 22.sp),
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                )
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}
