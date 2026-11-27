package com.weldsuite.weldmail.ui

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatItalic
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatUnderlined
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.weldsuite.weldmail.Attachments
import com.weldsuite.weldmail.ComposeMode
import com.weldsuite.weldmail.ComposePrefill
import com.weldsuite.weldmail.MailAccount
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.Person
import com.weldsuite.weldmail.PickedFile
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SchedulePayload
import com.weldsuite.weldmail.SendErrorAlert
import com.weldsuite.weldmail.SendErrors
import com.weldsuite.weldmail.SendFailure
import com.weldsuite.weldmail.resolve
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.ZonedDateTime
import kotlin.random.Random

private enum class Field { TO, CC, BCC }

/** Which "when" sheet is open: "Send later" sends on choosing, "Schedule send" only sets the time. */
private enum class WhenSheet { SEND_LATER, SCHEDULE }

/** The rich editor's state: the HTML, its text, and the formats under the cursor. */
private class EditorState {
    var html by mutableStateOf("")
    var text by mutableStateOf("")
    var bold by mutableStateOf(false)
    var italic by mutableStateOf(false)
    var underline by mutableStateOf(false)
    var bullets by mutableStateOf(false)
    var numbers by mutableStateOf(false)
    var view: WebView? = null

    fun format(command: String) {
        view?.evaluateJavascript("window.weldFormat && window.weldFormat('$command');", null)
    }
}

