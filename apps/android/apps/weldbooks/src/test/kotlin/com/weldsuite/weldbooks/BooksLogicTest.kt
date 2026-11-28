package com.weldsuite.weldbooks

import com.weldsuite.weldbooks.logic.Address
import com.weldsuite.weldbooks.logic.AddressDraft
import com.weldsuite.weldbooks.logic.Addresses
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.BankAccount
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BillPrefill
import com.weldsuite.weldbooks.logic.CompanyDraft
import com.weldsuite.weldbooks.logic.CompanyForm
import com.weldsuite.weldbooks.logic.ContactIdentityDraft
import com.weldsuite.weldbooks.logic.DashboardSeries
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.DocumentHtml
import com.weldsuite.weldbooks.logic.DueItem
import com.weldsuite.weldbooks.logic.TrendMonth
import com.weldsuite.weldbooks.logic.Entity
import com.weldsuite.weldbooks.logic.ExpenseCategories
import com.weldsuite.weldbooks.logic.GlAccount
import com.weldsuite.weldbooks.logic.Identifiers
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.LineDraft
import com.weldsuite.weldbooks.logic.LineItems
import com.weldsuite.weldbooks.logic.Payments
import com.weldsuite.weldbooks.logic.PrefillLine
import com.weldsuite.weldbooks.logic.QuickExpense
import com.weldsuite.weldbooks.logic.Statuses
import com.weldsuite.weldbooks.logic.TaxBreakdown
import com.weldsuite.weldbooks.logic.TaxMode
import com.weldsuite.weldbooks.logic.TaxRow
import com.weldsuite.weldbooks.logic.UsRules
import com.weldsuite.weldbooks.logic.resolveActiveEntity
import com.weldsuite.weldbooks.ui.formatCompact
import com.weldsuite.weldbooks.ui.pushRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigDecimal
import java.time.LocalDate
import java.util.Locale

class BooksLogicTest {
    private fun d(text: String) = BigDecimal(text)

    // ── amounts and days ──

    @Test
    fun `typed amounts read in European and US style`() {
        assertEquals(d("1234.56"), Amounts.parse("1.234,56"))
        assertEquals(d("1234.56"), Amounts.parse("1,234.56", decimalPoint = true))
        assertEquals(d("1234"), Amounts.parse("1,234", decimalPoint = true))
        assertEquals(d("1.234"), Amounts.parse("1,234"))
        assertEquals(d("12.5"), Amounts.parse("€ 12,5"))
        assertEquals(d("12"), Amounts.parse("12."))
        assertEquals(BigDecimal.ZERO, Amounts.parse(""))
    }

    @Test
    fun `server decimals read as numbers, and go back without trailing zeros`() {
        assertEquals(d("121.00"), Amounts.of("121.00"))
        assertEquals(BigDecimal.ZERO, Amounts.of(null as String?))
        assertEquals(BigDecimal.ZERO, Amounts.of("abc"))
        assertEquals("2", Amounts.plain(d("2.000")))
        assertEquals("12.5", Amounts.plain(d("12.50")))
        assertEquals("0", Amounts.plain(d("-0.00")))
        assertEquals("21", Amounts.percent(d("21.0000")))
        assertEquals("9.5", Amounts.percent(d("9.50")))
    }

    @Test
    fun `dates are calendar days, and overdue needs an open balance`() {
        val today = LocalDate.of(2026, 11, 27)
        assertEquals(LocalDate.of(2026, 11, 1), Days.of("2026-11-01T00:00:00.000Z"))
        assertNull(Days.of("2026-11"))
        assertNull(Days.of(null))
        assertEquals(-3L, Days.until(LocalDate.of(2026, 11, 24), today))
        assertTrue(Days.isOverdue("2026-11-20", d("10"), today))
        assertFalse(Days.isOverdue("2026-11-20", BigDecimal.ZERO, today))
        assertFalse(Days.isOverdue("2026-11-27", d("10"), today))
        assertEquals(LocalDate.of(2026, 11, 1) to LocalDate.of(2026, 11, 30), Days.monthRange(today))
        assertEquals(LocalDate.of(2026, 1, 1) to LocalDate.of(2026, 12, 31), Days.yearRange(today))
    }

