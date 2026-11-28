import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// A day picker on `yyyy-MM-dd` strings, within `min` and `max`.
struct DayField: View {
    let label: String
    @Binding var value: String
    var min: String?
    var max: String?
    var tag: String?

    var body: some View {
        let lower = min.flatMap { HRDays.parse($0) } ?? Date.distantPast
        let upper = max.flatMap { HRDays.parse($0) } ?? Date.distantFuture
        DatePicker(
            label,
            selection: Binding(get: { HRDays.parse(value) ?? Date() }, set: { value = HRDays.string($0) }),
            in: lower ... upper,
            displayedComponents: .date
        )
        .accessibilityIdentifier(tag ?? "")
    }
}

/// The close button and the action (Submit, Post) of a form sheet.
private struct FormChrome: ViewModifier {
    let title: String
    let action: String?
    var actionTag: String?
    var enabled = true
    var busy = false
    var onAction: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonClose) { dismiss() }
                        .accessibilityIdentifier("form-close")
                }
                if let action {
                    ToolbarItem(placement: .confirmationAction) {
                        if busy {
                            ProgressView()
                        } else {
                            Button(action, action: onAction)
                                .disabled(!enabled)
                                .accessibilityIdentifier(actionTag ?? "")
                        }
                    }
                }
            }
            .interactiveDismissDisabled(busy)
    }
}

private extension View {
    func formChrome(_ title: String, action: String?, tag: String? = nil, enabled: Bool = true, busy: Bool = false, onAction: @escaping () -> Void = {}) -> some View {
        modifier(FormChrome(title: title, action: action, actionTag: tag, enabled: enabled, busy: busy, onAction: onAction))
    }
}

/// A hint under a field, red for an error.
private struct Hint: View {
    let text: String?
    var error = false

    var body: some View {
        if let text, !text.isEmpty {
            Text(text)
                .font(.footnote)
                .foregroundStyle(error ? Tokens.Status.danger : .secondary)
                .accessibilityIdentifier(error ? "form-error" : "")
        }
    }
}

