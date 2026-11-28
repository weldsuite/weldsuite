package com.weldsuite.weldmail.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Comment
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.weldsuite.weldmail.ContactLogic
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.Person
import com.weldsuite.weldmail.R
import kotlinx.coroutines.launch
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** A contact card field: what it shows, and whether it can be changed here. */
private data class ContactField(val key: ContactLogic.Field, val label: Int, val icon: ImageVector, val editable: Boolean, val keyboard: KeyboardType)

private val FIELDS = listOf(
    ContactField(ContactLogic.Field.DOMAINS, R.string.weldmail_contact_domains, Icons.Outlined.Language, true, KeyboardType.Uri),
    ContactField(ContactLogic.Field.NAME, R.string.weldmail_contact_name, Icons.Outlined.Badge, true, KeyboardType.Text),
    ContactField(ContactLogic.Field.DESCRIPTION, R.string.weldmail_contact_description, Icons.AutoMirrored.Outlined.Notes, true, KeyboardType.Text),
    ContactField(ContactLogic.Field.TEAM, R.string.weldmail_contact_team, Icons.Outlined.Groups, true, KeyboardType.Text),
    ContactField(ContactLogic.Field.EMAIL, R.string.weldmail_contact_email, Icons.Outlined.Mail, true, KeyboardType.Email),
    ContactField(ContactLogic.Field.PHONE, R.string.weldmail_contact_phone, Icons.Outlined.Phone, true, KeyboardType.Phone),
    ContactField(ContactLogic.Field.ADDRESS, R.string.weldmail_contact_address, Icons.Outlined.Place, false, KeyboardType.Text),
)