    @Test
    fun `KPI tiles shorten thousands and leave small amounts exact`() {
        assertEquals("€12.3K", formatCompact(d("12345"), "EUR", Locale.UK))
        assertEquals("€1.5M", formatCompact(d("1500000"), "EUR", Locale.UK))
        assertFalse(formatCompact(d("999"), "EUR", Locale.UK).contains("K"))
    }

    // ── statuses ──

    @Test
    fun `an open invoice past its due date is overdue, a partial one partly paid`() {
        val today = LocalDate.of(2026, 11, 27)
        assertEquals("overdue", Statuses.invoice("sent", "2026-11-01", d("50"), today))
        assertEquals("sent", Statuses.invoice("sent", "2026-12-01", d("50"), today))
        assertEquals("partially_paid", Statuses.invoice("partial", "2026-12-01", d("50"), today))
        assertEquals("draft", Statuses.invoice("draft", "2026-11-01", d("50"), today))
        assertEquals("paid", Statuses.invoice("paid", "2026-11-01", BigDecimal.ZERO, today))
    }

    @Test
    fun `a rejected bill reads as rejected, an approved one past due as overdue`() {
        val today = LocalDate.of(2026, 11, 27)
        assertEquals("rejected", Statuses.bill("cancelled", "rejected", "2026-11-01", d("5"), today))
        assertEquals("rejected", Statuses.bill("cancelled", null, "2026-11-01", d("5"), today))
        assertEquals("overdue", Statuses.bill("approved", "approved", "2026-11-01", d("5"), today))
        assertEquals("approved", Statuses.bill("approved", "approved", "2026-12-01", d("5"), today))
        assertEquals("submitted", Statuses.vatReturn("filed"))
        assertEquals("red", Statuses.tone("overdue"))
        assertEquals("green", Statuses.tone("paid"))
        assertEquals("blue", Statuses.tone("approved"))
        assertEquals("amber", Statuses.tone("partially_paid"))
        assertEquals("gray", Statuses.tone("draft"))
    }

    @Test
    fun `a draft bill awaits approval and an approved one with a balance can be paid`() {
        fun bill(status: String, approval: String?, balance: String) =
            Bill("b", null, status, approval, "c", null, "2026-11-01", "2026-12-01", "EUR", balanceDue = d(balance))
        assertTrue(Statuses.billAwaitsApproval(bill("draft", "pending", "10")))
        assertFalse(Statuses.billAwaitsApproval(bill("draft", "rejected", "10")))
        assertTrue(Statuses.billIsPayable(bill("approved", "approved", "10")))
        assertFalse(Statuses.billIsPayable(bill("approved", "approved", "0")))
        assertFalse(Statuses.billIsPayable(bill("draft", "pending", "10")))
    }

    // ── line items ──

    @Test
    fun `line totals add the tax per rate, and a US invoice leaves tax to the server`() {
        val lines = listOf(
            LineDraft("a", "Work", "2", "100", "21"),
            LineDraft("b", "Book", "1", "10", "9"),
        )
        val totals = LineItems.totals(lines, TaxMode.RATE)
        assertEquals(0, d("210").compareTo(totals.subtotal))
        assertEquals(0, d("42.9").compareTo(totals.taxTotal))
        assertEquals(0, d("252.9").compareTo(totals.total))
        assertEquals(0, BigDecimal.ZERO.compareTo(LineItems.totals(lines, TaxMode.CODE).taxTotal))
    }