/// Requesting time off: the type with its balance, the days, and a reason.
struct LeaveForm: View {
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var typeId: String?
    @State private var start = HRDays.nextWeekday(HRDays.today())
    @State private var end = HRDays.nextWeekday(HRDays.today())
    @State private var reason = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Group {
            if store.me.data?.features.leaveRequests == false {
                Form { Hint(text: HRStrings.timeOffTurnedOff) }
                    .formChrome(HRStrings.leaveFormTitle, action: nil)
            } else if let data = store.leave.data {
                form(data)
            } else {
                Form {
                    if store.leave.error != nil { Hint(text: apiErrorMessage(store.leave.error), error: true) } else { ProgressView() }
                }
                .formChrome(HRStrings.leaveFormTitle, action: nil)
            }
        }
        .task { await store.ensure(.leave) }
    }

    private func form(_ data: HRLeave) -> some View {
        let today = HRDays.today()
        let type = data.types.first { $0.id == typeId }
        let balance = LeaveRules.balanceForStart(data.balances, leaveTypeId: typeId, startDate: start, today: today)
        let days = HRDays.weekdaysBetween(start, end)
        let allowance = LeaveRules.checkAllowance(balance, days: days)
        let blocked = allowance.excess?.blocked ?? false
        let balances = start.prefix(4) == today.prefix(4) ? data.balances : []
        return Form {
            Section(HRStrings.leaveFormType) {
                ForEach(data.types) { option in
                    let optionBalance = balances.first { $0.leaveTypeId == option.id }
                    Button { typeId = option.id } label: {
                        HStack(spacing: Tokens.Spacing.m) {
                            LeaveTypeTile(color: option.color)
                            VStack(alignment: .leading) {
                                Text(option.name).foregroundStyle(.primary)
                                if let remaining = optionBalance?.remaining {
                                    Text("\(HRStrings.balanceLeft(days: Fmt.days(remaining))) · \(HRStrings.balanceOfAllowance(days: Fmt.days(optionBalance?.allowance ?? 0)))")
                                        .font(.footnote).foregroundStyle(.secondary)
                                } else if optionBalance != nil {
                                    Text(HRStrings.balanceUnlimited).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if option.id == typeId { Image(systemName: "checkmark").foregroundStyle(Tokens.Brand.weldhr) }
                        }
                    }
                    .accessibilityIdentifier("leave-type-\(option.id)")
                }
            }
            Section {
                DayField(label: HRStrings.leaveFormFrom, value: Binding(get: { start }, set: { next in
                    start = next
                    if end < next { end = next }
                }), tag: "leave-from")
                DayField(label: HRStrings.leaveFormTo, value: $end, min: start, tag: "leave-to")
            } footer: {
                VStack(alignment: .leading) {
                    Text(HRStrings.leaveFormEstimate(days))
                    if let over = allowance.excess {
                        Text(over.blocked ? HRStrings.leaveFormOverAllowanceBlocked(days: Fmt.days(over.remaining)) : HRStrings.leaveFormOverAllowance(days: Fmt.days(over.remaining)))
                            .foregroundStyle(over.blocked ? Tokens.Status.danger : Tokens.Status.warning)
                    }
                }
            }
            Section {
                TextField(HRStrings.leaveFormReasonPlaceholder, text: $reason, axis: .vertical)
                    .lineLimit(3 ... 6)
                    .accessibilityIdentifier("leave-reason")
            } header: {
                Text(HRStrings.leaveFormReason)
            } footer: {
                if let error {
                    Hint(text: error, error: true)
                } else if let type {
                    Text(type.requiresApproval ? HRStrings.leaveFormNeedsApproval : HRStrings.leaveFormAutoApproved)
                }
            }
        }
        .formChrome(HRStrings.leaveFormTitle, action: HRStrings.commonSubmit, tag: "leave-submit", enabled: !blocked && typeId != nil, busy: busy) {
            submit()
        }
        .onAppear { if typeId == nil, data.types.count == 1 { typeId = data.types.first?.id } }
    }

    private func submit() {
        error = nil
        guard let typeId else { error = HRStrings.leaveFormChooseType; return }
        guard end >= start else { error = HRStrings.leaveFormEndBeforeStart; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                let status = try await store.requestLeave(typeId: typeId, startDate: start, endDate: end, reason: trimmed.isEmpty ? nil : String(trimmed.prefix(2000)))
                toaster.show(status == "approved" ? HRStrings.leaveFormApproved : HRStrings.leaveFormSent)
                dismiss()
            } catch {
                self.error = HRFailure.from(error).text
            }
        }
    }
}

/// The camera, for a photo of a receipt (SwiftUI has no camera view of its own).
private struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onImage: onImage) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void

        init(onImage: @escaping (UIImage?) -> Void) {
            self.onImage = onImage
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onImage(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
        }
    }
}

/// A new expense: amount, currency, day, category, what for, and the receipt (camera or photos).
struct ExpenseForm: View {
    let start: String?
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var currency = "EUR"
    @State private var date = HRDays.today()
    @State private var category = "travel"
    @State private var description = ""
    @State private var receipt: HRPickedFile?
    @State private var photo: PhotosPickerItem?
    @State private var showLibrary = false
    @State private var showCamera = false
    @State private var started = false
    @State private var error: String?
    @State private var busy = false

    private static let currencies = ["EUR", "USD", "GBP"]

    var body: some View {
        if store.me.data?.features.declarations == false {
            Form { Hint(text: HRStrings.expensesTurnedOff) }
                .formChrome(HRStrings.expenseFormTitle, action: nil)
        } else {
            form
        }
    }

