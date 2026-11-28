package com.weldsuite.weldhr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Thermostat
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.weldsuite.weldhr.AddAction
import com.weldsuite.weldhr.AddMenus
import com.weldsuite.weldhr.HrAccess
import com.weldsuite.weldhr.HrRepository
import com.weldsuite.weldhr.HrRoutes
import com.weldsuite.weldhr.HrTabs
import com.weldsuite.weldhr.HrTarget
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.ToastHost
import org.weldsuite.ui.Toaster
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** What every WeldHR screen reaches for. */
class Hr(
    val env: AppEnvironment,
    val repository: HrRepository,
    val session: SessionState.Ready,
    val appearance: AppearancePreference,
    val nav: NavHostController,
    private val toaster: Toaster,
    private val scope: CoroutineScope,
) {
    fun toast(text: String) = toaster.show(text, scope)

    fun open(route: String) = nav.navigate(route)

    fun back() {
        nav.popBackStack()
    }

    /** Run a write; the toast says how it went (the server's message on failure). */
    fun launch(block: suspend () -> Unit) {
        scope.launch { block() }
    }
}

val LocalHr = staticCompositionLocalOf<Hr> { error("WeldHR screens run inside WeldHRApp") }

/** The workspace hub's WeldHR topics: every one reloads what is on screen (the Expo app's sync map). */
val HR_TOPICS = listOf(
    "hr_employee", "hr_checklist", "hr_attendance", "hr_leave_request", "hr_shift_request", "hr_open_shift",
    "hr_announcement", "hr_declaration", "hr_absence", "hr_coaching_log", "hr_evaluation", "hr_milestone", "hr_payslip",
)

object Routes {
    const val HOME = "home"
    const val SCHEDULE = "schedule"
    const val ABSENCE = "absence"
    const val EXPENSES = "expenses"
    const val ANNOUNCEMENTS = "announcements"
    const val PROFILE = "profile"
    const val PAY = "pay"
    const val TASKS = "tasks"
    const val REVIEWS = "reviews"
    const val DIRECTORY = "directory"
    const val SICK = "sick"
    const val LEAVE_NEW = "leave-new"
    const val SHIFT_NEW = "shift-new"
    const val ANNOUNCEMENT_NEW = "announcement-new"

    fun employee(id: String) = "employee/$id"
    fun shift(id: String, day: String) = "shift/$id?day=$day"
    fun shiftRequest(id: String, day: String) = "shift-request/$id?day=$day"
    fun openShift(id: String) = "open-shift/$id"
    fun leave(id: String) = "leave/$id"
    fun sickReport(id: String) = "sick-report/$id"
    fun expense(id: String) = "expense/$id"
    fun announcement(id: String) = "announcement/$id"
    fun expenseNew(receipt: String = "") = "expense-new?receipt=$receipt"
}

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Home(Routes.HOME, R.string.weldhr_tabs_home, Icons.Filled.Home, "tab-home"),
    Schedule(Routes.SCHEDULE, R.string.weldhr_tabs_schedule, Icons.Filled.CalendarMonth, "tab-schedule"),
    Absence(Routes.ABSENCE, R.string.weldhr_tabs_absence, Icons.Filled.EventBusy, "tab-absence"),
    Expenses(Routes.EXPENSES, R.string.weldhr_tabs_expenses, Icons.Filled.Receipt, "tab-expenses"),
    Announcements(Routes.ANNOUNCEMENTS, R.string.weldhr_tabs_announcements, Icons.Filled.Campaign, "tab-announcements"),
}

