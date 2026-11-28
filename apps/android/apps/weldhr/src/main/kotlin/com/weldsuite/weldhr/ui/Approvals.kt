package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldhr.R
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Button
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * A request or claim to approve, the same on Absence → Requests and
 * Expenses → To approve, as the platform's review rows: who (medium) with
 * what and when under it, the amount on the right, and the small outline
 * Approve and Reject buttons the platform puts on a pending row.
 */
@Composable
fun ApprovalRow(
    id: String,
    name: String,
    subtitle: String,
    note: String?,
    approve: suspend (Boolean, String?) -> Unit,
    subtitleMarker: (@Composable () -> Unit)? = null,
    value: String? = null,
) {
    val hr = LocalHr.current
    var busy by remember { mutableStateOf(false) }
    var rejecting by remember { mutableStateOf(false) }
    val approvedText = stringResource(R.string.weldhr_team_approved)
    val rejectedText = stringResource(R.string.weldhr_team_rejected)
    val generic = stringResource(org.weldsuite.core.R.string.core_errors_generic)
    fun decide(accept: Boolean, reason: String?) {
        busy = true
        hr.launch {
            try {
                approve(accept, reason)
                hr.toast(if (accept) approvedText else rejectedText)
                rejecting = false
            } catch (error: Exception) {
                hr.toast(error.message?.takeIf { it.isNotBlank() } ?: generic)
            } finally {
                busy = false
            }
        }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().tagged("approval-$id")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Avatar(name, size = 32.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, modifier = Modifier.weight(1f))
                    if (value != null) Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    subtitleMarker?.invoke()
                    Text(subtitle, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp), color = muted, maxLines = 2)
                }
                if (!note.isNullOrBlank()) {
                    Text(note, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp), color = muted, maxLines = 2)
                }
                Row(Modifier.padding(top = Tokens.Spacing.s), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    SmallOutline(
                        label = stringResource(R.string.weldhr_team_approve),
                        icon = { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(14.dp)) },
                        enabled = !busy,
                        tag = "approve-$id",
                        onClick = { decide(true, null) },
                    )
                    SmallOutline(
                        label = stringResource(R.string.weldhr_team_reject),
                        icon = { Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(14.dp)) },
                        enabled = !busy,
                        tag = "reject-$id",
                        onClick = { rejecting = true },
                    )
                    if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                }
            }
        }
        HorizontalDivider(color = rowRule())
    }
    if (rejecting) RejectSheet(busy, onReject = { decide(false, it) }, onDismiss = { rejecting = false })
}

/** The platform's `size="sm" variant="outline"` row button: 32dp high, 12sp. */
@Composable
private fun SmallOutline(label: String, icon: @Composable () -> Unit, enabled: Boolean, tag: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
        modifier = Modifier.height(32.dp).tagged(tag),
    ) {
        icon()
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 4.dp))
    }
}

/** Rejecting, with an optional note the employee sees; the button is destructive, as on the platform. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RejectSheet(busy: Boolean, onReject: (String?) -> Unit, onDismiss: () -> Unit) {
    var note by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.xl), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Text(stringResource(R.string.weldhr_team_reject_title), style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = note,
                onValueChange = { note = it.take(2000) },
                label = { Text(stringResource(R.string.weldhr_team_reject_note)) },
                placeholder = { Text(stringResource(R.string.weldhr_team_reject_note_placeholder)) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth().tagged("reject-note"),
            )
            Button(
                onClick = { onReject(note.trim().ifEmpty { null }) },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = Tokens.Status.danger.current(), contentColor = Color.White),
                modifier = Modifier.fillMaxWidth().tagged("reject-confirm"),
            ) { Text(stringResource(R.string.weldhr_team_reject_confirm)) }
        }
    }
}