/** The sender's contact card: a contact found by address (or a placeholder), its fields editable in place. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactScreen(store: MailStore, key: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var person by remember(key) { mutableStateOf<Person?>(null) }
    var loading by remember(key) { mutableStateOf(true) }
    var tab by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<ContactField?>(null) }
    var value by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var notAContact by remember { mutableStateOf(false) }

    LaunchedEffect(key) {
        loading = true
        person = try {
            if ('@' in key) {
                val found = runCatching { store.repository.people(key, limit = 20) }.getOrDefault(emptyList())
                ContactLogic.exactMatch(found, key) ?: ContactLogic.placeholder(key)
            } else {
                store.repository.person(key)
            }
        } catch (_: Exception) {
            null
        }
        loading = false
    }

    fun save() {
        val field = editing ?: return
        val contact = person ?: return
        val trimmed = value.trim()
        if (trimmed == ContactLogic.value(contact, field.key).orEmpty()) {
            editing = null
            return
        }
        if ('@' in contact.id) {
            editing = null
            notAContact = true
            return
        }
        saving = true
        scope.launch {
            try {
                val change = ContactLogic.change(field.key, trimmed)
                person = store.repository.updatePerson(
                    contact.id,
                    firstName = change.firstName,
                    lastName = change.lastName,
                    email = change.email,
                    phone = change.phone,
                    notes = change.notes,
                    department = change.department,
                    linkedinUrl = change.linkedinUrl,
                )
                notify.show(context.getString(R.string.weldmail_contact_saved))
            } catch (_: Exception) {
                notify.show(context.getString(R.string.weldmail_contact_save_failed))
            } finally {
                saving = false
                editing = null
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(person?.let { ContactLogic.displayName(it) } ?: stringResource(R.string.weldmail_contact_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.tagged("contact-close")) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(CoreR.string.core_common_close))
                    }
                },
                actions = {
                    val email = person?.email?.takeIf { ContactLogic.isEmail(it) }
                    val phone = person?.phone?.let(ContactLogic::dialable)?.takeIf { it.isNotEmpty() }
                    IconButton(onClick = { email?.let { openExternal(context, "mailto:$it") } }, enabled = email != null) {
                        Icon(Icons.Outlined.Mail, contentDescription = stringResource(R.string.weldmail_contact_send_email))
                    }
                    IconButton(onClick = { phone?.let { openExternal(context, "tel:$it") } }, enabled = phone != null) {
                        Icon(Icons.Outlined.Phone, contentDescription = stringResource(R.string.weldmail_contact_call))
                    }
                },
            )
        },
    ) { padding ->
        val contact = person
        Column(Modifier.padding(padding).fillMaxSize()) {
            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                contact == null -> EmptyState(title = stringResource(R.string.weldmail_contact_not_found))
                else -> {
                    Row(Modifier.padding(Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
                        MailAvatar(ContactLogic.displayName(contact), size = 48.dp)
                        Column(Modifier.padding(start = Tokens.Spacing.m)) {
                            Text(ContactLogic.displayName(contact), style = MaterialTheme.typography.titleLarge)
                            contact.email?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                    PrimaryTabRow(selectedTabIndex = tab) {
                        Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.weldmail_contact_details)) }, modifier = Modifier.tagged("contact-details"))
                        Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.weldmail_contact_comments)) }, modifier = Modifier.tagged("contact-comments"))
                    }
                    if (tab == 0) {
                        Column(Modifier.verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                            Text(stringResource(R.string.weldmail_contact_record_details), style = MaterialTheme.typography.titleSmall)
                            FIELDS.forEach { field ->
                                val shown = ContactLogic.value(contact, field.key)
                                val fieldLabel = stringResource(field.label)
                                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                    Icon(field.icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                                    if (editing == field) {
                                        OutlinedTextField(
                                            value = value,
                                            onValueChange = { value = it },
                                            label = { Text(fieldLabel) },
                                            singleLine = field.key != ContactLogic.Field.DESCRIPTION,
                                            enabled = !saving,
                                            keyboardOptions = KeyboardOptions(keyboardType = field.keyboard, imeAction = ImeAction.Done),
                                            keyboardActions = KeyboardActions(onDone = { save() }),
                                            trailingIcon = { TextButton(onClick = { save() }, enabled = !saving) { Text(stringResource(CoreR.string.core_common_save)) } },
                                            modifier = Modifier.weight(1f).padding(start = Tokens.Spacing.m).tagged("contact-edit-${field.key.name.lowercase()}"),
                                        )
                                    } else {
                                        Column(
                                            Modifier
                                                .weight(1f)
                                                .padding(start = Tokens.Spacing.m, top = Tokens.Spacing.s, bottom = Tokens.Spacing.s)
                                                .clickable(enabled = field.editable || shown != null) {
                                                    when {
                                                        field.key == ContactLogic.Field.EMAIL && shown != null && ContactLogic.isEmail(shown) -> openExternal(context, "mailto:${shown.trim()}")
                                                        field.key == ContactLogic.Field.PHONE && shown != null -> openExternal(context, "tel:${ContactLogic.dialable(shown)}")
                                                        field.editable -> {
                                                            value = shown.orEmpty()
                                                            editing = field
                                                        }
                                                    }
                                                }
                                                .tagged("contact-field-${field.key.name.lowercase()}"),
                                        ) {
                                            Text(fieldLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            Text(
                                                shown ?: stringResource(R.string.weldmail_contact_set_field, fieldLabel),
                                                color = when {
                                                    shown == null -> MaterialTheme.colorScheme.onSurfaceVariant
                                                    field.key == ContactLogic.Field.EMAIL || field.key == ContactLogic.Field.PHONE -> MaterialTheme.colorScheme.primary
                                                    else -> MaterialTheme.colorScheme.onSurface
                                                },
                                                maxLines = if (field.key == ContactLogic.Field.DESCRIPTION) 3 else 1,
                                            )
                                        }
                                        if (field.editable && (field.key == ContactLogic.Field.EMAIL || field.key == ContactLogic.Field.PHONE) && shown != null) {
                                            TextButton(onClick = {
                                                value = shown
                                                editing = field
                                            }) { Text(stringResource(CoreR.string.core_common_edit)) }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        EmptyState(
                            title = stringResource(R.string.weldmail_contact_no_comments),
                            description = stringResource(R.string.weldmail_contact_no_comments_hint),
                            icon = { Icon(Icons.AutoMirrored.Outlined.Comment, contentDescription = null, modifier = Modifier.size(32.dp)) },
                        )
                    }
                }
            }
        }
    }

    if (notAContact) {
        AlertDialog(
            onDismissRequest = { notAContact = false },
            title = { Text(stringResource(R.string.weldmail_contact_not_contact_title)) },
            text = { Text(stringResource(R.string.weldmail_contact_not_contact)) },
            confirmButton = { TextButton(onClick = { notAContact = false }) { Text(stringResource(CoreR.string.core_common_done)) } },
        )
    }
}
