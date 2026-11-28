import WeldBooksAPI
import WeldCore
import XCTest
@testable import WeldBooks

/// The port of Android's `BooksLogicTest.kt`, case for case, and the iOS-only helpers.
final class BooksLogicTests: XCTestCase {
    private func d(_ text: String) -> Decimal {
        Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) ?? .nan
    }

    private func day(_ year: Int, _ month: Int, _ day: Int) -> Day {
        guard let value = Day(year: year, month: month, day: day) else {
            XCTFail("not a day: \(year)-\(month)-\(day)")
            return Day(epochDay: 0)
        }
        return value
    }

    // MARK: - Amounts and days

    func testTypedAmountsReadInEuropeanAndUsStyle() {
        XCTAssertEqual(Amounts.parse("1.234,56"), d("1234.56"))
        XCTAssertEqual(Amounts.parse("1,234.56", decimalPoint: true), d("1234.56"))
        XCTAssertEqual(Amounts.parse("1,234", decimalPoint: true), d("1234"))
        XCTAssertEqual(Amounts.parse("1,234"), d("1.234"))
        XCTAssertEqual(Amounts.parse("€ 12,5"), d("12.5"))
        XCTAssertEqual(Amounts.parse("12."), d("12"))
        XCTAssertEqual(Amounts.parse(""), 0)
        XCTAssertEqual(Amounts.parse("-"), 0)
    }

    func testServerDecimalsReadAsNumbersAndGoBackWithoutTrailingZeros() {
        XCTAssertEqual(Amounts.of("121.00"), d("121.00"))
        XCTAssertEqual(Amounts.of(nil as String?), 0)
        XCTAssertEqual(Amounts.of("abc"), 0)
        XCTAssertEqual(Amounts.of("12abc"), 0)
        XCTAssertEqual(Amounts.plain(d("2.000")), "2")
        XCTAssertEqual(Amounts.plain(d("12.50")), "12.5")
        XCTAssertEqual(Amounts.plain(d("-0.00")), "0")
        XCTAssertEqual(Amounts.percent(d("21.0000")), "21")
        XCTAssertEqual(Amounts.percent(d("9.50")), "9.5")
    }

    func testJsonNumbersAndRoundingHalfUp() {
        XCTAssertEqual(Amounts.of(1.75 as Double?), d("1.75"))
        XCTAssertEqual(Amounts.of(0.1 as Double?), d("0.1"))
        XCTAssertEqual(Amounts.of(Double.nan as Double?), 0)
        XCTAssertEqual(Amounts.of(nil as Double?), 0)
        XCTAssertEqual(Amounts.round(d("2.345"), scale: 2), d("2.35"))
        XCTAssertEqual(Amounts.round(d("-2.345"), scale: 2), d("-2.35"))
        XCTAssertEqual(Amounts.cents(d("3.125")), d("3.13"))
        XCTAssertEqual(Amounts.int(d("12")), 12)
        XCTAssertEqual(Amounts.plain(d("1234567.891")), "1234567.891")
    }

    func testDatesAreCalendarDaysAndOverdueNeedsAnOpenBalance() {
        let today = day(2026, 11, 27)
        XCTAssertEqual(Days.of("2026-11-01T00:00:00.000Z"), day(2026, 11, 1))
        XCTAssertNil(Days.of("2026-11"))
        XCTAssertNil(Days.of(nil))
        XCTAssertEqual(Days.until(day(2026, 11, 24), today: today), -3)
        XCTAssertTrue(Days.isOverdue("2026-11-20", balanceDue: d("10"), today: today))
        XCTAssertFalse(Days.isOverdue("2026-11-20", balanceDue: 0, today: today))
        XCTAssertFalse(Days.isOverdue("2026-11-27", balanceDue: d("10"), today: today))
        let month = Days.monthRange(today: today)
        XCTAssertEqual(month.0, day(2026, 11, 1))
        XCTAssertEqual(month.1, day(2026, 11, 30))
        let year = Days.yearRange(today: today)
        XCTAssertEqual(year.0, day(2026, 1, 1))
        XCTAssertEqual(year.1, day(2026, 12, 31))
    }

    func testDaysAreRealCalendarDaysWithPureArithmetic() {
        XCTAssertNotNil(Day(iso: "2024-02-29"))
        XCTAssertNil(Day(iso: "2026-02-29"))
        XCTAssertNil(Day(iso: "2026-13-01"))
        XCTAssertNil(Day(iso: "27-11-2026"))
        XCTAssertEqual(day(1970, 1, 1).epochDay, 0)
        XCTAssertEqual(day(1969, 12, 31).epochDay, -1)
        let today = day(2026, 11, 27)
        XCTAssertEqual(Day(epochDay: today.epochDay), today)
        XCTAssertEqual(today.adding(days: 5), day(2026, 12, 2))
        XCTAssertEqual(day(2024, 3, 1).adding(days: -1), day(2024, 2, 29))
        XCTAssertEqual(day(2026, 1, 5).iso, "2026-01-05")
        XCTAssertEqual(day(2026, 2, 10).lastOfMonth, day(2026, 2, 28))
        XCTAssertTrue(day(2026, 11, 26) < today)
        // Midnight on the phone's clock and back is the same day.
        XCTAssertEqual(Day(date: today.date()), today)
    }

    func testKpiTilesShortenThousandsAndLeaveSmallAmountsExact() {
        let uk = Locale(identifier: "en_GB")
        XCTAssertEqual(formatCompact(d("12345"), currency: "EUR", locale: uk), "€12.3K")
        XCTAssertEqual(formatCompact(d("1500000"), currency: "EUR", locale: uk), "€1.5M")
        XCTAssertFalse(formatCompact(d("999"), currency: "EUR", locale: uk).contains("K"))
    }

    func testMoneyAndDaysFollowTheCompanysLocale() {
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(formatDay(day(2026, 11, 27), locale: us), "11/27/2026")
        XCTAssertEqual(formatShortDay(day(2026, 11, 27), locale: us), "11/27")
        XCTAssertEqual(formatMoney(d("1234.5"), currency: "USD", locale: us), "$1,234.50")
        XCTAssertTrue(formatMoney(d("1234.5"), currency: "XYZ", locale: us).hasPrefix("XYZ "))
    }

    // MARK: - Statuses

    func testAnOpenInvoicePastItsDueDateIsOverdueAPartialOnePartlyPaid() {
        let today = day(2026, 11, 27)
        XCTAssertEqual(Statuses.invoice("sent", dueDate: "2026-11-01", balanceDue: d("50"), today: today), "overdue")
        XCTAssertEqual(Statuses.invoice("sent", dueDate: "2026-12-01", balanceDue: d("50"), today: today), "sent")
        XCTAssertEqual(Statuses.invoice("partial", dueDate: "2026-12-01", balanceDue: d("50"), today: today), "partially_paid")
        XCTAssertEqual(Statuses.invoice("draft", dueDate: "2026-11-01", balanceDue: d("50"), today: today), "draft")
        XCTAssertEqual(Statuses.invoice("paid", dueDate: "2026-11-01", balanceDue: 0, today: today), "paid")
    }

    func testARejectedBillReadsAsRejectedAnApprovedOnePastDueAsOverdue() {
        let today = day(2026, 11, 27)
        XCTAssertEqual(Statuses.bill("cancelled", approvalStatus: "rejected", dueDate: "2026-11-01", balanceDue: d("5"), today: today), "rejected")
        XCTAssertEqual(Statuses.bill("cancelled", approvalStatus: nil, dueDate: "2026-11-01", balanceDue: d("5"), today: today), "rejected")
        XCTAssertEqual(Statuses.bill("approved", approvalStatus: "approved", dueDate: "2026-11-01", balanceDue: d("5"), today: today), "overdue")
        XCTAssertEqual(Statuses.bill("approved", approvalStatus: "approved", dueDate: "2026-12-01", balanceDue: d("5"), today: today), "approved")
        XCTAssertEqual(Statuses.vatReturn("filed"), "submitted")
        XCTAssertEqual(Statuses.tone("overdue"), "danger")
        XCTAssertEqual(Statuses.tone("paid"), "success")
    }

    func testADraftBillAwaitsApprovalAndAnApprovedOneWithABalanceCanBePaid() {
        func bill(_ status: String, _ approval: String?, _ balance: String) -> Bill {
            Bill(
                id: "b", number: nil, status: status, approvalStatus: approval, contactId: "c", contactName: nil,
                issueDate: "2026-11-01", dueDate: "2026-12-01", currency: "EUR", balanceDue: d(balance)
            )
        }
        XCTAssertTrue(Statuses.billAwaitsApproval(bill("draft", "pending", "10")))
        XCTAssertFalse(Statuses.billAwaitsApproval(bill("draft", "rejected", "10")))
        XCTAssertTrue(Statuses.billIsPayable(bill("approved", "approved", "10")))
        XCTAssertFalse(Statuses.billIsPayable(bill("approved", "approved", "0")))
        XCTAssertFalse(Statuses.billIsPayable(bill("draft", "pending", "10")))
    }

    // MARK: - Line items

    func testLineTotalsAddTheTaxPerRateAndAUsInvoiceLeavesTaxToTheServer() {
        let lines = [
            LineDraft(key: "a", description: "Work", quantity: "2", unitPrice: "100", taxRate: "21"),
            LineDraft(key: "b", description: "Book", quantity: "1", unitPrice: "10", taxRate: "9"),
        ]
        let totals = LineItems.totals(lines, mode: .rate)
        XCTAssertEqual(totals.subtotal, d("210"))
        XCTAssertEqual(totals.taxTotal, d("42.9"))
        XCTAssertEqual(totals.total, d("252.9"))
        XCTAssertEqual(LineItems.totals(lines, mode: .code).taxTotal, 0)
    }

    func testOnlyLinesWithADescriptionAndAPriceGoOutAsDecimalStrings() {
        let lines = [
            LineDraft(key: "a", description: " Work ", quantity: "1,5", unitPrice: "80", taxRate: "21"),
            LineDraft(key: "b", description: "", quantity: "1", unitPrice: "10", taxRate: "21"),
            LineDraft(key: "c", description: "Free", quantity: "1", unitPrice: "0", taxRate: "21"),
        ]
        let rate = LineItems.inputs(lines, mode: .rate)
        XCTAssertEqual(rate.count, 1)
        XCTAssertEqual(rate[0].description, "Work")
        XCTAssertEqual(rate[0].quantity, "1.5")
        XCTAssertEqual(rate[0].taxRate, "21")
        XCTAssertNil(rate[0].taxCode)

        let code = LineItems.inputs([LineDraft(key: "a", description: "SaaS", quantity: "1", unitPrice: "50", taxCode: "saas")], mode: .code)
        XCTAssertEqual(code[0].taxCode, "saas")
        XCTAssertNil(code[0].taxRate)

        let cost = LineItems.inputs([LineDraft(key: "a", description: "Desk", quantity: "1", unitPrice: "50", taxRate: "0", accrueUseTax: true)], mode: .cost)
        XCTAssertTrue(cost[0].accrueUseTax)
        XCTAssertEqual(cost[0].taxCode, UsRules.defaultTaxCode)
    }

    func testAReadReceiptBecomesFormLines() {
        let prefill = BillPrefill(items: [PrefillLine(description: "Paper", quantity: "2", unitPrice: "0", taxRate: nil, sortOrder: 0)], sourceDocumentId: "doc")
        let lines = LineItems.fromPrefill(prefill, defaultTaxRate: "21")
        XCTAssertEqual(lines[0].description, "Paper")
        XCTAssertEqual(lines[0].unitPrice, "")
        XCTAssertEqual(lines[0].taxRate, "21")
        var empty = prefill
        empty.items = []
        XCTAssertEqual(LineItems.fromPrefill(empty, defaultTaxRate: "9").count, 1)
    }

    // MARK: - Quick expense

    private var mixed: BillPrefill {
        BillPrefill(
            contactName: "Shop",
            currency: "EUR",
            items: [
                PrefillLine(description: "Koffie", quantity: "1", unitPrice: "13.75", taxRate: "9", sortOrder: 0),
                PrefillLine(description: "Papier", quantity: "1", unitPrice: "5.74", taxRate: "21", sortOrder: 1),
                PrefillLine(description: "Melk", quantity: "2", unitPrice: "1.18", taxRate: "9", sortOrder: 2),
            ],
            total: d("24.52"),
            sourceDocumentId: "doc"
        )
    }

    func testTheNetPriceIsTheOneWhoseRoundedVatLandsOnTheReceiptTotal() {
        let split = QuickExpense.split(d("32.48"), rate: d("21"))
        XCTAssertEqual(split.net, d("26.84"))
        XCTAssertEqual(split.tax, d("5.64"))
        XCTAssertEqual(split.rounding, 0)
        let untaxed = QuickExpense.split(d("12.5"), rate: 0)
        XCTAssertEqual(untaxed.net, d("12.50"))
        XCTAssertEqual(untaxed.tax, 0)
        for cents in stride(from: 1, through: 3000, by: 7) {
            for rate in [d("9"), d("21")] {
                let total = Decimal(cents) / 100
                let result = QuickExpense.split(total, rate: rate)
                XCTAssertLessThanOrEqual(result.rounding.magnitude, d("0.01"))
                XCTAssertEqual(total, result.net + result.tax + result.rounding)
            }
        }
    }

    func testAReceiptGivesItsRatesItsTotalAndItsMainRate() {
        XCTAssertEqual(QuickExpense.rates(mixed), [d("9"), d("21")])
        XCTAssertEqual(QuickExpense.totalFromPrefill(mixed), d("24.52"))
        var withoutTotal = mixed
        withoutTotal.total = nil
        XCTAssertEqual(QuickExpense.totalFromPrefill(withoutTotal), d("24.51"))
        withoutTotal.items = []
        XCTAssertNil(QuickExpense.totalFromPrefill(withoutTotal))
        XCTAssertEqual(QuickExpense.mainRate(mixed), "9")
    }

    func testAMixedRateReceiptKeepsItsLinesWithTheCentOfRoundingOnTop() {
        let lines = QuickExpense.lines(total: d("24.52"), rate: d("9"), description: "Food", roundingDescription: "Rounding", accountId: nil, receiptLines: mixed.items)
        XCTAssertEqual(lines.map(\.taxRate), ["9", "21", "9", "0"])
        XCTAssertEqual(lines[3].description, "Rounding")
        XCTAssertEqual(lines[3].unitPrice, "0.01")
        XCTAssertEqual(lines.map(\.sortOrder), [0, 1, 2, 3])
    }

    func testLinesThatMissTheTotalByMoreThanRoundingGiveWayToOneLineAtOneRate() {
        let lines = QuickExpense.lines(total: d("25"), rate: d("9"), description: "Food", roundingDescription: "Rounding", accountId: "acc_1", receiptLines: mixed.items)
        XCTAssertEqual(lines[0].description, "Food")
        XCTAssertEqual(lines[0].taxRate, "9")
        XCTAssertEqual(lines[0].accountId, "acc_1")
        let booked = lines.reduce(Decimal(0)) { sum, line in
            let net = d(line.unitPrice)
            return sum + net + Amounts.round(net * d(line.taxRate ?? "0") / 100, scale: 2)
        }
        XCTAssertEqual(booked, d("25"))
    }

    func testAQueuedExpenseGoesOutAsTheStoreTakesIt() {
        let expense = QueuedExpense(
            amount: "12.50",
            category: "Food",
            date: "2026-11-27",
            taxRate: "9",
            receiptLines: [QueuedLine(description: "Koffie", quantity: "1", unitPrice: "11.47", taxRate: "9")],
            roundingDescription: "Rounding",
            paymentMethod: "card"
        )
        let values = expense.values(documentId: "doc_1")
        XCTAssertEqual(values.amount, d("12.5"))
        XCTAssertEqual(values.taxRate, d("9"))
        XCTAssertEqual(values.documentId, "doc_1")
        XCTAssertTrue(values.amountIncludesTax)
        XCTAssertEqual(values.receiptLines?.first?.unitPrice, "11.47")
        XCTAssertEqual(OfflineQueue.receiptFileName(mimeType: "image/jpeg", at: 5), "receipt-5.jpg")
        XCTAssertEqual(OfflineQueue.receiptFileName(mimeType: "image/png", at: 5), "receipt-5.png")
        XCTAssertEqual(OfflineQueue.fileExtension("weird"), "jpg")
    }

    // MARK: - Payments

    func testPaymentMethodsAndTheDepositChoiceFollowTheCountry() {
        XCTAssertEqual(Payments.defaultMethod(isUs: true), "ach")
        XCTAssertEqual(Payments.defaultMethod(isUs: false), "bank_transfer")
        XCTAssertEqual(Payments.defaultExpenseMethod(isUs: false), "card")
        XCTAssertTrue(Payments.offersDepositChoice(isUs: true, received: true, method: "check"))
        XCTAssertFalse(Payments.offersDepositChoice(isUs: true, received: false, method: "check"))
        XCTAssertFalse(Payments.offersDepositChoice(isUs: false, received: true, method: "cash"))
        XCTAssertTrue(Payments.takesCheckNumber(isUs: true, method: "check"))
        XCTAssertEqual(Payments.masked("1234"), "••••1234")
        XCTAssertNil(Payments.masked("12345"))
    }

    func testAUsBankAccountReadsAsBankTypeAndMaskedNumber() {
        let us = BankAccount(
            id: "a", name: "Ops", iban: nil, bankName: "Chase", accountType: "checking", routingNumber: "021000021",
            accountNumberLast4: "1234", currency: "USD", balance: 0, lastImportDate: nil
        )
        XCTAssertEqual(Payments.accountSubtitle(us) { $0.capitalizedFirst }, "Chase · Checking ••••1234")
        var nl = us
        nl.iban = "NL91ABNA0417164300"
        nl.accountNumberLast4 = nil
        nl.bankName = "ABN"
        XCTAssertEqual(Payments.accountSubtitle(nl) { $0 }, "NL91ABNA0417164300")
    }

    // MARK: - Identifiers

    func testIbansAreCheckedForShapeAndChecksum() {
        XCTAssertNil(Identifiers.ibanProblem("NL91 ABNA 0417 1643 00"))
        XCTAssertEqual(Identifiers.ibanProblem("NL92ABNA0417164300"), "checksum")
        XCTAssertEqual(Identifiers.ibanProblem("NL91"), "format")
        XCTAssertEqual(Identifiers.formatIbanInput("nl91abna0417164300"), "NL91 ABNA 0417 1643 00")
    }

    func testDutchBtwAndKvkNumbersUsEinsAndZipCodes() {
        XCTAssertNil(Identifiers.btwProblem("NL 8536.48.115.B01"))
        XCTAssertEqual(Identifiers.btwProblem("NL853648115"), "format")
        XCTAssertNil(Identifiers.kvkProblem("1234 5678"))
        XCTAssertEqual(Identifiers.kvkProblem("1234567"), "format")
        XCTAssertEqual(Identifiers.formatEinInput("123456789"), "12-3456789")
        XCTAssertNil(Identifiers.einProblem("12-3456789"))
        XCTAssertEqual(Identifiers.einProblem("07-1234567"), "prefix")
        XCTAssertEqual(Identifiers.einProblem("12-34"), "format")
        XCTAssertEqual(Identifiers.normalizeEin("123456789"), "12-3456789")
        XCTAssertEqual(Identifiers.normalizeZip("62704"), "62704")
        XCTAssertEqual(Identifiers.normalizeZip("627041234"), "62704-1234")
        XCTAssertNil(Identifiers.normalizeZip("00000"))
        XCTAssertEqual(Identifiers.formatZipInput("6270412"), "62704-12")
    }

    func testCnpjsCarryTwoCheckDigits() {
        XCTAssertNil(Identifiers.cnpjProblem("11.222.333/0001-81"))
        XCTAssertEqual(Identifiers.cnpjProblem("11.222.333/0001-82"), "checkDigits")
        XCTAssertEqual(Identifiers.cnpjProblem("11111111111111"), "format")
        XCTAssertEqual(Identifiers.formatCnpjInput("11222333000181"), "11.222.333/0001-81")
    }

    func testBrazilianRegimesFollowTheLegalForm() {
        XCTAssertEqual(Identifiers.allowedBrRegimes("mei"), ["mei"])
        XCTAssertEqual(Identifiers.validBrRegime("sa", "simples_nacional"), "lucro_presumido")
        XCTAssertEqual(Identifiers.validBrRegime("ltda", nil), "simples_nacional")
    }

    func testUsStatesAndClassifications() {
        XCTAssertEqual(UsRules.stateCode("california"), "CA")
        XCTAssertEqual(UsRules.stateCode("tx"), "TX")
        XCTAssertTrue(UsRules.isStateCode("ny"))
        let types = UsRules.entityTypes(nil)
        XCTAssertEqual(UsRules.validClassification(types, "single_member_llc", "partnership"), "disregarded")
        XCTAssertEqual(UsRules.validClassification(types, "single_member_llc", "s_corp"), "s_corp")
        XCTAssertEqual(UsRules.defaultClassification(types, "multi_member_llc"), "partnership")
    }

    // MARK: - Company form

    private var nlEntity: Entity {
        Entity(
            id: "e1", name: "Acme B.V.", jurisdictionCode: "NL", baseCurrency: "EUR",
            address: Address(line1: "Dam 1", city: "Amsterdam", postalCode: "1012 JS", country: "NL"),
            vatNumber: "NL853648115B01", registrationNumber: "12345678", iban: "NL91ABNA0417164300"
        )
    }

    func testAnEmptyFormOnlyWantsANameWhenItIsRequired() {
        XCTAssertTrue(CompanyForm.problems(CompanyDraft(), "NL", requireName: false).isEmpty)
        XCTAssertTrue(CompanyForm.problems(CompanyDraft(), "NL", requireName: true).name)
    }

    func testAMalformedBtwKvkAndIbanAreFlaggedAndAStartedAddressNeedsAStreetAndCity() {
        let problems = CompanyForm.problems(
            CompanyDraft(name: "X", taxId: "NL12", registrationNumber: "123", iban: "NL92ABNA0417164300", address: AddressDraft(postalCode: "1012")),
            "NL",
            requireName: true
        )
        XCTAssertEqual(problems.taxId, "btwFormat")
        XCTAssertEqual(problems.registrationNumber, "kvkFormat")
        XCTAssertEqual(problems.iban, "ibanChecksum")
        XCTAssertTrue(problems.line1)
        XCTAssertTrue(problems.city)
        XCTAssertFalse(CompanyForm.problems(CompanyDraft(address: AddressDraft(postalCode: "62704")), "US", requireName: false).line1)
        XCTAssertEqual(CompanyForm.problems(CompanyDraft(taxId: "12-34"), "US", requireName: false).taxId, "einFormat")
    }

    func testTheEditSheetStartsOnWhatIsStoredAndSendsOnlyWhatChanged() {
        let draft = CompanyForm.draft(nlEntity)
        XCTAssertEqual(draft.iban, "NL91 ABNA 0417 1643 00")
        XCTAssertTrue(CompanyForm.update(nlEntity, draft).isEmpty)
        var changed = draft
        changed.name = "Acme Holding"
        changed.taxId = ""
        let update = CompanyForm.update(nlEntity, changed)
        XCTAssertEqual(update.name, "Acme Holding")
        XCTAssertEqual(update.vatNumber, "")
        XCTAssertNil(update.iban)
        XCTAssertNil(update.address)
        XCTAssertTrue(update.changesTaxIdentifiers)
    }

    func testAUsCompanysEinIsItsTaxIdAndGoesOutAsEinOrSsn() {
        let us = Entity(id: "u", name: "Acme Inc", jurisdictionCode: "US", baseCurrency: "USD", ein: "12-3456789")
        let draft = CompanyForm.draft(us)
        XCTAssertEqual(draft.taxId, "12-3456789")
        var changed = draft
        changed.taxId = "987654321"
        changed.address = AddressDraft(line1: "1 Main", city: "Austin", state: "tx", postalCode: "78701")
        let update = CompanyForm.update(us, changed)
        XCTAssertEqual(update.einOrSsn, "98-7654321")
        XCTAssertEqual(update.address?.state, "TX")
        XCTAssertEqual(update.address?.country, "US")
    }

    func testMissingInvoiceFieldsAreListedAsAPhrase() {
        var bare = nlEntity
        bare.vatNumber = nil
        bare.iban = nil
        bare.address = nil
        let missing = CompanyForm.missingInvoiceFields(bare, Jurisdictions.requiredInvoiceFields("NL", nil))
        XCTAssertEqual(missing, ["vatNumber", "iban", "address"])
        let names = ["vatNumber": "BTW", "iban": "IBAN", "address": "address"]
        XCTAssertEqual(CompanyForm.listFields(missing, name: { names[$0] ?? $0 }, and: "and"), "BTW, IBAN and address")
        XCTAssertEqual(CompanyForm.listFields([], name: { $0 }, and: "and"), "")
        XCTAssertEqual(CompanyForm.fiscalYearStart(1, locale: Locale(identifier: "en_GB")), "1 January")
        XCTAssertEqual(CompanyForm.fiscalYearStart(4, locale: Locale(identifier: "en_US")), "April 1")
    }

    func testAGenericAddressKeepsTheStoredStateAndSetsTheCountry() {
        XCTAssertNil(Addresses.genericAddress(AddressDraft(), country: "NL"))
        let stored = Address(line1: "Old", state: "MH", country: "IN", county: "X")
        let address = Addresses.genericAddress(AddressDraft(line1: "New 1", city: "Mumbai"), country: "IN", stored: stored)
        XCTAssertEqual(address?.line1, "New 1")
        XCTAssertEqual(address?.state, "MH")
        XCTAssertEqual(address?.country, "IN")
    }

    func testAUsAddressNeedsAStateAndZipOnceStarted() {
        XCTAssertTrue(Addresses.usProblems(AddressDraft()).isEmpty)
        let problems = Addresses.usProblems(AddressDraft(line1: "1 Main"))
        XCTAssertEqual(problems.state, "required")
        XCTAssertEqual(problems.postalCode, "required")
        XCTAssertEqual(Addresses.usProblems(AddressDraft(), requireStateAndZip: true).state, "required")
        XCTAssertTrue(AddressDraft(state: "IL", postalCode: "62704").isUsTaxable)
        XCTAssertEqual(Addresses.cityLine(Address(city: "Springfield", state: "IL", postalCode: "62704")), "Springfield, IL 62704")
    }

    // MARK: - Jurisdictions

    func testEveryCountryNeedsAnAddressOnInvoicesTheNetherlandsMuchMore() {
        XCTAssertEqual(Jurisdictions.requiredInvoiceFields("nl", nil), ["vatNumber", "registrationNumber", "iban", "address"])
        XCTAssertEqual(Jurisdictions.requiredInvoiceFields("US", nil), ["address"])
        XCTAssertEqual(Jurisdictions.requiredInvoiceFields(nil, nil), ["address"])
        XCTAssertEqual(Jurisdictions.defaultTaxRate("NL"), "21")
        XCTAssertEqual(Jurisdictions.defaultTaxRate("US"), "0")
        XCTAssertEqual(Jurisdictions.defaultCode(Locale(identifier: "en_US")), "US")
        XCTAssertEqual(Jurisdictions.defaultCode(Locale(identifier: "ja_JP")), "NL")
        let germany = Locale(identifier: "de_DE")
        XCTAssertEqual(Jurisdictions.formatLocale("en-US", device: germany).identifier, "en_US")
        XCTAssertEqual(Jurisdictions.formatLocale("nl-NL", device: germany).identifier, "de_DE")
    }

    func testTheOpenCompanyIsThePickedOneElseTheDefaultElseTheFirst() {
        let list: [(String, Bool)] = [("a", false), ("b", true), ("c", false)]
        XCTAssertEqual(resolveActiveEntity(list, selectedId: "c", id: { $0.0 }, isDefault: { $0.1 })?.0, "c")
        XCTAssertEqual(resolveActiveEntity(list, selectedId: "gone", id: { $0.0 }, isDefault: { $0.1 })?.0, "b")
        let none: [(String, Bool)] = list.map { ($0.0, false) }
        XCTAssertEqual(resolveActiveEntity(none, selectedId: nil, id: { $0.0 }, isDefault: { $0.1 })?.0, "a")
        let empty: [(String, Bool)] = []
        XCTAssertNil(resolveActiveEntity(empty, selectedId: nil, id: { $0.0 }, isDefault: { $0.1 })?.0)
    }

    func testTheCountrysWordsFollowItsTerminology() {
        let us = terminologyLabels(Terminology(tax: "sales_tax", taxId: "ein", registrationId: "state_id", supplier: "vendor", creditNote: "credit_memo"))
        XCTAssertEqual(us.supplier, BooksStrings.terminologySupplierVendor)
        XCTAssertEqual(us.creditNote, BooksStrings.terminologyCreditNoteCreditMemo)
        XCTAssertEqual(us.taxRate("21"), BooksStrings.terminologyTaxRateSalesTax(rate: "21"))
        let nl = terminologyLabels(Terminology())
        XCTAssertEqual(nl.tax, BooksStrings.terminologyTaxVat)
        XCTAssertEqual(nl.supplierLower, BooksStrings.terminologySupplierSupplier.lowercased())
    }

    // MARK: - Tax breakdown

    func testUsTaxGroupsPerJurisdictionStateFirstUseTaxLast() {
        let rows = [
            TaxRow(rate: d("1.75"), taxableAmount: d("100"), taxAmount: d("1.75"), jurisdictionName: "Cook County", level: "county"),
            TaxRow(rate: d("6.25"), taxableAmount: d("100"), taxAmount: d("6.25"), jurisdictionName: "Illinois", level: "state"),
            TaxRow(rate: d("6.25"), taxableAmount: d("50"), taxAmount: d("3.125"), jurisdictionName: "Illinois", level: "state", kind: "use"),
            TaxRow(rate: d("6.25"), taxableAmount: d("20"), taxAmount: d("1.25"), jurisdictionName: "Illinois", level: "state"),
        ]
        let groups = TaxBreakdown.groups(rows)
        XCTAssertEqual(groups.map(\.name), ["Illinois", "Cook County", "Illinois"])
        XCTAssertEqual(groups[0].tax, d("7.50"))
        XCTAssertEqual(groups[2].kind, "use")
        XCTAssertEqual(TaxBreakdown.chargedTotal(rows), d("9.25"))
        XCTAssertEqual(TaxBreakdown.useTaxTotal(rows), d("3.13"))
    }

    func testWarningsReadAsTheirCodeAndDetail() {
        let parsed = TaxBreakdown.parseWarning("tax_engine_unavailable: it timed out")
        XCTAssertEqual(parsed.code, "tax_engine_unavailable")
        XCTAssertEqual(parsed.detail, "it timed out")
        XCTAssertNil(TaxBreakdown.parseWarning("no_ship_to").detail)
        XCTAssertEqual(TaxBreakdown.warningText("not_registered") { _ in "Known" }, "Known")
        XCTAssertEqual(TaxBreakdown.warningText("odd_thing: x") { _ in nil }, "odd thing: x")
        XCTAssertEqual(TaxBreakdown.exemptReasons([TaxRow(exemptReason: "resale"), TaxRow(exemptReason: "resale")]), ["Resale"])
    }

    func testBrazilianTaxesGroupByTreatmentWithholdingsAsPositiveAmounts() {
        let rows = [
            TaxRow(name: "ICMS", rate: d("18"), taxableAmount: d("100"), taxAmount: d("18"), component: "icms", treatment: "added"),
            TaxRow(name: "IRRF", rate: d("1.5"), taxableAmount: d("100"), taxAmount: d("-1.5"), component: "irrf", treatment: "withheld"),
            TaxRow(name: "PIS", rate: d("0.65"), taxableAmount: d("100"), taxAmount: d("0.65"), component: "pis", treatment: "embedded"),
        ]
        XCTAssertTrue(TaxBreakdown.hasTreatments(rows))
        XCTAssertEqual(TaxBreakdown.byTreatment(rows).map(\.treatment), ["added", "embedded", "withheld"])
        let totals = TaxBreakdown.treatmentTotals(rows)
        XCTAssertEqual(totals.added, d("18.00"))
        XCTAssertEqual(totals.withheld, d("1.50"))
        XCTAssertFalse(TaxBreakdown.hasTreatments([TaxRow(rate: d("21"))]))
    }

    // MARK: - Expense categories, contacts

    func testACategoryFindsItsExpenseAccountByNameInCodeOrder() {
        let accounts = [
            GlAccount(id: "1", code: "4300", name: "Kantoorkosten", type: "expense", isActive: true),
            GlAccount(id: "2", code: "4100", name: "Autokosten", type: "expense", isActive: true),
            GlAccount(id: "3", code: "4110", name: "Autokosten oud", type: "expense", isActive: false),
            GlAccount(id: "4", code: "8000", name: "Omzet", type: "revenue", isActive: true),
        ]
        XCTAssertEqual(ExpenseCategories.expenseAccounts(accounts).map(\.code), ["4100", "4300"])
        XCTAssertEqual(ExpenseCategories.accountFor("transport", accounts)?.id, "2")
        XCTAssertEqual(ExpenseCategories.accountFor("office", accounts)?.id, "1")
        XCTAssertNil(ExpenseCategories.accountFor("insurance", accounts))
    }

    func testAContactSendsOnlyItsOwnKindsFields() {
        let company = ContactIdentityDraft(companyName: " Acme ", nameOnInvoices: "", firstName: "Jan", taxId: "NL1")
        let payload = company.payload(withTaxId: true)
        XCTAssertEqual(payload.kind, "company")
        XCTAssertEqual(payload.fullName, "Acme")
        XCTAssertEqual(payload.vatNumber, "NL1")
        XCTAssertNil(payload.firstName)
        XCTAssertNil(company.payload(withTaxId: false).vatNumber)
        var personDraft = company
        personDraft.kind = "person"
        personDraft.firstName = " Jan "
        personDraft.lastName = "Jansen"
        let person = personDraft.payload(withTaxId: true)
        XCTAssertEqual(person.fullName, "Jan Jansen")
        XCTAssertNil(person.vatNumber)
        XCTAssertNil(person.companyName)
        XCTAssertEqual(ContactIdentityDraft().problem(), "companyName")
        XCTAssertEqual(ContactIdentityDraft(kind: "person").problem(), "personName")
    }

    // MARK: - Mapping

    func testAnInvoiceFromTheServerBecomesTheAppsModel() {
        let row = Components.Schemas.Invoice(
            id: "inv_1",
            invoiceNumber: " ",
            _type: "invoice",
            status: "partial",
            contactId: "c1",
            issueDate: "2026-11-01T00:00:00.000Z",
            dueDate: "2026-11-20",
            subtotal: "100.00",
            total: "121.00",
            balanceDue: "21.00",
            taxBreakdown: [.init(taxRateName: "BTW 21%", taxRate: 21, taxableAmount: 100, taxAmount: 21)],
            taxWarnings: [" ", "no_ship_to"],
            items: [.init(id: "l1", description: "Work", unitPrice: "100", taxRate: "21", lineTotal: "100")]
        )
        let invoice = BooksStore.invoice(row)
        XCTAssertNil(invoice.number)
        XCTAssertEqual(invoice.total, d("121"))
        XCTAssertEqual(invoice.taxWarnings, ["no_ship_to"])
        XCTAssertEqual(invoice.lines.first?.quantity, 1)
        XCTAssertEqual(invoice.taxBreakdown.first?.rate, 21)
        XCTAssertNil(invoice.billingAddress)
        XCTAssertEqual(invoice.displayStatus(today: day(2026, 11, 27)), "overdue")
    }

    func testABankLineFromTheServerAndAStoragePathSegment() {
        let line = BooksStore.transaction(Components.Schemas.BankTransaction(
            id: "t1", bankAccountId: "b1", date: "2026-11-02", description: " ", amount: "-12.50", status: "unreconciled"
        ))
        XCTAssertNil(line.description)
        XCTAssertEqual(line.amount, d("-12.5"))
        XCTAssertEqual(BooksStore.segment("receipts/a b.jpg"), "receipts%2Fa%20b.jpg")
    }

    // MARK: - Errors

    func testErrorsReadAsTheServersExplanationOrTheFallback() {
        XCTAssertEqual(ErrorTexts.describe(CompanyFieldsMissing(fields: ["iban"], message: "Add your IBAN"), fallback: "x"), "Add your IBAN")
        XCTAssertEqual(ErrorTexts.describe(BooksError(api: APIError(status: 422, code: "VALIDATION"), message: "Bad date"), fallback: "x"), "Bad date")
        XCTAssertEqual(ErrorTexts.describe(BooksError(api: APIError(status: 422, code: nil), message: "Request failed with 422"), fallback: "x"), "x")
        XCTAssertEqual(ErrorTexts.describe(BooksError(api: APIError(status: 500, code: nil), message: "boom"), fallback: "x"), "x")
        XCTAssertEqual(ErrorTexts.describe(APIError(status: nil, code: nil), fallback: "x"), BooksStrings.commonOfflineError)
        XCTAssertEqual(ErrorTexts.describe(APIError(status: 404, code: nil), fallback: "x"), apiErrorMessage(APIError(status: 404, code: nil)))
        XCTAssertEqual(
            ErrorTexts.describe(BooksError(api: APIError(status: 503, code: "TAX_ENGINE_UNAVAILABLE"), message: nil), fallback: "x"),
            BooksStrings.salesTaxErrorsEngineUnavailableRetry
        )
        XCTAssertEqual(
            ErrorTexts.describe(BooksError(api: APIError(status: 422, code: "ADDRESS_REQUIRED"), message: "nope"), fallback: "x"),
            BooksStrings.salesTaxErrorsAddressRequired
        )
        XCTAssertEqual(ErrorTexts.describe(CancellationError(), fallback: "x"), "x")
        XCTAssertEqual(ErrorTexts.describe(nil, fallback: "x"), "x")
        XCTAssertEqual(apiError(BooksError(api: APIError(status: 403, code: "FORBIDDEN"), message: nil))?.status, 403)
    }

    // MARK: - Navigation

    func testATappedNotificationOpensItsInvoiceOrBill() {
        XCTAssertEqual(pushRoute(entityType: "invoice", entityId: "inv_1", actionUrl: nil), .invoice(id: "inv_1"))
        XCTAssertEqual(pushRoute(entityType: "bill", entityId: "bill_1", actionUrl: nil), .bill(id: "bill_1"))
        XCTAssertEqual(pushRoute(entityType: nil, entityId: nil, actionUrl: "/weldbooks/invoices/inv_2"), .invoice(id: "inv_2"))
        XCTAssertEqual(pushRoute(entityType: "payment", entityId: "p", actionUrl: "https://app/bills/b_3"), .bill(id: "b_3"))
        XCTAssertNil(pushRoute(entityType: nil, entityId: nil, actionUrl: nil))
    }

    func testDeepLinksOpenTheScreensTheExpoAppsRoutesDid() {
        XCTAssertEqual(DeepLinks.routeFor(host: "invoice", segments: ["inv_1"]), .invoice(id: "inv_1"))
        XCTAssertEqual(DeepLinks.routeFor(host: "invoice", segments: ["new"]), .newInvoice)
        XCTAssertEqual(DeepLinks.routeFor(host: "invoices", segments: []), .invoices)
        XCTAssertEqual(DeepLinks.routeFor(host: "scan", segments: []), .scan)
        XCTAssertEqual(DeepLinks.routeFor(host: "reports", segments: ["profit-loss"]), .profitLoss)
        XCTAssertEqual(DeepLinks.routeFor(host: "contacts", segments: ["new"]), .newContact)
        XCTAssertEqual(DeepLinks.routeFor(host: "vat", segments: ["v1"]), .vatReturn(id: "v1"))
        XCTAssertNil(DeepLinks.routeFor(host: "sso-callback", segments: []))
        XCTAssertEqual(DeepLinks.routeFor(host: "bill", segments: ["new"]), .newBill(documentId: nil, receipt: nil, receiptType: nil))
        XCTAssertEqual(DeepLinks.routeFor(host: "expense", segments: []), .quickExpense(documentId: nil, receipt: nil, receiptType: nil))
    }

    func testDeepLinkUrlsAreReadByHostAndPath() {
        XCTAssertEqual(URL(string: "weldbooks://bill/b_1").flatMap(DeepLinks.route(for:)), .bill(id: "b_1"))
        XCTAssertEqual(URL(string: "weldbooks://bank").flatMap(DeepLinks.route(for:)), .bank)
        XCTAssertEqual(URL(string: "weldbooks://bank/acc_1").flatMap(DeepLinks.route(for:)), .bankAccount(id: "acc_1"))
        XCTAssertNil(URL(string: "otherapp://invoice/x").flatMap(DeepLinks.route(for:)))
    }

    @MainActor
    func testTheNavigatorPushesSwitchesTabsAndReplacesForms() {
        let navigator = BooksNavigator()
        navigator.open(.newInvoice)
        XCTAssertEqual(navigator.homePath, [.newInvoice])
        navigator.replace(with: .invoice(id: "inv_1"))
        XCTAssertEqual(navigator.homePath, [.invoice(id: "inv_1")])
        navigator.back()
        XCTAssertEqual(navigator.homePath, [])
        navigator.open(.invoices)
        XCTAssertEqual(navigator.tab, .invoices)
        navigator.open(.bank)
        XCTAssertEqual(navigator.invoicesPath, [.bank])
        navigator.select(.invoices)
        XCTAssertEqual(navigator.invoicesPath, [])
        navigator.select(.scan)
        XCTAssertTrue(navigator.scanning)
        XCTAssertEqual(navigator.tab, .invoices)
        navigator.open(.scan)
        navigator.closeScanner()
        XCTAssertFalse(navigator.scanning)
        navigator.pending = .settings
        XCTAssertEqual(navigator.takePending(), .settings)
        XCTAssertNil(navigator.takePending())
        navigator.reset()
        XCTAssertEqual(navigator.tab, .home)
    }

    // MARK: - Text helpers

    func testTextHelpersBehaveAsKotlinsStandardLibrary() {
        XCTAssertTrue("  ".isBlank)
        XCTAssertNil(" ".nilIfBlank)
        XCTAssertEqual("a".nilIfBlank, "a")
        XCTAssertEqual("".orIfBlank("x"), "x")
        XCTAssertTrue((nil as String?).isNullOrBlank)
        XCTAssertTrue("12-3456789".fullyMatches("\\d{2}-\\d{7}"))
        XCTAssertFalse("x12-3456789".fullyMatches("\\d{2}-\\d{7}"))
        XCTAssertEqual("abc/12".firstMatchGroups("/(\\d+)"), ["/12", "12"])
        XCTAssertEqual("hello".take(2), "he")
        XCTAssertEqual("hello".dropping(2), "llo")
        XCTAssertEqual("hello".slice(1, 3), "el")
        XCTAssertEqual("resale".capitalizedFirst, "Resale")
    }
}