    private var form: some View {
        Form {
            Section(HRStrings.expenseFormAmount) {
                TextField(HRStrings.expenseFormAmountPlaceholder, text: $amount)
                    .keyboardType(.decimalPad)
                    .accessibilityIdentifier("expense-amount")
                Picker(HRStrings.expenseFormCurrency, selection: $currency) {
                    ForEach(Self.currencies, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("expense-currency")
            }
            Section {
                DayField(label: HRStrings.expenseFormDate, value: $date, max: HRDays.today(), tag: "expense-date")
                Picker(HRStrings.expenseFormCategory, selection: $category) {
                    ForEach(ExpenseFilter.allCategories, id: \.self) { Text(Labels.category($0)).tag($0) }
                }
                .accessibilityIdentifier("expense-category")
            }
            Section(HRStrings.expenseFormDescription) {
                TextField(HRStrings.expenseFormDescriptionPlaceholder, text: $description, axis: .vertical)
                    .lineLimit(2 ... 5)
                    .accessibilityIdentifier("expense-description")
            }
            Section {
                if let receipt {
                    HStack {
                        Image(systemName: receipt.mimeType == "application/pdf" ? "doc" : "photo")
                        Text(receipt.name).lineLimit(1)
                        Spacer()
                        Button(HRStrings.expenseFormRemoveReceipt, role: .destructive) { self.receipt = nil }
                            .buttonStyle(.borderless)
                            .accessibilityIdentifier("expense-receipt-remove")
                    }
                } else {
                    Button { openCamera() } label: { Label(HRStrings.expenseFormTakePhoto, systemImage: "camera") }
                        .accessibilityIdentifier("expense-take-photo")
                    Button { showLibrary = true } label: { Label(HRStrings.expenseFormChoosePhoto, systemImage: "photo.on.rectangle") }
                        .accessibilityIdentifier("expense-choose-photo")
                }
            } header: {
                Text(HRStrings.expenseFormReceipt)
            } footer: {
                Hint(text: error, error: true)
            }
        }
        .formChrome(HRStrings.expenseFormTitle, action: HRStrings.commonSubmit, tag: "expense-submit", busy: busy) { submit() }
        // The system photo picker: no photo library permission.
        .photosPicker(isPresented: $showLibrary, selection: $photo, matching: .images)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image { take(image) }
            }
            .ignoresSafeArea()
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                    take(image)
                } else {
                    error = HRStrings.expenseFormReceiptType
                }
                photo = nil
            }
        }
        .onAppear {
            // From the "+" on Expenses: start with the receipt, once.
            guard !started else { return }
            started = true
            if start == "camera" { openCamera() } else if start == "library" { showLibrary = true }
        }
    }

    private func openCamera() {
        error = nil
        // A simulator has no camera.
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            error = HRStrings.expenseFormNoCamera
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            error = HRStrings.expenseFormCameraDenied
        case .notDetermined:
            Task {
                if await AVCaptureDevice.requestAccess(for: .video) {
                    showCamera = true
                } else {
                    error = HRStrings.expenseFormCameraDenied
                }
            }
        default:
            showCamera = true
        }
    }

    /// A photo as a JPEG receipt (HEIC and the like are not taken), refused above 10 MB.
    private func take(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.7) else {
            error = HRStrings.expenseFormReceiptType
            return
        }
        if Receipts.problem(mimeType: "image/jpeg", size: data.count) == .size {
            error = HRStrings.expenseFormReceiptSize
            return
        }
        error = nil
        receipt = HRPickedFile(name: Receipts.fileName(nil, mimeType: "image/jpeg", today: HRDays.today()), mimeType: "image/jpeg", data: data)
    }

    private func submit() {
        error = nil
        guard let value = parseAmount(amount) else { error = HRStrings.expenseFormAmountInvalid; return }
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { error = HRStrings.expenseFormDescriptionRequired; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let withReceipt = try await store.createDeclaration(
                    amount: value, currency: currency, expenseDate: date, category: category, description: String(text.prefix(2000)), receipt: receipt
                )
                toaster.show(withReceipt ? HRStrings.expenseFormSent : HRStrings.expenseFormSentNoReceipt)
                dismiss()
            } catch {
                self.error = HRFailure.from(error).text
            }
        }
    }
}

