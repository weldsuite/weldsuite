package com.weldsuite.weldchat.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.SentimentSatisfied
import androidx.compose.material.icons.filled.Support
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.CommonConceptsInfo
import com.weldsuite.weldchat.MemberActivityEntry
import com.weldsuite.weldchat.MemberLogic
import com.weldsuite.weldchat.MemberProfileInfo
import com.weldsuite.weldchat.ProfileField
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.LocalNotify
import com.weldsuite.weldchat.ui.copyText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.weldsuite.core.R as CoreR

// MARK: Overview

/**
 * The member's Overview: one column of property rows (editable for
 * yourself or as an admin, per `canEdit`), then working hours, links and
 * your private note about this person.
 */
@Composable
fun MemberOverviewTab(store: ChatStore, profile: MemberProfileInfo, onProfile: (MemberProfileInfo) -> Unit) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val saveFailed = stringResource(R.string.weldchat_member_profile_save_failed)
    val emailCopied = stringResource(R.string.weldchat_member_email_copied)
    // The timezone line's clock.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = Instant.now()
        }
    }

    fun save(field: ProfileField, value: String) {
        if (!profile.canEdit) return
        val userId = profile.userId
        store.env.scope.launch {
            try {
                onProfile(store.repository.updateProfile(userId, field, value))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(saveFailed)
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
        Column {
            EditableRow(Icons.Filled.Work, stringResource(R.string.weldchat_member_fields_title), profile.title, profile.canEdit) { save(ProfileField.TITLE, it) }
            EditableRow(Icons.AutoMirrored.Filled.Notes, stringResource(R.string.weldchat_member_fields_bio), profile.bio, profile.canEdit, multiline = true) {
                save(ProfileField.BIO, it)
            }
            MemberPropertyRow(Icons.Filled.Email, stringResource(R.string.weldchat_member_fields_email), profile.email) { email ->
                LinkValue(
                    email,
                    onClick = { openLink(context, "mailto:$email") },
                    onLongClick = {
                        copyText(context, email)
                        notify(emailCopied)
                    },
                )
            }
            EditableRow(
                Icons.Filled.Phone,
                stringResource(R.string.weldchat_member_fields_phone),
                profile.phone,
                profile.canEdit,
                keyboardType = KeyboardType.Phone,
                render = { phone -> LinkValue(phone, onClick = { openLink(context, "tel:" + phone.filter { it.isDigit() || it == '+' }) }) },
            ) { save(ProfileField.PHONE, it) }
            EditableRow(Icons.Filled.Place, stringResource(R.string.weldchat_member_fields_location), profile.location, profile.canEdit) {
                save(ProfileField.LOCATION, it)
            }
            EditableRow(Icons.Filled.SentimentSatisfied, stringResource(R.string.weldchat_member_fields_pronouns), profile.pronouns, profile.canEdit) {
                save(ProfileField.PRONOUNS, it)
            }
            EditableRow(
                Icons.Filled.Schedule,
                stringResource(R.string.weldchat_member_fields_hours_per_week),
                profile.hoursPerWeek,
                profile.canEdit,
                keyboardType = KeyboardType.Decimal,
            ) { save(ProfileField.HOURS_PER_WEEK, it) }
            MemberPropertyRow(
                Icons.Filled.Shield,
                stringResource(R.string.weldchat_member_fields_role),
                profile.role.takeIf { it.isNotEmpty() }?.let { stringResource(MemberLogic.roleLabel(it)) },
            )
            MemberPropertyRow(Icons.Filled.Public, stringResource(R.string.weldchat_member_fields_timezone), profile.timezone) { zone ->
                Text(MemberScreenRules.zoneLine(zone, now), style = MaterialTheme.typography.bodyMedium)
            }
        }

        MemberScreenRules.schedule(profile.workingHours)?.let { week ->
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                SectionTitle(stringResource(R.string.weldchat_member_working_hours))
                week.forEach { (day, hours) ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(stringResource(MemberLogic.weekdayLabel(day)), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(110.dp))
                        Text(
                            MemberScreenRules.dayHours(hours) { it.resolve(context) },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (hours?.isOpen == true) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        if (profile.links.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                SectionTitle(stringResource(R.string.weldchat_member_links))
                profile.links.forEach { link ->
                    Row(
                        Modifier.clickable { openLink(context, link.url) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        Icon(Icons.Filled.Link, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        Text(link.label, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        MemberNoteView(store, profile.userId)
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
}

/** A value that opens something (mail, the phone); held, it can do something else (copy). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LinkValue(text: String, onClick: () -> Unit, onLongClick: (() -> Unit)? = null) {
    Text(
        text,
        color = MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick),
    )
}

/** A row that becomes a text field on tap when [editable]. */
@Composable
private fun EditableRow(
    icon: ImageVector,
    label: String,
    value: String?,
    editable: Boolean,
    multiline: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    render: (@Composable (String) -> Unit)? = null,
    onSave: (String) -> Unit,
) {
    MemberPropertyRow(icon, label, value, multiline, keyboardType, editable, onSave, render)
}

/**
 * One field of a member: the icon and label, the value beside it. Empty
 * values read "Set {label}…"; an editable row turns into a text field on
 * tap and saves when it loses focus (or on Done, when single-line).
 */
@Composable
fun MemberPropertyRow(
    icon: ImageVector,
    label: String,
    value: String?,
    multiline: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    editable: Boolean = false,
    onSave: ((String) -> Unit)? = null,
    render: (@Composable (String) -> Unit)? = null,
) {
    var editing by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var hadFocus by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    fun commit() {
        if (!editing) return
        editing = false
        hadFocus = false
        MemberScreenRules.commit(draft, value)?.let { onSave?.invoke(it) }
    }

    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = editable && !editing) {
                    draft = value.orEmpty()
                    editing = true
                }
                .padding(vertical = 10.dp),
            verticalAlignment = if (editing) Alignment.CenterVertically else Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Row(Modifier.width(130.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.weight(1f)) {
                when {
                    editing -> {
                        TextField(
                            value = draft,
                            onValueChange = { draft = it },
                            singleLine = !multiline,
                            maxLines = if (multiline) 8 else 1,
                            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = if (multiline) ImeAction.Default else ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = { commit() }),
                            modifier = Modifier
                                .fillMaxWidth()
                                .focusRequester(focus)
                                .onFocusChanged { state ->
                                    if (state.isFocused) hadFocus = true else if (hadFocus) commit()
                                }
                                .tagged("member-field-input"),
                        )
                        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                    }
                    !value.isNullOrEmpty() -> if (render != null) render(value) else Text(value, style = MaterialTheme.typography.bodyMedium)
                    else -> Text(
                        stringResource(R.string.weldchat_member_set_field, label),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                }
            }
        }
        HorizontalDivider()
    }
}

/**
 * Your own note about this person, saved 600 ms after you stop typing. It
 * is only editable once it loaded, so a failed load can never be saved over;
 * what is left unsaved goes out as the screen closes.
 */
@Composable
fun MemberNoteView(store: ChatStore, userId: String) {
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val saveFailed = stringResource(R.string.weldchat_member_note_save_failed)
    var draft by remember(userId) { mutableStateOf("") }
    var saved by remember(userId) { mutableStateOf("") }
    var loaded by remember(userId) { mutableStateOf(false) }
    var loadFailed by remember(userId) { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var pendingSave by remember { mutableStateOf<Job?>(null) }

    suspend fun load() {
        loaded = false
        loadFailed = false
        try {
            val note = store.repository.memberNote(userId)
            saved = note
            draft = note
            loaded = true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            loadFailed = true
        }
    }

    LaunchedEffect(userId) { load() }

    fun changed(text: String) {
        if (!loaded) return
        val next = text.take(MemberScreenRules.NOTE_LIMIT)
        draft = next
        if (next == saved) return
        pendingSave?.cancel()
        pendingSave = scope.launch {
            delay(MemberScreenRules.NOTE_SAVE_DELAY_MS)
            try {
                store.repository.saveMemberNote(userId, next)
                saved = next
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(saveFailed)
            }
        }
    }

    // The last words, when the screen closes before the pause ran out.
    val latestDraft by rememberUpdatedState(draft)
    val latestSaved by rememberUpdatedState(saved)
    val latestLoaded by rememberUpdatedState(loaded)
    DisposableEffect(userId) {
        onDispose {
            pendingSave?.cancel()
            if (latestLoaded && latestDraft != latestSaved) {
                val text = latestDraft
                store.env.scope.launch { quietly { store.repository.saveMemberNote(userId, text) } }
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        SectionTitle(stringResource(R.string.weldchat_member_private_notes))
        if (loadFailed) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.weldchat_member_note_load_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { scope.launch { load() } }) { Text(stringResource(CoreR.string.core_common_try_again)) }
            }
        } else {
            OutlinedTextField(
                value = draft,
                onValueChange = { changed(it) },
                enabled = loaded,
                placeholder = { Text(stringResource(R.string.weldchat_member_note_placeholder)) },
                minLines = 4,
                maxLines = 12,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { focused = it.isFocused }
                    .tagged("member-note"),
            )
            if (focused) {
                Text(
                    stringResource(R.string.weldchat_member_note_length, draft.length.toString(), MemberScreenRules.NOTE_LIMIT.toString()),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        }
    }
}

// MARK: Common

/** What you and this person share: conversations, projects, tasks, CRM opportunities and helpdesk tickets. */
@Composable
fun MemberCommonTab(store: ChatStore, userId: String, nav: ChatNavigator) {
    var info by remember(userId) { mutableStateOf<CommonConceptsInfo?>(null) }
    var failed by remember(userId) { mutableStateOf(false) }

    LaunchedEffect(userId) {
        failed = false
        val loaded = quietly { store.repository.memberCommon(userId) }
        if (loaded != null) info = loaded else if (info == null) failed = true
    }

    val current = info
    when {
        current != null && MemberScreenRules.commonCount(current) == 0 -> EmptyState(
            stringResource(R.string.weldchat_member_common_empty_title),
            stringResource(R.string.weldchat_member_common_empty_description),
            icon = { Icon(Icons.Filled.Group, contentDescription = null, modifier = Modifier.size(40.dp)) },
        )
        current != null -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
            CommonSection(stringResource(R.string.weldchat_member_common_channels), current.channels.size) {
                current.channels.forEach { channel ->
                    CommonRow(
                        icon = when (channel.type) {
                            "dm" -> Icons.AutoMirrored.Filled.Chat
                            "private" -> Icons.Filled.Lock
                            else -> Icons.Filled.Tag
                        },
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        label = MemberScreenRules.commonChannelLabel(channel),
                        hint = androidx.compose.ui.res.pluralStringResource(R.plurals.weldchat_member_common_member_count, channel.memberCount, channel.memberCount),
                        onClick = { nav.openConversation(channel.id, channel.name, channel.type) },
                    )
                }
            }
            CommonSection(stringResource(R.string.weldchat_member_common_projects), current.projects.size) {
                current.projects.forEach { project ->
                    CommonRow(Icons.Filled.Folder, Color(0xFF3B82F6), project.name, project.status?.let { MemberScreenRules.capitalizeWords(it) })
                }
            }
            CommonSection(stringResource(R.string.weldchat_member_common_tasks), current.tasks.size) {
                current.tasks.forEach { task ->
                    CommonRow(Icons.Filled.CheckBox, Color(0xFFD97706), task.title, MemberScreenRules.capitalizeWords(MemberScreenRules.taskHint(task).text()))
                }
            }
            CommonSection(stringResource(R.string.weldchat_member_common_crm), current.crm.size) {
                current.crm.forEach { record ->
                    CommonRow(Icons.Filled.Work, Color(0xFF059669), record.name, MemberScreenRules.capitalizeWords(record.status ?: record.kind))
                }
            }
            CommonSection(stringResource(R.string.weldchat_member_common_helpdesk), current.helpdesk.size) {
                current.helpdesk.forEach { ticket ->
                    CommonRow(Icons.Filled.Support, Color(0xFFE11D48), ticket.subject, MemberScreenRules.capitalizeWords(ticket.status))
                }
            }
        }
        failed -> EmptyState(
            stringResource(R.string.weldchat_member_common_load_failed_title),
            stringResource(R.string.weldchat_member_common_load_failed_description),
            icon = { Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(40.dp)) },
        )
        else -> Spinner()
    }
}

@Composable
private fun CommonSection(title: String, count: Int, content: @Composable () -> Unit) {
    if (count <= 0) return
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SectionTitle(title)
            Text(
                count.toString(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
        content()
    }
}

@Composable
private fun CommonRow(icon: ImageVector, tint: Color, label: String, hint: String?, onClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Box(Modifier.size(28.dp).background(tint.copy(alpha = 0.15f), RoundedCornerShape(Tokens.Radius.small)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!hint.isNullOrEmpty()) {
                Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

// MARK: Activity

/** The member's timeline: per day, what they did ("Ann created 4 × Project") with the time, and a card per named record. */
@Composable
fun MemberActivityTab(store: ChatStore, userId: String, memberName: String?) {
    var days by remember(userId) { mutableStateOf<List<MemberLogic.Day>?>(null) }
    var failed by remember(userId) { mutableStateOf(false) }

    LaunchedEffect(userId) {
        failed = false
        val entries: List<MemberActivityEntry>? = quietly { store.repository.memberActivity(userId) }
        if (entries != null) days = MemberLogic.timeline(entries) else if (days == null) failed = true
    }

    val current = days
    when {
        current != null && current.isEmpty() -> EmptyState(
            stringResource(R.string.weldchat_member_activity_empty_title),
            stringResource(R.string.weldchat_member_activity_empty_description),
            icon = { Icon(Icons.Filled.MonitorHeart, contentDescription = null, modifier = Modifier.size(40.dp)) },
        )
        current != null -> {
            val today = LocalDate.now()
            val now = Instant.now()
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l), modifier = Modifier.tagged("member-activity")) {
                current.forEach { day ->
                    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                        Text(
                            MemberScreenRules.dayLabel(day.date, today).text(),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        day.events.forEach { event -> EventRow(event, memberName, now) }
                    }
                }
            }
        }
        failed -> EmptyState(
            stringResource(R.string.weldchat_member_activity_load_failed_title),
            stringResource(R.string.weldchat_member_activity_load_failed_description),
            icon = { Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(40.dp)) },
        )
        else -> Spinner()
    }
}

@Composable
private fun EventRow(event: MemberLogic.TimelineEvent, memberName: String?, now: Instant) {
    val icon = entityIcon(MemberScreenRules.entityIcon(event.entityType))
    val action = MemberLogic.actionLabel(event.action).text().lowercase()
    val sentence = MemberScreenRules.sentence(event, memberName, action).text()
    val repeats = MemberScreenRules.eventRepeats(event)
    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        Box(Modifier.size(24.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    if (repeats != null) "$sentence  ×$repeats" else sentence,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                WeldDate.parse(event.latest.createdAt)?.let { instant ->
                    Text(
                        MemberScreenRules.eventTime(instant, now, ZoneId.systemDefault()).text(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Tokens.Spacing.s),
                    )
                }
            }
            MemberScreenRules.cards(event).forEach { card ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.small))
                        .padding(Tokens.Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                    Text(card.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    MemberScreenRules.cardCount(card)?.let { count ->
                        Text(
                            "×$count",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(50))
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Spinner() {
    Box(Modifier.fillMaxWidth().padding(top = Tokens.Spacing.l), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

private fun entityIcon(icon: EntityIcon): ImageVector = when (icon) {
    EntityIcon.TASK -> Icons.Filled.CheckBox
    EntityIcon.TAG -> Icons.Filled.LocalOffer
    EntityIcon.PERSON -> Icons.Filled.Person
    EntityIcon.COMPANY -> Icons.Filled.Business
    EntityIcon.DEAL -> Icons.Filled.Work
    EntityIcon.TICKET -> Icons.Filled.ConfirmationNumber
    EntityIcon.EMAIL -> Icons.Filled.Email
    EntityIcon.CALENDAR -> Icons.Filled.CalendarMonth
    EntityIcon.DOCUMENT -> Icons.Filled.Description
    EntityIcon.ORDER -> Icons.Filled.ShoppingCart
    EntityIcon.PRODUCT -> Icons.Filled.Inventory2
    EntityIcon.FOLDER -> Icons.Filled.Folder
    EntityIcon.OTHER -> Icons.Filled.Category
}