/**
 * A new message, a reply or a forward: recipients with suggestions from the
 * contacts, a rich-text body, attachments from photos, the camera or files,
 * sending now, later or at a set time. Offline, it waits in the outbox; closed
 * with content, it is kept as a draft.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ComposeScreen(
    env: AppEnvironment,
    store: MailStore,
    attachments: Attachments,
    prefill: ComposePrefill,
    aiAvailable: Boolean,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val accounts = store.sendableAccounts
    var from by remember {
        mutableStateOf(
            accounts.firstOrNull { it.id == prefill.accountId } ?: store.selectedAccount?.takeIf { it.inActiveWorkspace } ?: accounts.firstOrNull(),
        )
    }
    val to = remember { mutableStateListOf<String>().apply { addAll(prefill.to) } }
    val cc = remember { mutableStateListOf<String>().apply { addAll(prefill.cc) } }
    val bcc = remember { mutableStateListOf<String>() }
    val typed = remember { mutableStateOf(mapOf(Field.TO to "", Field.CC to "", Field.BCC to "")) }
    var showCcBcc by remember { mutableStateOf(prefill.cc.isNotEmpty()) }
    var active by remember { mutableStateOf<Field?>(null) }
    var subject by remember { mutableStateOf(prefill.subject) }
    val editor = remember { EditorState() }
    val files = remember { mutableStateListOf<PickedFile>() }
    var scheduledAt by remember { mutableStateOf<ZonedDateTime?>(null) }
    var sending by remember { mutableStateOf(false) }
    var recipientMissing by remember { mutableStateOf(false) }
    var suggestions by remember { mutableStateOf<List<Person>>(emptyList()) }
    var whenSheet by remember { mutableStateOf<WhenSheet?>(null) }
    var pickingDate by remember { mutableStateOf<WhenSheet?>(null) }
    var attachMenu by remember { mutableStateOf(false) }
    var fromMenu by remember { mutableStateOf(false) }
    var showQuote by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Pair<String, String>?>(null) }
    var confirmEmpty by remember { mutableStateOf<(() -> Unit)?>(null) }

    fun typedIn(field: Field) = typed.value[field].orEmpty()
    fun setTyped(field: Field, value: String) {
        typed.value = typed.value + (field to value)
    }
    fun chips(field: Field) = when (field) {
        Field.TO -> to
        Field.CC -> cc
        Field.BCC -> bcc
    }
    val allTo = { MailLogic.withPending(to, typedIn(Field.TO)) }
    val allCc = { MailLogic.withPending(cc, typedIn(Field.CC)) }
    val allBcc = { MailLogic.withPending(bcc, typedIn(Field.BCC)) }
    val hasRecipient = to.isNotEmpty() || typedIn(Field.TO).isNotBlank()
    LaunchedEffect(hasRecipient) { if (hasRecipient) recipientMissing = false }

    // Recent contacts at once; matches as an address is typed.
    LaunchedEffect(Unit) { suggestions = runCatching { store.repository.people(null) }.getOrDefault(emptyList()) }
    val query = active?.let { typedIn(it) }.orEmpty()
    LaunchedEffect(query) {
        if (query.isBlank()) return@LaunchedEffect
        delay(200)
        suggestions = runCatching { store.repository.people(query) }.getOrDefault(suggestions)
    }

    val quoteLabel = stringResource(if (prefill.mode == ComposeMode.FORWARD) R.string.weldmail_compose_forwarded_message else R.string.weldmail_compose_original_message)
    val quoteFrom = stringResource(R.string.weldmail_compose_quoted_from, prefill.quotedFrom)
    val quoteSubject = stringResource(R.string.weldmail_compose_quoted_subject, prefill.quotedSubject)
    val quotedSuffix = MailLogic.quotedSuffix(prefill, quoteLabel, quoteFrom, quoteSubject)

    fun commit(field: Field) {
        val value = typedIn(field).trim()
        if (value.isEmpty()) return
        chips(field).addAll(MailLogic.splitAddresses(value))
        setTyped(field, "")
    }

    fun close() {
        val account = from
        val hasContent = to.isNotEmpty() || typedIn(Field.TO).isNotBlank() || subject.isNotBlank() || editor.text.isNotBlank()
        onClose()
        if (!hasContent || account == null) return
        store.saveDraft(
            MailStore.DraftContent(
                accountId = account.id,
                to = allTo(),
                cc = allCc(),
                bcc = allBcc(),
                subject = subject,
                body = editor.html.ifBlank { editor.text },
                html = editor.html.isNotBlank(),
            ),
        )
        val saved = context.getString(R.string.weldmail_inbox_draft_saved)
        val discarded = context.getString(R.string.weldmail_inbox_draft_discarded)
        fun showSaved() {
            notify.show(saved, context.getString(R.string.weldmail_common_discard)) {
                env.scope.launch {
                    store.discardDraft()
                    notify.show(discarded, context.getString(R.string.weldmail_common_undo)) {
                        store.restoreDraft()
                        showSaved()
                    }
                }
            }
        }
        showSaved()
    }
    BackHandler(enabled = !sending) { close() }

    fun fail(error: Throwable, fallback: Int) {
        val failure = error as? SendFailure
        val described: SendErrorAlert? = failure?.let { SendErrors.describe(it.code, it.details) }
        alert = if (described != null) {
            described.title.resolve(context) to described.lines.joinToString(" ") { it.resolve(context) }
        } else {
            val status = failure?.status ?: (error as? ApiException)?.status
            val serverMessage = error.message?.takeIf { status != null && status in 400..499 && failure?.code != null }
            context.getString(R.string.weldmail_compose_send_failed_title) to (serverMessage ?: context.getString(fallback))
        }
    }

    /** Runs a send behind the guard; closes the composer when it went out, was queued or scheduled. */
    fun submit(at: ZonedDateTime?) {
        val account = from
        if (account == null) {
            alert = context.getString(R.string.weldmail_compose_send_failed_title) to context.getString(R.string.weldmail_compose_no_account)
            return
        }
        if (!hasRecipient) {
            recipientMissing = true
            return
        }
        if (at != null && files.isNotEmpty()) {
            alert = context.getString(R.string.weldmail_compose_attachments_not_supported_title) to
                context.getString(if (at == scheduledAt) R.string.weldmail_compose_attachments_scheduled_send else R.string.weldmail_compose_attachments_scheduled_later)
            return
        }
        val go = {
            sending = true
            scope.launch {
                val html = editor.html.takeIf { editor.text.isNotBlank() || it.contains("<img", ignoreCase = true) }.orEmpty()
                try {
                    if (at != null) {
                        val payload = MailLogic.sendPayload(
                            allTo(), allCc(), allBcc(), subject, editor.text, html, quotedSuffix, emptyList(), null,
                            prefill.inReplyTo, prefill.references, context.getString(R.string.weldmail_common_no_subject),
                        )
                        store.repository.schedule(
                            SchedulePayload(
                                accountId = account.id,
                                to = payload.to,
                                cc = payload.cc,
                                bcc = payload.bcc,
                                subject = subject.trim().ifEmpty { null },
                                body = payload.body,
                                htmlBody = payload.htmlBody,
                                scheduledFor = WeldDate.timestampString(at.toInstant()),
                                inReplyTo = payload.inReplyTo,
                                references = payload.references,
                            ),
                        )
                        onClose()
                        notify.show(context.getString(R.string.weldmail_compose_scheduled, momentText(at.toInstant())))
                        return@launch
                    }
                    val uploaded = files.map { file ->
                        try {
                            attachments.upload(file)
                        } catch (error: Exception) {
                            alert = context.getString(R.string.weldmail_compose_send_failed_title) to
                                context.getString(R.string.weldmail_compose_upload_failed, file.name)
                            return@launch
                        }
                    }
                    val payload = MailLogic.sendPayload(
                        allTo(), allCc(), allBcc(), subject, editor.text, html, quotedSuffix, uploaded,
                        MailLogic.idempotencyKey(System.currentTimeMillis()) { Random.nextInt(it) },
                        prefill.inReplyTo, prefill.references, context.getString(R.string.weldmail_common_no_subject),
                    )
                    try {
                        store.repository.send(account.id, payload)
                        onClose()
                        notify.show(context.getString(R.string.weldmail_compose_sent))
                    } catch (error: SendFailure) {
                        if (!error.isNetwork) throw error
                        // Offline: it goes out when the phone is back online, once (its key).
                        store.queueSend(account.id, payload)
                        onClose()
                        notify.show(context.getString(R.string.weldmail_compose_queued))
                    }
                } catch (error: Exception) {
                    fail(error, if (at != null) R.string.weldmail_compose_schedule_failed else R.string.weldmail_compose_send_failed)
                } finally {
                    sending = false
                }
            }
            Unit
        }
        if (MailLogic.hasNoBody(editor.text, quotedSuffix, files.size)) confirmEmpty = go else go()
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        uris.forEachIndexed { index, uri -> files += attachments.describe(uri, "photo_${System.currentTimeMillis()}_${index + 1}.jpg") }
    }
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val uri = photoUri
        if (taken && uri != null) files += attachments.describe(uri, "photo_${System.currentTimeMillis()}.jpg")
    }
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri -> files += attachments.describe(uri, "attachment") }
    }

    val title = stringResource(
        when (prefill.mode) {
            ComposeMode.NEW -> R.string.weldmail_compose_new_title
            ComposeMode.REPLY -> R.string.weldmail_compose_reply_title
            ComposeMode.REPLY_ALL -> R.string.weldmail_compose_reply_all_title
            ComposeMode.FORWARD -> R.string.weldmail_compose_forward_title
        },
    )

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = { close() }, enabled = !sending, modifier = Modifier.tagged("compose-close")) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_compose_close))
                    }
                },
                title = {
                    Column(
                        Modifier.clickable(enabled = accounts.size > 1) { fromMenu = true }.tagged("compose-from"),
                    ) {
                        Text(title, maxLines = 1)
                        from?.let { account ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(account.email, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (accounts.size > 1) Icon(Icons.Outlined.ArrowDropDown, contentDescription = stringResource(R.string.weldmail_compose_from))
                            }
                        }
                        DropdownMenu(expanded = fromMenu, onDismissRequest = { fromMenu = false }) {
                            accounts.forEach { account: MailAccount ->
                                DropdownMenuItem(text = { Text(account.email) }, onClick = {
                                    from = account
                                    fromMenu = false
                                })
                            }
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { submit(scheduledAt) }, enabled = !sending, modifier = Modifier.tagged("compose-send")) {
                        if (sending) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(
                                Icons.AutoMirrored.Outlined.Send,
                                contentDescription = stringResource(R.string.weldmail_compose_send),
                                tint = if (hasRecipient) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 2.dp, modifier = Modifier.imePadding()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FormatToggle(editor.bold, Icons.Outlined.FormatBold, R.string.weldmail_compose_bold) { editor.format("bold") }
                    FormatToggle(editor.italic, Icons.Outlined.FormatItalic, R.string.weldmail_compose_italic) { editor.format("italic") }
                    FormatToggle(editor.underline, Icons.Outlined.FormatUnderlined, R.string.weldmail_compose_underline) { editor.format("underline") }
                    FormatToggle(editor.bullets, Icons.AutoMirrored.Outlined.FormatListBulleted, R.string.weldmail_compose_bullet_list) { editor.format("insertUnorderedList") }
                    FormatToggle(editor.numbers, Icons.Outlined.FormatListNumbered, R.string.weldmail_compose_numbered_list) { editor.format("insertOrderedList") }
                    Box {
                        IconButton(onClick = { attachMenu = true }, enabled = !sending, modifier = Modifier.tagged("compose-attach")) {
                            Icon(Icons.Outlined.AttachFile, contentDescription = stringResource(R.string.weldmail_compose_add_attachment))
                        }
                        DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_compose_photo_library)) }, onClick = {
                                attachMenu = false
                                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                            })
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_compose_take_photo)) }, onClick = {
                                attachMenu = false
                                val uri = attachments.newPhotoUri()
                                photoUri = uri
                                camera.launch(uri)
                            })
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldmail_compose_choose_file)) }, onClick = {
                                attachMenu = false
                                documents.launch(arrayOf("*/*"))
                            })
                        }
                    }
                    IconButton(onClick = {
                        if (from == null) {
                            alert = context.getString(R.string.weldmail_compose_send_failed_title) to context.getString(R.string.weldmail_compose_no_account)
                        } else if (!hasRecipient) {
                            recipientMissing = true
                        } else {
                            whenSheet = WhenSheet.SCHEDULE
                        }
                    }, enabled = !sending, modifier = Modifier.tagged("compose-schedule")) {
                        Icon(
                            Icons.Outlined.AccessTime,
                            contentDescription = stringResource(R.string.weldmail_compose_schedule),
                            tint = if (scheduledAt != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = {
                        if (from == null) {
                            alert = context.getString(R.string.weldmail_compose_send_failed_title) to context.getString(R.string.weldmail_compose_no_account)
                        } else if (!hasRecipient) {
                            recipientMissing = true
                        } else {
                            whenSheet = WhenSheet.SEND_LATER
                        }
                    }, enabled = !sending, modifier = Modifier.tagged("compose-send-later")) {
                        Icon(Icons.Outlined.EditCalendar, contentDescription = stringResource(R.string.weldmail_compose_send_later))
                    }
                    if (aiAvailable) {
                        IconButton(onClick = { notify.show(context.getString(R.string.weldmail_compose_ai_unavailable)) }) {
                            Icon(Icons.Outlined.AutoAwesome, contentDescription = stringResource(R.string.weldmail_compose_ai), tint = MailColors.pin)
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState())) {
            RecipientRow(
                field = Field.TO,
                label = stringResource(R.string.weldmail_compose_to),
                chips = to,
                typed = typedIn(Field.TO),
                invalid = recipientMissing,
                onTyped = { value ->
                    val committed = MailLogic.committedAddress(value)
                    if (committed != null) {
                        to += committed
                        setTyped(Field.TO, "")
                    } else {
                        setTyped(Field.TO, value)
                    }
                },
                onCommit = { commit(Field.TO) },
                onFocus = { active = if (it) Field.TO else active.takeUnless { field -> field == Field.TO } },
                trailing = {
                    IconButton(onClick = { showCcBcc = !showCcBcc }, modifier = Modifier.tagged("compose-cc-toggle")) {
                        Icon(
                            if (showCcBcc) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                            contentDescription = stringResource(if (showCcBcc) R.string.weldmail_compose_hide_cc_bcc else R.string.weldmail_compose_show_cc_bcc),
                        )
                    }
                },
            )
            if (recipientMissing) {
                Text(
                    stringResource(R.string.weldmail_compose_recipient_required),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                )
            }
            if (active == Field.TO) Suggestions(query, suggestions) { email -> to += email; setTyped(Field.TO, ""); active = null }
            if (showCcBcc) {
                for (field in listOf(Field.CC, Field.BCC)) {
                    val list = chips(field)
                    RecipientRow(
                        field = field,
                        label = stringResource(if (field == Field.CC) R.string.weldmail_compose_cc else R.string.weldmail_compose_bcc),
                        chips = list,
                        typed = typedIn(field),
                        invalid = false,
                        onTyped = { value ->
                            val committed = MailLogic.committedAddress(value)
                            if (committed != null) {
                                list += committed
                                setTyped(field, "")
                            } else {
                                setTyped(field, value)
                            }
                        },
                        onCommit = { commit(field) },
                        onFocus = { active = if (it) field else active.takeUnless { current -> current == field } },
                    )
                    if (active == field) Suggestions(query, suggestions) { email -> list += email; setTyped(field, ""); active = null }
                }
            }
            if (active == null || query.isBlank()) {
                Row(Modifier.padding(horizontal = Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.weldmail_compose_subject), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    BasicTextField(
                        value = subject,
                        onValueChange = { subject = it },
                        singleLine = true,
                        textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = MaterialTheme.typography.bodyLarge.fontSize),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        modifier = Modifier.weight(1f).padding(Tokens.Spacing.m).tagged("compose-subject"),
                    )
                }
                HorizontalDivider()
                scheduledAt?.let { at ->
                    InputChip(
                        selected = true,
                        onClick = { scheduledAt = null },
                        label = { Text(stringResource(R.string.weldmail_send_later_scheduled_for, momentText(at.toInstant()))) },
                        trailingIcon = { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_send_later_clear), modifier = Modifier.size(16.dp)) },
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l).tagged("compose-scheduled"),
                    )
                }
                if (files.isNotEmpty()) {
                    FlowRow(
                        Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        files.forEach { file ->
                            InputChip(
                                selected = false,
                                onClick = { files.remove(file) },
                                label = { Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp)) },
                                leadingIcon = { Icon(Icons.Outlined.AttachFile, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                trailingIcon = {
                                    Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_compose_remove_attachment, file.name), modifier = Modifier.size(16.dp))
                                },
                            )
                        }
                    }
                }
                RichEditor(editor, Modifier.fillMaxWidth().heightIn(min = 220.dp).padding(horizontal = Tokens.Spacing.l))
                if (prefill.mode != ComposeMode.NEW && prefill.quotedBody.isNotBlank()) {
                    Column(Modifier.padding(Tokens.Spacing.l)) {
                        IconButton(onClick = { showQuote = !showQuote }, modifier = Modifier.tagged("compose-show-quote")) {
                            Icon(Icons.Outlined.MoreHoriz, contentDescription = stringResource(R.string.weldmail_compose_show_quoted))
                        }
                        if (showQuote) {
                            Column(
                                Modifier
                                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(Tokens.Radius.small))
                                    .padding(Tokens.Spacing.m),
                            ) {
                                Text("---------- $quoteLabel ---------", style = MaterialTheme.typography.labelSmall)
                                Text(quoteFrom, style = MaterialTheme.typography.bodySmall)
                                Text(stringResource(R.string.weldmail_compose_quoted_date, fullTime(prefill.quotedDate)), style = MaterialTheme.typography.bodySmall)
                                Text(quoteSubject, style = MaterialTheme.typography.bodySmall)
                                Text(prefill.quotedBody, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = Tokens.Spacing.s))
                            }
                        }
                    }
                }
            }
        }
    }

    whenSheet?.let { sheet ->
        SendLaterSheet(
            title = stringResource(if (sheet == WhenSheet.SEND_LATER) R.string.weldmail_send_later_send_later_title else R.string.weldmail_send_later_schedule_title),
            onDismiss = { whenSheet = null },
            onChoose = { at ->
                whenSheet = null
                if (sheet == WhenSheet.SEND_LATER) submit(at) else scheduledAt = at
            },
            onPick = {
                whenSheet = null
                pickingDate = sheet
            },
        )
    }
    pickingDate?.let { sheet ->
        DateTimeDialog(onDismiss = { pickingDate = null }) { at ->
            pickingDate = null
            if (sheet == WhenSheet.SEND_LATER) submit(at) else scheduledAt = at
        }
    }
    alert?.let { (title, message) ->
        AlertDialog(
            onDismissRequest = { alert = null },
            title = { Text(title) },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { alert = null }) { Text(stringResource(CoreR.string.core_common_done)) } },
        )
    }
    confirmEmpty?.let { go ->
        AlertDialog(
            onDismissRequest = { confirmEmpty = null },
            title = { Text(stringResource(R.string.weldmail_compose_send_without_body_title)) },
            text = { Text(stringResource(R.string.weldmail_compose_send_without_body_message)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmEmpty = null
                    go()
                }, modifier = Modifier.tagged("send-anyway")) { Text(stringResource(R.string.weldmail_compose_send_anyway)) }
            },
            dismissButton = { TextButton(onClick = { confirmEmpty = null }) { Text(stringResource(CoreR.string.core_common_cancel)) } },
        )
    }
}

