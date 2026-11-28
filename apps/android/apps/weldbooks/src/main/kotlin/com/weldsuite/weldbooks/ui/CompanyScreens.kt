package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Sync
import org.weldsuite.ui.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.NewEntity
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Addresses
import com.weldsuite.weldbooks.logic.CompanyDraft
import com.weldsuite.weldbooks.logic.CompanyForm
import com.weldsuite.weldbooks.logic.CompanyProblems
import com.weldsuite.weldbooks.logic.Entity
import com.weldsuite.weldbooks.logic.Identifiers
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.Terminology
import com.weldsuite.weldbooks.logic.UsAddressProblems
import com.weldsuite.weldbooks.logic.UsRules
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged

/** The words for a legal form (`llc`, `ltda`, …), or the code itself. */
@Composable
fun entityTypeLabel(type: String): String = when (type) {
    "sole_proprietorship" -> stringResource(R.string.weldbooks_entity_setup_entity_types_sole_proprietorship)
    "single_member_llc" -> stringResource(R.string.weldbooks_entity_setup_entity_types_single_member_llc)
    "multi_member_llc" -> stringResource(R.string.weldbooks_entity_setup_entity_types_multi_member_llc)
    "partnership" -> stringResource(R.string.weldbooks_entity_setup_entity_types_partnership)
    "s_corp" -> stringResource(R.string.weldbooks_entity_setup_entity_types_s_corp)
    "c_corp" -> stringResource(R.string.weldbooks_entity_setup_entity_types_c_corp)
    "nonprofit" -> stringResource(R.string.weldbooks_entity_setup_entity_types_nonprofit)
    "mei" -> stringResource(R.string.weldbooks_entity_setup_entity_types_mei)
    "ei" -> stringResource(R.string.weldbooks_entity_setup_entity_types_ei)
    "slu" -> stringResource(R.string.weldbooks_entity_setup_entity_types_slu)
    "ltda" -> stringResource(R.string.weldbooks_entity_setup_entity_types_ltda)
    "sa" -> stringResource(R.string.weldbooks_entity_setup_entity_types_sa)
    else -> type
}

/** The words for a tax classification or regime, or the code itself. */
@Composable
fun taxClassificationLabel(value: String): String = when (value) {
    "disregarded" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_disregarded)
    "sole_proprietor" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_sole_proprietor)
    "partnership" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_partnership)
    "s_corp" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_s_corp)
    "c_corp" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_c_corp)
    "exempt" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_exempt)
    "mei" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_mei)
    "simples_nacional" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_simples_nacional)
    "lucro_presumido" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_lucro_presumido)
    "lucro_real" -> stringResource(R.string.weldbooks_entity_setup_tax_classifications_lucro_real)
    else -> value
}

@Composable
private fun companyProblemText(problem: String?): String? = when (problem) {
    null -> null
    "einFormat" -> stringResource(R.string.weldbooks_entity_setup_ein_format)
    "einPrefix" -> stringResource(R.string.weldbooks_entity_setup_ein_prefix)
    "cnpjFormat" -> stringResource(R.string.weldbooks_entity_setup_cnpj_format)
    "cnpjCheckDigits" -> stringResource(R.string.weldbooks_entity_setup_cnpj_check_digits)
    "btwFormat" -> stringResource(R.string.weldbooks_company_btw_format)
    "kvkFormat" -> stringResource(R.string.weldbooks_company_kvk_format)
    "ibanChecksum" -> stringResource(R.string.weldbooks_company_iban_checksum)
    else -> stringResource(R.string.weldbooks_company_iban_format)
}

@Composable
private fun registrationPlaceholder(registrationId: String): String = when (registrationId) {
    "kvk" -> stringResource(R.string.weldbooks_company_registration_placeholder_kvk)
    "pan" -> stringResource(R.string.weldbooks_company_registration_placeholder_pan)
    "state_id" -> stringResource(R.string.weldbooks_company_registration_placeholder_state_id)
    "ie" -> stringResource(R.string.weldbooks_company_registration_placeholder_ie)
    else -> stringResource(R.string.weldbooks_company_registration_placeholder_company_number)
}

/**
 * The company's tax ID, bank details and address: what an invoice can't be
 * finalised without. Shared by the setup and the edit sheet. A field the
 * country makes mandatory on invoices says so underneath.
 */
