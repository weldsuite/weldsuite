package com.weldsuite.weldmail.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.weldsuite.weldmail.AddAccountLogic
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

private enum class AddStep { CHOOSE, FREE, CUSTOM }

/** A new mailbox: a free WeldMail address of the workspace, or an address on one of its own domains. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddAccountScreen(store: MailStore, freeAddresses: Boolean, customDomains: Boolean, onDone: () -> Unit) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(AddStep.CHOOSE) }
    var domains by remember { mutableStateOf<List<String>>(emptyList()) }
    var freeDomain by remember { mutableStateOf<String?>(null) }
    var address by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var domain by remember { mutableStateOf<String?>(null) }
    var domainMenu by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var availability by remember { mutableStateOf<AddAccountLogic.Check?>(null) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(customDomains) {
        if (customDomains) {
            domains = runCatching { store.repository.mailDomains() }.getOrDefault(emptyList())
            domain = domains.firstOrNull()
        }
    }
    LaunchedEffect(step) {
        if (step == AddStep.FREE && freeDomain == null) freeDomain = runCatching { store.repository.weldmailDomain() }.getOrNull()
    }
    // The address is checked as it's typed, half a second after the last key.
    LaunchedEffect(address, step) {
        availability = null
        if (step != AddStep.FREE || address.length < 3) {
            checking = false
            return@LaunchedEffect
        }
        checking = true
        delay(500)
        availability = try {
            AddAccountLogic.check(store.repository.checkAddress(address))
        } catch (failure: Exception) {
            AddAccountLogic.Check.Unavailable(null)
        }
        checking = false
    }

    fun back() {
        if (step == AddStep.CHOOSE) {
            onDone()
        } else {
            step = AddStep.CHOOSE
            address = ""
            displayName = ""
            error = null
        }
    }
    BackHandler { back() }

    fun submit() {
        error = null
        submitting = true
        scope.launch {
            try {
                if (step == AddStep.FREE) {
                    val email = store.repository.reserveAddress(address, displayName)
                    notify.show(context.getString(R.string.weldmail_add_account_created, email))
                } else {
                    val chosen = domain ?: return@launch
                    val email = "$address@$chosen"
                    store.repository.createAccount(displayName.ifBlank { address }, email, displayName.ifBlank { address })
                    notify.show(context.getString(R.string.weldmail_add_account_account_created, email))
                }
                store.loadAccounts()
                store.loadLabels()
                onDone()
            } catch (failure: Exception) {
                error = context.getString(
                    if ((failure as? ApiException)?.status == 403) CoreR.string.core_errors_forbidden else R.string.weldmail_add_account_failed,
                )
            } finally {
                submitting = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldmail_add_account_title)) },
                navigationIcon = {
                    IconButton(onClick = { back() }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(CoreR.string.core_common_close))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            when (step) {
                AddStep.CHOOSE -> {
                    if (!freeAddresses && !(customDomains && domains.isNotEmpty())) {
                        EmptyState(title = stringResource(R.string.weldmail_add_account_nothing_to_add))
                        return@Column
                    }
                    Text(stringResource(R.string.weldmail_add_account_intro), style = MaterialTheme.typography.bodyMedium)
                    if (freeAddresses) {
                        OutlinedCard(Modifier.fillMaxWidth().clickable { step = AddStep.FREE }.tagged("add-free-address")) {
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.weldmail_add_account_free_address)) },
                                supportingContent = { Text(stringResource(R.string.weldmail_add_account_free_address_hint)) },
                                leadingContent = { Icon(Icons.Outlined.Mail, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null) },
                            )
                        }
                    }
                    if (customDomains && domains.isNotEmpty()) {
                        OutlinedCard(Modifier.fillMaxWidth().clickable { step = AddStep.CUSTOM }.tagged("add-custom-domain")) {
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.weldmail_add_account_custom_domain)) },
                                supportingContent = { Text(stringResource(R.string.weldmail_add_account_custom_domain_hint)) },
                                leadingContent = { Icon(Icons.Outlined.Language, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
                                trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null) },
                            )
                        }
                    }
                    Text(stringResource(R.string.weldmail_add_account_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                AddStep.FREE, AddStep.CUSTOM -> {
                    val suffix = if (step == AddStep.FREE) freeDomain else domain
                    Text(
                        "${address.ifEmpty { stringResource(R.string.weldmail_add_account_address_placeholder) }}@${suffix.orEmpty()}",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.tagged("add-account-preview"),
                    )
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = AddAccountLogic.cleanAddress(it) },
                        label = { Text(stringResource(R.string.weldmail_add_account_address)) },
                        placeholder = { Text(stringResource(R.string.weldmail_add_account_address_placeholder)) },
                        suffix = { Text("@${suffix.orEmpty()}") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().tagged("add-account-address"),
                    )
                    if (step == AddStep.FREE && address.isNotEmpty()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val check = availability
                            when {
                                address.length < 3 -> Text(stringResource(R.string.weldmail_add_account_min_length), style = MaterialTheme.typography.bodySmall)
                                checking -> {
                                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                                    Text(stringResource(R.string.weldmail_add_account_checking), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 6.dp))
                                }
                                check is AddAccountLogic.Check.Available -> {
                                    Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = org.weldsuite.ui.Tokens.Status.success.current(), modifier = Modifier.size(14.dp))
                                    Text(stringResource(R.string.weldmail_add_account_available), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 6.dp))
                                }
                                check is AddAccountLogic.Check.Unavailable -> {
                                    Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                                    Text(
                                        stringResource(
                                            when (check.reason) {
                                                "reserved" -> R.string.weldmail_add_account_reserved
                                                "taken" -> R.string.weldmail_add_account_taken
                                                else -> R.string.weldmail_add_account_not_available
                                            },
                                        ),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                        modifier = Modifier.padding(start = 6.dp),
                                    )
                                }
                            }
                        }
                    }
                    if (step == AddStep.CUSTOM) {
                        Column {
                            OutlinedCard(Modifier.fillMaxWidth().clickable { domainMenu = true }.tagged("add-account-domain")) {
                                ListItem(
                                    headlineContent = { Text(domain ?: stringResource(R.string.weldmail_add_account_choose_domain)) },
                                    overlineContent = { Text(stringResource(R.string.weldmail_add_account_domain)) },
                                )
                            }
                            DropdownMenu(expanded = domainMenu, onDismissRequest = { domainMenu = false }) {
                                domains.forEach { option ->
                                    DropdownMenuItem(text = { Text(option) }, onClick = {
                                        domain = option
                                        domainMenu = false
                                    })
                                }
                            }
                        }
                    }
                    OutlinedTextField(
                        value = displayName,
                        onValueChange = { displayName = it },
                        label = { Text(stringResource(R.string.weldmail_add_account_display_name)) },
                        placeholder = { Text(stringResource(R.string.weldmail_add_account_display_name_placeholder)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().tagged("add-account-name"),
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    val ready = if (step == AddStep.FREE) {
                        availability is AddAccountLogic.Check.Available && address.length >= 3
                    } else {
                        address.isNotEmpty() && domain != null
                    }
                    Button(onClick = { submit() }, enabled = ready && !submitting, modifier = Modifier.fillMaxWidth().tagged("add-account-create")) {
                        if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.weldmail_add_account_create))
                    }
                }
            }
        }
    }
}