@Composable
private fun FormatToggle(on: Boolean, icon: androidx.compose.ui.graphics.vector.ImageVector, label: Int, onClick: () -> Unit) {
    IconToggleButton(checked = on, onCheckedChange = { onClick() }) {
        Icon(
            icon,
            contentDescription = stringResource(label),
            tint = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun RecipientRow(
    field: Field,
    label: String,
    chips: MutableList<String>,
    typed: String,
    invalid: Boolean,
    onTyped: (String) -> Unit,
    onCommit: () -> Unit,
    onFocus: (Boolean) -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = if (invalid) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(
            Modifier.weight(1f).padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.xs),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
            verticalArrangement = Arrangement.Center,
        ) {
            chips.forEachIndexed { index, email ->
                InputChip(
                    selected = false,
                    onClick = { chips.removeAt(index) },
                    label = { Text(email, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_compose_remove_recipient, email), modifier = Modifier.size(14.dp)) },
                )
            }
            BasicTextField(
                value = typed,
                onValueChange = onTyped,
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onNext = { onCommit() }),
                textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = MaterialTheme.typography.bodyLarge.fontSize),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier
                    .widthIn(min = 120.dp)
                    .padding(vertical = Tokens.Spacing.m)
                    .onFocusChanged { onFocus(it.isFocused) }
                    .tagged("compose-${field.name.lowercase()}"),
            )
        }
        trailing?.invoke()
    }
    HorizontalDivider()
}

