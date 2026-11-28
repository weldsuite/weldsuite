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
                        HRRow(title: profile.displayName, subtitle: [profile.jobTitle, Labels.employeeStatus(profile.status)].compactMap { $0 }.joined(separator: " • ")) {
                            PersonAvatar(name: profile.displayName, url: profile.avatarUrl, size: 40)
                        }
                        Facts(rows: [
                            (HRStrings.meDepartment, profile.departmentName),
                            (HRStrings.meManager, profile.managerName),
                            (HRStrings.meStartDate, profile.startDate.map(Fmt.date)),
                            (HRStrings.meEmployeeNumberLabel, profile.employeeNumber),
                        ])
                    }
                    if let balances = store.leave.data?.balances, !balances.isEmpty {
                        Section(HRStrings.absenceBalances) {
                            ForEach(balances) { item in
                                Button { balance = item } label: { BalanceRow(balance: item) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("balance-\(item.leaveTypeId)")
                            }
                        }
                    }
                    Section {
                        if store.payslips.data?.isOn == true {
                            link(HRStrings.payPayslips, symbol: "doc.text", count: 0, route: .pay, tag: "profile-pay")
                        }
                        Button { nav.present(.sick) } label: { linkLabel(HRStrings.meSickLeave, symbol: "thermometer.medium", count: 0) }
                            .accessibilityIdentifier("profile-sick")
                        link(HRStrings.meTasks, symbol: "checklist", count: store.overview.data?.openTasks ?? 0, route: .tasks, tag: "profile-tasks")
                        link(HRStrings.meReviews, symbol: "text.bubble", count: store.overview.data?.toAcknowledge ?? 0, route: .reviews, tag: "profile-reviews")
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

    private func linkLabel(_ title: String, symbol: String, count: Int) -> some View {
        HStack {
            Label(title, systemImage: symbol).foregroundStyle(.primary)
            Spacer()
            if count > 0 {
                Text(String(count))
                    .font(.inter(.caption, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Tokens.Palette.primary, in: Capsule())
            }
            Image(systemName: "chevron.right").font(.inter(.footnote)).foregroundStyle(.tertiary)
        }
    }
}

private struct BalanceItem: Identifiable {
    let balance: HRLeaveBalance
    var id: String { balance.leaveTypeId }
}

/// A leave type with a ring for how much is left and the days left on the right.
private struct BalanceRow: View {
    let balance: HRLeaveBalance

    var body: some View {
        let fraction: Double = {
            guard let allowance = balance.allowance, let remaining = balance.remaining else { return 1 }
            return allowance > 0 ? min(1, max(0, remaining / allowance)) : 0
        }()
        let color = Swatches.hex(balance.color).map { Color(hrRGB: $0) } ?? Tokens.Palette.primary
        HRRow(
            title: balance.name,
            value: balance.remaining.map { HRStrings.absenceRemaining(amount: Fmt.daysText($0)) } ?? HRStrings.balanceUnlimited
        ) {
            ZStack {
                Circle().stroke(Color(.systemGray5), lineWidth: 3)
                Circle().trim(from: 0, to: fraction).stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 26, height: 26)
            .accessibilityHidden(true)
        }
    }
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
                    ContentUnavailableView(HRStrings.payNotEnabled, systemImage: "doc.text")
                case let .on(slips):
                    if let latest = slips.first {
                        Section {
                            Button { openPayslip(latest) } label: { LatestPayslip(slip: latest, busy: opening == latest.id) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("payslip-latest")
                        }
                    } else {
                        ContentUnavailableView(HRStrings.payNoPayslips, systemImage: "doc.text", description: Text(HRStrings.payNoPayslipsDescription))
                    }
                    if slips.count > 1 {
                        Section(HRStrings.payEarlier) {
                            ForEach(slips.dropFirst()) { slip in
                                Button { openPayslip(slip) } label: {
                                    HRRow(
                                        title: Fmt.dateRange(slip.periodStart, slip.periodEnd),
                                        subtitle: HRStrings.payPaidOn(date: Fmt.date(slip.payDate)),
                                        value: Fmt.money(slip.netPay, slip.currency),
                                        detail: slip.viewedAt == nil ? HRStrings.payNew : nil,
                                        detailColor: Tokens.Palette.primary
                                    ) { IconTile(symbol: "doc.text") }
                                }
                                .buttonStyle(.plain)
                                .disabled(opening == slip.id)
                                .accessibilityIdentifier("payslip-\(slip.id)")
                            }
                        }
                    }
                    if let statements = store.statements.data, !statements.isEmpty {
                        Section(HRStrings.payAnnualStatements) {
                            ForEach(statements) { statement in
                                Button { openStatement(statement) } label: {
                                    HRRow(
                                        title: statement.kind == "w2" ? HRStrings.payW2(year: String(statement.year)) : HRStrings.payJaaropgaaf(year: String(statement.year)),
                                        subtitle: statement.employerName
                                    ) { IconTile(symbol: "doc.text") }
                                }
                                .buttonStyle(.plain)
                                .disabled(opening == statement.id)
                                .accessibilityIdentifier("statement-\(statement.id)")
                            }
                        }
                    }
                }
            }
        }
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
                Text(HRStrings.payLatest).foregroundStyle(.secondary)
                Spacer()
                if slip.viewedAt == nil { Text(HRStrings.payNew).font(.inter(.subheadline, weight: .semibold)).foregroundStyle(Tokens.Palette.primary) }
            }
            Text(Fmt.dateRange(slip.periodStart, slip.periodEnd)).font(.inter(.headline))
            Text(HRStrings.payNetPay).foregroundStyle(.secondary)
            Text(Fmt.money(slip.netPay, slip.currency)).font(.inter(.largeTitle, weight: .bold)).monospacedDigit()
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
                    ContentUnavailableView(HRStrings.tasksEmpty, systemImage: "checklist", description: Text(HRStrings.tasksEmptyDescription))
                }
                ForEach(groups, id: \.0) { group in
                    Section {
                        ForEach(group.1) { task in TaskRow(task: task) }
                    } header: {
                        HeadWithFigure(title: group.0, figure: "\(group.1.filter { $0.completedAt != nil }.count)/\(group.1.count)")
                    }
                }
            }
        }
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
            HRRow(
                title: task.title,
                subtitle: overdue ? task.dueDate.map { HRStrings.tasksDue(date: Fmt.day($0)) } : task.description,
                subtitleColor: overdue ? Tokens.Status.danger : .secondary,
                subtitleLines: 3,
                value: task.dueDate.map(Fmt.day),
                detail: task.canComplete ? nil : HRStrings.tasksAssignedTo(role: Labels.role(task.assigneeRole)),
                muted: done,
                strike: done
            ) {
                Group {
                    if busy {
                        ProgressView()
                    } else {
                        Image(systemName: done ? "checkmark.circle.fill" : "circle")
                            .font(.inter(.title2))
                            .foregroundStyle(done ? Tokens.Palette.primary : .secondary)
                            .opacity(task.canComplete || done ? 1 : 0.4)
                    }
                }
                .frame(width: 28)
            }
        }
        .buttonStyle(.plain)
        .disabled(!task.canComplete || busy)
        .accessibilityLabel(done ? HRStrings.a11yMarkOpen : HRStrings.a11yMarkDone)
        .accessibilityValue(task.title)
        .accessibilityIdentifier("task-\(task.id)")
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
                        Segment(value: "coaching", label: withCount(HRStrings.reviewsCoaching, openCoaching), tag: "reviews-coaching"),
                        Segment(value: "evaluations", label: withCount(HRStrings.reviewsEvaluations, openEvaluations), tag: "reviews-evaluations"),
                    ],
                    selection: $tab
                )
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            if tab == "coaching" {
                QueryBody(state: store.coaching, retry: { await store.load(.coaching) }) { logs in
                    if logs.isEmpty { ContentUnavailableView(HRStrings.reviewsNoCoaching, systemImage: "text.bubble") }
                    ForEach(logs) { log in
                        Section { CoachingCard(log: log) { target = AcknowledgeTarget(coaching: true, id: log.id) } }
                    }
                }
            } else {
                QueryBody(state: store.evaluations, retry: { await store.load(.evaluations) }) { rows in
                    if rows.isEmpty { ContentUnavailableView(HRStrings.reviewsNoEvaluations, systemImage: "text.bubble") }
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
                Text(Labels.coachingCategory(log.category))
                    .font(.inter(.subheadline, weight: .semibold))
                    .foregroundStyle(log.category == "recognition" ? Tokens.Status.success : Tokens.Palette.primary)
                Spacer()
                Text(Fmt.date(log.sessionDate)).font(.inter(.subheadline)).foregroundStyle(.secondary)
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
                if let score = evaluation.overallScore {
                    Text(HRStrings.reviewsScore(score: Fmt.days(score))).font(.inter(.subheadline, weight: .semibold)).foregroundStyle(Tokens.Palette.primary)
                }
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
                    ContentUnavailableView(HRStrings.directoryEmpty, systemImage: "person.3", description: Text(HRStrings.directoryEmptyDescription))
                }
                ForEach(rows) { employee in
                    Button { nav.open(.employee(employee.id)) } label: {
                        HRRow(
                            title: employee.displayName,
                            subtitle: [employee.jobTitle, employee.departmentName].compactMap { $0 }.joined(separator: " • ").nilIfEmpty ?? employee.email
                        ) { PersonAvatar(name: employee.displayName, url: employee.avatarUrl) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("employee-\(employee.id)")
                }
            }
        }
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
                    VStack(spacing: Tokens.Spacing.xs) {
                        PersonAvatar(name: data.displayName, url: data.avatarUrl, size: 84)
                        if let job = data.jobTitle { Text(job).font(.inter(.headline)).multilineTextAlignment(.center) }
                        Text([Labels.employeeStatus(data.status), data.pronouns].compactMap { $0 }.joined(separator: " • ")).foregroundStyle(.secondary)
                        HStack {
                            if let phone = data.phone {
                                Button {
                                    let digits = phone.filter { $0.isNumber || $0 == "+" }
                                    if let url = URL(string: "tel:\(digits)") { UIApplication.shared.open(url) }
                                } label: { Label(HRStrings.directoryCall, systemImage: "phone") }
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("employee-call")
                            }
                            Button {
                                if let url = URL(string: "mailto:\(data.email)") { UIApplication.shared.open(url) }
                            } label: { Label(HRStrings.directoryEmail, systemImage: "envelope") }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("employee-email")
                        }
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
                                    PersonAvatar(name: report.displayName, url: report.avatarUrl)
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
