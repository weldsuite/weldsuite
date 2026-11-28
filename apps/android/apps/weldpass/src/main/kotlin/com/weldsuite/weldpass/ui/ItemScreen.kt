package com.weldsuite.weldpass.ui

import android.content.Intent
import androidx.core.net.toUri
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import org.weldsuite.ui.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.OutlinedButton
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** The secret fields of an item, by name. */
private enum class Secret { PASSWORD, NOTES, CONTENT, CARDHOLDER, NUMBER, EXPIRY, CVC }

private fun ItemFields.valueOf(secret: Secret): String? = when (secret) {
    Secret.PASSWORD -> password
    Secret.NOTES -> notes
    Secret.CONTENT -> content
    Secret.CARDHOLDER -> cardholder
    Secret.NUMBER -> number
    Secret.EXPIRY -> expiry
    Secret.CVC -> cvc
}

/**
 * One item. The list's metadata shows straight away; the secret fields stay
 * dots until the person reveals them, which asks for biometrics (or the
 * passcode) and is a request the server audits. Revealed fields live in this
 * screen's state only and are dropped when the app goes to the background.
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
                        IconButton(onClick = { confirmDelete = true }, enabled = !deleting, modifier = Modifier.tagged("delete-item")) {
                            Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.weldpass_common_delete))
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (item == null) {
            if (!items.loading && !deleting) {
                EmptyState(stringResource(R.string.weldpass_item_not_found), modifier = Modifier.padding(padding))
            }
            return@Scaffold
        }
        ItemDetail(
            env = env,
            repository = repository,
            item = item,
            vaultName = vault?.let { vaultLabel(it) },
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
                ) { Text(stringResource(R.string.weldpass_common_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.weldpass_common_cancel)) }
            },
        )
    }
}

@Composable
private fun ItemDetail(env: AppEnvironment, repository: PassRepository, item: Item, vaultName: String?, modifier: Modifier) {
    val context = LocalContext.current
    val activity = LocalActivity.current as FragmentActivity
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var fields by remember { mutableStateOf<ItemFields?>(null) }
    var shown by remember { mutableStateOf(emptySet<Secret>()) }
    var revealing by remember { mutableStateOf(false) }
    val revealPrompt = stringResource(R.string.weldpass_lock_reveal_prompt)
    val copyPrompt = stringResource(R.string.weldpass_lock_copy_prompt)

    // Back from the background: everything hidden again.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                fields = null
                shown = emptySet()
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    /** The item's fields, revealing them (after a confirmation) the first time. */
    suspend fun ensureFields(prompt: String): ItemFields? {
        fields?.let { return it }
        if (!env.lock.confirm(activity, prompt)) return null
        revealing = true
        return try {
            repository.reveal(item.vaultId, item.id).also { fields = it }
        } catch (error: ApiException) {
            notify(context.getString(passErrorMessage(error)))
            null
        } finally {
            revealing = false
        }
    }

    val toggle: (Secret) -> Unit = { secret ->
        if (secret in shown) {
            shown = shown - secret
        } else {
            scope.launch { if (ensureFields(revealPrompt) != null) shown = shown + secret }
        }
    }
    val copySecret: (String, Secret) -> Unit = { label, secret ->
        scope.launch {
            if (!env.lock.confirm(activity, copyPrompt)) return@launch
            val value = ensureFields(copyPrompt)?.valueOf(secret)
            if (value.isNullOrEmpty()) return@launch
            SensitiveClipboard.copySecret(context, value)
            repository.recordCopy(item.vaultId, item.id)
            notify(context.getString(R.string.weldpass_item_copied_secret, label))
        }
    }
    val copyPlain: (String, String) -> Unit = { label, value ->
        SensitiveClipboard.copyPlain(context, value)
        notify(context.getString(R.string.weldpass_item_copied, label))
    }
    val secretRow: @Composable (Secret, Int, Boolean, String) -> Unit = { secret, label, copyable, tag ->
        val labelText = stringResource(label)
        FieldRow(
            label = labelText,
            value = if (secret in shown) fields?.valueOf(secret) else null,
            secret = true,
            shown = secret in shown,
            monospace = secret == Secret.PASSWORD || secret == Secret.NUMBER,
            onToggle = { toggle(secret) },
            onCopy = if (copyable) ({ copySecret(labelText, secret) }) else null,
            tag = tag,
        )
    }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 48.dp)) {
        Row(
            Modifier.padding(horizontal = Tokens.Spacing.xl, vertical = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            ItemIcon(item.type, size = 56.dp)
            Column(Modifier.weight(1f)) {
                Text(item.title, style = MaterialTheme.typography.headlineSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(stringResource(typeLabel(item.type)), vaultName).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        FieldGroup {
            when (item.type) {
                Item.Type.LOGIN -> {
                    val username = stringResource(R.string.weldpass_item_username)
                    FieldRow(
                        label = username,
                        value = item.subtitle,
                        onCopy = item.subtitle?.takeIf { it.isNotEmpty() }?.let { { copyPlain(username, it) } },
                        tag = "field-username",
                    )
                    secretRow(Secret.PASSWORD, R.string.weldpass_item_password, true, "field-password")
                    item.url?.takeIf { it.isNotBlank() }?.let { url ->
                        val website = stringResource(R.string.weldpass_item_website)
                        val href = PassLogic.safeHref(url)
                        FieldRow(
                            label = website,
                            value = url,
                            onOpen = href?.let { { context.startActivity(Intent(Intent.ACTION_VIEW, it.toUri())) } },
                            onCopy = { copyPlain(website, url) },
                            tag = "field-website",
                        )
                    }
                    if (item.hasTotp) {
                        TotpRow(repository, item) { code ->
                            scope.launch {
                                if (!env.lock.confirm(activity, copyPrompt)) return@launch
                                SensitiveClipboard.copySecret(context, code)
                                notify(context.getString(R.string.weldpass_item_copied_secret, context.getString(R.string.weldpass_item_totp)))
                            }
                        }
                    }
                }
                Item.Type.CARD -> {
                    secretRow(Secret.CARDHOLDER, R.string.weldpass_item_cardholder, false, "field-cardholder")
                    secretRow(Secret.NUMBER, R.string.weldpass_item_number, true, "field-number")
                    secretRow(Secret.EXPIRY, R.string.weldpass_item_expiry, false, "field-expiry")
                    secretRow(Secret.CVC, R.string.weldpass_item_cvc, true, "field-cvc")
                }
                else -> secretRow(Secret.CONTENT, R.string.weldpass_item_content, true, "field-content")
            }
        }

        if (item.type != Item.Type.NOTE) {
            FieldGroup {
                secretRow(Secret.NOTES, R.string.weldpass_item_notes, false, "field-notes")
                fields?.apps?.takeIf { it.isNotEmpty() }?.let { apps ->
                    FieldRow(label = stringResource(R.string.weldpass_item_apps), value = apps.joinToString("\n"))
                }
            }
        }

        if (fields == null) {
            OutlinedButton(
                onClick = { scope.launch { if (ensureFields(revealPrompt) != null) shown = Secret.entries.toSet() } },
                enabled = !revealing,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).tagged("reveal-item"),
            ) { Text(stringResource(R.string.weldpass_item_reveal)) }
        }

        Text(
            stringResource(R.string.weldpass_item_updated, formatDate(item.updatedAt)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = Tokens.Spacing.l),
        )
    }
}

@Composable
private fun FieldGroup(content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        Column { content() }
    }
}

/** A labelled value, with copy, open and (for a secret) show/hide. A hidden secret shows as dots. */
@Composable
private fun FieldRow(
    label: String,
    value: String?,
    secret: Boolean = false,
    shown: Boolean = false,
    monospace: Boolean = false,
    onToggle: (() -> Unit)? = null,
    onCopy: (() -> Unit)? = null,
    onOpen: (() -> Unit)? = null,
    tag: String? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp).tagged(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val display = when {
                secret && !shown -> "••••••••"
                value.isNullOrEmpty() -> stringResource(R.string.weldpass_common_dash)
                else -> value
            }
            Text(
                display,
                style = MaterialTheme.typography.bodyLarge,
                fontFamily = if (monospace && shown) FontFamily.Monospace else null,
            )
        }
        if (secret && onToggle != null) {
            IconButton(onClick = onToggle) {
                Icon(
                    if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                    contentDescription = stringResource(if (shown) R.string.weldpass_item_hide else R.string.weldpass_item_show),
                )
            }
        }
        if (onOpen != null) {
            IconButton(onClick = onOpen) {
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = stringResource(R.string.weldpass_item_open_website))
            }
        }
        if (onCopy != null) {
            IconButton(onClick = onCopy) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = stringResource(R.string.weldpass_common_copy))
            }
        }
    }
    HorizontalDivider()
}