    @Test
    fun `only lines with a description and a price go out, as decimal strings`() {
        val lines = listOf(
            LineDraft("a", " Work ", "1,5", "80", "21"),
            LineDraft("b", "", "1", "10", "21"),
            LineDraft("c", "Free", "1", "0", "21"),
        )
        val rate = LineItems.inputs(lines, TaxMode.RATE)
        assertEquals(1, rate.size)
        assertEquals("Work", rate[0].description)
        assertEquals("1.5", rate[0].quantity)
        assertEquals("21", rate[0].taxRate)
        assertNull(rate[0].taxCode)

        val code = LineItems.inputs(listOf(LineDraft("a", "SaaS", "1", "50", taxCode = "saas")), TaxMode.CODE)
        assertEquals("saas", code[0].taxCode)
        assertNull(code[0].taxRate)

        val cost = LineItems.inputs(listOf(LineDraft("a", "Desk", "1", "50", "0", accrueUseTax = true)), TaxMode.COST)
        assertTrue(cost[0].accrueUseTax)
        assertEquals(UsRules.DEFAULT_TAX_CODE, cost[0].taxCode)
    }

    @Test
    fun `a read receipt becomes form lines`() {
        val prefill = BillPrefill(null, null, null, null, null, listOf(PrefillLine("Paper", "2", "0", null, 0)), null, null, null, "doc", null)
        val lines = LineItems.fromPrefill(prefill, "21")
        assertEquals("Paper", lines[0].description)
        assertEquals("", lines[0].unitPrice)
        assertEquals("21", lines[0].taxRate)
        assertEquals(1, LineItems.fromPrefill(prefill.copy(items = emptyList()), "9").size)
    }

    // ── quick expense ──

    private val mixed = BillPrefill(
        contactName = "Shop", externalReference = null, issueDate = null, dueDate = null, currency = "EUR",
        items = listOf(
            PrefillLine("Koffie", "1", "13.75", "9", 0),
            PrefillLine("Papier", "1", "5.74", "21", 1),
            PrefillLine("Melk", "2", "1.18", "9", 2),
        ),
        subtotal = null, taxTotal = null, total = d("24.52"), sourceDocumentId = "doc", matchedContactId = null,
    )

    @Test
    fun `the net price is the one whose rounded VAT lands on the receipt total`() {
        val split = QuickExpense.split(d("32.48"), d("21"))
        assertEquals(d("26.84"), split.net)
        assertEquals(d("5.64"), split.tax)
        assertEquals(0, split.rounding.signum())
        val untaxed = QuickExpense.split(d("12.5"), BigDecimal.ZERO)
        assertEquals(d("12.50"), untaxed.net)
        assertEquals(0, untaxed.tax.signum())
        for (cents in 1..3000 step 7) {
            for (rate in listOf(d("9"), d("21"))) {
                val total = BigDecimal(cents).movePointLeft(2)
                val result = QuickExpense.split(total, rate)
                assertTrue(result.rounding.abs() <= d("0.01"))
                assertEquals(0, total.compareTo(result.net + result.tax + result.rounding))
            }
        }
    }

    @Test
    fun `a receipt gives its rates, its total and its main rate`() {
        assertEquals(listOf(d("9"), d("21")), QuickExpense.rates(mixed))
        assertEquals(d("24.52"), QuickExpense.totalFromPrefill(mixed))
        assertEquals(0, d("24.51").compareTo(QuickExpense.totalFromPrefill(mixed.copy(total = null))))
        assertNull(QuickExpense.totalFromPrefill(mixed.copy(items = emptyList(), total = null)))
        assertEquals("9", QuickExpense.mainRate(mixed))
    }

    @Test
    fun `a mixed-rate receipt keeps its lines with the cent of rounding on top`() {
        val lines = QuickExpense.lines(d("24.52"), d("9"), "Food", "Rounding", null, mixed.items)
        assertEquals(listOf("9", "21", "9", "0"), lines.map { it.taxRate })
        assertEquals("Rounding", lines[3].description)
        assertEquals("0.01", lines[3].unitPrice)
        assertEquals(listOf(0, 1, 2, 3), lines.map { it.sortOrder })
    }