@Composable
fun CompanyFields(
    code: String,
    draft: CompanyDraft,
    onChange: (CompanyDraft) -> Unit,
    problems: CompanyProblems,
    usProblems: UsAddressProblems,
    requiredFields: List<String>,
    labels: Labels,
    terminology: Terminology,
    taxIdLabel: String,
) {
    val isUs = code == "US"
    val needed = stringResource(R.string.weldbooks_company_needed_for_invoices)
    val taxIdError = companyProblemText(problems.taxId)
    FormField(
        taxIdLabel,
        draft.taxId,
        { onChange(draft.copy(taxId = CompanyForm.formatTaxIdInput(code, it))) },
        placeholder = labels.taxIdPlaceholder,
        error = taxIdError,
        helper = when {
            taxIdError != null -> null
            code == "US" -> stringResource(R.string.weldbooks_entity_setup_ein_hint)
            code == "BR" -> stringResource(R.string.weldbooks_entity_setup_cnpj_hint)
            "vatNumber" in requiredFields -> needed
            else -> null
        },
        keyboard = if (isUs) KeyboardType.Number else KeyboardType.Text,
        tag = "company-tax-id",
    )
    if ("registrationNumber" in requiredFields) {
        val error = companyProblemText(problems.registrationNumber)
        FormField(
            labels.registrationId,
            draft.registrationNumber,
            { onChange(draft.copy(registrationNumber = it)) },
            placeholder = registrationPlaceholder(terminology.registrationId),
            error = error,
            helper = needed.takeIf { error == null },
            tag = "company-registration",
        )
    }
    if ("iban" in requiredFields) {
        val error = companyProblemText(problems.iban)
        FormField(
            stringResource(R.string.weldbooks_company_iban),
            draft.iban,
            { onChange(draft.copy(iban = Identifiers.formatIbanInput(it))) },
            placeholder = stringResource(R.string.weldbooks_company_iban_placeholder),
            error = error,
            helper = needed.takeIf { error == null },
            tag = "company-iban",
        )
        FormField(
            stringResource(R.string.weldbooks_company_bic),
            draft.bic,
            { onChange(draft.copy(bic = it.uppercase())) },
            placeholder = stringResource(R.string.weldbooks_company_bic_placeholder),
            tag = "company-bic",
        )
    }
    Text(
        stringResource(R.string.weldbooks_entity_setup_business_address),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(top = Tokens.Spacing.m),
    )
    val hint = stringResource(if (isUs) R.string.weldbooks_entity_setup_address_hint else R.string.weldbooks_entity_setup_address_hint_invoice)
    HintText(if (!isUs && "address" in requiredFields) "$hint $needed." else hint)
    if (isUs) {
        AddressFields(draft.address, { onChange(draft.copy(address = it)) }, usProblems)
    } else {
        FormField(
            stringResource(R.string.weldbooks_address_line1),
            draft.address.line1,
            { onChange(draft.copy(address = draft.address.copy(line1 = it))) },
            placeholder = stringResource(R.string.weldbooks_address_line1_placeholder),
            error = if (problems.line1) stringResource(R.string.weldbooks_company_line1_required) else null,
            tag = "company-line1",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            FormField(
                stringResource(R.string.weldbooks_company_postal_code),
                draft.address.postalCode,
                { onChange(draft.copy(address = draft.address.copy(postalCode = it))) },
                placeholder = stringResource(R.string.weldbooks_company_postal_code_placeholder),
                modifier = Modifier.weight(1f),
                tag = "company-postal-code",
            )
            FormField(
                stringResource(R.string.weldbooks_address_city),
                draft.address.city,
                { onChange(draft.copy(address = draft.address.copy(city = it))) },
                error = if (problems.city) stringResource(R.string.weldbooks_company_city_required) else null,
                modifier = Modifier.weight(1.4f),
                tag = "company-city",
            )
        }
    }
}