/**
 * The current 2FA code, minted by the server (PASS-007: the seed stays in
 * the vault), with its countdown. A new code is fetched when this one runs out.
 */
@Composable
private fun TotpRow(repository: PassRepository, item: Item, onCopy: (String) -> Unit) {
    var code by remember { mutableStateOf<TotpCode?>(null) }
    var offline by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val left = code?.let { PassLogic.secondsUntil(it.expiresAt, now) } ?: 0

    LaunchedEffect(item.id) {
        while (true) {
            now = System.currentTimeMillis()
            val current = code
            if (current == null || PassLogic.secondsUntil(current.expiresAt, now) == 0) {
                try {
                    code = repository.totp(item.vaultId, item.id)
                    offline = false
                } catch (error: ApiException) {
                    offline = error.isNetwork
                    delay(5_000)
                }
            }
            delay(1_000)
        }
    }

    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = code != null) { code?.let { onCopy(it.code) } }
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .tagged("field-totp"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.weldpass_item_totp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                code?.let { PassLogic.formatTotpCode(it.code) } ?: stringResource(R.string.weldpass_common_dash),
                fontSize = 26.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 2.sp,
            )
            when {
                code != null -> Text(
                    pluralStringResource(R.plurals.weldpass_item_totp_expires, left, left),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                offline -> Text(
                    stringResource(R.string.weldpass_item_totp_offline),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Icon(Icons.Outlined.ContentCopy, contentDescription = stringResource(R.string.weldpass_common_copy))
    }
}

private fun formatDate(iso: String): String =
    runCatching {
        DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
    }.getOrDefault(iso)