@Composable
private fun Suggestions(query: String, people: List<Person>, onChoose: (String) -> Unit) {
    if (query.isBlank()) return
    val matches = people.filter { !it.email.isNullOrBlank() }
    Column(Modifier.fillMaxWidth().tagged("compose-suggestions")) {
        matches.forEach { person ->
            val email = person.email.orEmpty()
            ListItem(
                headlineContent = { Text(person.name ?: email, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                supportingContent = if (person.name != null) {
                    { Text(email, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                } else {
                    null
                },
                leadingContent = { SenderAvatar(person.name ?: email, size = 32.dp) },
                modifier = Modifier.clickable { onChoose(email) },
            )
        }
        ListItem(
            headlineContent = { Text(stringResource(R.string.weldmail_compose_add_contact, query.trim()), color = MaterialTheme.colorScheme.primary) },
            leadingContent = { Icon(Icons.Outlined.Add, contentDescription = null) },
            modifier = Modifier.clickable { onChoose(query.trim()) }.tagged("compose-add-typed"),
        )
        HorizontalDivider()
    }
}

/** The body: an editable page (`contenteditable`), as the Expo app's editor, with formatting from the toolbar. */
@Composable
private fun RichEditor(state: EditorState, modifier: Modifier) {
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val placeholder = stringResource(R.string.weldmail_compose_body_placeholder)
    val html = remember(textColor, placeholder) { editorHtml(String.format(java.util.Locale.ROOT, "#%06X", textColor and 0xFFFFFF), placeholder) }
    AndroidView(
        modifier = modifier.tagged("compose-body"),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                addJavascriptInterface(EditorBridge(state), "WeldMailEditor")
                loadDataWithBaseURL("https://compose.local/", html, "text/html", "utf-8", null)
                state.view = this
            }
        },
    )
}

private class EditorBridge(private val state: EditorState) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun change(html: String, text: String) {
        main.post {
            state.html = html
            state.text = text
        }
    }

    @JavascriptInterface
    fun formats(json: String) {
        main.post {
            runCatching {
                val formats = JSONObject(json)
                state.bold = formats.optBoolean("b")
                state.italic = formats.optBoolean("i")
                state.underline = formats.optBoolean("u")
                state.bullets = formats.optBoolean("l")
                state.numbers = formats.optBoolean("ol")
            }
        }
    }
}

private fun editorHtml(textColor: String, placeholder: String): String =
    "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">" +
        "<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:transparent}" +
        "#e{font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;color:$textColor;padding:10px 0;min-height:200px;outline:none;word-wrap:break-word}" +
        "#e:empty:before{content:attr(data-placeholder);color:#9CA3AF;pointer-events:none}#e ul,#e ol{padding-left:20px;margin:4px 0}#e a{color:#3B82F6}</style></head>" +
        "<body><div id=\"e\" contenteditable=\"true\" data-placeholder=\"${MailLogic.escapeHtml(placeholder)}\"></div><script>" +
        "var e=document.getElementById('e');" +
        "function s(){WeldMailEditor.change(e.innerHTML,e.innerText)}" +
        "function f(){WeldMailEditor.formats(JSON.stringify({b:document.queryCommandState('bold'),i:document.queryCommandState('italic'),u:document.queryCommandState('underline'),l:document.queryCommandState('insertUnorderedList'),ol:document.queryCommandState('insertOrderedList')}))}" +
        "e.addEventListener('input',s);document.addEventListener('selectionchange',f);" +
        "window.weldFormat=function(c){e.focus();document.execCommand(c,false,null);f();s()};" +
        "</script></body></html>"