/// Report sick, or "I'm better" while a report is open. Always available: an ill employee has to be able to say so.
struct SickForm: View {
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var start = HRDays.today()
    @State private var firstDay = "full"
    @State private var note = ""
    @State private var end: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Group {
            if let data = store.absences.data {
                if let current = data.current {
                    recover(current, history: data.history)
                } else {
                    report(history: data.history)
                }
            } else {
                Form {
                    if store.absences.error != nil { Hint(text: apiErrorMessage(store.absences.error), error: true) } else { ProgressView() }
                }
                .formChrome(HRStrings.sickTitle, action: nil)
            }
        }
        .task { await store.ensure(.absences) }
    }

    private func report(history: [HRAbsence]) -> some View {
        let today = HRDays.today()
        return Form {
            Section {
                // A report can start a few days back (ill over the weekend), never in the future.
                DayField(label: HRStrings.sickFirstDay, value: $start, min: HRDays.add(today, -14), max: today, tag: "sick-first-day")
                Picker(HRStrings.sickFirstDayLength, selection: $firstDay) {
                    Text(HRStrings.sickFullDay).tag("full")
                    Text(HRStrings.sickHalfDay).tag("half")
                }
                .accessibilityIdentifier("sick-length")
            }
            Section {
                TextField(HRStrings.sickNotePlaceholder, text: $note, axis: .vertical)
                    .lineLimit(2 ... 5)
                    .accessibilityIdentifier("sick-note")
            } header: {
                Text(HRStrings.sickNote)
            } footer: {
                if let error { Hint(text: error, error: true) } else { Text(HRStrings.sickNoteHint) }
            }
            HistorySection(history: history)
        }
        .formChrome(HRStrings.sickTitle, action: HRStrings.commonSubmit, tag: "sick-submit", busy: busy) {
            run(success: HRStrings.sickReported) {
                let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                try await store.reportSick(startDate: start, firstDay: firstDay, note: trimmed.isEmpty ? nil : String(trimmed.prefix(1000)))
            }
        }
    }

    private func recover(_ current: HRAbsence, history: [HRAbsence]) -> some View {
        let today = HRDays.today()
        // Most people report it the morning they are back, so yesterday was the last sick day.
        let suggested = max(HRDays.add(today, -1), current.startDate)
        return Form {
            Section {
                DayField(label: HRStrings.sickLastDay, value: Binding(get: { end ?? suggested }, set: { end = $0 }), min: current.startDate, max: today, tag: "sick-last-day")
            } footer: {
                if let error { Hint(text: error, error: true) } else { Text(HRStrings.sickRecoverHint(date: Fmt.day(current.startDate))) }
            }
            HistorySection(history: history)
        }
        .formChrome(HRStrings.sickRecoverTitle, action: HRStrings.commonSubmit, tag: "sick-recover-submit", busy: busy) {
            run(success: HRStrings.sickRecovered) { try await store.reportRecovered(id: current.id, endDate: end ?? suggested) }
        }
    }

    private func run(success: String, _ work: @escaping () async throws -> Void) {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await work()
                toaster.show(success)
                dismiss()
            } catch {
                self.error = HRFailure.from(error).text
            }
        }
    }
}

/// The last reports, under the form: when and how many days.
private struct HistorySection: View {
    let history: [HRAbsence]

    var body: some View {
        if !history.isEmpty {
            Section(HRStrings.sickHistory) {
                ForEach(history.prefix(10)) { absence in
                    LabeledContent(Fmt.dateRange(absence.startDate, absence.endDate ?? absence.startDate), value: Fmt.daysText(absence.days))
                }
            }
        }
    }
}

/// Asking to work a shift: the day, from and until (until before from ends the next day), the work and a note.
struct ShiftRequestForm: View {
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var day = HRDays.add(HRDays.today(), 1)
    @State private var from = HRShiftTimes.date(hour: 9)
    @State private var until = HRShiftTimes.date(hour: 17)
    @State private var work = ""
    @State private var note = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let span = HRShiftTimes.span(day: day, from: from, until: until)
        Form {
            Section {
                DayField(label: HRStrings.shiftRequestDay, value: $day, min: HRDays.today(), tag: "shift-request-day")
                DatePicker(HRStrings.shiftRequestFrom, selection: $from, displayedComponents: .hourAndMinute)
                    .accessibilityIdentifier("shift-request-from")
                DatePicker(HRStrings.shiftRequestTo, selection: $until, displayedComponents: .hourAndMinute)
                    .accessibilityIdentifier("shift-request-until")
            } footer: {
                Text([Fmt.hm(span.minutes), span.nextDay ? HRStrings.shiftRequestNextDay : nil].compactMap { $0 }.joined(separator: " · "))
            }
            Section(HRStrings.shiftRequestWork) {
                TextField(HRStrings.shiftRequestWorkPlaceholder, text: $work)
                    .accessibilityIdentifier("shift-request-work")
            }
            Section {
                TextField(HRStrings.shiftRequestNotePlaceholder, text: $note, axis: .vertical)
                    .lineLimit(2 ... 5)
                    .accessibilityIdentifier("shift-request-note")
            } header: {
                Text(HRStrings.shiftRequestNote)
            } footer: {
                if let error { Hint(text: error, error: true) } else { Text(HRStrings.shiftRequestHint) }
            }
        }
        .formChrome(HRStrings.shiftRequestTitle, action: HRStrings.commonSubmit, tag: "shift-request-submit", busy: busy) { submit(span) }
    }

    private func submit(_ span: HRShiftTimes.Span) {
        error = nil
        guard let startsAt = span.start, let endsAt = span.end, startsAt > Date() else {
            error = HRStrings.shiftRequestInPast
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                let workText = work.trimmingCharacters(in: .whitespacesAndNewlines)
                let noteText = note.trimmingCharacters(in: .whitespacesAndNewlines)
                try await store.requestShift(
                    startsAt: WeldDate.timestampString(startsAt),
                    endsAt: WeldDate.timestampString(endsAt),
                    workType: workText.isEmpty ? nil : String(workText.prefix(100)),
                    note: noteText.isEmpty ? nil : String(noteText.prefix(1000))
                )
                toaster.show(HRStrings.shiftRequestSent)
                dismiss()
            } catch {
                self.error = HRFailure.from(error).text
            }
        }
    }
}

