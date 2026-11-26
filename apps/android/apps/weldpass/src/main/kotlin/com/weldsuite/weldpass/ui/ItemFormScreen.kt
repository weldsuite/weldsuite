package com.weldsuite.weldpass.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.ItemFormValues
import com.weldsuite.weldpass.PassForms
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.Strength
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** "What do you want to add?": a login, a secure note or a card. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewItemSheet(onDismiss: () -> Unit, onChoose: (Item.Type) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            stringResource(R.string.weldpass_items_choose_type),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        )
        listOf(Item.Type.LOGIN, Item.Type.NOTE, Item.Type.CARD).forEach { type ->
            ListItem(
                headlineContent = { Text(stringResource(typeLabel(type))) },
                leadingContent = { ItemIcon(type, size = 36.dp) },
                modifier = Modifier.clickable { onChoose(type) }.tagged("new-${type.value}"),
            )
        }
        Column(Modifier.height(Tokens.Spacing.xl)) {}
    }
}

/**
 * The item form, for a new item ([itemId] null) and for an edit. Editing
 * starts with a reveal, which asks for biometrics and is audited, to fill in
 * the secret fields; saving sends the whole item.
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
        itemId != null -> stringResource(R.string.weldpass_form_edit_title)
        draft != null -> stringResource(R.string.weldpass_form_from_autofill)
        type == Item.Type.NOTE -> stringResource(R.string.weldpass_form_new_title_note)
        type == Item.Type.CARD -> stringResource(R.string.weldpass_form_new_title_card)
        else -> stringResource(R.string.weldpass_form_new_title_login)
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(title) }, navigationIcon = { BackButton(onDone) }) },
    ) { padding ->
        val current = values
        when {
            failed != null -> EmptyState(stringResource(failed!!), modifier = Modifier.padding(padding))
            current == null -> CenteredProgress(Modifier.padding(padding))
            else -> ItemForm(
                initial = current,
                vaults = if (itemId == null) writable else emptyList(),
                saving = saving,
                modifier = Modifier.padding(padding),
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
    vaults: List<org.weldsuite.api.weldpass.models.Vault>,
    saving: Boolean,
    modifier: Modifier,
    onSubmit: (ItemFormValues) -> Unit,
) {
    var values by remember { mutableStateOf(initial) }
    var appsText by rememberSaveable { mutableStateOf(initial.apps.joinToString("\n")) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
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

    Column(
        modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        if (vaults.size > 1) {
            Text(stringResource(R.string.weldpass_form_vault), style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                vaults.forEach { vault ->
                    FilterChip(
                        selected = vault.id == values.vaultId,
                        onClick = { values = values.copy(vaultId = vault.id) },
                        label = { Text(vaultLabel(vault)) },
                    )
                }
            }
        }
        Field(
            label = R.string.weldpass_form_title,
            value = values.title,
            onChange = { values = values.copy(title = it) },
            placeholder = R.string.weldpass_form_title_placeholder,
            error = titleError,
            tag = "form-title",
        )
        when (values.type) {
            Item.Type.NOTE -> Field(
                label = R.string.weldpass_form_content,
                value = values.content,
                onChange = { values = values.copy(content = it) },
                multiline = true,
                tag = "form-content",
            )
            Item.Type.CARD -> {
                Field(R.string.weldpass_form_cardholder, values.cardholder, { values = values.copy(cardholder = it) })
                Field(
                    R.string.weldpass_form_number,
                    values.number,
                    { values = values.copy(number = it) },
                    keyboard = KeyboardType.Number,
                )
                Field(R.string.weldpass_form_expiry, values.expiry, { values = values.copy(expiry = it) })
                Field(R.string.weldpass_form_cvc, values.cvc, { values = values.copy(cvc = it) }, keyboard = KeyboardType.Number)
                Field(R.string.weldpass_form_notes, values.notes, { values = values.copy(notes = it) }, multiline = true)
            }
            else -> {
                Field(
                    R.string.weldpass_form_url,
                    values.url,
                    { values = values.copy(url = it) },
                    placeholder = R.string.weldpass_form_url_placeholder,
                    keyboard = KeyboardType.Uri,
                    tag = "form-url",
                )
                Field(
                    R.string.weldpass_form_username,
                    values.username,
                    { values = values.copy(username = it) },
                    keyboard = KeyboardType.Email,
                    tag = "form-username",
                )
                OutlinedTextField(
                    value = values.password,
                    onValueChange = { values = values.copy(password = it) },
                    label = { Text(stringResource(R.string.weldpass_form_password)) },
                    singleLine = true,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = stringResource(
                                    if (showPassword) R.string.weldpass_item_hide else R.string.weldpass_item_show,
                                ),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth().tagged("form-password"),
                )
                StrengthMeter(values.password)
                OutlinedButton(
                    onClick = {
                        values = values.copy(password = PassForms.generatePassword())
                        showPassword = true
                    },
                    modifier = Modifier.tagged("form-generate"),
                ) {
                    Icon(Icons.Outlined.AutoFixHigh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.weldpass_form_generate), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
                Field(
                    R.string.weldpass_form_totp,
                    values.totp,
                    { values = values.copy(totp = it) },
                    secret = true,
                    help = R.string.weldpass_form_totp_help,
                )
                Field(R.string.weldpass_form_notes, values.notes, { values = values.copy(notes = it) }, multiline = true)
                OutlinedTextField(
                    value = appsText,
                    onValueChange = { appsText = it },
                    label = { Text(stringResource(R.string.weldpass_form_apps)) },
                    isError = appsError != null,
                    supportingText = { Text(appsError ?: stringResource(R.string.weldpass_form_apps_help)) },
                    minLines = 2,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        Button(
            onClick = submit,
            enabled = !saving,
            modifier = Modifier.fillMaxWidth().padding(top = Tokens.Spacing.s).tagged("form-save"),
        ) {
            Text(stringResource(if (saving) R.string.weldpass_common_saving else R.string.weldpass_common_save))
        }
    }
}

@Composable
private fun Field(
    label: Int,
    value: String,
    onChange: (String) -> Unit,
    placeholder: Int? = null,
    error: String? = null,
    help: Int? = null,
    multiline: Boolean = false,
    secret: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    tag: String? = null,
) {
    val supporting = error ?: help?.let { stringResource(it) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(stringResource(label)) },
        placeholder = placeholder?.let { { Text(stringResource(it)) } },
        isError = error != null,
        supportingText = supporting?.let { { Text(it) } },
        singleLine = !multiline,
        minLines = if (multiline) 3 else 1,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (secret) KeyboardType.Password else keyboard,
            autoCorrectEnabled = !secret && keyboard == KeyboardType.Text,
        ),
        modifier = Modifier.fillMaxWidth().tagged(tag),
    )
}

/** How strong a password is: a bar and a word, the platform's thresholds. */
@Composable
fun StrengthMeter(password: String) {
    if (password.isEmpty()) return
    val strength = PassForms.strength(password)
    val bits = PassForms.entropyBits(password).toInt()
    val (color, label, fraction) = when (strength) {
        Strength.WEAK -> Triple(Tokens.Status.danger.current(), R.string.weldpass_strength_weak, 0.33f)
        Strength.FAIR -> Triple(Tokens.Status.warning.current(), R.string.weldpass_strength_fair, 0.66f)
        Strength.STRONG -> Triple(Tokens.Status.success.current(), R.string.weldpass_strength_strong, 1f)
    }
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
        LinearProgressIndicator(progress = { fraction }, color = color, modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${stringResource(R.string.weldpass_strength_label)}: ${stringResource(label)}",
                style = MaterialTheme.typography.bodySmall,
                color = color,
                modifier = Modifier.weight(1f),
            )
            Text(
                stringResource(R.string.weldpass_strength_bits, bits),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