    @Test
    fun `lines that miss the total by more than rounding give way to one line at one rate`() {
        val lines = QuickExpense.lines(d("25"), d("9"), "Food", "Rounding", "acc_1", mixed.items)
        assertEquals("Food", lines[0].description)
        assertEquals("9", lines[0].taxRate)
        assertEquals("acc_1", lines[0].accountId)
        val booked = lines.fold(BigDecimal.ZERO) { sum, line ->
            val net = d(line.unitPrice)
            sum + net + net.multiply(d(line.taxRate ?: "0")).divide(d("100")).setScale(2, java.math.RoundingMode.HALF_UP)
        }
        assertEquals(0, d("25").compareTo(booked))
    }

    // ── payments ──

    @Test
    fun `payment methods and the deposit choice follow the country`() {
        assertEquals("ach", Payments.defaultMethod(isUs = true))
        assertEquals("bank_transfer", Payments.defaultMethod(isUs = false))
        assertEquals("card", Payments.defaultExpenseMethod(isUs = false))
        assertTrue(Payments.offersDepositChoice(isUs = true, received = true, method = "check"))
        assertFalse(Payments.offersDepositChoice(isUs = true, received = false, method = "check"))
        assertFalse(Payments.offersDepositChoice(isUs = false, received = true, method = "cash"))
        assertTrue(Payments.takesCheckNumber(isUs = true, method = "check"))
        assertEquals("••••1234", Payments.masked("1234"))
        assertNull(Payments.masked("12345"))
    }

    @Test
    fun `a US bank account reads as bank, type and masked number`() {
        val us = BankAccount("a", "Ops", null, "Chase", "checking", "021000021", "1234", "USD", BigDecimal.ZERO, null)
        assertEquals("Chase · Checking ••••1234", Payments.accountSubtitle(us) { it.replaceFirstChar { c -> c.uppercase() } })
        val nl = us.copy(iban = "NL91ABNA0417164300", accountNumberLast4 = null, bankName = "ABN")
        assertEquals("NL91ABNA0417164300", Payments.accountSubtitle(nl) { it })
    }

    // ── identifiers ──

    @Test
    fun `IBANs are checked for shape and checksum`() {
        assertNull(Identifiers.ibanProblem("NL91 ABNA 0417 1643 00"))
        assertEquals("checksum", Identifiers.ibanProblem("NL92ABNA0417164300"))
        assertEquals("format", Identifiers.ibanProblem("NL91"))
        assertEquals("NL91 ABNA 0417 1643 00", Identifiers.formatIbanInput("nl91abna0417164300"))
    }

    @Test
    fun `Dutch BTW and KvK numbers, US EINs and ZIP codes`() {
        assertNull(Identifiers.btwProblem("NL 8536.48.115.B01"))
        assertEquals("format", Identifiers.btwProblem("NL853648115"))
        assertNull(Identifiers.kvkProblem("1234 5678"))
        assertEquals("format", Identifiers.kvkProblem("1234567"))
        assertEquals("12-3456789", Identifiers.formatEinInput("123456789"))
        assertNull(Identifiers.einProblem("12-3456789"))
        assertEquals("prefix", Identifiers.einProblem("07-1234567"))
        assertEquals("format", Identifiers.einProblem("12-34"))
        assertEquals("12-3456789", Identifiers.normalizeEin("123456789"))
        assertEquals("62704", Identifiers.normalizeZip("62704"))
        assertEquals("62704-1234", Identifiers.normalizeZip("627041234"))
        assertNull(Identifiers.normalizeZip("00000"))
        assertEquals("62704-12", Identifiers.formatZipInput("6270412"))
    }