/**
 * A new company: the jurisdiction (it decides the chart of accounts, tax
 * rates and numbering, and can't change later), the name, the currency and,
 * per country, how it is organised and what its invoices need. Created with
 * the country's defaults seeded.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateEntitySheet(onDismiss: () -> Unit, onCreated: (Entity) -> Unit, additional: Boolean = false, initialJurisdiction: String? = null) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val loaded = books.jurisdictions
    val jurisdictions = loaded?.takeIf { it.isNotEmpty() } ?: Jurisdictions.builtIn
    val initialCode = (initialJurisdiction ?: Jurisdictions.defaultCode()).uppercase()

    var company by remember { mutableStateOf(CompanyDraft()) }
    var code by rememberSaveable { mutableStateOf(initialCode) }
    var currency by rememberSaveable { mutableStateOf(Jurisdictions.find(initialCode, loaded)?.defaultCurrency ?: "EUR") }
    var entityType by rememberSaveable { mutableStateOf("single_member_llc") }
    var classification by rememberSaveable { mutableStateOf("disregarded") }
    var dba by rememberSaveable { mutableStateOf("") }
    var brEntityType by rememberSaveable { mutableStateOf("ltda") }
    var brRegime by rememberSaveable { mutableStateOf("simples_nacional") }
    var submitting by remember { mutableStateOf(false) }
    var problems by remember { mutableStateOf(CompanyProblems()) }
    var usProblems by remember { mutableStateOf(UsAddressProblems()) }

    val jurisdiction = Jurisdictions.find(code, loaded)
    val isUs = Jurisdictions.isUs(code)
    val isBr = Jurisdictions.isBr(code)
    val terminology = jurisdiction?.terminology ?: Terminology()
    val labels = terminologyLabels(terminology)
    val types = UsRules.entityTypes(jurisdiction?.entityTypes)
    val classifications = types.firstOrNull { it.type == entityType }?.classifications.orEmpty()
    val required = Jurisdictions.requiredInvoiceFields(code, loaded)
    val created = stringResource(R.string.weldbooks_entity_setup_created)
    val failed = stringResource(R.string.weldbooks_entity_setup_create_failed)

    fun change(next: CompanyDraft) {
        company = next
        problems = CompanyProblems()
        usProblems = UsAddressProblems()
    }

    fun create() {
        val found = CompanyForm.problems(company, code, requireName = true)
        // The US address is where the company's sales tax starts from: a state and ZIP are required.
        val usFound = if (isUs) Addresses.usProblems(company.address, requireStateAndZip = true) else UsAddressProblems()
        problems = found
        usProblems = usFound
        if (!found.isEmpty || !usFound.isEmpty) return
        val taxId = CompanyForm.normalizeTaxId(company.taxId, code).ifEmpty { null }
        val values = when {
            isUs -> NewEntity(
                name = company.name.trim(), jurisdictionCode = code, baseCurrency = currency, isDefault = !additional,
                entityType = entityType,
                taxClassification = UsRules.validClassification(types, entityType, classification),
                dba = dba.trim().ifEmpty { null },
                ein = taxId,
                address = Addresses.usAddress(company.address),
            )
            isBr -> NewEntity(
                name = company.name.trim(), jurisdictionCode = code, baseCurrency = currency, isDefault = !additional,
                entityType = brEntityType,
                taxClassification = Identifiers.validBrRegime(brEntityType, brRegime),
                vatNumber = taxId,
                address = Addresses.genericAddress(company.address, code),
            )
            else -> NewEntity(
                name = company.name.trim(), jurisdictionCode = code, baseCurrency = currency, isDefault = !additional,
                vatNumber = taxId,
                registrationNumber = company.registrationNumber.trim().ifEmpty { null },
                iban = Identifiers.normalizeIban(company.iban).ifEmpty { null },
                bic = company.bic.trim().uppercase().ifEmpty { null },
                address = Addresses.genericAddress(company.address, code),
            )
        }
        submitting = true
        scope.launch {
            runCatching { books.repository.createEntity(values) }
                .onSuccess { entity ->
                    notify(created)
                    onCreated(entity)
                    onDismiss()
                }
                .onFailure { notify(errors.describe(it, failed)) }
            submitting = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("create-company-sheet"),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                stringResource(if (additional) R.string.weldbooks_entity_setup_add_sheet_title else R.string.weldbooks_entity_setup_sheet_title),
                style = MaterialTheme.typography.titleLarge,
            )
            HintText(stringResource(R.string.weldbooks_entity_setup_hint))
            Dropdown(
                stringResource(R.string.weldbooks_entity_setup_jurisdiction),
                code,
                jurisdictions.map { it.code.uppercase() to "${it.name} (${it.code.uppercase()})" },
                { next ->
                    code = next
                    // Each country starts on its own currency; the picker below can still change it.
                    currency = Jurisdictions.find(next, loaded)?.defaultCurrency ?: currency
                    company = company.copy(taxId = "", registrationNumber = "", iban = "", bic = "")
                    problems = CompanyProblems()
                    usProblems = UsAddressProblems()
                },
                tag = "company-jurisdiction",
            )
            FormField(
                stringResource(R.string.weldbooks_entity_setup_company_name),
                company.name,
                { change(company.copy(name = it)) },
                placeholder = if (isUs) stringResource(R.string.weldbooks_examples_company_us) else stringResource(R.string.weldbooks_entity_setup_company_name_placeholder),
                error = if (problems.name) stringResource(R.string.weldbooks_entity_setup_company_name_error) else null,
                tag = "company-name",
            )
            if (isUs) {
                Dropdown(
                    stringResource(R.string.weldbooks_entity_setup_entity_type),
                    entityType,
                    types.map { it.type to entityTypeLabel(it.type).let { label -> if (label == it.type) it.label else label } },
                    { type ->
                        entityType = type
                        classification = UsRules.validClassification(types, type, classification)
                    },
                    tag = "company-entity-type",
                )
                val optionTemplate = stringResource(R.string.weldbooks_entity_setup_classification_option, "%LABEL%", "%FORM%")
                Dropdown(
                    stringResource(R.string.weldbooks_entity_setup_tax_classification),
                    UsRules.validClassification(types, entityType, classification),
                    classifications.map { option ->
                        val label = taxClassificationLabel(option.value)
                        option.value to if (option.formLabel.isNotBlank()) optionTemplate.replace("%LABEL%", label).replace("%FORM%", option.formLabel) else label
                    },
                    { classification = it },
                    enabled = classifications.size > 1,
                    tag = "company-tax-classification",
                )
                HintText(stringResource(R.string.weldbooks_entity_setup_classification_hint))
                FormField(stringResource(R.string.weldbooks_entity_setup_dba), dba, { dba = it }, placeholder = stringResource(R.string.weldbooks_entity_setup_dba_placeholder), tag = "company-dba")
            }
            if (isBr) {
                Dropdown(
                    stringResource(R.string.weldbooks_entity_setup_entity_type),
                    brEntityType,
                    Identifiers.brEntityTypes.map { it to entityTypeLabel(it) },
                    { type ->
                        brEntityType = type
                        brRegime = Identifiers.validBrRegime(type, brRegime)
                    },
                    tag = "company-entity-type",
                )
                val regimes = Identifiers.allowedBrRegimes(brEntityType)
                Dropdown(
                    stringResource(R.string.weldbooks_entity_setup_tax_regime),
                    Identifiers.validBrRegime(brEntityType, brRegime),
                    regimes.map { it to taxClassificationLabel(it) },
                    { brRegime = it },
                    enabled = regimes.size > 1,
                    tag = "company-tax-regime",
                )
                HintText(stringResource(R.string.weldbooks_entity_setup_regime_hint))
            }
            Dropdown(
                stringResource(R.string.weldbooks_entity_setup_base_currency),
                currency,
                listOf(
                    "EUR" to stringResource(R.string.weldbooks_entity_setup_currency_eur),
                    "GBP" to stringResource(R.string.weldbooks_entity_setup_currency_gbp),
                    "USD" to stringResource(R.string.weldbooks_entity_setup_currency_usd),
                    "INR" to stringResource(R.string.weldbooks_entity_setup_currency_inr),
                    "BRL" to stringResource(R.string.weldbooks_entity_setup_currency_brl),
                ),
                { currency = it },
                tag = "company-currency",
            )
            if (!isUs) {
                Text(stringResource(R.string.weldbooks_entity_setup_invoice_details), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = Tokens.Spacing.m))
                HintText(stringResource(R.string.weldbooks_entity_setup_invoice_details_hint))
            }
            CompanyFields(
                code = code,
                draft = company,
                onChange = ::change,
                problems = problems,
                usProblems = usProblems,
                requiredFields = required,
                labels = labels,
                terminology = terminology,
                taxIdLabel = stringResource(R.string.weldbooks_entity_setup_tax_id_optional, labels.taxId),
            )
            Button(
                onClick = ::create,
                enabled = !submitting,
                modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.l).tagged("create-company-submit"),
            ) { Text(stringResource(R.string.weldbooks_entity_setup_create_company)) }
        }
    }
}

/**
 * The door of a workspace without a company: create one, or find the way
 * out (set it up on the web and check again, switch workspace, sign out).
 */
