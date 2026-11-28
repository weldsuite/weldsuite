package com.weldsuite.weldpass.ui

import android.content.Intent
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.SensitiveClipboard
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.ItemFields
import org.weldsuite.api.weldpass.models.TotpCode
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** What a hidden secret shows, as on the platform. */
private const val MASK = "••••••••••••"

/**
 * One item, laid out as the platform's item dialog. What the list carried
 * (title, username, site) shows straight away; the secret fields stay masked
 * until the person reveals them, which asks for biometrics (or the passcode)
 * and is a request the server audits. Revealed fields live in this screen's
 * state only: hiding them drops them, and so does the app going to the
 * background.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemScreen(
    env: AppEnvironment,
    repository: PassRepository,
    vaultId: String,
    itemId: String,
    onBack: () -> Unit,
    onEdit: (vaultId: String, itemId: String) -> Unit,
) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val items by repository.items.collectAsStateWithLifecycle()
    val vaults by repository.vaults.collectAsStateWithLifecycle()
    val item = items.data?.firstOrNull { it.id == itemId }
    val vault = vaults.data?.firstOrNull { it.id == vaultId }
    val writable = PassLogic.canEditVault(vault)
    var confirmDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(item?.title.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    if (writable && item != null) {
                        IconButton(onClick = { onEdit(vaultId, itemId) }, modifier = Modifier.tagged("edit-item")) {
                            Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.weldpass_common_edit))
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (item == null) {
            if (!items.loading && !deleting) {
                EmptyMessage(
                    icon = Icons.Outlined.ErrorOutline,
                    title = stringResource(R.string.weldpass_item_not_found),
                    modifier = Modifier.padding(padding),
                )
            }
            return@Scaffold
        }
        ItemDetail(
            env = env,
            repository = repository,
            item = item,
            vaultName = vault?.let { vaultLabel(it) },
            canDelete = writable,
            deleting = deleting,
            onDelete = { confirmDelete = true },
            modifier = Modifier.padding(padding),
        )
    }

    if (confirmDelete && item != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.weldpass_item_delete_title, item.title)) },
            text = { Text(stringResource(R.string.weldpass_item_delete_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        deleting = true
                        scope.launch {
                            try {
                                repository.delete(vaultId, itemId)
                                notify(context.getString(R.string.weldpass_item_deleted))
                                onBack()
                            } catch (error: ApiException) {
                                notify(context.getString(passErrorMessage(error)))
                            } finally {
                                deleting = false
                            }
                        }
                    },
                    modifier = Modifier.tagged("confirm-delete"),
                ) { Text(stringResource(R.string.weldpass_common_delete), color = Tokens.Status.danger.current()) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text(stringResource(R.string.weldpass_common_cancel), color = MaterialTheme.colorScheme.onSurface)
                }
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemDetail(
    env: AppEnvironment,
    repository: PassRepository,
    item: Item,
    vaultName: String?,
    canDelete: Boolean,
    deleting: Boolean,
    onDelete: () -> Unit,
    modifier: Modifier,
) {
    val context = LocalContext.current
    val activity = LocalActivity.current as FragmentActivity
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var revealed by remember { mutableStateOf<ItemFields?>(null) }
    var revealing by remember { mutableStateOf(false) }
    val revealPrompt = stringResource(R.string.weldpass_lock_reveal_prompt)
    val copyPrompt = stringResource(R.string.weldpass_lock_copy_prompt)

    // Back from the background: everything hidden again.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) revealed = null
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    /** Reveal every field (after a confirmation), or hide them again and drop them. */
    val toggleReveal: () -> Unit = {
        if (revealed != null) {
            revealed = null
        } else {
            scope.launch {
                if (!env.lock.confirm(activity, revealPrompt)) return@launch
                revealing = true
                try {
                    revealed = repository.reveal(item.vaultId, item.id)
                } catch (error: ApiException) {
                    notify(context.getString(passErrorMessage(error)))
                } finally {
                    revealing = false
                }
            }
        }
    }

    /**
     * Copies a secret. Read from the revealed fields when they're on screen;
     * otherwise fetched, copied and dropped, so the field stays masked.
     */
    suspend fun copySecret(label: String, pick: (ItemFields) -> String?): Boolean {
        if (!env.lock.confirm(activity, copyPrompt)) return false
        val source = revealed ?: try {
            repository.reveal(item.vaultId, item.id)
        } catch (error: ApiException) {
            notify(context.getString(passErrorMessage(error)))
            return false
        }
        val value = pick(source)
        if (value.isNullOrEmpty()) return false
        SensitiveClipboard.copySecret(context, value)
        repository.recordCopy(item.vaultId, item.id)
        notify(context.getString(R.string.weldpass_item_copied_secret, label))
        return true
    }

    val revealButton: @Composable (String) -> Unit = { tag ->
        FieldIconButton(
            icon = if (revealed != null) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
            label = stringResource(if (revealed != null) R.string.weldpass_item_hide else R.string.weldpass_item_show),
            onClick = toggleReveal,
            enabled = !revealing,
            modifier = Modifier.tagged(tag),
        )
    }
    val fields = revealed
    val password = stringResource(R.string.weldpass_item_password)
    val number = stringResource(R.string.weldpass_item_number)
    val cvc = stringResource(R.string.weldpass_item_cvc)
    val content = stringResource(R.string.weldpass_item_content)

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.l)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
    ) {
        when (item.type) {
            Item.Type.LOGIN -> {
                val username = item.subtitle.orEmpty()
                ReadOnlyField(
                    label = stringResource(R.string.weldpass_item_username),
                    value = username,
                    modifier = Modifier.tagged("field-username"),
                    actions = if (username.isNotEmpty()) {
                        {
                            // The username is on the list already: no reveal needed.
                            val label = stringResource(R.string.weldpass_item_username)
                            CopyIconButton(stringResource(R.string.weldpass_item_copy_username), Modifier.tagged("field-username-copy")) {
                                SensitiveClipboard.copyPlain(context, username)
                                notify(context.getString(R.string.weldpass_item_copied, label))
                                true
                            }
                        }
                    } else {
                        null
                    },
                )
                ReadOnlyField(
                    label = password,
                    value = fields?.password ?: MASK,
                    monospace = true,
                    modifier = Modifier.tagged("field-password"),
                    actions = {
                        revealButton("field-password-toggle")
                        CopyIconButton(stringResource(R.string.weldpass_item_copy_password), Modifier.tagged("field-password-copy")) {
                            copySecret(password) { it.password }
                        }
                    },
                )
                val href = PassLogic.safeHref(item.url)
                if (href != null) {
                    ReadOnlyField(
                        label = stringResource(R.string.weldpass_item_website),
                        value = item.url.orEmpty(),
                        modifier = Modifier.tagged("field-website"),
                        actions = {
                            FieldIconButton(
                                Icons.AutoMirrored.Outlined.OpenInNew,
                                stringResource(R.string.weldpass_item_open_website),
                                onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, href.toUri())) },
                            )
                        },
                    )
                }
                if (item.hasTotp) {
                    LabeledField(stringResource(R.string.weldpass_item_totp), Modifier.tagged("field-totp")) {
                        TotpField(repository, item) { code ->
                            if (!env.lock.confirm(activity, copyPrompt)) return@TotpField false
                            SensitiveClipboard.copySecret(context, code)
                            notify(context.getString(R.string.weldpass_item_copied_secret, context.getString(R.string.weldpass_item_totp)))
                            true
                        }
                    }
                }
                NotesAndApps(fields)
            }
            Item.Type.NOTE -> ReadOnlyField(
                label = content,
                value = fields?.content ?: MASK,
                monospace = fields == null,
                multiline = fields != null,
                modifier = Modifier.tagged("field-content"),
                actions = {
                    revealButton("field-content-toggle")
                    CopyIconButton(stringResource(R.string.weldpass_common_copy), Modifier.tagged("field-content-copy")) {
                        copySecret(content) { it.content }
                    }
                },
            )
            Item.Type.CARD -> {
                ReadOnlyField(
                    label = number,
                    value = fields?.number ?: item.subtitle?.takeIf { it.isNotBlank() } ?: MASK,
                    monospace = true,
                    modifier = Modifier.tagged("field-number"),
                    actions = {
                        revealButton("field-number-toggle")
                        CopyIconButton(stringResource(R.string.weldpass_item_copy_number), Modifier.tagged("field-number-copy")) {
                            copySecret(number) { it.number }
                        }
                    },
                )
                ReadOnlyField(
                    label = stringResource(R.string.weldpass_item_cardholder),
                    value = fields?.cardholder ?: MASK,
                    monospace = fields == null,
                    modifier = Modifier.tagged("field-cardholder"),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
                    ReadOnlyField(
                        label = stringResource(R.string.weldpass_item_expiry),
                        value = fields?.expiry ?: MASK,
                        monospace = true,
                        modifier = Modifier.weight(1f).tagged("field-expiry"),
                    )
                    ReadOnlyField(
                        label = cvc,
                        value = fields?.cvc ?: MASK,
                        monospace = true,
                        modifier = Modifier.weight(1f).tagged("field-cvc"),
                        actions = {
                            CopyIconButton(stringResource(R.string.weldpass_item_copy_cvc), Modifier.tagged("field-cvc-copy")) {
                                copySecret(cvc) { it.cvc }
                            }
                        },
                    )
                }
                NotesAndApps(fields)
            }
        }

        // The platform's footer line: type, vault, when it changed and its version.
        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            val meta = MaterialTheme.typography.bodySmall
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                NeutralBadge(stringResource(typeLabel(item.type)))
                if (!vaultName.isNullOrEmpty()) {
                    Text(vaultName, style = meta, color = muted)
                    Text("·", style = meta, color = muted)
                }
                Text(
                    stringResource(R.string.weldpass_item_updated_meta, formatAgo(item.updatedAt), "${item.version}"),
                    style = meta,
                    color = muted,
                )
            }
            Text(stringResource(R.string.weldpass_item_audit_note), style = meta, color = muted)
        }

        if (canDelete) {
            TextButton(
                onClick = onDelete,
                enabled = !deleting,
                modifier = Modifier.tagged("delete-item"),
            ) { Text(stringResource(R.string.weldpass_common_delete), color = Tokens.Status.danger.current()) }
        }
    }
}

