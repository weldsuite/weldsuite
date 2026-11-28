package com.weldsuite.weldmail.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.TextFields
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import org.weldsuite.ui.Button
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
    var showCc by remember { mutableStateOf(prefill.cc.isNotEmpty()) }
    var showBcc by remember { mutableStateOf(false) }
    var formatting by remember { mutableStateOf(false) }
    var active by remember { mutableStateOf<Field?>(null) }
    var subject by remember { mutableStateOf(prefill.subject) }
    val editor = remember { EditorState() }
    val files = remember { mutableStateListOf<PickedFile>() }
    var scheduledAt by remember { mutableStateOf<ZonedDateTime?>(null) }
    var sending by remember { mutableStateOf(false) }
    var recipientMissing by remember { mutableStateOf(false) }
    var suggestions by remember { mutableStateOf<List<Person>>(emptyList()) }
    var choosingTime by remember { mutableStateOf(false) }
    var pickingDate by remember { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
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
                title = { Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1) },
            )
        },
        bottomBar = {
            // The platform's compose footer: the tools on the left, Send (or Schedule at the chosen time) on the right.
            Column(
                Modifier
                    .background(MaterialTheme.colorScheme.background)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)),
            ) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (formatting) {
                    Row(
                        Modifier
                            .padding(start = Tokens.Spacing.m, end = Tokens.Spacing.m, top = Tokens.Spacing.s)
                            .clip(MaterialTheme.shapes.medium)
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                            .horizontalScroll(rememberScrollState())
                            .padding(Tokens.Spacing.xs),
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        FormatToggle(editor.bold, Icons.Outlined.FormatBold, R.string.weldmail_compose_bold) { editor.format("bold") }
                        FormatToggle(editor.italic, Icons.Outlined.FormatItalic, R.string.weldmail_compose_italic) { editor.format("italic") }
                        FormatToggle(editor.underline, Icons.Outlined.FormatUnderlined, R.string.weldmail_compose_underline) { editor.format("underline") }
                        FormatToggle(editor.bullets, Icons.AutoMirrored.Outlined.FormatListBulleted, R.string.weldmail_compose_bullet_list) { editor.format("insertUnorderedList") }
                        FormatToggle(editor.numbers, Icons.Outlined.FormatListNumbered, R.string.weldmail_compose_numbered_list) { editor.format("insertOrderedList") }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ToolButton(Icons.Outlined.TextFields, R.string.weldmail_compose_formatting, on = formatting, modifier = Modifier.tagged("compose-formatting")) {
                        formatting = !formatting
                    }
                    Box {
                        ToolButton(Icons.Outlined.AttachFile, R.string.weldmail_compose_add_attachment, enabled = !sending, modifier = Modifier.tagged("compose-attach")) {
                            attachMenu = true
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
                    ToolButton(Icons.Outlined.AccessTime, R.string.weldmail_compose_schedule, on = scheduledAt != null, enabled = !sending, modifier = Modifier.tagged("compose-schedule")) {
                        if (from == null) {
                            alert = context.getString(R.string.weldmail_compose_send_failed_title) to context.getString(R.string.weldmail_compose_no_account)
                        } else if (!hasRecipient) {
                            recipientMissing = true
                        } else {
                            choosingTime = true
                        }
                    }
                    if (aiAvailable) {
                        ToolButton(Icons.Outlined.AutoAwesome, R.string.weldmail_compose_ai) {
                            notify.show(context.getString(R.string.weldmail_compose_ai_unavailable))
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    Button(
                        onClick = { submit(scheduledAt) },
                        enabled = !sending,
                        contentPadding = PaddingValues(horizontal = Tokens.Spacing.m),
                        modifier = Modifier.padding(end = Tokens.Spacing.s).height(36.dp).tagged("compose-send"),
                    ) {
                        if (sending) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            Spacer(Modifier.width(Tokens.Spacing.s))
                        }
                        Text(
                            scheduledAt?.let { stringResource(R.string.weldmail_compose_schedule_for, momentText(it.toInstant())) }
                                ?: stringResource(R.string.weldmail_compose_send),
                            style = MaterialTheme.typography.labelLarge,
                            maxLines = 1,
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .fillMaxSize()
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.height(Tokens.Spacing.xs))
            FromRow(from, accounts) { from = it }
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
                    if (!showCc) {
                        TextButton(onClick = { showCc = true }, contentPadding = PaddingValues(horizontal = Tokens.Spacing.s), modifier = Modifier.tagged("compose-cc-toggle")) {
                            Text(stringResource(R.string.weldmail_compose_cc), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (!showBcc) {
                        TextButton(onClick = { showBcc = true }, contentPadding = PaddingValues(horizontal = Tokens.Spacing.s), modifier = Modifier.tagged("compose-bcc-toggle")) {
                            Text(stringResource(R.string.weldmail_compose_bcc), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
            )
            if (recipientMissing) {
                Text(
                    stringResource(R.string.weldmail_compose_recipient_required),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(start = Tokens.Spacing.l + FIELD_LABEL_WIDTH, bottom = Tokens.Spacing.xs),
                )
            }
            if (active == Field.TO) Suggestions(query, suggestions) { email -> to += email; setTyped(Field.TO, ""); active = null }
            for (field in listOf(Field.CC, Field.BCC)) {
                if ((field == Field.CC && !showCc) || (field == Field.BCC && !showBcc)) continue
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
            if (active == null || query.isBlank()) {
                FieldRow(stringResource(R.string.weldmail_compose_subject)) {
                    BasicTextField(
                        value = subject,
                        onValueChange = { subject = it },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        modifier = Modifier.weight(1f).padding(vertical = Tokens.Spacing.s).tagged("compose-subject"),
                    )
                }
                scheduledAt?.let { at ->
                    Row(
                        Modifier.padding(start = Tokens.Spacing.l, top = Tokens.Spacing.xs).tagged("compose-scheduled"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.AccessTime, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                        Text(
                            stringResource(R.string.weldmail_send_later_scheduled_for, momentText(at.toInstant())),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 6.dp),
                        )
                        IconButton(onClick = { scheduledAt = null }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_send_later_clear), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                        }
                    }
                }
                if (files.isNotEmpty()) AttachedFiles(files) { files.remove(it) }
                RichEditor(editor, Modifier.fillMaxWidth().heightIn(min = 220.dp).padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.s))
                if (prefill.mode != ComposeMode.NEW && prefill.quotedBody.isNotBlank()) {
                    val quoteToggleLabel = stringResource(R.string.weldmail_compose_show_quoted)
                    Column(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
                        // The platform's "···" toggle for the quoted text.
                        Box(
                            Modifier
                                .height(20.dp)
                                .width(32.dp)
                                .clip(MaterialTheme.shapes.small)
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
                                .clickable { showQuote = !showQuote }
                                .semantics { contentDescription = quoteToggleLabel }
                                .tagged("compose-show-quote"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Outlined.MoreHoriz, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                        }
                        if (showQuote) {
                            Column(
                                Modifier
                                    .padding(top = Tokens.Spacing.s)
                                    .fillMaxWidth()
                                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
                                    .padding(Tokens.Spacing.m),
                            ) {
                                val quoteStyle = MaterialTheme.typography.bodySmall
                                val muted = MaterialTheme.colorScheme.onSurfaceVariant
                                Text("---------- $quoteLabel ---------", style = quoteStyle, color = muted)
                                Text(quoteFrom, style = quoteStyle, color = muted)
                                Text(stringResource(R.string.weldmail_compose_quoted_date, fullTime(prefill.quotedDate)), style = quoteStyle, color = muted)
                                Text(quoteSubject, style = quoteStyle, color = muted)
                                Text(prefill.quotedBody, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = Tokens.Spacing.s))
                            }
                        }
                    }
                }
            }
        }
    }

    if (choosingTime) {
        SendLaterSheet(
            title = stringResource(R.string.weldmail_send_later_schedule_title),
            onDismiss = { choosingTime = false },
            onChoose = { at ->
                choosingTime = false
                scheduledAt = at
            },
            onPick = {
                choosingTime = false
                pickingDate = true
            },
        )
    }
    if (pickingDate) {
        DateTimeDialog(onDismiss = { pickingDate = false }) { at ->
            pickingDate = false
            scheduledAt = at
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

/** The platform's field-label column (`w-[72px]`), so From, To and Subject line up. */
private val FIELD_LABEL_WIDTH = 72.dp

@Composable
private fun FormatToggle(on: Boolean, icon: ImageVector, label: Int, onClick: () -> Unit) {
    IconToggleButton(checked = on, onCheckedChange = { onClick() }, modifier = Modifier.size(36.dp)) {
        Box(
            Modifier.size(30.dp).background(if (on) MaterialTheme.colorScheme.background else Color.Transparent, MaterialTheme.shapes.small),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = stringResource(label),
                tint = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** A footer tool, as the platform's: a muted icon, on a muted square while its panel or setting is on. */
@Composable
private fun ToolButton(icon: ImageVector, label: Int, modifier: Modifier = Modifier, on: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier.size(40.dp)) {
        Box(
            Modifier.size(32.dp).background(if (on) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent, MaterialTheme.shapes.small),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = stringResource(label),
                tint = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** A compose field: its muted label in the label column, then the value. */
@Composable
private fun FieldRow(label: String, invalid: Boolean = false, content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (invalid) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(FIELD_LABEL_WIDTH),
        )
        content()
    }
}

/** "From": the sending account's initial and name; a picker when there is more than one. */
@Composable
private fun FromRow(from: MailAccount?, accounts: List<MailAccount>, onChoose: (MailAccount) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    FieldRow(stringResource(R.string.weldmail_compose_from)) {
        Box(Modifier.weight(1f)) {
            Row(
                Modifier
                    .clip(MaterialTheme.shapes.small)
                    .clickable(enabled = accounts.size > 1) { open = true }
                    .padding(horizontal = 6.dp, vertical = Tokens.Spacing.xs)
                    .tagged("compose-from"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (from != null) {
                    val name = from.displayName.ifBlank { from.email }
                    // The same single-initial avatar as the inbox rows, in the platform colour for the name.
                    MailAvatar(name, size = 20.dp)
                    Text(
                        name,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false),
                    )
                }
                if (accounts.size > 1) {
                    Icon(Icons.Outlined.ArrowDropDown, contentDescription = stringResource(R.string.weldmail_compose_from), tint = muted, modifier = Modifier.size(18.dp))
                }
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                accounts.forEach { account ->
                    val name = account.displayName.ifBlank { account.email }
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                if (name != account.email) Text(account.email, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1)
                            }
                        },
                        onClick = {
                            onChoose(account)
                            open = false
                        },
                    )
                }
            }
        }
    }
}

/** A recipient, as the platform's: a small person icon and the address, in a `rounded-md` outline; tapped, it goes. */
@Composable
private fun RecipientToken(email: String, onRemove: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier
            .height(28.dp)
            .clip(MaterialTheme.shapes.small)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
            .clickable(onClick = onRemove)
            .padding(start = Tokens.Spacing.xs, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(16.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Person, contentDescription = null, tint = muted, modifier = Modifier.size(11.dp))
        }
        Text(
            email,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 6.dp).widthIn(max = 220.dp),
        )
        Icon(
            Icons.Outlined.Close,
            contentDescription = stringResource(R.string.weldmail_compose_remove_recipient, email),
            tint = muted,
            modifier = Modifier.padding(start = Tokens.Spacing.xs).size(14.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
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
    FieldRow(label, invalid) {
        FlowRow(
            Modifier.weight(1f).padding(vertical = Tokens.Spacing.xs),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
        ) {
            chips.forEachIndexed { index, email -> RecipientToken(email) { if (index < chips.size) chips.removeAt(index) } }
            BasicTextField(
                value = typed,
                onValueChange = onTyped,
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onNext = { onCommit() }),
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                modifier = Modifier
                    .widthIn(min = 120.dp)
                    .padding(vertical = 6.dp)
                    .onFocusChanged { onFocus(it.isFocused) }
                    .tagged("compose-${field.name.lowercase()}"),
            )
        }
        trailing?.invoke()
    }
}

@Composable
private fun Suggestions(query: String, people: List<Person>, onChoose: (String) -> Unit) {
    if (query.isBlank()) return
    val matches = people.filter { !it.email.isNullOrBlank() }
    Column(Modifier.fillMaxWidth().tagged("compose-suggestions")) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        matches.forEach { person ->
            val email = person.email.orEmpty()
            Row(
                Modifier.fillMaxWidth().clickable { onChoose(email) }.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MailAvatar(person.name ?: email, url = person.avatarUrl)
                Column(Modifier.padding(start = Tokens.Spacing.m)) {
                    Text(person.name ?: email, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (person.name != null) {
                        Text(email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().clickable { onChoose(query.trim()) }.padding(horizontal = Tokens.Spacing.l, vertical = 10.dp).tagged("compose-add-typed"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.weldmail_compose_add_contact, query.trim()), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = Tokens.Spacing.m))
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** The files going along, as the platform's attachments box: a muted panel with the count and each file. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachedFiles(files: List<PickedFile>, onRemove: (PickedFile) -> Unit) {
    Column(
        Modifier
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.medium)
            .padding(Tokens.Spacing.m),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AttachFile, contentDescription = null, modifier = Modifier.size(14.dp))
            Text(
                pluralStringResource(R.plurals.weldmail_message_attachments, files.size, files.size),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(start = 6.dp),
            )
        }
        FlowRow(
            Modifier.padding(top = Tokens.Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            files.forEach { file ->
                Row(
                    Modifier
                        .height(30.dp)
                        .clip(MaterialTheme.shapes.small)
                        .background(MaterialTheme.colorScheme.background)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
                        .clickable { onRemove(file) }
                        .padding(horizontal = Tokens.Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(file.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
                    Icon(
                        Icons.Outlined.Close,
                        contentDescription = stringResource(R.string.weldmail_compose_remove_attachment, file.name),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp).size(14.dp),
                    )
                }
            }
        }
    }
}

/** The body: an editable page (`contenteditable`), as the Expo app's editor, with formatting from the toolbar. */
@Composable
private fun RichEditor(state: EditorState, modifier: Modifier) {
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val mutedColor = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    val linkColor = Tokens.Palette.link.current().toArgb()
    val placeholder = stringResource(R.string.weldmail_compose_body_placeholder)
    val html = remember(textColor, mutedColor, linkColor, placeholder) { editorHtml(cssColor(textColor), cssColor(mutedColor), cssColor(linkColor), placeholder) }
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

private fun cssColor(argb: Int): String = String.format(java.util.Locale.ROOT, "#%06X", argb and 0xFFFFFF)

/** The editor page, in the platform's body text (14px) and colours: muted placeholder, link-coloured links. */
private fun editorHtml(textColor: String, mutedColor: String, linkColor: String, placeholder: String): String =
    "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">" +
        "<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:transparent}" +
        "#e{font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:$textColor;padding:10px 0;min-height:200px;outline:none;word-wrap:break-word}" +
        "#e:empty:before{content:attr(data-placeholder);color:$mutedColor;pointer-events:none}#e ul,#e ol{padding-left:20px;margin:4px 0}#e a{color:$linkColor}</style></head>" +
        "<body><div id=\"e\" contenteditable=\"true\" data-placeholder=\"${MailLogic.escapeHtml(placeholder)}\"></div><script>" +
        "var e=document.getElementById('e');" +
        "function s(){WeldMailEditor.change(e.innerHTML,e.innerText)}" +
        "function f(){WeldMailEditor.formats(JSON.stringify({b:document.queryCommandState('bold'),i:document.queryCommandState('italic'),u:document.queryCommandState('underline'),l:document.queryCommandState('insertUnorderedList'),ol:document.queryCommandState('insertOrderedList')}))}" +
        "e.addEventListener('input',s);document.addEventListener('selectionchange',f);" +
        "window.weldFormat=function(c){e.focus();document.execCommand(c,false,null);f();s()};" +
        "</script></body></html>"