    @Test
    fun `CNPJs carry two check digits`() {
        assertNull(Identifiers.cnpjProblem("11.222.333/0001-81"))
        assertEquals("checkDigits", Identifiers.cnpjProblem("11.222.333/0001-82"))
        assertEquals("format", Identifiers.cnpjProblem("11111111111111"))
        assertEquals("11.222.333/0001-81", Identifiers.formatCnpjInput("11222333000181"))
    }

    @Test
    fun `Brazilian regimes follow the legal form`() {
        assertEquals(listOf("mei"), Identifiers.allowedBrRegimes("mei"))
        assertEquals("lucro_presumido", Identifiers.validBrRegime("sa", "simples_nacional"))
        assertEquals("simples_nacional", Identifiers.validBrRegime("ltda", null))
    }

    @Test
    fun `US states and classifications`() {
        assertEquals("CA", UsRules.stateCode("california"))
        assertEquals("TX", UsRules.stateCode("tx"))
        assertTrue(UsRules.isStateCode("ny"))
        val types = UsRules.entityTypes(null)
        assertEquals("disregarded", UsRules.validClassification(types, "single_member_llc", "partnership"))
        assertEquals("s_corp", UsRules.validClassification(types, "single_member_llc", "s_corp"))
        assertEquals("partnership", UsRules.defaultClassification(types, "multi_member_llc"))
    }

    // ── company form ──

    private val nlEntity = Entity(
        id = "e1", name = "Acme B.V.", jurisdictionCode = "NL", baseCurrency = "EUR",
        vatNumber = "NL853648115B01", registrationNumber = "12345678", iban = "NL91ABNA0417164300",
        address = Address(line1 = "Dam 1", city = "Amsterdam", postalCode = "1012 JS", country = "NL"),
    )

    @Test
    fun `an empty form only wants a name when it is required`() {
        assertTrue(CompanyForm.problems(CompanyDraft(), "NL", requireName = false).isEmpty)
        assertTrue(CompanyForm.problems(CompanyDraft(), "NL", requireName = true).name)
    }

    @Test
    fun `a malformed BTW, KvK and IBAN are flagged, and a started address needs a street and city`() {
        val problems = CompanyForm.problems(
            CompanyDraft(name = "X", taxId = "NL12", registrationNumber = "123", iban = "NL92ABNA0417164300", address = AddressDraft(postalCode = "1012")),
            "NL",
            requireName = true,
        )
        assertEquals("btwFormat", problems.taxId)
        assertEquals("kvkFormat", problems.registrationNumber)
        assertEquals("ibanChecksum", problems.iban)
        assertTrue(problems.line1)
        assertTrue(problems.city)
        assertFalse(CompanyForm.problems(CompanyDraft(address = AddressDraft(postalCode = "62704")), "US", requireName = false).line1)
        assertEquals("einFormat", CompanyForm.problems(CompanyDraft(taxId = "12-34"), "US", requireName = false).taxId)
    }

    @Test
    fun `the edit sheet starts on what is stored and sends only what changed`() {
        val draft = CompanyForm.draft(nlEntity)
        assertEquals("NL91 ABNA 0417 1643 00", draft.iban)
        assertTrue(CompanyForm.update(nlEntity, draft).isEmpty)
        val update = CompanyForm.update(nlEntity, draft.copy(name = "Acme Holding", taxId = ""))
        assertEquals("Acme Holding", update.name)
        assertEquals("", update.vatNumber)
        assertNull(update.iban)
        assertNull(update.address)
        assertTrue(update.changesTaxIdentifiers)
    }

    @Test
    fun `a US company's EIN is its tax ID and goes out as einOrSsn`() {
        val us = Entity(id = "u", name = "Acme Inc", jurisdictionCode = "US", baseCurrency = "USD", ein = "12-3456789")
        val draft = CompanyForm.draft(us)
        assertEquals("12-3456789", draft.taxId)
        val update = CompanyForm.update(us, draft.copy(taxId = "987654321", address = AddressDraft(line1 = "1 Main", city = "Austin", state = "tx", postalCode = "78701")))
        assertEquals("98-7654321", update.einOrSsn)
        assertEquals("TX", update.address?.state)
        assertEquals("US", update.address?.country)
    }

