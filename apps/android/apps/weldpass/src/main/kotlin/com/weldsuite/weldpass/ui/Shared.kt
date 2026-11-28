package com.weldsuite.weldpass.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.weldsuite.weldpass.R
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.tagged

/** What went wrong with a WeldPass request, in words the person can act on. */
@StringRes
fun passErrorMessage(error: Throwable?): Int {
    val api = error as? ApiException ?: return R.string.weldpass_errors_generic
    return when {
        api.isNetwork -> R.string.weldpass_errors_offline
        api.code == "CRYPTO_ERROR" -> R.string.weldpass_errors_crypto
        api.status == 403 -> R.string.weldpass_errors_forbidden
        api.status == 404 -> R.string.weldpass_errors_not_found
        else -> R.string.weldpass_errors_generic
    }
}

/** The personal vault is named by what it is, not by its stored name. */
@Composable
fun vaultLabel(vault: Vault): String =
    if (vault.kind == Vault.Kind.PERSONAL) stringResource(R.string.weldpass_vaults_personal) else vault.name

@StringRes
fun typeLabel(type: Item.Type): Int = when (type) {
    Item.Type.NOTE -> R.string.weldpass_types_note
    Item.Type.CARD -> R.string.weldpass_types_card
    else -> R.string.weldpass_types_login
}

/** The platform's icon for an item type (`ItemTypeIcon`: globe, sticky note, credit card). */
fun typeIcon(type: Item.Type): ImageVector = when (type) {
    Item.Type.NOTE -> Icons.AutoMirrored.Outlined.StickyNote2
    Item.Type.CARD -> Icons.Outlined.CreditCard
    else -> Icons.Outlined.Language
}

/** The item type's icon, plain, in the muted colour unless told otherwise. */
@Composable
fun TypeIcon(type: Item.Type, modifier: Modifier = Modifier, size: Dp = 18.dp, tint: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Icon(typeIcon(type), contentDescription = null, tint = tint, modifier = modifier.size(size))
}

/** A server timestamp as the phone shows dates and times ("26 Nov 2026, 17:40"). */
fun formatWhen(iso: String): String = runCatching {
    java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT)
        .format(java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()))
}.getOrDefault(iso)

/** A server timestamp as time ago ("5 minutes ago", "Yesterday"), like the platform's `TimeAgo`. */
fun formatAgo(iso: String, nowMillis: Long = System.currentTimeMillis()): String = runCatching {
    android.text.format.DateUtils.getRelativeTimeSpanString(
        java.time.Instant.parse(iso).toEpochMilli(),
        nowMillis,
        android.text.format.DateUtils.MINUTE_IN_MILLIS,
    ).toString()
}.getOrDefault(iso)

/** "Add item", in a top bar. */
@Composable
fun AddButton(onClick: () -> Unit, tag: String) {
    IconButton(onClick = onClick, modifier = Modifier.tagged(tag)) {
        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldpass_items_add))
    }
}

@Composable
fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack, modifier = Modifier.tagged("back")) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.weldpass_common_back))
    }
}