@Composable
fun EntityEmptyState(session: SessionState.Ready, onSwitchWorkspace: () -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }
    val signOutFailed = stringResource(R.string.weldbooks_settings_sign_out_failed)
    val brand = Brand.current()

    BooksScaffold(title = stringResource(R.string.weldbooks_app_name)) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
            Column(
                Modifier.widthIn(max = 360.dp).verticalScroll(rememberScrollState()).tagged("entity-empty"),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                IconTile(Icons.Outlined.Apartment, brand, size = 96.dp)
                Text(
                    stringResource(R.string.weldbooks_entity_setup_empty_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = Tokens.Spacing.m),
                )
                Text(
                    stringResource(R.string.weldbooks_entity_setup_empty_description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Button(onClick = { creating = true }, modifier = Modifier.padding(top = Tokens.Spacing.l).tagged("create-company-open")) {
                    Text(stringResource(R.string.weldbooks_entity_setup_create_company))
                }
                Text(
                    stringResource(R.string.weldbooks_entity_setup_empty_web_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = Tokens.Spacing.l),
                )
                TextButton(
                    onClick = {
                        checking = true
                        scope.launch {
                            books.entities.load()
                            checking = false
                        }
                    },
                    enabled = !checking,
                    modifier = Modifier.tagged("entity-check-again"),
                ) { Text(stringResource(R.string.weldbooks_entity_setup_empty_refresh)) }
                if (session.workspaces.size > 1) {
                    TextButton(onClick = onSwitchWorkspace, modifier = Modifier.tagged("entity-switch-workspace")) {
                        Text(stringResource(R.string.weldbooks_entity_setup_switch_workspace))
                    }
                }
                TextButton(onClick = { confirmSignOut = true }, modifier = Modifier.tagged("entity-sign-out")) {
                    Text(stringResource(R.string.weldbooks_settings_sign_out), color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
    if (creating) {
        CreateEntitySheet(
            onDismiss = { creating = false },
            onCreated = { entity ->
                books.entities.adopt(entity)
                scope.launch { books.entities.load() }
            },
        )
    }
    if (confirmSignOut) {
        ConfirmDialog(
            stringResource(R.string.weldbooks_settings_sign_out_title),
            null,
            stringResource(R.string.weldbooks_settings_sign_out),
            destructive = true,
            onConfirm = {
                confirmSignOut = false
                scope.launch { runCatching { books.env.signOut() }.onFailure { notify(signOutFailed) } }
            },
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** "NL · EUR · Acme Holding B.V." */
private fun entityMeta(entity: Entity): String =
    listOfNotNull(entity.jurisdictionCode, entity.baseCurrency, entity.legalName?.takeIf { it.isNotBlank() && it != entity.name })
        .joinToString(" · ")

/**
 * The administration switcher: pick the company whose books are open, or add
 * another one. Mounted once, opened from Home, More and Settings.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdministrationSheet() {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    val snapshot by books.entities.snapshot.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }
    val brand = Brand.current()
    val defaultLabel = stringResource(R.string.weldbooks_common_default)

    if (snapshot.switcherOpen) {
        ModalBottomSheet(onDismissRequest = { books.entities.closeSwitcher() }) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = Tokens.Spacing.xl).tagged("administrations")) {
                Text(
                    stringResource(R.string.weldbooks_administrations_title),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                )
                snapshot.entities.forEachIndexed { index, entity ->
                    if (index > 0) HorizontalDivider(Modifier.padding(start = 68.dp))
                    val selected = entity.id == snapshot.activeId
                    Row(
                        Modifier.fillMaxWidth().clickable { books.entities.select(entity.id) }
                            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("administration-${entity.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                    ) {
                        IconTile(Icons.Outlined.Apartment, Accents.settings)
                        Column(Modifier.weight(1f)) {
                            Text(entity.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(
                                entityMeta(entity) + if (entity.isDefault) " · $defaultLabel" else "",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                        if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = brand) else Box(Modifier.size(24.dp))
                    }
                }
                HorizontalDivider()
                Row(
                    Modifier.fillMaxWidth().clickable {
                        books.entities.closeSwitcher()
                        adding = true
                    }.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("administration-add"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                ) {
                    Box(
                        Modifier.size(40.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.Add, contentDescription = null, tint = brand) }
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.weldbooks_administrations_add), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = brand)
                        Text(stringResource(R.string.weldbooks_administrations_add_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    if (adding) {
        CreateEntitySheet(
            onDismiss = { adding = false },
            onCreated = { entity ->
                books.entities.adopt(entity)
                // The created row is enough to switch; the refresh fills in what the list adds.
                scope.launch { books.entities.load() }
            },
            additional = true,
            // A second company is usually registered where the first one is.
            initialJurisdiction = books.entity?.jurisdictionCode,
        )
    }
}


/**
 * The open company's name, tax IDs, bank details and address. The country
 * and currency are fixed once the books exist, so they aren't here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditCompanySheet(onDismiss: () -> Unit, onSaved: () -> Unit = {}) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val entity = books.entity ?: return
    val code = entity.jurisdictionCode.uppercase()
    var draft by remember(entity.id) { mutableStateOf(CompanyForm.draft(entity)) }
    var problems by remember { mutableStateOf(CompanyProblems()) }
    var usProblems by remember { mutableStateOf(UsAddressProblems()) }
    var saving by remember { mutableStateOf(false) }
    val saved = stringResource(R.string.weldbooks_company_saved)
    val failed = stringResource(R.string.weldbooks_company_save_failed)

    fun change(next: CompanyDraft) {
        draft = next
        problems = CompanyProblems()
        usProblems = UsAddressProblems()
    }

    fun save() {
        val found = CompanyForm.problems(draft, code, requireName = true)
        // A US address that is started needs its state and ZIP: they decide the sales tax.
        val usFound = if (books.isUs) Addresses.usProblems(draft.address) else UsAddressProblems()
        problems = found
        usProblems = usFound
        if (!found.isEmpty || !usFound.isEmpty) return
        val update = CompanyForm.update(entity, draft)
        if (update.isEmpty) {
            onDismiss()
            return
        }
        saving = true
        scope.launch {
            runCatching { books.repository.updateEntity(entity.id, update) }
                .onSuccess {
                    notify(saved)
                    books.entities.load()
                    onSaved()
                    onDismiss()
                }
                .onFailure { notify(errors.describe(it, failed)) }
            saving = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("edit-company-sheet"),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(stringResource(R.string.weldbooks_company_edit_title), style = MaterialTheme.typography.titleLarge)
            HintText(stringResource(R.string.weldbooks_company_edit_hint))
            FormField(
                stringResource(R.string.weldbooks_company_name),
                draft.name,
                { change(draft.copy(name = it)) },
                error = if (problems.name) stringResource(R.string.weldbooks_entity_setup_company_name_error) else null,
                tag = "company-name",
            )
            CompanyFields(
                code = code,
                draft = draft,
                onChange = ::change,
                problems = problems,
                usProblems = usProblems,
                requiredFields = Jurisdictions.requiredInvoiceFields(code, books.jurisdictions),
                labels = books.labels,
                terminology = books.terminology,
                taxIdLabel = books.labels.taxId,
            )
            Button(onClick = ::save, enabled = !saving, modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.l).tagged("save-company")) {
                Text(stringResource(R.string.weldbooks_company_save))
            }
        }
    }
}

/** Settings: the company first, then sync, then what every WeldSuite app has. */
@Composable
fun SettingsScreen(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference, onBack: () -> Unit, onSwitchWorkspace: () -> Unit) {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    val snapshot by books.entities.snapshot.collectAsStateWithLifecycle()
    val queue by books.queue.items.collectAsStateWithLifecycle()
    val online by books.queue.isOnline.collectAsStateWithLifecycle()
    val syncing by books.queue.isSyncing.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf(false) }
    val entity = snapshot.active
    val appName = stringResource(R.string.weldbooks_app_name)
    val waiting = queue.size

    BooksScaffold(title = stringResource(R.string.weldbooks_settings_title), onBack = onBack) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("settings")) {
            item("company") { CompanyCard(entity, snapshot.canSwitch, onEdit = { editing = true }) }
            item("sync") {
                SectionCard(title = stringResource(R.string.weldbooks_settings_sync)) {
                    DetailRow(stringResource(R.string.weldbooks_settings_connection), stringResource(if (online) R.string.weldbooks_settings_online else R.string.weldbooks_settings_offline))
                    DetailRow(stringResource(R.string.weldbooks_settings_queued_items), waiting.toString())
                    if (waiting > 0) {
                        HintText(pluralStringResource(R.plurals.weldbooks_settings_sign_out_queued, waiting, waiting))
                        OutlinedButton(
                            onClick = { scope.launch { books.queue.sync() } },
                            enabled = online && !syncing,
                            modifier = Modifier.padding(top = Tokens.Spacing.s).tagged("sync-now"),
                        ) {
                            Icon(Icons.Outlined.Sync, contentDescription = null)
                            Text(stringResource(R.string.weldbooks_settings_sync_now), modifier = Modifier.padding(start = Tokens.Spacing.s))
                        }
                    }
                }
            }
            commonSettingsItems(
                env = env,
                appName = appName,
                person = session.person,
                workspace = session.workspace,
                workspaces = session.workspaces,
                appearance = appearance,
                onSwitchWorkspace = onSwitchWorkspace,
            )
            item("bottom") { BottomSpace() }
        }
    }
    if (editing) EditCompanySheet(onDismiss = { editing = false })
}

@Composable
private fun CompanyCard(entity: Entity?, canSwitch: Boolean, onEdit: () -> Unit) {
    val books = LocalBooks.current
    val dash = stringResource(R.string.weldbooks_common_dash)
    val notSet = stringResource(R.string.weldbooks_company_not_set)
    val warning = Tokens.Status.warning.current()
    val required = Jurisdictions.requiredInvoiceFields(books.code, books.jurisdictions)
    val missing = CompanyForm.missingInvoiceFields(entity, required)
    SectionCard(title = stringResource(R.string.weldbooks_settings_company)) {
        val name = entity?.name ?: dash
        if (canSwitch) {
            Row(
                Modifier.fillMaxWidth().clickable { books.entities.openSwitcher() }.padding(vertical = 5.dp).tagged("settings-administration"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.weldbooks_settings_administration), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.weldbooks_screen_switch_administration, name))
            }
        } else {
            DetailRow(stringResource(R.string.weldbooks_settings_name), name)
        }
        DetailRow(stringResource(R.string.weldbooks_settings_jurisdiction), entity?.jurisdictionCode ?: dash)
        DetailRow(stringResource(R.string.weldbooks_settings_base_currency), books.currency)
        DetailRow(
            stringResource(R.string.weldbooks_settings_fiscal_year_start),
            CompanyForm.fiscalYearStart(entity?.fiscalYearStart, books.locale) ?: stringResource(R.string.weldbooks_settings_fiscal_year_fallback),
        )
        // A field the country needs on invoices shows as "Not set" while empty, instead of vanishing.
        @Composable
        fun field(label: String, value: String?, key: String) {
            if (!value.isNullOrBlank()) DetailRow(label, value) else if (key in required) DetailRow(label, notSet, valueColor = warning)
        }
        field(books.labels.taxId, if (books.isUs) entity?.ein else entity?.vatNumber, "vatNumber")
        field(books.labels.registrationId, entity?.registrationNumber, "registrationNumber")
        field(stringResource(R.string.weldbooks_company_iban), entity?.iban, "iban")
        if (books.isUs && entity != null) {
            entity.entityType?.let { DetailRow(stringResource(R.string.weldbooks_settings_legal_form), entityTypeLabel(it)) }
            entity.taxClassification?.let { DetailRow(stringResource(R.string.weldbooks_settings_tax_classification), taxClassificationLabel(it)) }
            entity.dba?.takeIf { it.isNotBlank() }?.let { DetailRow(stringResource(R.string.weldbooks_settings_dba), it) }
        }
        val address = Addresses.lines(entity?.address)
        if (address.isNotEmpty()) {
            DetailRow(stringResource(R.string.weldbooks_settings_address), address.joinToString("\n"))
        } else {
            DetailRow(stringResource(R.string.weldbooks_settings_address), notSet, valueColor = warning)
        }
        if (missing.isNotEmpty()) HintText(stringResource(R.string.weldbooks_settings_missing_for_invoices, invoiceFieldNames(missing)))
        OutlinedButton(onClick = onEdit, enabled = entity != null, modifier = Modifier.padding(top = Tokens.Spacing.s).tagged("edit-company")) {
            Icon(Icons.Outlined.Edit, contentDescription = null)
            Text(stringResource(R.string.weldbooks_settings_edit_company), modifier = Modifier.padding(start = Tokens.Spacing.s))
        }
    }
}