    @Test
    fun `missing invoice fields are listed as a phrase`() {
        val bare = nlEntity.copy(vatNumber = null, iban = null, address = null)
        val missing = CompanyForm.missingInvoiceFields(bare, Jurisdictions.requiredInvoiceFields("NL", null))
        assertEquals(listOf("vatNumber", "iban", "address"), missing)
        assertEquals("BTW, IBAN and address", CompanyForm.listFields(missing, { mapOf("vatNumber" to "BTW", "iban" to "IBAN", "address" to "address").getValue(it) }, "and"))
        assertEquals("", CompanyForm.listFields(emptyList(), { it }, "and"))
        assertEquals("1 January", CompanyForm.fiscalYearStart(1, Locale.UK))
        assertEquals("April 1", CompanyForm.fiscalYearStart(4, Locale.US))
    }

    @Test
    fun `a generic address keeps the stored state and sets the country`() {
        assertNull(Addresses.genericAddress(AddressDraft(), "NL"))
        val stored = Address(line1 = "Old", state = "MH", county = "X", country = "IN")
        val address = Addresses.genericAddress(AddressDraft(line1 = "New 1", city = "Mumbai"), "IN", stored)
        assertEquals("New 1", address?.line1)
        assertEquals("MH", address?.state)
        assertEquals("IN", address?.country)
    }

    @Test
    fun `a US address needs a state and ZIP once started`() {
        assertTrue(Addresses.usProblems(AddressDraft()).isEmpty)
        val problems = Addresses.usProblems(AddressDraft(line1 = "1 Main"))
        assertEquals("required", problems.state)
        assertEquals("required", problems.postalCode)
        assertEquals("required", Addresses.usProblems(AddressDraft(), requireStateAndZip = true).state)
        assertTrue(AddressDraft(state = "IL", postalCode = "62704").isUsTaxable)
    }

    // ── jurisdictions ──

    @Test
    fun `every country needs an address on invoices, the Netherlands much more`() {
        assertEquals(listOf("vatNumber", "registrationNumber", "iban", "address"), Jurisdictions.requiredInvoiceFields("nl", null))
        assertEquals(listOf("address"), Jurisdictions.requiredInvoiceFields("US", null))
        assertEquals(listOf("address"), Jurisdictions.requiredInvoiceFields(null, null))
        assertEquals("21", Jurisdictions.defaultTaxRate("NL"))
        assertEquals("0", Jurisdictions.defaultTaxRate("US"))
        assertEquals("US", Jurisdictions.defaultCode(Locale.US))
        assertEquals("NL", Jurisdictions.defaultCode(Locale.JAPAN))
        assertEquals(Locale.US, Jurisdictions.formatLocale("en-US", Locale.GERMANY))
        assertEquals(Locale.GERMANY, Jurisdictions.formatLocale("nl-NL", Locale.GERMANY))
    }

    @Test
    fun `the open company is the one picked, else the default, else the first`() {
        val list = listOf("a" to false, "b" to true, "c" to false)
        assertEquals("c", resolveActiveEntity(list, "c", { it.first }, { it.second })?.first)
        assertEquals("b", resolveActiveEntity(list, "gone", { it.first }, { it.second })?.first)
        assertEquals("a", resolveActiveEntity(list.map { it.first to false }, null, { it.first }, { it.second })?.first)
        assertNull(resolveActiveEntity(emptyList<Pair<String, Boolean>>(), null, { it.first }, { it.second }))
    }

    // ── tax breakdown ──