/** WeldHR once signed in, in a workspace and unlocked. */
@Composable
fun WeldHRApp(
    env: AppEnvironment,
    repository: HrRepository,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    pendingLink: MutableStateFlow<HrTarget?>,
) {
    NotificationPermissionRequest()
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val toaster = remember { Toaster() }
    val hr = remember(nav, session) { Hr(env, repository, session, appearance, nav, toaster, scope) }

    LaunchedEffect(session.workspace.id) {
        repository.useWorkspace(session.workspace.id)
        repository.access.ensure()
        repository.me.ensure()
    }
    RealtimeRefresh(env, HR_TOPICS) { repository.invalidate() }

    // A tapped push, or a weldhr:// link, opens its screen.
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        val payload = tap ?: return@LaunchedEffect
        WeldPush.takeTap()
        HrRoutes.forPush(payload.values)?.let { follow(nav, it) }
    }
    val link by pendingLink.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        val target = link ?: return@LaunchedEffect
        pendingLink.value = null
        follow(nav, target)
    }

    val access by repository.access.state.collectAsStateWithLifecycle()
    val me by repository.me.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, access)
    val accessNow = access.data ?: HrAccess.NONE
    val tabs = HrTabs.of(accessNow, access.data == null && access.error == null)

    CompositionLocalProvider(LocalHr provides hr) {
        ToastHost(toaster) {
            Scaffold(
                bottomBar = { TabBar(nav, tabs, accessNow, self is SelfState.Ready) },
                floatingActionButton = { AddButton(nav, self, accessNow) },
            ) { padding ->
                NavHost(nav, startDestination = Routes.HOME, modifier = Modifier.padding(padding)) {
                    composable(Routes.HOME) { HomeScreen() }
                    composable(Routes.SCHEDULE) { ScheduleScreen() }
                    composable(Routes.ABSENCE) { AbsenceScreen() }
                    composable(
                        "${Routes.EXPENSES}?view={view}",
                        arguments = listOf(navArgument("view") { defaultValue = "" }),
                    ) { entry -> ExpensesScreen(startOnApprove = entry.arguments?.getString("view") == "approve") }
                    composable(Routes.ANNOUNCEMENTS) { AnnouncementsScreen() }
                    composable(Routes.PROFILE) { ProfileScreen() }
                    composable(Routes.PAY) { PayScreen() }
                    composable(Routes.TASKS) { TasksScreen() }
                    composable(Routes.REVIEWS) { ReviewsScreen() }
                    composable(Routes.DIRECTORY) { DirectoryScreen() }
                    composable("employee/{id}") { entry -> EmployeeScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable(
                        "shift/{id}?day={day}",
                        arguments = listOf(navArgument("day") { defaultValue = "" }),
                    ) { entry -> ShiftScreen(entry.arguments?.getString("id").orEmpty(), entry.arguments?.getString("day").orEmpty()) }
                    composable(
                        "shift-request/{id}?day={day}",
                        arguments = listOf(navArgument("day") { defaultValue = "" }),
                    ) { entry -> ShiftRequestScreen(entry.arguments?.getString("id").orEmpty(), entry.arguments?.getString("day").orEmpty()) }
                    composable("open-shift/{id}") { entry -> OpenShiftScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable("leave/{id}") { entry -> LeaveScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable("sick-report/{id}") { entry -> SickReportScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable("expense/{id}") { entry -> ExpenseScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable("announcement/{id}") { entry -> AnnouncementScreen(entry.arguments?.getString("id").orEmpty()) }
                    composable(Routes.LEAVE_NEW) { LeaveFormScreen() }
                    composable(
                        "expense-new?receipt={receipt}",
                        arguments = listOf(navArgument("receipt") { type = NavType.StringType; defaultValue = "" }),
                    ) { entry -> ExpenseFormScreen(entry.arguments?.getString("receipt").orEmpty()) }
                    composable(Routes.SICK) { SickFormScreen() }
                    composable(Routes.SHIFT_NEW) { ShiftRequestFormScreen() }
                    composable(Routes.ANNOUNCEMENT_NEW) { AnnouncementFormScreen() }
                }
            }
        }
    }
}

private fun follow(nav: NavHostController, target: HrTarget) {
    val route = when (target) {
        HrTarget.Announcements -> Routes.ANNOUNCEMENTS
        is HrTarget.Announcement -> Routes.announcement(target.id)
        is HrTarget.Leave -> Routes.leave(target.id)
        is HrTarget.Expense -> Routes.expense(target.id)
        is HrTarget.SickReport -> Routes.sickReport(target.id)
        HrTarget.Schedule -> Routes.SCHEDULE
        HrTarget.Absence -> Routes.ABSENCE
        HrTarget.Expenses -> Routes.EXPENSES
        HrTarget.Pay -> Routes.PAY
        HrTarget.Tasks -> Routes.TASKS
        HrTarget.Reviews -> Routes.REVIEWS
    }
    nav.navigate(route)
}

private fun tabOf(route: String?): String? = when {
    route == null -> Routes.HOME
    route.startsWith(Routes.EXPENSES) && !route.startsWith("expense/") -> Routes.EXPENSES
    else -> Tab.entries.firstOrNull { it.route == route }?.route
}

@Composable
private fun TabBar(nav: NavHostController, tabs: HrTabs, access: HrAccess, selfReady: Boolean) {
    val hr = LocalHr.current
    val entry by nav.currentBackStackEntryAsState()
    val current = tabOf(entry?.destination?.route)
    // Pushed pages and forms cover the tab bar, as on iOS.
    if (current == null) return
    val pendingLeave by hr.repository.pendingLeave.state.collectAsStateWithLifecycle()
    val pendingExpenses by hr.repository.pendingExpenses.state.collectAsStateWithLifecycle()
    val announcements by hr.repository.announcements.state.collectAsStateWithLifecycle()
    LaunchedEffect(access.approveLeave, access.approveExpenses, selfReady) {
        if (access.approveLeave) hr.repository.pendingLeave.ensure()
        if (access.approveExpenses) hr.repository.pendingExpenses.ensure()
        if (selfReady) hr.repository.announcements.ensure()
    }
    val visible = Tab.entries.filter {
        when (it) {
            Tab.Home -> true
            Tab.Schedule -> tabs.schedule
            Tab.Absence -> tabs.absence
            Tab.Expenses -> tabs.expenses
            Tab.Announcements -> tabs.announcements
        }
    }
    NavigationBar {
        visible.forEach { tab ->
            val badge = when (tab) {
                Tab.Absence -> if (access.approveLeave) pendingLeave.data?.size ?: 0 else 0
                Tab.Expenses -> if (access.approveExpenses) pendingExpenses.data?.size ?: 0 else 0
                Tab.Announcements -> if (selfReady) announcements.data?.unread ?: 0 else 0
                else -> 0
            }
            NavigationBarItem(
                selected = current == tab.route,
                onClick = {
                    nav.navigate(tab.route) {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = {
                    BadgedBox(badge = { if (badge > 0) Badge { Text(badge.toString()) } }) {
                        Icon(tab.icon, contentDescription = null)
                    }
                },
                label = { Text(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}

/** The "+" on every tab but Home, for a member linked to an employee; what it offers depends on the tab. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddButton(nav: NavHostController, self: SelfState, access: HrAccess) {
    val hr = LocalHr.current
    val entry by nav.currentBackStackEntryAsState()
    val tab = tabOf(entry?.destination?.route) ?: return
    val ready = self as? SelfState.Ready ?: return
    val absences by hr.repository.absences.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { hr.repository.absences.ensure() }
    val sick = absences.data?.current != null
    val menu = AddMenus.forTab(tab, ready.features, access) ?: return
    var open by remember { mutableStateOf(false) }
    val go: (AddAction) -> Unit = { action ->
        open = false
        nav.navigate(
            when (action) {
                AddAction.REQUEST_LEAVE -> Routes.LEAVE_NEW
                AddAction.REQUEST_SHIFT -> Routes.SHIFT_NEW
                AddAction.REPORT_SICK -> Routes.SICK
                AddAction.NEW_EXPENSE -> Routes.expenseNew()
                AddAction.PHOTO_RECEIPT -> Routes.expenseNew("camera")
                AddAction.UPLOAD_RECEIPT -> Routes.expenseNew("library")
                AddAction.NEW_ANNOUNCEMENT -> Routes.ANNOUNCEMENT_NEW
            },
        )
    }
    FloatingActionButton(
        onClick = { if (menu.direct) go(menu.main) else open = true },
        modifier = Modifier.tagged("tab-add"),
    ) { Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldhr_a11y_add)) }
    if (open) {
        ModalBottomSheet(onDismissRequest = { open = false }, modifier = Modifier.tagged("add-menu")) {
            Column(Modifier.padding(bottom = Tokens.Spacing.xl)) {
                menu.entries.forEach { action ->
                    val (title, hint, icon) = describe(action, sick)
                    ListItem(
                        headlineContent = { Text(title) },
                        supportingContent = hint?.let { { Text(it) } },
                        leadingContent = { Icon(icon, contentDescription = null) },
                        modifier = Modifier.clickable { go(action) }.tagged(tagOf(action)),
                    )
                }
                val (title, _, icon) = describe(menu.main, sick)
                Button(
                    onClick = { go(menu.main) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(tagOf(menu.main)),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        Icon(icon, contentDescription = null)
                        Text(title)
                    }
                }
            }
        }
    }
}



private fun tagOf(action: AddAction): String = when (action) {
    AddAction.REQUEST_LEAVE -> "add-leave"
    AddAction.REQUEST_SHIFT -> "add-shift"
    AddAction.REPORT_SICK -> "add-sick"
    AddAction.NEW_EXPENSE -> "add-expense"
    AddAction.PHOTO_RECEIPT -> "add-receipt-photo"
    AddAction.UPLOAD_RECEIPT -> "add-receipt-upload"
    AddAction.NEW_ANNOUNCEMENT -> "add-announcement"
}

@Composable
private fun describe(action: AddAction, sick: Boolean): Triple<String, String?, ImageVector> = when (action) {
    AddAction.REQUEST_LEAVE -> Triple(stringResource(R.string.weldhr_home_request_time_off), null, Icons.Filled.EditCalendar)
    AddAction.REQUEST_SHIFT -> Triple(stringResource(R.string.weldhr_home_request_shift), stringResource(R.string.weldhr_home_request_shift_hint), Icons.Filled.Schedule)
    AddAction.REPORT_SICK -> if (sick) {
        Triple(stringResource(R.string.weldhr_home_im_better), stringResource(R.string.weldhr_home_im_better_hint), Icons.Filled.Thermostat)
    } else {
        Triple(stringResource(R.string.weldhr_home_report_sick), stringResource(R.string.weldhr_home_report_sick_hint), Icons.Filled.Thermostat)
    }
    AddAction.NEW_EXPENSE -> Triple(stringResource(R.string.weldhr_home_new_expense), stringResource(R.string.weldhr_home_new_expense_hint), Icons.Filled.Receipt)
    AddAction.PHOTO_RECEIPT -> Triple(stringResource(R.string.weldhr_home_photo_receipt), null, Icons.Filled.CameraAlt)
    AddAction.UPLOAD_RECEIPT -> Triple(stringResource(R.string.weldhr_home_upload_receipt), stringResource(R.string.weldhr_home_upload_receipt_hint), Icons.Filled.PhotoLibrary)
    AddAction.NEW_ANNOUNCEMENT -> Triple(stringResource(R.string.weldhr_announcement_form_title), null, Icons.Filled.Campaign)
}

/** The tint for text on the brand. */
@Composable
fun brand() = Tokens.Brand.weldhr.current()

