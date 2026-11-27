use std::io::Write as _;

use base64::Engine as _;

use super::*;

const XML: &str = r#"<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>4242</report_id>
    <date_range><begin>1764028800</begin><end>1764115199</end></date_range>
  </report_metadata>
  <policy_published><domain>acme.test</domain><p>none</p></policy_published>
  <record>
    <row><source_ip>198.51.100.7</source_ip><count>12</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>acme.test</header_from></identifiers>
    <auth_results><dkim><domain>acme.test</domain><selector>ws1</selector><result>pass</result></dkim></auth_results>
  </record>
</feedback>"#;

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).expect("gzip");
    encoder.finish().expect("gzip")
}

/// A report message as Google sends one, with Haraka's results on top.
fn message(from: &str, dmarc: &str, attachment: &[u8]) -> Vec<u8> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(attachment);
    format!(
        "Authentication-Results: mx.weldsuite.test; spf=pass smtp.mailfrom={from}; dkim=pass header.d=google.com; dmarc={dmarc} header.from=google.com\r\n\
From: {from}\r\n\
To: dmarc@reports.weldsuite.test\r\n\
Subject: Report domain: acme.test Submitter: google.com Report-ID: 4242\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: text/plain\r\n\
\r\n\
This is an aggregate report from google.com.\r\n\
--b1\r\n\
Content-Type: application/gzip; name=\"google.com!acme.test!1764028800!1764115199.xml.gz\"\r\n\
Content-Disposition: attachment; filename=\"google.com!acme.test!1764028800!1764115199.xml.gz\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
{encoded}\r\n\
--b1--\r\n"
    )
    .into_bytes()
}

#[test]
fn reads_an_authenticated_report() {
    let (report, authenticated) = read(&message(
        "noreply-dmarc-support@google.com",
        "pass",
        &gzip(XML.as_bytes()),
    ))
    .expect("report");
    assert!(authenticated);
    assert_eq!(report.report_id, "4242");
    assert_eq!(report.records.len(), 1);
    assert_eq!(report.records[0].count, 12);
}

#[test]
fn a_report_that_fails_dmarc_or_comes_from_elsewhere_is_not_authenticated() {
    let gz = gzip(XML.as_bytes());
    let (_, failing) =
        read(&message("noreply-dmarc-support@google.com", "fail", &gz)).expect("report");
    assert!(!failing);
    let (_, forged) = read(&message("reports@forger.test", "pass", &gz)).expect("report");
    assert!(!forged);
}

#[test]
fn failure_reports_and_other_mail_are_not_read() {
    let arf = b"From: a@b.test\r\nContent-Type: multipart/report; report-type=feedback-report; boundary=\"x\"\r\n\r\n--x\r\nContent-Type: message/feedback-report\r\n\r\nFeedback-Type: auth-failure\r\n--x--\r\n";
    assert_eq!(read(arf).map(|_| ()), Err(Outcome::NotAggregate));
    let note =
        b"From: a@b.test\r\nContent-Type: text/plain\r\n\r\nHello, please add me to your list.\r\n";
    assert_eq!(read(note).map(|_| ()), Err(Outcome::NotAggregate));
}

#[test]
fn a_broken_attachment_is_invalid() {
    let broken = message(
        "noreply-dmarc-support@google.com",
        "pass",
        &[0x1f, 0x8b, 1, 2, 3],
    );
    assert!(matches!(read(&broken), Err(Outcome::Invalid(_))));
}

#[test]
fn reporters_are_labelled_by_organisation() {
    assert_eq!(reporter_label("google.com"), "google");
    assert_eq!(reporter_label("dmarcreport.microsoft.com"), "microsoft");
    assert_eq!(reporter_label("example.test"), "other");
}
