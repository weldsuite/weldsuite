package com.weldsuite.weldpass.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.ItemFormValues
import com.weldsuite.weldpass.PassForms
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Button
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

private val ITEM_TYPES = listOf(Item.Type.LOGIN, Item.Type.NOTE, Item.Type.CARD)

/**
 * The item form, as the platform's "Add item" and "Edit" dialogs: a new item
 * ([itemId] null, the type picked in the form) or an edit. Editing starts
 * with a reveal, which asks for biometrics and is audited, to fill in the
 * secret fields; saving sends the whole item.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemFormScreen(
    env: AppEnvironment,
    repository: PassRepository,
    type: Item.Type,
    vaultId: String?,
    itemId: String?,
    onDone: () -> Unit,
    /** A new item's values to start from (a login autofill asked to save). */
    draft: ItemFormValues? = null,
) {
    val context = LocalContext.current
    val activity = LocalActivity.current as FragmentActivity
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val vaults by repository.vaults.collectAsStateWithLifecycle()
    val items by repository.items.collectAsStateWithLifecycle()
    val writable = vaults.data.orEmpty().filter(PassLogic::canEditVault)
    val editedItem = itemId?.let { id -> items.data?.firstOrNull { it.id == id } }
    var values by remember { mutableStateOf<ItemFormValues?>(null) }
    var failed by remember { mutableStateOf<Int?>(null) }
    var saving by remember { mutableStateOf(false) }
    val editPrompt = stringResource(R.string.weldpass_lock_edit_prompt)

    LaunchedEffect(itemId, vaults.data) {
        if (values != null) return@LaunchedEffect
        if (itemId == null) {
            val target = PassLogic.defaultCreateVaultId(vaults.data.orEmpty(), vaultId)
            if (vaults.data != null) {
                values = target?.let { draft?.copy(vaultId = it) ?: ItemFormValues(type = type, vaultId = it) }
                if (target == null) failed = R.string.weldpass_form_no_writable_vault
            }
            return@LaunchedEffect
        }
        val item = items.data?.firstOrNull { it.id == itemId } ?: return@LaunchedEffect
        if (!env.lock.confirm(activity, editPrompt)) {
            onDone()
            return@LaunchedEffect
        }
        values = try {
            PassForms.fromItem(item, repository.reveal(item.vaultId, item.id))
        } catch (error: ApiException) {
            failed = passErrorMessage(error)
            null
        }
    }

    val title = when {
        itemId != null -> stringResource(R.string.weldpass_form_edit_title, editedItem?.title.orEmpty())
        draft != null -> stringResource(R.string.weldpass_form_from_autofill)
        else -> stringResource(R.string.weldpass_form_add_title)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onDone) },
            )
        },
    ) { padding ->
        val current = values
        when {
            failed != null -> EmptyMessage(
                icon = Icons.Outlined.ErrorOutline,
                title = stringResource(failed!!),
                modifier = Modifier.padding(padding),
            )
            current == null -> CenteredProgress(Modifier.padding(padding))
            else -> ItemForm(
                initial = current,
                editing = itemId != null,
                vaults = if (itemId == null) writable else emptyList(),
                saving = saving,
                modifier = Modifier.padding(padding),
                onCancel = onDone,
                onSubmit = { submitted ->
                    saving = true
                    scope.launch {
                        try {
                            val input = PassForms.toInput(submitted)
                            if (itemId == null) {
                                repository.create(submitted.vaultId, input)
                                notify(context.getString(R.string.weldpass_form_created))
                            } else {
                                repository.update(submitted.vaultId, itemId, input)
                                notify(context.getString(R.string.weldpass_form_saved))
                            }
                            onDone()
                        } catch (error: ApiException) {
                            notify(context.getString(passErrorMessage(error)))
                        } finally {
                            saving = false
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun ItemForm(
    initial: ItemFormValues,
    editing: Boolean,
    vaults: List<Vault>,
    saving: Boolean,
    modifier: Modifier,
    onCancel: () -> Unit,
    onSubmit: (ItemFormValues) -> Unit,
) {
    var values by remember { mutableStateOf(initial) }
    var appsText by rememberSaveable { mutableStateOf(initial.apps.joinToString("\n")) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var generating by remember { mutableStateOf(false) }
    var titleError by remember { mutableStateOf<String?>(null) }
    var appsError by remember { mutableStateOf<String?>(null) }
    val titleRequired = stringResource(R.string.weldpass_form_title_required)
    val context = LocalContext.current

    val submit = {
        val apps = if (values.type == Item.Type.LOGIN) PassForms.parseAppList(appsText) else emptyList()
        val wrongApps = PassForms.invalidApps(apps)
        titleError = if (values.title.isBlank()) titleRequired else null
        appsError = if (wrongApps.isEmpty()) {
            null
        } else {
            context.getString(R.string.weldpass_form_apps_invalid, wrongApps.joinToString(", "))
        }
        if (titleError == null && appsError == null) onSubmit(values.copy(apps = apps))
    }
    val plain = KeyboardOptions(autoCorrectEnabled = false)
    val secret = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)

    Column(
        modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
    ) {
        Text(
            stringResource(if (editing) R.string.weldpass_form_edit_description else R.string.weldpass_form_add_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (editing) {
            // The type is fixed once the item exists.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                StatusBadge(stringResource(typeLabel(values.type)), MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    stringResource(R.string.weldpass_form_type_locked),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LabeledField(stringResource(R.string.weldpass_form_type)) {
                TypePicker(values.type) { values = values.copy(type = it) }
            }
        }

        if (!editing && vaults.isNotEmpty()) {
            val selected = vaults.firstOrNull { it.id == values.vaultId }
            LabeledField(
                stringResource(R.string.weldpass_form_vault),
                hint = if (selected?.kind == Vault.Kind.SHARED) stringResource(R.string.weldpass_form_shared_vault_hint) else null,
            ) {
                VaultSelect(vaults, values.vaultId) { values = values.copy(vaultId = it) }
            }
        }

        LabeledField(stringResource(R.string.weldpass_form_title), error = titleError) {
            PlatformTextField(
                values.title,
                { values = values.copy(title = it) },
                isError = titleError != null,
                modifier = Modifier.tagged("form-title"),
            )
        }

        when (values.type) {
            Item.Type.LOGIN -> {
                LabeledField(stringResource(R.string.weldpass_form_url)) {
                    PlatformTextField(
                        values.url,
                        { values = values.copy(url = it) },
                        placeholder = stringResource(R.string.weldpass_form_url_placeholder),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier.tagged("form-url"),
                    )
                }
                LabeledField(stringResource(R.string.weldpass_form_username)) {
                    PlatformTextField(
                        values.username,
                        { values = values.copy(username = it) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                        modifier = Modifier.tagged("form-username"),
                    )
                }
                LabeledField(stringResource(R.string.weldpass_form_password)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        PlatformTextField(
                            values.password,
                            { values = values.copy(password = it) },
                            monospace = true,
                            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                            keyboardOptions = secret,
                            modifier = Modifier.weight(1f).tagged("form-password"),
                        )
                        OutlinedButton(
                            onClick = { showPassword = !showPassword },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                            modifier = Modifier.size(40.dp).tagged("form-password-toggle"),
                        ) {
                            Icon(
                                if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = stringResource(if (showPassword) R.string.weldpass_item_hide else R.string.weldpass_item_show),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                        OutlinedButton(
                            onClick = { generating = !generating },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Tokens.Spacing.m),
                            modifier = Modifier.heightIn(min = 40.dp).tagged("form-generate"),
                        ) {
                            Icon(Icons.Outlined.AutoFixHigh, contentDescription = null, modifier = Modifier.size(16.dp))
                            Text(stringResource(R.string.weldpass_form_generate), modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                    StrengthMeter(values.password)
                }
                if (generating) {
                    GeneratorPanel(
                        onCancel = { generating = false },
                        onUse = { generated ->
                            values = values.copy(password = generated)
                            showPassword = true
                            generating = false
                        },
                    )
                }
                LabeledField(stringResource(R.string.weldpass_form_totp), hint = stringResource(R.string.weldpass_form_totp_help)) {
                    PlatformTextField(
                        values.totp,
                        { values = values.copy(totp = it) },
                        placeholder = stringResource(R.string.weldpass_form_totp_placeholder),
                        monospace = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = secret,
                        modifier = Modifier.tagged("form-totp"),
                    )
                }
                NotesField(values.notes) { values = values.copy(notes = it) }
                LabeledField(
                    stringResource(R.string.weldpass_form_apps),
                    hint = stringResource(R.string.weldpass_form_apps_help),
                    error = appsError,
                ) {
                    PlatformTextField(
                        appsText,
                        { appsText = it },
                        singleLine = false,
                        minLines = 2,
                        isError = appsError != null,
                        keyboardOptions = plain,
                        modifier = Modifier.tagged("form-apps"),
                    )
                }
            }
            Item.Type.NOTE -> LabeledField(stringResource(R.string.weldpass_form_content)) {
                PlatformTextField(
                    values.content,
                    { values = values.copy(content = it) },
                    singleLine = false,
                    minLines = 8,
                    modifier = Modifier.tagged("form-content"),
                )
            }
            Item.Type.CARD -> {
                LabeledField(stringResource(R.string.weldpass_form_cardholder)) {
                    PlatformTextField(values.cardholder, { values = values.copy(cardholder = it) }, keyboardOptions = plain)
                }
                LabeledField(stringResource(R.string.weldpass_form_number)) {
                    PlatformTextField(
                        values.number,
                        { values = values.copy(number = it) },
                        monospace = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, autoCorrectEnabled = false),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                    LabeledField(stringResource(R.string.weldpass_form_expiry), Modifier.weight(1f)) {
                        PlatformTextField(
                            values.expiry,
                            { values = values.copy(expiry = it) },
                            placeholder = stringResource(R.string.weldpass_form_expiry_placeholder),
                            monospace = true,
                            keyboardOptions = plain,
                        )
                    }
                    LabeledField(stringResource(R.string.weldpass_form_cvc), Modifier.weight(1f)) {
                        PlatformTextField(
                            values.cvc,
                            { values = values.copy(cvc = it) },
                            monospace = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, autoCorrectEnabled = false),
                        )
                    }
                }
                NotesField(values.notes) { values = values.copy(notes = it) }
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, Alignment.End)) {
            OutlinedButton(onClick = onCancel, enabled = !saving) { Text(stringResource(R.string.weldpass_common_cancel)) }
            Button(onClick = submit, enabled = !saving, modifier = Modifier.tagged("form-save")) {
                Text(stringResource(if (saving) R.string.weldpass_common_saving else R.string.weldpass_common_save))
            }
        }
    }
}

@Composable
private fun NotesField(notes: String, onChange: (String) -> Unit) {
    LabeledField(stringResource(R.string.weldpass_form_notes)) {
        PlatformTextField(notes, onChange, singleLine = false, minLines = 3, modifier = Modifier.tagged("form-notes"))
    }
}

/**
 * Login, secure note or card, as the platform's three bordered choices: the
 * chosen one outlined in the primary colour on a light wash of it.
 */
@Composable
private fun TypePicker(selected: Item.Type, onSelect: (Item.Type) -> Unit) {
    Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        ITEM_TYPES.forEach { type ->
            val chosen = type == selected
            val primary = MaterialTheme.colorScheme.primary
            val shape = MaterialTheme.shapes.small
            Column(
                Modifier
                    .weight(1f)
                    .heightIn(min = 56.dp)
                    .background(if (chosen) primary.copy(alpha = 0.05f) else MaterialTheme.colorScheme.background, shape)
                    .border(1.dp, if (chosen) primary else MaterialTheme.colorScheme.outlineVariant, shape)
                    .selectable(selected = chosen, role = Role.RadioButton, onClick = { onSelect(type) })
                    .padding(horizontal = Tokens.Spacing.xs, vertical = Tokens.Spacing.s)
                    .tagged("new-${type.value}"),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs, Alignment.CenterVertically),
            ) {
                val tint = if (chosen) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
                TypeIcon(type, size = 16.dp, tint = tint)
                Text(
                    stringResource(typeLabel(type)),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (chosen) FontWeight.Medium else FontWeight.Normal,
                    color = tint,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The vault to add to, as the platform's select: the chosen vault and a chevron, opening a menu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultSelect(vaults: List<Vault>, selectedId: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val selected = vaults.firstOrNull { it.id == selectedId }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        Row(
            Modifier
                .fillMaxWidth()
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .heightIn(min = 40.dp)
                .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)
                .padding(horizontal = Tokens.Spacing.m)
                .tagged("form-vault"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                selected?.let { vaultLabel(it) }.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Outlined.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            vaults.forEach { vault ->
                DropdownMenuItem(
                    text = { Text(vaultLabel(vault), style = MaterialTheme.typography.bodyMedium) },
                    onClick = {
                        onSelect(vault.id)
                        open = false
                    },
                )
            }
        }
    }
}
