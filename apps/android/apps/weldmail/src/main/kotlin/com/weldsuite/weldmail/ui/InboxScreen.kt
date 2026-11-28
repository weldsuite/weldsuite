package com.weldsuite.weldmail.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Drafts
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Unsubscribe
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.DateSection
import com.weldsuite.weldmail.InboxFilter
import com.weldsuite.weldmail.MailAccount
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.Mailbox
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SystemLabel
import kotlinx.coroutines.launch
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.SessionState
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import kotlin.math.roundToInt

/** The inbox: a folder of one mailbox or of all of them, with the mailbox menu in a drawer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    store: MailStore,
    session: SessionState.Ready,
    onOpen: (String) -> Unit,
    onCompose: () -> Unit,
    onSearch: () -> Unit,
    onSubscriptions: () -> Unit,
    onAddAccount: () -> Unit,
    onSwitchWorkspace: (String) -> Unit,
    aiAvailable: Boolean,
) {
    val inbox by store.inbox.collectAsStateWithLifecycle()
    val label by store.label.collectAsStateWithLifecycle()
    val labels by store.labels.collectAsStateWithLifecycle()
    val pinned by store.pinned.collectAsStateWithLifecycle()
    val online by store.connectivity.online.collectAsStateWithLifecycle()
    val accountsLoaded by store.accountsLoaded.collectAsStateWithLifecycle()
    val accounts by store.accounts.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val context = LocalContext.current
    var filter by rememberSaveable { mutableStateOf(InboxFilter.ALL) }
    var snoozing by remember { mutableStateOf<MailMessage?>(null) }

    val visible = remember(inbox.messages, filter) { MailLogic.filter(inbox.messages, filter) }
    val sections = remember(visible, pinned) { MailLogic.sections(visible, pinned) }
    LaunchedEffect(sections) { store.visibleIds = sections.flatMap { section -> section.messages.map { it.id } } }

    val system = SystemLabel.of(label)
    val title = system?.let { stringResource(systemLabelName(it)) } ?: labels.custom.firstOrNull { it.slug == label }?.name ?: label

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            MailboxDrawer(
                store = store,
                session = session,
                onLabel = { slug ->
                    scope.launch { drawer.close() }
                    store.selectLabel(slug)
                },
                onMailbox = { mailbox ->
                    scope.launch { drawer.close() }
                    store.selectMailbox(mailbox)
                },
                onOtherWorkspace = { account ->
                    scope.launch { drawer.close() }
                    account.workspaceId?.let { workspace ->
                        store.preselect(workspace, account.id)
                        onSwitchWorkspace(workspace)
                    }
                },
                onSubscriptions = {
                    scope.launch { drawer.close() }
                    onSubscriptions()
                },
                onAddAccount = {
                    scope.launch { drawer.close() }
                    onAddAccount()
                },
                aiAvailable = aiAvailable,
            )
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.tagged("open-mailboxes")) {
                            Icon(Icons.Outlined.Menu, contentDescription = stringResource(R.string.weldmail_inbox_open_mailboxes))
                        }
                    },
                )
            },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = onCompose,
                    icon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    text = { Text(stringResource(R.string.weldmail_inbox_compose)) },
                    modifier = Modifier.tagged("compose"),
                )
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (!online) OfflineBanner()
                PullToRefreshBox(
                    isRefreshing = inbox.refreshing,
                    onRefresh = { scope.launch { store.refresh(pullToRefresh = true) } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    val listState = rememberLazyListState()
                    val nearEnd by remember {
                        derivedStateOf {
                            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                            last >= listState.layoutInfo.totalItemsCount - 10
                        }
                    }
                    LaunchedEffect(nearEnd, inbox.cursor) { if (nearEnd && inbox.cursor != null) store.loadMore() }
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize().tagged("inbox-list")) {
                        item("controls") {
                            ListControls(filter = filter, onFilter = { filter = it }, onSearch = onSearch)
                        }
                        when {
                            inbox.loading && inbox.messages.isEmpty() -> item("loading") {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                            }
                            accountsLoaded && accounts.none { it.inActiveWorkspace } && inbox.messages.isEmpty() -> item("no-mailbox") {
                                EmptyState(
                                    title = stringResource(R.string.weldmail_empty_no_mailbox_title),
                                    description = stringResource(R.string.weldmail_empty_no_mailbox_description),
                                    icon = { Icon(Icons.Outlined.Mail, contentDescription = null, modifier = Modifier.size(40.dp)) },
                                )
                            }
                            sections.isEmpty() -> item("empty") {
                                val (emptyTitle, emptyDescription) = emptyText(system)
                                EmptyState(
                                    title = stringResource(emptyTitle),
                                    description = stringResource(emptyDescription),
                                    icon = { Icon(emptyIcon(system), contentDescription = null, modifier = Modifier.size(40.dp)) },
                                )
                            }
                            else -> sections.forEach { section ->
                                item("section-${section.section}") { SectionHeader(section.section) }
                                items(section.messages, key = { "message-${it.id}" }) { message ->
                                    MessageRow(
                                        message = message,
                                        pinned = message.id in pinned,
                                        customColors = labels.custom.associate { it.name to it.color },
                                        onOpen = {
                                            if (!message.isRead) scope.launch { store.setRead(message.id, true) }
                                            onOpen(message.id)
                                        },
                                        onToggleRead = { scope.launch { store.setRead(message.id, !message.isRead) } },
                                        onPin = { store.togglePin(message.id) },
                                        onSnooze = { snoozing = message },
                                        onArchive = { scope.launch { store.archive(message.id) } },
                                        onDelete = { scope.launch { store.delete(message.id) } },
                                    )
                                }
                            }
                        }
                        if (inbox.loadingMore) {
                            item("more") {
                                Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(24.dp))
                                }
                            }
                        }
                        item("bottom") { Spacer(Modifier.size(88.dp)) }
                    }
                }
            }
        }
    }

    snoozing?.let { message ->
        SnoozeSheet(
            onDismiss = { snoozing = null },
            onChoose = { at ->
                snoozing = null
                scope.launch {
                    store.snooze(message, org.weldsuite.core.WeldDate.timestampString(at.toInstant()))
                    notify.show(
                        context.getString(R.string.weldmail_inbox_snoozed, momentText(at.toInstant())),
                        context.getString(R.string.weldmail_common_undo),
                    ) { scope.launch { store.unsnooze(message) } }
                }
            },
        )
    }
}

@Composable
private fun ListControls(filter: InboxFilter, onFilter: (InboxFilter) -> Unit, onSearch: () -> Unit) {
    Column(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        Surface(
            shape = RoundedCornerShape(Tokens.Radius.medium),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onSearch).tagged("search-mail"),
        ) {
            Row(Modifier.padding(horizontal = Tokens.Spacing.m, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    stringResource(R.string.weldmail_inbox_search_mail),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = Tokens.Spacing.s),
                )
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), modifier = Modifier.padding(top = Tokens.Spacing.s)) {
            items(InboxFilter.entries) { option ->
                FilterChip(
                    selected = filter == option,
                    onClick = { onFilter(option) },
                    label = {
                        Text(
                            stringResource(
                                when (option) {
                                    InboxFilter.ALL -> R.string.weldmail_inbox_filter_all
                                    InboxFilter.UNREAD -> R.string.weldmail_inbox_filter_unread
                                    InboxFilter.STARRED -> R.string.weldmail_inbox_filter_starred
                                    InboxFilter.ATTACHMENTS -> R.string.weldmail_inbox_filter_attachments
                                },
                            ),
                        )
                    },
                    modifier = Modifier.tagged("filter-${option.name.lowercase()}"),
                )
            }
        }
    }
}

@Composable
private fun SectionHeader(section: DateSection) {
    Text(
        stringResource(
            when (section) {
                DateSection.PINNED -> R.string.weldmail_inbox_pinned
                DateSection.TODAY -> CoreR.string.core_common_today
                DateSection.YESTERDAY -> CoreR.string.core_common_yesterday
                DateSection.THIS_WEEK -> R.string.weldmail_inbox_this_week
                DateSection.OLDER -> R.string.weldmail_inbox_older
            },
        ),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Tokens.Spacing.l, top = Tokens.Spacing.m, bottom = Tokens.Spacing.xs),
    )
}

/** An action behind a row, revealed by a swipe. */
private data class SwipeAction(val label: String, val icon: ImageVector, val color: Color, val onClick: () -> Unit)