/// The times of a shift request: the day at "from", until on the same day or, at or before "from", the next.
enum HRShiftTimes {
    struct Span: Equatable {
        let start: Date?
        let end: Date?
        let nextDay: Bool

        var minutes: Double {
            guard let start, let end else { return 0 }
            return end.timeIntervalSince(start) / 60
        }
    }

    /// Today at `hour`:00, for a time picker's default.
    static func date(hour: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
    }

    static func span(day: String, from: Date, until: Date, calendar: Calendar = .current) -> Span {
        let fromParts = calendar.dateComponents([.hour, .minute], from: from)
        let untilParts = calendar.dateComponents([.hour, .minute], from: until)
        let fromMinutes = (fromParts.hour ?? 0) * 60 + (fromParts.minute ?? 0)
        let untilMinutes = (untilParts.hour ?? 0) * 60 + (untilParts.minute ?? 0)
        let nextDay = untilMinutes <= fromMinutes
        guard let base = HRDays.parse(day) else { return Span(start: nil, end: nil, nextDay: nextDay) }
        let start = calendar.date(byAdding: .minute, value: fromMinutes, to: base)
        let endBase = nextDay ? calendar.date(byAdding: .day, value: 1, to: base) : base
        let end = endBase.flatMap { calendar.date(byAdding: .minute, value: untilMinutes, to: $0) }
        return Span(start: start, end: end, nextDay: nextDay)
    }
}

/// Posting an announcement to every employee: title, message, pinned, and a push.
struct AnnouncementForm: View {
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var message = ""
    @State private var pinned = false
    @State private var notify = false
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let ready = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        Form {
            Section(HRStrings.announcementFormTitleLabel) {
                TextField(HRStrings.announcementFormTitlePlaceholder, text: $title)
                    .accessibilityIdentifier("announcement-title")
            }
            Section {
                TextField(HRStrings.announcementFormBodyPlaceholder, text: $message, axis: .vertical)
                    .lineLimit(6 ... 20)
                    .accessibilityIdentifier("announcement-body")
            } header: {
                Text(HRStrings.announcementFormBody)
            } footer: {
                Hint(text: error, error: true)
            }
            Section {
                Toggle(isOn: $pinned) {
                    VStack(alignment: .leading) {
                        Text(HRStrings.announcementFormPinned)
                        Text(HRStrings.announcementFormPinnedHint).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("announcement-pinned")
                Toggle(isOn: $notify) {
                    VStack(alignment: .leading) {
                        Text(HRStrings.announcementFormNotify)
                        Text(HRStrings.announcementFormNotifyHint).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("announcement-notify")
            }
        }
        .formChrome(HRStrings.announcementFormTitle, action: HRStrings.announcementFormPost, tag: "announcement-submit", enabled: ready, busy: busy) {
            error = nil
            busy = true
            Task {
                defer { busy = false }
                do {
                    try await store.createAnnouncement(
                        title: String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)),
                        body: String(message.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20000)),
                        pinned: pinned,
                        notify: notify
                    )
                    toaster.show(HRStrings.announcementFormPosted)
                    dismiss()
                } catch {
                    self.error = HRStrings.announcementFormFailed
                }
            }
        }
    }
}
