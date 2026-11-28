package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import org.weldsuite.ui.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import org.weldsuite.ui.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import com.weldsuite.weldhr.R
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * A request or claim to approve, the same on Absence → Requests and
 * Expenses → To approve: who and what for on the left, the dates or the
 * amount on the right, Decline and Approve under it.
 */
@Composable
fun ApprovalRow(
    id: String,
    name: String,
    subtitle: String,
    note: String?,
    value: String,
    detail: String,
    approve: suspend (Boolean, String?) -> Unit,
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
    Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("approval-$id"), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        Avatar(name, size = 34.dp)
        Column(Modifier.weight(1f)) {
            Row {
                Column(Modifier.weight(1f)) {
                    Text(name, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    if (!note.isNullOrBlank()) Text(note, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(value, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
            Row(Modifier.padding(top = Tokens.Spacing.m), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                FilledTonalButton(onClick = { rejecting = true }, enabled = !busy, modifier = Modifier.tagged("reject-$id")) {
                    Text(stringResource(R.string.weldhr_team_reject))
                }
                Button(onClick = { decide(true, null) }, enabled = !busy, modifier = Modifier.tagged("approve-$id")) {
                    if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.weldhr_team_approve))
                }
            }
        }
    }
    if (rejecting) RejectSheet(busy, onReject = { decide(false, it) }, onDismiss = { rejecting = false })
}

/** Declining, with an optional reason the employee sees. */
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