/**
 * A row whose actions sit behind it: a swipe to the right shows Read and
 * Pin, to the left Snooze, Archive and Delete, as in the Expo app. TalkBack
 * offers the same actions on the row.
 */
@Composable
private fun SwipeRow(leading: List<SwipeAction>, trailing: List<SwipeAction>, content: @Composable () -> Unit) {
    val width = 76.dp
    val density = LocalDensity.current
    val start = with(density) { (width * leading.size).toPx() }
    val end = with(density) { (width * trailing.size).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    fun close() = scope.launch { offset.animateTo(0f) }
    Box(
        Modifier
            .fillMaxWidth()
            .semantics {
                customActions = (leading + trailing).map { action ->
                    CustomAccessibilityAction(action.label) {
                        action.onClick()
                        true
                    }
                }
            },
    ) {
        Row(Modifier.matchParentSize()) {
            leading.forEach { action -> SwipeButton(action, width) { close(); action.onClick() } }
            Spacer(Modifier.weight(1f))
            trailing.forEach { action -> SwipeButton(action, width) { close(); action.onClick() } }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-end, start)) }
                    },
                    onDragStopped = {
                        val target = when {
                            offset.value > start / 2 -> start
                            offset.value < -end / 2 -> -end
                            else -> 0f
                        }
                        offset.animateTo(target)
                    },
                )
                .background(MaterialTheme.colorScheme.surface),
        ) { content() }
    }
}