    @Test
    fun `US tax groups per jurisdiction, state first, use tax last`() {
        val rows = listOf(
            TaxRow(jurisdictionName = "Cook County", level = "county", rate = d("1.75"), taxableAmount = d("100"), taxAmount = d("1.75")),
            TaxRow(jurisdictionName = "Illinois", level = "state", rate = d("6.25"), taxableAmount = d("100"), taxAmount = d("6.25")),
            TaxRow(jurisdictionName = "Illinois", level = "state", rate = d("6.25"), taxableAmount = d("50"), taxAmount = d("3.125"), kind = "use"),
            TaxRow(jurisdictionName = "Illinois", level = "state", rate = d("6.25"), taxableAmount = d("20"), taxAmount = d("1.25")),
        )
        val groups = TaxBreakdown.groups(rows)
        assertEquals(listOf("Illinois", "Cook County", "Illinois"), groups.map { it.name })
        assertEquals(d("7.50"), groups[0].tax)
        assertEquals("use", groups[2].kind)
        assertEquals(d("9.25"), TaxBreakdown.chargedTotal(rows))
        assertEquals(d("3.13"), TaxBreakdown.useTaxTotal(rows))
    }

    @Test
    fun `warnings read as their code and detail`() {
        assertEquals("tax_engine_unavailable" to "it timed out", TaxBreakdown.parseWarning("tax_engine_unavailable: it timed out"))
        assertEquals("Known", TaxBreakdown.warningText("not_registered", { "Known" }))
        assertEquals("odd thing: x", TaxBreakdown.warningText("odd_thing: x", { null }))
        assertEquals(listOf("Resale"), TaxBreakdown.exemptReasons(listOf(TaxRow(exemptReason = "resale"), TaxRow(exemptReason = "resale"))))
    }

    @Test
    fun `Brazilian taxes group by treatment, withholdings as positive amounts`() {
        val rows = listOf(
            TaxRow(name = "ICMS", component = "icms", rate = d("18"), taxableAmount = d("100"), taxAmount = d("18"), treatment = "added"),
            TaxRow(name = "IRRF", component = "irrf", rate = d("1.5"), taxableAmount = d("100"), taxAmount = d("-1.5"), treatment = "withheld"),
            TaxRow(name = "PIS", component = "pis", rate = d("0.65"), taxableAmount = d("100"), taxAmount = d("0.65"), treatment = "embedded"),
        )
        assertTrue(TaxBreakdown.hasTreatments(rows))
        assertEquals(listOf("added", "embedded", "withheld"), TaxBreakdown.byTreatment(rows).map { it.treatment })
        assertEquals(d("18.00") to d("1.50"), TaxBreakdown.treatmentTotals(rows))
        assertFalse(TaxBreakdown.hasTreatments(listOf(TaxRow(rate = d("21")))))
    }

    // ── expense categories, contacts ──

    @Test
    fun `a category finds its expense account by name, in code order`() {
        val accounts = listOf(
            GlAccount("1", "4300", "Kantoorkosten", "expense", true),
            GlAccount("2", "4100", "Autokosten", "expense", true),
            GlAccount("3", "4110", "Autokosten oud", "expense", false),
            GlAccount("4", "8000", "Omzet", "revenue", true),
        )
        assertEquals(listOf("4100", "4300"), ExpenseCategories.expenseAccounts(accounts).map { it.code })
        assertEquals("2", ExpenseCategories.accountFor("transport", accounts)?.id)
        assertEquals("1", ExpenseCategories.accountFor("office", accounts)?.id)
        assertNull(ExpenseCategories.accountFor("insurance", accounts))
    }

