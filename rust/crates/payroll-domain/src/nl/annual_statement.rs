//! The Dutch annual statement, the jaaropgaaf (`nl/annual-statement.ts`).

use serde::Deserialize;

use crate::documents::{DocumentField, DocumentSection, Lang, PayrollDocument, euro_text};
use crate::js::number_text;
use crate::types::{NlFilingData, Ytd};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualEmployer {
    pub name: String,
    pub loonheffingennummer: Option<String>,
    pub address: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualEmployee {
    pub name: String,
    pub bsn: Option<String>,
    pub date_of_birth: Option<String>,
    pub address: Vec<String>,
    pub employment_start: Option<String>,
    pub employment_end: Option<String>,
    pub personnel_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualPayslip {
    pub pay_date: String,
    pub filing_data: NlFilingData,
    pub ytd: Ytd,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NlAnnualStatementInput {
    pub lang: Lang,
    pub year: i64,
    pub employer: AnnualEmployer,
    pub employee: AnnualEmployee,
    pub payslips: Vec<AnnualPayslip>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NlAnnualTotals {
    pub loon_lb_ph: f64,
    pub wage_tax: f64,
    pub labour_credit: f64,
    pub zvw_withheld: f64,
    pub employee_insurance_premiums: f64,
    pub zvw_employer_levy: f64,
    pub loon_sv: f64,
    pub holiday_allowance_paid: f64,
    pub company_car_value: f64,
    pub company_car_employee_contribution: f64,
    pub pension_employee: f64,
    pub hours_paid: f64,
}

/// `nlAnnualTotals(payslips)`.
pub fn nl_annual_totals(payslips: &[AnnualPayslip]) -> NlAnnualTotals {
    let mut t = NlAnnualTotals::default();
    for p in payslips {
        let a = &p.filing_data.amounts;
        t.loon_lb_ph += a.loon_lb_ph;
        t.wage_tax += a.wage_tax;
        t.labour_credit += a.labour_credit;
        t.zvw_withheld += a.zvw_withheld;
        t.employee_insurance_premiums +=
            a.awf_premium + a.aof_premium + a.wko_premium + a.whk_premium;
        t.zvw_employer_levy += a.zvw_employer_levy;
        t.loon_sv += a.loon_sv;
        t.holiday_allowance_paid += a.holiday_allowance_paid;
        t.company_car_value += a.company_car_value;
        t.company_car_employee_contribution += a.company_car_employee_contribution;
        t.pension_employee += a.pension_employee;
        t.hours_paid += p.filing_data.hours_paid;
    }
    t
}

fn format_bsn(bsn: Option<&str>) -> String {
    let Some(bsn) = bsn.filter(|b| !b.is_empty()) else {
        return "—".into();
    };
    let digits: String = bsn.chars().filter(char::is_ascii_digit).collect();
    let d = format!("{digits:0>9}");
    format!("{}.{}.{}", &d[..4], &d[4..6], &d[6..])
}

fn s(text: &str) -> String {
    text.to_owned()
}

/// `nlAnnualStatement(input)`.
#[allow(clippy::too_many_lines)]
pub fn nl_annual_statement(input: &NlAnnualStatementInput) -> PayrollDocument {
    let lang = input.lang;
    let nl = lang.is_nl();
    let t = nl_annual_totals(&input.payslips);
    let m = |c: f64| euro_text(c, lang);
    let pick = |a: &str, b: &str| if nl { s(a) } else { s(b) };
    let start = input
        .employee
        .employment_start
        .as_deref()
        .filter(|v| !v.is_empty());
    let end = input
        .employee
        .employment_end
        .as_deref()
        .filter(|v| !v.is_empty());
    let employment = if start.is_some() || end.is_some() {
        format!(
            "{} – {}",
            input.employee.employment_start.as_deref().unwrap_or("…"),
            input.employee.employment_end.as_deref().unwrap_or(if nl {
                "heden"
            } else {
                "present"
            })
        )
    } else {
        s("—")
    };
    let year = input.year;
    let mut from = vec![input.employer.name.clone()];
    from.extend(input.employer.address.iter().cloned());
    if let Some(lhnr) = input
        .employer
        .loonheffingennummer
        .as_deref()
        .filter(|v| !v.is_empty())
    {
        from.push(format!(
            "{}: {lhnr}",
            if nl {
                "Loonheffingennummer"
            } else {
                "Payroll tax number"
            }
        ));
    }
    let mut to = vec![input.employee.name.clone()];
    to.extend(input.employee.address.iter().cloned());

    let mut employee_fields = vec![
        DocumentField::new(pick("Naam", "Name"), input.employee.name.clone()),
        DocumentField::new(
            pick("Burgerservicenummer", "Citizen service number (BSN)"),
            format_bsn(input.employee.bsn.as_deref()),
        ),
    ];
    if let Some(dob) = input
        .employee
        .date_of_birth
        .as_deref()
        .filter(|v| !v.is_empty())
    {
        employee_fields.push(DocumentField::new(
            pick("Geboortedatum", "Date of birth"),
            dob,
        ));
    }
    if let Some(nr) = input
        .employee
        .personnel_number
        .as_deref()
        .filter(|v| !v.is_empty())
    {
        employee_fields.push(DocumentField::new(
            pick("Personeelsnummer", "Personnel number"),
            nr,
        ));
    }
    employee_fields.push(DocumentField::new(
        pick("Periode in dienst", "Employment"),
        employment,
    ));

    let paragraphs = if nl {
        vec![
            s(
                "Het loon onder 1 is het loon waarover loonheffing is ingehouden. Dit bedrag en de ingehouden loonheffing onder 2 geeft u op in uw aangifte inkomstenbelasting.",
            ),
            s(
                "De verrekende arbeidskorting onder 3 is de arbeidskorting die met uw maandloon is verrekend. De premies onder 5 en de werkgeversheffing onder 6 heeft uw werkgever betaald; ze zijn niet op uw loon ingehouden.",
            ),
            s("Kloppen deze gegevens niet? Neem dan contact op met uw werkgever."),
        ]
    } else {
        vec![
            s(
                "Box 1 is the wage on which wage tax was withheld. Report it, with the tax withheld in box 2, in your Dutch income tax return.",
            ),
            s(
                "Box 3 is the labour tax credit applied with your monthly pay. The premiums in box 5 and the levy in box 6 were paid by your employer and not withheld from your pay.",
            ),
            s("If anything is wrong, contact your employer."),
        ]
    };

    PayrollDocument {
        title: if nl {
            format!("Jaaropgaaf {year}")
        } else {
            format!("Annual statement {year}")
        },
        subtitle: Some(pick(
            "Opgaaf van loon en ingehouden loonheffingen",
            "Statement of wages and payroll taxes withheld",
        )),
        language: lang,
        from: Some(from),
        to: Some(to),
        sections: vec![
            DocumentSection::Fields {
                title: Some(pick("Gegevens werknemer", "Employee")),
                fields: employee_fields,
            },
            DocumentSection::Fields {
                title: Some(pick("Gegevens werkgever", "Employer")),
                fields: vec![DocumentField::new(
                    pick("Naam", "Name"),
                    input.employer.name.clone(),
                )],
            },
            DocumentSection::Fields {
                title: Some(if nl {
                    format!("Bedragen {year}")
                } else {
                    format!("Amounts {year}")
                }),
                fields: vec![
                    DocumentField::new(
                        pick(
                            "1 Loon voor de loonbelasting/volksverzekeringen",
                            "1 Wage for wage tax and national insurance",
                        ),
                        m(t.loon_lb_ph),
                    )
                    .emphasised(),
                    DocumentField::new(
                        pick(
                            "2 Ingehouden loonbelasting/premie volksverzekeringen (loonheffing)",
                            "2 Wage tax and national insurance withheld",
                        ),
                        m(t.wage_tax),
                    )
                    .emphasised(),
                    DocumentField::new(
                        pick("3 Verrekende arbeidskorting", "3 Labour tax credit applied"),
                        m(t.labour_credit),
                    ),
                    DocumentField::new(
                        pick(
                            "4 Ingehouden bijdrage Zorgverzekeringswet",
                            "4 Health insurance contribution withheld (Zvw)",
                        ),
                        m(t.zvw_withheld),
                    ),
                    DocumentField::new(
                        pick(
                            "5 Totaal premies werknemersverzekeringen",
                            "5 Employee insurance premiums paid by the employer",
                        ),
                        m(t.employee_insurance_premiums),
                    ),
                    DocumentField::new(
                        pick(
                            "6 Werkgeversheffing Zorgverzekeringswet",
                            "6 Employer health insurance levy (Zvw)",
                        ),
                        m(t.zvw_employer_levy),
                    ),
                ],
            },
            DocumentSection::Table {
                title: Some(pick("Ter informatie", "For information")),
                columns: vec![pick("Omschrijving", "Item"), pick("Bedrag", "Amount")],
                align_right: Some(vec![1]),
                rows: vec![
                    vec![
                        pick(
                            "Loon werknemersverzekeringen (SV-loon)",
                            "Wage for employee insurances",
                        ),
                        m(t.loon_sv),
                    ],
                    vec![
                        pick("Uitbetaald vakantiegeld", "Holiday allowance paid"),
                        m(t.holiday_allowance_paid),
                    ],
                    vec![
                        pick("Pensioenpremie werknemer", "Employee pension contribution"),
                        m(t.pension_employee),
                    ],
                    vec![
                        pick("Bijtelling auto van de zaak", "Company car taxable benefit"),
                        m(t.company_car_value),
                    ],
                    vec![
                        pick(
                            "Eigen bijdrage auto van de zaak",
                            "Own contribution company car",
                        ),
                        m(t.company_car_employee_contribution),
                    ],
                    vec![
                        pick("Verloonde uren", "Hours paid"),
                        number_text(t.hours_paid),
                    ],
                ],
                totals: None,
            },
            DocumentSection::Text {
                title: Some(pick("Toelichting", "Notes")),
                paragraphs,
            },
        ],
        footer: Some(vec![if nl {
            format!("Jaaropgaaf {year}")
        } else {
            format!("Annual statement {year} (jaaropgaaf)")
        }]),
        watermark: Some(None),
    }
}