@Composable
private fun SwipeButton(action: SwipeAction, width: androidx.compose.ui.unit.Dp, onClick: () -> Unit) {
    Column(
        Modifier
            .width(width)
            .fillMaxHeight()
            .background(action.color)
            .clickable(onClick = onClick),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(action.icon, contentDescription = null, tint = Color.White)
        Text(action.label, color = Color.White, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

@Composable
private fun MessageRow(
    message: MailMessage,
    pinned: Boolean,
    customColors: Map<String, String?>,
    onOpen: () -> Unit,
    onToggleRead: () -> Unit,
    onPin: () -> Unit,
    onSnooze: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
) {
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_unknown)
    val leading = listOf(
        SwipeAction(
            stringResource(if (message.isRead) R.string.weldmail_swipe_unread else R.string.weldmail_swipe_read),
            Icons.Outlined.Drafts,
            MailColors.read,
            onToggleRead,
        ),
        SwipeAction(stringResource(if (pinned) R.string.weldmail_swipe_unpin else R.string.weldmail_swipe_pin), Icons.Outlined.PushPin, MailColors.pin, onPin),
    )
    val trailing = listOf(
        SwipeAction(stringResource(R.string.weldmail_swipe_snooze), Icons.Outlined.AccessTime, MailColors.snooze, onSnooze),
        SwipeAction(stringResource(R.string.weldmail_swipe_archive), Icons.Outlined.Archive, MailColors.archive, onArchive),
        SwipeAction(stringResource(R.string.weldmail_swipe_delete), Icons.Outlined.Delete, MailColors.delete, onDelete),
    )
    SwipeRow(leading, trailing) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpen)
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                .tagged("inbox-email-row"),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Box {
                SenderAvatar(sender)
                if (!message.isRead) {
                    Box(
                        Modifier
                            .align(Alignment.TopEnd)
                            .size(10.dp)
                            .background(MaterialTheme.colorScheme.primary, CircleShape),
                    )
                }
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        sender,
                        fontWeight = if (message.isRead) FontWeight.Medium else FontWeight.SemiBold,
                        color = if (message.isRead) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (message.threadCount > 1) {
                        Text(
                            message.threadCount.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .padding(start = Tokens.Spacing.xs)
                                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp))
                                .padding(horizontal = 5.dp),
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    if (message.hasAttachments) {
                        Icon(
                            Icons.Outlined.AttachFile,
                            contentDescription = stringResource(R.string.weldmail_inbox_has_attachments),
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (pinned) {
                        Icon(Icons.Filled.PushPin, contentDescription = stringResource(R.string.weldmail_inbox_is_pinned), modifier = Modifier.size(14.dp), tint = MailColors.pin)
                    }
                    if (message.isStarred) {
                        Icon(Icons.Filled.Star, contentDescription = stringResource(R.string.weldmail_inbox_is_starred), modifier = Modifier.size(14.dp), tint = MailColors.star)
                    }
                    Text(
                        rowTime(message.listDate),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Tokens.Spacing.xs),
                    )
                }
                Text(
                    message.subject?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_subject),
                    fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.Medium,
                    color = if (message.isRead) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    message.preview.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val shown = MailLogic.displayLabels(message.labels)
                if (shown.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs), modifier = Modifier.padding(top = Tokens.Spacing.xs)) {
                        shown.take(3).forEach { name -> LabelChip(name, MailLogic.labelColor(name, customColors[name])) }
                        if (shown.size > 3) {
                            Text("+${shown.size - 3}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
}

/** The mailboxes, the folders and labels of the one on screen, subscriptions. */
@Composable
private fun MailboxDrawer(
    store: MailStore,
    session: SessionState.Ready,
    onLabel: (String) -> Unit,
    onMailbox: (Mailbox) -> Unit,
    onOtherWorkspace: (MailAccount) -> Unit,
    onSubscriptions: () -> Unit,
    onAddAccount: () -> Unit,
    aiAvailable: Boolean,
) {
    val accounts by store.accounts.collectAsStateWithLifecycle()
    val mailbox by store.mailbox.collectAsStateWithLifecycle()
    val label by store.label.collectAsStateWithLifecycle()
    val labels by store.labels.collectAsStateWithLifecycle()
    var more by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    val own = accounts.filter { it.inActiveWorkspace }
    val others = accounts.filterNot { it.inActiveWorkspace }.groupBy { it.workspaceName.orEmpty() }
    val selected = (mailbox as? Mailbox.Account)?.let { m -> own.firstOrNull { it.id == m.id } }

    ModalDrawerSheet(modifier = Modifier.tagged("mailbox-drawer")) {
        LazyColumn(Modifier.padding(horizontal = Tokens.Spacing.m)) {
            item {
                Column(Modifier.padding(Tokens.Spacing.l)) {
                    Text(
                        selected?.displayName ?: stringResource(R.string.weldmail_drawer_all_inboxes),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        selected?.email ?: pluralStringResource(R.plurals.weldmail_drawer_accounts, own.size, own.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(session.workspace.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.weldmail_drawer_all_inboxes)) },
                    icon = { Icon(Icons.Outlined.Inbox, contentDescription = null) },
                    selected = mailbox is Mailbox.Unified,
                    onClick = { onMailbox(Mailbox.Unified) },
                    modifier = Modifier.tagged("mailbox-unified"),
                )
                own.forEach { account ->
                    NavigationDrawerItem(
                        label = { Text(account.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        icon = { SenderAvatar(account.displayName, size = 24.dp) },
                        badge = { Text(account.email, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        selected = selected?.id == account.id,
                        onClick = { onMailbox(Mailbox.Account(account.id)) },
                        modifier = Modifier.tagged("mailbox-${account.email}"),
                    )
                }
                others.forEach { (workspace, list) ->
                    Text(
                        stringResource(R.string.weldmail_drawer_in_workspace, workspace),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Tokens.Spacing.l, top = Tokens.Spacing.m, bottom = Tokens.Spacing.xs),
                    )
                    list.forEach { account ->
                        NavigationDrawerItem(
                            label = { Text(account.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            icon = { SenderAvatar(account.displayName, size = 24.dp) },
                            selected = false,
                            onClick = { onOtherWorkspace(account) },
                        )
                    }
                }
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.weldmail_drawer_add_account)) },
                    icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                    selected = false,
                    onClick = onAddAccount,
                    modifier = Modifier.tagged("add-account"),
                )
                HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
            }
            items(SystemLabel.MAIN) { system ->
                FolderItem(system, labels.systemCounts[system.slug], label == system.slug) { onLabel(system.slug) }
            }
            if (more) {
                items(SystemLabel.SECONDARY) { system ->
                    FolderItem(system, labels.systemCounts[system.slug], label == system.slug) { onLabel(system.slug) }
                }
                item {
                    NavigationDrawerItem(
                        label = { Text(stringResource(R.string.weldmail_drawer_subscriptions)) },
                        icon = { Icon(Icons.Outlined.Unsubscribe, contentDescription = null) },
                        selected = false,
                        onClick = onSubscriptions,
                        modifier = Modifier.tagged("open-subscriptions"),
                    )
                }
            }
            item {
                NavigationDrawerItem(
                    label = { Text(stringResource(if (more) R.string.weldmail_drawer_less else R.string.weldmail_drawer_more)) },
                    icon = { Icon(if (more) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null) },
                    selected = false,
                    onClick = { more = !more },
                    modifier = Modifier.tagged("drawer-more"),
                )
                HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = Tokens.Spacing.l)) {
                    Text(stringResource(R.string.weldmail_drawer_labels), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                    if (selected != null) {
                        IconButton(onClick = { creating = true }, modifier = Modifier.tagged("create-label")) {
                            Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.weldmail_drawer_create_label))
                        }
                    }
                }
                if (labels.custom.isEmpty()) {
                    Text(
                        stringResource(R.string.weldmail_drawer_no_labels),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Tokens.Spacing.l, bottom = Tokens.Spacing.m),
                    )
                }
            }
            items(labels.custom, key = { "label-${it.id}" }) { custom ->
                NavigationDrawerItem(
                    label = { Text(custom.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    icon = { Icon(Icons.AutoMirrored.Outlined.Label, contentDescription = null, tint = rgb(MailLogic.labelColor(custom.name, custom.color))) },
                    badge = { if (custom.count > 0) Text(custom.count.toString()) },
                    selected = label == custom.slug,
                    onClick = { onLabel(custom.slug) },
                )
            }
        }
    }
    if (creating && selected != null) {
        CreateLabelDialog(aiAvailable = aiAvailable, onDismiss = { creating = false }) { name, color ->
            store.createLabel(selected.id, name, color)
        }
    }
}

@Composable
private fun FolderItem(system: SystemLabel, count: Int?, selected: Boolean, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(stringResource(systemLabelName(system))) },
        icon = { Icon(systemLabelIcon(system), contentDescription = null) },
        badge = { if (count != null && count > 0) Text(count.toString()) },
        selected = selected,
        onClick = onClick,
        modifier = Modifier.tagged("folder-${system.slug.lowercase()}"),
    )
}