    @Test
    fun `a contact sends only its own kind's fields`() {
        val company = ContactIdentityDraft(companyName = " Acme ", nameOnInvoices = "", taxId = "NL1", firstName = "Jan")
        val payload = company.payload(withTaxId = true)
        assertEquals("company", payload.kind)
        assertEquals("Acme", payload.fullName)
        assertEquals("NL1", payload.vatNumber)
        assertNull(payload.firstName)
        assertNull(company.payload(withTaxId = false).vatNumber)
        val person = company.copy(kind = "person", firstName = " Jan ", lastName = "Jansen").payload(withTaxId = true)
        assertEquals("Jan Jansen", person.fullName)
        assertNull(person.vatNumber)
        assertNull(person.companyName)
        assertEquals("companyName", ContactIdentityDraft().problem())
        assertEquals("personName", ContactIdentityDraft(kind = "person").problem())
    }

    // ── navigation ──

    @Test
    fun `a tapped notification opens its invoice or bill`() {
        assertEquals("invoice/inv_1", pushRoute("invoice", "inv_1", null))
        assertEquals("bill/bill_1", pushRoute("bill", "bill_1", null))
        assertEquals("invoice/inv_2", pushRoute(null, null, "/weldbooks/invoices/inv_2"))
        assertEquals("bill/b_3", pushRoute("payment", "p", "https://app/bills/b_3"))
        assertNull(pushRoute(null, null, null))
    }

    @Test
    fun `deep links open the screens the Expo app's routes did`() {
        assertEquals("invoice/inv_1", DeepLinks.routeFor("invoice", listOf("inv_1")))
        assertEquals("invoice/new", DeepLinks.routeFor("invoice", listOf("new")))
        assertEquals("invoices", DeepLinks.routeFor("invoices", emptyList()))
        assertEquals("scan", DeepLinks.routeFor("scan", emptyList()))
        assertEquals("reports/profit-loss", DeepLinks.routeFor("reports", listOf("profit-loss")))
        assertEquals("contacts/new", DeepLinks.routeFor("contacts", listOf("new")))
        assertEquals("vat/v1", DeepLinks.routeFor("vat", listOf("v1")))
        assertNull(DeepLinks.routeFor("sso-callback", emptyList()))
    }

    @Test
    fun `the dashboard adds this year up to this month and last year up to the same month`() {
        val months = listOf(
            TrendMonth("2025-01", d("100"), d("40"), d("60")),
            TrendMonth("2025-02", d("50"), d("10"), d("40")),
            TrendMonth("2025-03", d("999"), d("0"), d("999")),
            TrendMonth("2026-01", d("200"), d("20"), d("180")),
            TrendMonth("2026-02", d("30"), d("5"), d("25")),
        )
        val revenue = DashboardSeries.yearToDate(months, "revenue")
        assertEquals(2026, revenue.year)
        assertEquals("2026-02", revenue.throughMonth)
        assertEquals(d("230"), revenue.total)
        assertEquals(d("150"), revenue.lastYearTotal)
        assertEquals(12, revenue.points.size)
        assertEquals(null, revenue.points[2].first)
        assertEquals(d("205"), DashboardSeries.yearToDate(months, "profit").total)
        assertTrue(DashboardSeries.hasTrend(months))
    }

    @Test
    fun `due this week keeps what falls due within seven days, late ones too, soonest first`() {
        val today = LocalDate.of(2026, 11, 27)
        fun item(id: String, due: String) = DueItem("invoice", id, id, null, due, d("1"), "EUR")
        val rows = DashboardSeries.dueThisWeek(listOf(item("late", "2026-11-20T00:00:00.000Z"), item("later", "2026-12-10"), item("soon", "2026-12-03")), today)
        assertEquals(listOf("late", "soon"), rows.map { it.id })
    }

    @Test
    fun `the printable invoice is laid out at its page width, not the phone's`() {
        val page = "<html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head><body></body></html>"
        val fitted = DocumentHtml.fitToPage(page)
        assertTrue(fitted.contains("<meta name=\"viewport\" content=\"width=800\">"))
        assertTrue(!fitted.contains("device-width"))
        assertTrue(DocumentHtml.fitToPage("<html><head><title>x</title></head></html>").startsWith("<html><head><meta name=\"viewport\""))
    }
}