/** A revealed item's notes, and a login's Android apps, when there are any. */
@Composable
private fun NotesAndApps(fields: ItemFields?) {
    fields?.notes?.takeIf { it.isNotEmpty() }?.let { notes ->
        ReadOnlyField(stringResource(R.string.weldpass_item_notes), notes, multiline = true, modifier = Modifier.tagged("field-notes"))
    }
    fields?.apps?.takeIf { it.isNotEmpty() }?.let { apps ->
        ReadOnlyField(stringResource(R.string.weldpass_item_apps), apps.joinToString("\n"), multiline = true)
    }
}

/**
 * The current 2FA code, minted by the server (PASS-007: the seed stays in
 * the vault) and fetched only when asked for, as on the platform: every
 * fetch is written to the vault's trail, so there's no polling. The code
 * shows with a countdown, then hides; it's dropped when the app goes to the
 * background.
 */
@Composable
private fun TotpField(repository: PassRepository, item: Item, onCopy: suspend (String) -> Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf<TotpCode?>(null) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var loading by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val left = code?.let { PassLogic.secondsUntil(it.expiresAt, now) } ?: 0
    val current = code?.takeIf { left > 0 }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) code = null
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(code) {
        val shown = code ?: return@LaunchedEffect
        while (PassLogic.secondsUntil(shown.expiresAt) > 0) {
            delay(500)
            now = System.currentTimeMillis()
        }
        now = System.currentTimeMillis()
    }

    if (current != null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Text(
                PassLogic.formatTotpCode(current.code),
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                fontSize = 18.sp,
                letterSpacing = 2.sp,
            )
            Text(
                pluralStringResource(R.plurals.weldpass_item_totp_expires, left, left),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Box(
                Modifier.width(64.dp).height(4.dp).background(Tokens.Palette.muted.current(), CircleShape),
            ) {
                val period = current.period.coerceAtLeast(1)
                Box(
                    Modifier
                        .fillMaxHeight()
                        .fillMaxWidth((left.toFloat() / period).coerceIn(0f, 1f))
                        .background(MaterialTheme.colorScheme.primary, CircleShape),
                )
            }
            CopyIconButton(stringResource(R.string.weldpass_item_copy_code), Modifier.tagged("field-totp-copy")) { onCopy(current.code) }
        }
    } else {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = {
                    scope.launch {
                        failure = null
                        loading = true
                        try {
                            code = repository.totp(item.vaultId, item.id)
                            now = System.currentTimeMillis()
                        } catch (error: ApiException) {
                            code = null
                            failure = context.getString(
                                if (error.isNetwork) R.string.weldpass_item_totp_offline else R.string.weldpass_item_totp_failed,
                            )
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = !loading,
                contentPadding = PaddingValues(horizontal = Tokens.Spacing.m),
                modifier = Modifier.heightIn(min = 36.dp).tagged("show-totp"),
            ) {
                Icon(Icons.Outlined.VerifiedUser, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(stringResource(R.string.weldpass_item_show_code), modifier = Modifier.padding(start = 6.dp))
            }
            if (code != null) {
                Text(stringResource(R.string.weldpass_item_totp_expired), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            failure?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Tokens.Status.danger.current()) }
        }
    }
}
