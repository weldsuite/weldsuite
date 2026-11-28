import QuickLook
import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// Profile and settings, opened from the workspace at the top of Home: the
/// member's details and balances, what is not one of the tabs (payslips, sick
/// leave, tasks, reviews, the directory), then the settings every app shares.
struct ProfileView: View {
    let env: AppEnvironment
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var balance: HRLeaveBalance?

    var body: some View {
        let access = store.access.data ?? .noAccess
        let state = SelfState.of(me: store.me, access: store.access)
        Form {
            if access.me {
                SelfGate(state: state, retry: { await store.load(.me) }) { profile, _ in
                    Section {
                        // The platform's record header: avatar and name, the job title, the employee status badge.
                        HRRow(
                            title: profile.displayName,
                            subtitle: profile.jobTitle,
                            tag: .status(profile.status, Labels.employeeStatus(profile.status))
                        ) {
                            PersonAvatar(name: profile.displayName, url: profile.avatarUrl, size: 40)
                        }
                        // Its Details rows, in the platform's order.
                        Facts(rows: [
                            (HRStrings.meEmail, profile.email),
                            (HRStrings.mePhone, profile.phone),
                            (HRStrings.meDepartment, profile.departmentName),
                            (HRStrings.meManager, profile.managerName),
                            (HRStrings.meEmployeeNumberLabel, profile.employeeNumber),
                            (HRStrings.meStartDate, profile.startDate.map(Fmt.date)),
                            (HRStrings.meLocation, profile.location),
                        ])
                    }
                    if let balances = store.leave.data?.balances, !balances.isEmpty {
                        Section(HRStrings.absenceBalances) {
                            ForEach(balances) { item in
                                Button { balance = item } label: { BalanceRowView(balance: item) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("balance-\(item.leaveTypeId)")
                            }
                        }
                    }
                    Section(HRStrings.meMyHr) {
                        if store.payslips.data?.isOn == true {
                            link(HRStrings.payPayslips, symbol: "doc.text", count: 0, route: .pay, tag: "profile-pay")
                        }
                        Button { nav.present(.sick) } label: { linkLabel(HRStrings.meSickLeave, symbol: "heart.text.square", count: 0) }
                            .accessibilityIdentifier("profile-sick")
                        link(HRStrings.meTasks, symbol: "checkmark.square", count: store.overview.data?.openTasks ?? 0, route: .tasks, tag: "profile-tasks")
                        link(HRStrings.meReviews, symbol: "trophy", count: store.overview.data?.toAcknowledge ?? 0, route: .reviews, tag: "profile-reviews")
                    }
                }
            }
            if access.directory {
                Section(HRStrings.meTeam) {
                    link(HRStrings.directoryTitle, symbol: "person.text.rectangle", count: 0, route: .directory, tag: "profile-directory")
                }
            }
            CommonSettingsSections(
                env: env,
                appName: HRStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .navigationTitle(HRStrings.meTitle)
        .refreshable {
            await store.load(.me)
            await store.load(.access)
            await store.invalidate()
        }
        .task(id: state.features != nil) {
            guard state.features != nil else { return }
            await store.ensure(.overview)
            await store.ensure(.leave)
            await store.ensure(.payslips)
        }
        .sheet(item: Binding(get: { balance.map(BalanceItem.init) }, set: { balance = $0?.balance })) { item in
            BalanceSheet(balance: item.balance)
        }
    }

    private func link(_ title: String, symbol: String, count: Int, route: HRRoute, tag: String) -> some View {
        Button { nav.open(route) } label: { linkLabel(title, symbol: symbol, count: count) }
            .accessibilityIdentifier(tag)
    }

    /// A link to a page that is not a tab, as the platform's sidebar items: a muted icon, the label, its count in a chip.
    private func linkLabel(_ title: String, symbol: String, count: Int) -> some View {
        HStack {
            Label {
                Text(title).foregroundStyle(.primary)
            } icon: {
                Image(systemName: symbol).foregroundStyle(.secondary)
            }
            Spacer()
            if count > 0 { CountChip(count: count) }
            Image(systemName: "chevron.right").font(.inter(.footnote)).foregroundStyle(.tertiary)
        }
    }
}

private struct BalanceItem: Identifiable {
    let balance: HRLeaveBalance
    var id: String { balance.leaveTypeId }
}

/// A balance in figures: allowance, taken, waiting, left.
private struct BalanceSheet: View {
    let balance: HRLeaveBalance

    var body: some View {
        let days = { (value: Double?) in value.map(Fmt.days) ?? HRStrings.balanceUnlimited }
        NavigationStack {
            Form {
                Section {
                    FactRow(label: HRStrings.absenceAllowance, value: days(balance.allowance))
                    FactRow(label: HRStrings.absenceTaken, value: days(balance.used))
                    FactRow(label: HRStrings.absenceWaiting, value: days(balance.pending))
                    FactRow(label: HRStrings.absenceLeft, value: days(balance.remaining))
                } footer: {
                    if balance.prorated { Text(HRStrings.balanceProrated) }
                }
            }
            .navigationTitle(balance.name)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
    }
}

/// Payslips and annual statements. Opening one downloads the PDF with the
/// member's session; the server marks the payslip viewed, so "New" goes.
struct PayView: View {
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @State private var opening: String?
    @State private var preview: URL?

    var body: some View {
        List {
            QueryBody(state: store.payslips, retry: { await store.load(.payslips) }) { payroll in
                switch payroll {
                case .off:
                    HREmpty(HRStrings.payNotEnabled, symbol: "doc.text")
                case let .on(slips):
                    if let latest = slips.first {
                        Section {
                            Button { openPayslip(latest) } label: { LatestPayslip(slip: latest, busy: opening == latest.id) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("payslip-latest")
                        }
                    } else {
                        HREmpty(HRStrings.payNoPayslips, description: HRStrings.payNoPayslipsDescription, symbol: "doc.text")
                    }
                    if slips.count > 1 {
                        Section {
                            ForEach(slips.dropFirst()) { slip in
                                Button { openPayslip(slip) } label: {
                                    // As the platform's payslip rows: medium while unopened, with an outlined "New".
                                    HRRow(
                                        title: Fmt.dateRange(slip.periodStart, slip.periodEnd),
                                        subtitle: HRStrings.payPaidOn(date: Fmt.date(slip.payDate)),
                                        unread: slip.viewedAt == nil,
                                        tag: slip.viewedAt == nil ? HRTag(text: HRStrings.payNew, tone: .outline) : nil
                                    ) {
                                        EmptyView()
                                    } value: {
                                        Text(Fmt.money(slip.netPay, slip.currency)).font(.inter(.subheadline, weight: .medium)).monospacedDigit()
                                    }
                                }
                                .buttonStyle(.plain)
                                .disabled(opening == slip.id)
                                .accessibilityIdentifier("payslip-\(slip.id)")
                            }
                        } header: {
                            GroupHead(title: HRStrings.payEarlier, count: slips.count - 1)
                        }
                    }
                    if let statements = store.statements.data, !statements.isEmpty {
                        Section {
                            ForEach(statements) { statement in
                                Button { openStatement(statement) } label: {
                                    HRRow(
                                        title: statement.kind == "w2" ? HRStrings.payW2(year: String(statement.year)) : HRStrings.payJaaropgaaf(year: String(statement.year)),
                                        subtitle: statement.employerName
                                    )
                                }
                                .buttonStyle(.plain)
                                .disabled(opening == statement.id)
                                .accessibilityIdentifier("statement-\(statement.id)")
                            }
                        } header: {
                            GroupHead(title: HRStrings.payAnnualStatements, count: statements.count)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.payPayslips)
        .refreshable {
            await store.load(.payslips)
            await store.load(.statements)
        }
        .task {
            await store.ensure(.payslips)
            if store.payslips.data?.isOn == true { await store.ensure(.statements) }
        }
        .quickLookPreview($preview)
    }

    private func openPayslip(_ slip: HRPayslip) {
        open(key: slip.id, path: "api/weldhr/me/payslips/\(slip.id)/pdf", fileName: "payslip-\(slip.number ?? slip.periodEnd).pdf")
    }

    private func openStatement(_ statement: HRAnnualStatement) {
        let employer = statement.employerId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? statement.employerId
        open(key: statement.id, path: "api/weldhr/me/annual-statements/\(statement.year)?employerId=\(employer)", fileName: "\(statement.kind)-\(statement.year).pdf")
    }

    private func open(key: String, path: String, fileName: String) {
        opening = key
        Task {
            defer { opening = nil }
            do {
                preview = try await store.download(path: path, fileName: fileName)
                await store.load(.payslips)
            } catch {
                toaster.show(HRStrings.payOpenFailed)
            }
        }
    }
}

/// The newest payslip, large: what most people come here for.
private struct LatestPayslip: View {
    let slip: HRPayslip
    let busy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
            HStack {
                Text(HRStrings.payLatest).font(.inter(.subheadline)).foregroundStyle(.secondary)
                Spacer()
                if slip.viewedAt == nil { ToneBadge(HRStrings.payNew, tone: .outline) }
            }
            Text(Fmt.dateRange(slip.periodStart, slip.periodEnd)).font(.inter(.headline))
            Text(HRStrings.payNetPay).font(.inter(.subheadline)).foregroundStyle(.secondary)
            Text(Fmt.money(slip.netPay, slip.currency)).font(.inter(.largeTitle, weight: .semibold)).monospacedDigit()
            HStack {
                Text("\(HRStrings.payPaidOn(date: Fmt.date(slip.payDate))) · \(HRStrings.payGross(amount: Fmt.money(slip.grossPay, slip.currency)))")
                    .font(.inter(.footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                if busy { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
            }
        }
        .padding(.vertical, Tokens.Spacing.s)
        .contentShape(Rectangle())
    }
}

/// Onboarding and offboarding tasks per checklist, open ones first; ticking one off.
struct TasksView: View {
    @Environment(HRStore.self) private var store

    var body: some View {
        List {
            QueryBody(state: store.tasks, retry: { await store.load(.tasks) }) { tasks in
                let groups = groupTasks(tasks)
                if groups.isEmpty {
                    HREmpty(HRStrings.tasksEmpty, description: HRStrings.tasksEmptyDescription, symbol: "checkmark.square")
                }
                ForEach(groups, id: \.0) { group in
                    Section {
                        ForEach(group.1) { task in TaskRow(task: task) }
                    } header: {
                        GroupHead(
                            title: group.0,
                            count: group.1.count,
                            figure: HRStrings.tasksProgress(done: String(group.1.filter { $0.completedAt != nil }.count), total: String(group.1.count))
                        )
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.tasksTitle)
        .refreshable { await store.load(.tasks) }
        .task { await store.ensure(.tasks) }
    }
}

private struct TaskRow: View {
    let task: HRTask
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @State private var busy = false

    var body: some View {
        let done = task.completedAt != nil
        let overdue = !done && (task.dueDate.map { $0 < HRDays.today() } ?? false)
        Button {
            busy = true
            Task {
                defer { busy = false }
                do {
                    if try await store.completeTask(id: task.id, done: !done) { toaster.show(HRStrings.tasksChecklistDone) }
                } catch {
                    toaster.show(HRFailure.from(error).text)
                }
            }
        } label: {
            // As the platform's: a checkbox, the title (struck through and muted once done),
            // who it is for, and the state pill with the due date.
            HRRow(
                title: task.title,
                subtitle: [task.description, task.canComplete ? nil : HRStrings.tasksAssignedTo(role: Labels.role(task.assigneeRole))]
                    .compactMap { $0 }.joined(separator: "\n"),
                subtitleLines: 3,
                detail: task.dueDate.map(Fmt.day),
                detailColor: overdue ? Tokens.Status.danger : .secondary,
                muted: done,
                strike: done
            ) {
                Group {
                    if busy {
                        ProgressView()
                    } else {
                        Image(systemName: done ? "checkmark.square.fill" : "square")
                            .font(.system(size: 20))
                            .foregroundStyle(done ? Tokens.Palette.primary : .secondary)
                            .opacity(task.canComplete || done ? 1 : 0.4)
                    }
                }
                .frame(width: 28)
            } value: {
                TaskStatePill(state: done ? "done" : overdue ? "overdue" : "open")
            }
        }
        .buttonStyle(.plain)
        .disabled(!task.canComplete || busy)
        .accessibilityLabel(done ? HRStrings.a11yMarkOpen : HRStrings.a11yMarkDone)
        .accessibilityValue(task.title)
        .accessibilityIdentifier("task-\(task.id)")
    }
}

/// A task's state, as the platform's pill: to do grey, overdue red, done green.
private struct TaskStatePill: View {
    let state: String

    var body: some View {
        Text(style.label)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(style.ink)
            .lineLimit(1)
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 2)
            .background(style.fill, in: RoundedRectangle(cornerRadius: 4))
    }

    private var style: (label: String, fill: Color, ink: Color) {
        switch state {
        case "overdue": return (HRStrings.tasksStateOverdue, Color(hrLight: 0xFEF2F2, dark: 0x450A0A), Color(hrLight: 0xDC2626, dark: 0xF87171))
        case "done": return (HRStrings.tasksStateDone, Color(hrLight: 0xECFDF5, dark: 0x022C22), Color(hrLight: 0x059669, dark: 0x34D399))
        default: return (HRStrings.tasksStateOpen, Color(hrLight: 0xF3F4F6, dark: 0x2E3238), Color(hrLight: 0x4B5563, dark: 0xB5BDC9))
        }
    }
}

/// Coaching notes and evaluations shared with the employee; marking one read, with a comment.
struct ReviewsView: View {
    @Environment(HRStore.self) private var store
    @State private var tab = "coaching"
    @State private var target: AcknowledgeTarget?

    var body: some View {
        let openCoaching = (store.coaching.data ?? []).filter { $0.acknowledgedAt == nil }.count
        let openEvaluations = (store.evaluations.data ?? []).filter { $0.acknowledgedAt == nil }.count
        List {
            Section {
                Segments(
                    options: [
                        Segment(value: "coaching", label: HRStrings.reviewsCoaching, tag: "reviews-coaching", count: openCoaching),
                        Segment(value: "evaluations", label: HRStrings.reviewsEvaluations, tag: "reviews-evaluations", count: openEvaluations),
                    ],
                    selection: $tab
                )
                .segmentsRow()
                .listRowBackground(Color.clear)
            }
            if tab == "coaching" {
                QueryBody(state: store.coaching, retry: { await store.load(.coaching) }) { logs in
                    if logs.isEmpty { HREmpty(HRStrings.reviewsNoCoaching, symbol: "text.bubble") }
                    ForEach(logs) { log in
                        Section { CoachingCard(log: log) { target = AcknowledgeTarget(coaching: true, id: log.id) } }
                    }
                }
            } else {
                QueryBody(state: store.evaluations, retry: { await store.load(.evaluations) }) { rows in
                    if rows.isEmpty { HREmpty(HRStrings.reviewsNoEvaluations, symbol: "star") }
                    ForEach(rows) { evaluation in
                        Section { EvaluationCard(evaluation: evaluation) { target = AcknowledgeTarget(coaching: false, id: evaluation.id) } }
                    }
                }
            }
        }
        .navigationTitle(HRStrings.reviewsTitle)
        .refreshable {
            await store.load(.coaching)
            await store.load(.evaluations)
        }
        .task {
            await store.ensure(.coaching)
            await store.ensure(.evaluations)
        }
        .sheet(item: $target) { target in AcknowledgeSheet(target: target) }
    }
}

struct AcknowledgeTarget: Identifiable {
    let coaching: Bool
    let id: String
}

private struct Acknowledged: View {
    let acknowledgedAt: String?
    let comment: String?
    let tag: String
    let onAcknowledge: () -> Void

    var body: some View {
        if let acknowledgedAt {
            if let comment, !comment.isEmpty { Text("\(HRStrings.reviewsYourComment): \(comment)") }
            Label(HRStrings.reviewsAcknowledged(date: Fmt.date(acknowledgedAt)), systemImage: "checkmark.circle.fill")
                .font(.inter(.footnote))
                .foregroundStyle(.secondary)
        } else {
            Button(HRStrings.reviewsAcknowledge, action: onAcknowledge)
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(tag)
        }
    }
}

private struct CoachingCard: View {
    let log: HRCoachingLog
    let onAcknowledge: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack {
                // The platform shows the category as a secondary badge.
                ToneBadge(Labels.coachingCategory(log.category), tone: .secondary)
                Spacer()
                Text(Fmt.date(log.sessionDate)).font(.inter(.caption)).foregroundStyle(.secondary)
            }
            Text(log.topic).font(.inter(.headline))
            if let coach = log.coachName { Text(HRStrings.reviewsBy(name: coach)).font(.inter(.subheadline)).foregroundStyle(.secondary) }
            if let notes = log.notes { Text(notes) }
            if !log.actionItems.isEmpty {
                Text(HRStrings.reviewsActionItems).font(.inter(.footnote, weight: .semibold)).foregroundStyle(.secondary)
                ForEach(log.actionItems) { item in
                    Label(item.text, systemImage: item.done ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(item.done ? Tokens.Status.success : .primary)
                }
            }
            if let followUp = log.followUpDate {
                Text(HRStrings.reviewsFollowUp(date: Fmt.date(followUp))).font(.inter(.subheadline)).foregroundStyle(.secondary)
            }
            Acknowledged(acknowledgedAt: log.acknowledgedAt, comment: log.employeeComment, tag: "acknowledge-\(log.id)", onAcknowledge: onAcknowledge)
        }
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

private struct EvaluationCard: View {
    let evaluation: HREvaluation
    let onAcknowledge: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack {
                Text(evaluation.formName ?? HRStrings.reviewsEvaluations).font(.inter(.headline))
                Spacer()
                // The platform's coloured score badge.
                if let score = evaluation.overallScore { ScoreBadge(score: score) }
            }
            let period: String? = evaluation.periodStart.flatMap { start in evaluation.periodEnd.map { Fmt.dateRange(start, $0) } }
            Text([period, evaluation.evaluatorName.map { HRStrings.reviewsBy(name: $0) }].compactMap { $0 }.joined(separator: " • "))
                .font(.inter(.subheadline))
                .foregroundStyle(.secondary)
            ForEach(evaluation.criteria) { criterion in
                let score = evaluation.scores.first { $0.criterionId == criterion.id }?.score
                HStack {
                    Text(criterion.label)
                    Spacer()
                    Text(score.map { "\(Fmt.days($0))/\(Fmt.days(criterion.maxScore))" } ?? HRStrings.commonDash).monospacedDigit()
                }
            }
            if let summary = evaluation.summary { Text(summary) }
            Acknowledged(acknowledgedAt: evaluation.acknowledgedAt, comment: evaluation.employeeComment, tag: "acknowledge-\(evaluation.id)", onAcknowledge: onAcknowledge)
        }
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

private struct AcknowledgeSheet: View {
    let target: AcknowledgeTarget
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var comment = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                TextField(HRStrings.reviewsCommentPlaceholder, text: $comment, axis: .vertical)
                    .lineLimit(4 ... 10)
                    .accessibilityIdentifier("acknowledge-comment")
                Button {
                    busy = true
                    Task {
                        defer { busy = false }
                        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
                        if await runWrite(toaster, success: HRStrings.reviewsDone, {
                            try await store.acknowledge(coaching: target.coaching, id: target.id, comment: trimmed.isEmpty ? nil : String(trimmed.prefix(5000)))
                        }) { dismiss() }
                    }
                } label: {
                    if busy { ProgressView() } else { Text(HRStrings.reviewsAcknowledge).frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .accessibilityIdentifier("acknowledge-submit")
            }
            .navigationTitle(HRStrings.reviewsAcknowledgeTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
    }
}

/// The employee directory: search by name, role or email (on the server, a moment after typing stops).
struct DirectoryView: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var search = ""
    @State private var query = ""

    var body: some View {
        List {
            QueryBody(state: store.directory(query), retry: { await store.load(.employees(query)) }) { rows in
                if rows.isEmpty {
                    HREmpty(HRStrings.directoryEmpty, description: HRStrings.directoryEmptyDescription, symbol: "person.crop.circle.badge.questionmark")
                }
                ForEach(rows) { employee in
                    Button { nav.open(.employee(employee.id)) } label: {
                        HRRow(
                            title: employee.displayName,
                            subtitle: [employee.jobTitle, employee.departmentName].compactMap { $0 }.joined(separator: " • ").nilIfEmpty ?? employee.email
                        ) { PersonAvatar(name: employee.displayName, url: employee.avatarUrl, size: 32) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("employee-\(employee.id)")
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.directoryTitle)
        .searchable(text: $search, prompt: HRStrings.directorySearch)
        .refreshable { await store.load(.employees(query)) }
        .task(id: search) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            query = search.trimmingCharacters(in: .whitespaces)
        }
        .task(id: query) { await store.ensure(.employees(query)) }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A colleague's card: who they are and how to reach them. Read-only, the public fields only.
struct EmployeeView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let state = store.colleague(id)
        List {
            QueryBody(state: state, retry: { await store.load(.employee(id)) }) { data in
                Section {
                    VStack(spacing: Tokens.Spacing.s) {
                        PersonAvatar(name: data.displayName, url: data.avatarUrl, size: 72)
                        if let job = data.jobTitle { Text(job).font(.inter(size: 16, weight: .medium)).multilineTextAlignment(.center) }
                        if let pronouns = data.pronouns { Text(pronouns).font(.inter(.caption)).foregroundStyle(.secondary) }
                        // The employee status badge, as the platform's Employees list.
                        ToneBadge(Labels.employeeStatus(data.status), tone: .of(data.status))
                        HStack {
                            if let phone = data.phone {
                                Button {
                                    let digits = phone.filter { $0.isNumber || $0 == "+" }
                                    if let url = URL(string: "tel:\(digits)") { UIApplication.shared.open(url) }
                                } label: { Label(HRStrings.directoryCall, systemImage: "phone") }
                                    .accessibilityIdentifier("employee-call")
                            }
                            Button {
                                if let url = URL(string: "mailto:\(data.email)") { UIApplication.shared.open(url) }
                            } label: { Label(HRStrings.directoryEmail, systemImage: "envelope") }
                                .accessibilityIdentifier("employee-email")
                        }
                        .buttonStyle(.bordered)
                        .tint(Tokens.Palette.foreground)
                        .padding(.top, Tokens.Spacing.s)
                    }
                    .frame(maxWidth: .infinity)
                }
                Section {
                    Facts(rows: [
                        (HRStrings.directoryDepartment, data.departmentName),
                        (HRStrings.directoryManager, data.managerName),
                        (HRStrings.directoryLocation, data.location),
                        (HRStrings.directoryStartDate, data.startDate.map(Fmt.date)),
                        (HRStrings.directoryEmailAddress, data.email),
                    ])
                }
                if !data.directReports.isEmpty {
                    Section(HRStrings.directoryReports) {
                        ForEach(data.directReports) { report in
                            Button { nav.open(.employee(report.id)) } label: {
                                HRRow(title: report.displayName, subtitle: report.jobTitle) {
                                    PersonAvatar(name: report.displayName, url: report.avatarUrl, size: 32)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .navigationTitle(state.data?.displayName ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.employee(id)) }
        .task(id: id) { await store.ensure(.employee(id)) }
    }
}
