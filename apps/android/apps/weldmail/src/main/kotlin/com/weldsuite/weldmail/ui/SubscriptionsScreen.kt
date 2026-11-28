package com.weldsuite.weldmail.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Unsubscribe
import org.weldsuite.ui.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldmail.MailAccount
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.MailSubscription
import com.weldsuite.weldmail.R
import kotlinx.coroutines.launch
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant

/** The newsletters and mailing lists a mailbox receives, with one-tap unsubscribe. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionsScreen(store: MailStore, onBack: () -> Unit) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val accounts = store.sendableAccounts
    var account by remember { mutableStateOf<MailAccount?>(store.selectedAccount?.takeIf { it.inActiveWorkspace } ?: accounts.firstOrNull()) }
    var items by remember { mutableStateOf<List<MailSubscription>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var tab by remember { mutableIntStateOf(0) }
    var pending by remember { mutableStateOf<MailSubscription?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(account?.id, reload) {
        val current = account ?: run {
            loading = false
            return@LaunchedEffect
        }
        error = null
        try {
            val list = store.repository.subscriptions(current.id)
            if (account?.id == current.id) items = list
        } catch (failure: Exception) {
            if (account?.id == current.id) error = failure
        } finally {
            loading = false
            refreshing = false
        }
    }

    fun scan() {
        val current = account ?: return
        scanning = true
        scope.launch {
            try {
                val (found, scanned) = store.repository.scan(current.id)
                store.forgetSubscriptions(current.id)
                notify.show(context.getString(R.string.weldmail_subscriptions_scanned, found, scanned))
                reload++
            } catch (_: Exception) {
                notify.show(context.getString(R.string.weldmail_subscriptions_scan_failed))
            } finally {
                scanning = false
            }
        }
    }

    val active = items.count { it.active }
    val unsubscribed = items.size - active
    val shown = items.filter { it.active == (tab == 0) && MailLogic.matchesSubscription(it, query) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.weldmail_subscriptions_title))
                        account?.let { Text(it.email, style = MaterialTheme.typography.bodySmall) }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(org.weldsuite.core.R.string.core_common_close))
                    }
                },
                actions = {
                    IconButton(onClick = { scan() }, enabled = !scanning && account != null, modifier = Modifier.tagged("subscriptions-scan")) {
                        Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.weldmail_subscriptions_scan))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (account == null) {
                EmptyState(
                    title = stringResource(R.string.weldmail_subscriptions_no_mailbox_title),
                    description = stringResource(R.string.weldmail_subscriptions_no_mailbox),
                )
                return@Column
            }
            if (accounts.size > 1) {
                LazyRow(Modifier.padding(horizontal = Tokens.Spacing.l), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    items(accounts) { option ->
                        FilterChip(
                            selected = option.id == account?.id,
                            onClick = {
                                account = option
                                loading = true
                                items = emptyList()
                            },
                            label = { Text(option.email) },
                        )
                    }
                }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text(stringResource(R.string.weldmail_subscriptions_search_placeholder)) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("subscriptions-search"),
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l)) {
                SegmentedButton(selected = tab == 0, onClick = { tab = 0 }, shape = SegmentedButtonDefaults.itemShape(0, 2)) {
                    Text(stringResource(R.string.weldmail_subscriptions_subscribed, active))
                }
                SegmentedButton(selected = tab == 1, onClick = { tab = 1 }, shape = SegmentedButtonDefaults.itemShape(1, 2)) {
                    Text(stringResource(R.string.weldmail_subscriptions_unsubscribed_tab, unsubscribed))
                }
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    reload++
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                when {
                    loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    error != null && items.isEmpty() -> LoadErrorState(error, onRetry = { reload++ })
                    shown.isEmpty() -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        val hint = query.isBlank() && tab == 0
                        EmptyState(
                            title = stringResource(
                                when {
                                    query.isNotBlank() -> R.string.weldmail_subscriptions_no_matches
                                    tab == 0 -> R.string.weldmail_subscriptions_empty_active
                                    else -> R.string.weldmail_subscriptions_empty_unsubscribed
                                },
                            ),
                            description = if (hint) stringResource(R.string.weldmail_subscriptions_empty_hint) else null,
                            icon = { Icon(Icons.Outlined.Unsubscribe, contentDescription = null, modifier = Modifier.size(40.dp)) },
                        )
                        if (hint) {
                            Button(onClick = { scan() }, enabled = !scanning) {
                                Text(stringResource(if (scanning) R.string.weldmail_subscriptions_scanning else R.string.weldmail_subscriptions_scan))
                            }
                        }
                    }
                    else -> LazyColumn(Modifier.fillMaxSize().tagged("subscriptions-list")) {
                        items(shown, key = { it.id }) { item -> SubscriptionRow(item) { pending = item } }
                    }
                }
            }
        }
    }

    pending?.let { item ->
        UnsubscribeDialog(subscription = item, busy = busy, onDismiss = { if (!busy) pending = null }) {
            busy = true
            scope.launch {
                try {
                    val result = store.repository.unsubscribe(item.id)
                    store.forgetSubscriptions(item.accountId)
                    items = items.map {
                        if (it.id == item.id) it.copy(active = false, unsubscribedAt = WeldDate.timestampString(Instant.now())) else it
                    }
                    announceUnsubscribe(context, notify, result.method, result.url, item.senderLabel)
                } catch (_: Exception) {
                    notify.show(context.getString(R.string.weldmail_unsubscribe_failed, item.senderLabel))
                } finally {
                    busy = false
                    pending = null
                }
            }
        }
    }
}

@Composable
private fun SubscriptionRow(item: MailSubscription, onUnsubscribe: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("subscription-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MailAvatar(item.senderLabel, size = 36.dp)
        Column(Modifier.weight(1f).padding(horizontal = Tokens.Spacing.m)) {
            Text(item.senderLabel, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            item.lastSubject?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Text(
                pluralStringResource(R.plurals.weldmail_subscriptions_emails, item.messageCount, item.messageCount) + " · " +
                    stringResource(R.string.weldmail_subscriptions_last, rowTime(item.lastReceivedAt)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        when {
            !item.active -> Text(
                stringResource(if (MailLogic.stillSending(item)) R.string.weldmail_unsubscribe_still_sending else R.string.weldmail_unsubscribe_unsubscribed),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            MailLogic.canUnsubscribe(item) -> OutlinedButton(onClick = onUnsubscribe, modifier = Modifier.tagged("unsubscribe-${item.senderEmail}")) {
                Text(stringResource(R.string.weldmail_unsubscribe_button))
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
}
