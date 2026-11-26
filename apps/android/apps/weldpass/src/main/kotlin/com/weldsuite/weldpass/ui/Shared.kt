package com.weldsuite.weldpass.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

/** The item type's icon on a tinted tile. */
@Composable
fun ItemIcon(type: Item.Type, size: Dp = 40.dp) {
    val icon = when (type) {
        Item.Type.NOTE -> Icons.AutoMirrored.Outlined.StickyNote2
        Item.Type.CARD -> Icons.Outlined.CreditCard
        else -> Icons.Outlined.Key
    }
    Box(
        modifier = Modifier
            .size(size)
            .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(size * 0.28f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size * 0.5f))
    }
}

@Composable
fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack, modifier = Modifier.tagged("back")) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.weldpass_common_back))
    }
}
