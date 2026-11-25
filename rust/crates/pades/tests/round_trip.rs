//! A PDF through every step WeldSign takes: a seal at B-T, a filled form
//! field and a second signature in a later revision, the DSS and a document
//! timestamp, each checked again after the next is added.

use lopdf::{Dictionary, Document, Object, Stream, dictionary};
use weldsuite_pades::crypto::Hash;
use weldsuite_pades::local::{LocalCa, LocalTsa, Profile};
use weldsuite_pades::oid;
use weldsuite_pades::pdf::FieldKind;
use weldsuite_pades::{
    Revision, SIGNATURE_SIZE, SignatureKind, SignatureSpec, ValidationData, add_validation_data,
    prepare_document_timestamp, prepare_signature, signing, verify_pdf,
};

fn blank_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let content = doc.add_object(Stream::new(
        Dictionary::new(),
        b"BT /F1 12 Tf 72 720 Td (A contract) Tj ET".to_vec(),
    ));
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![Object::Integer(0), Object::Integer(0), Object::Integer(612), Object::Integer(792)],
        "Contents" => content,
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page)],
            "Count" => Object::Integer(1),
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).expect("save");
    out
}

fn cades(name: &str) -> SignatureKind {
    SignatureKind::Cades {
        name: Some(name.to_owned()),
        reason: Some("Signed with WeldSign".to_owned()),
        location: None,
        signing_time: time::OffsetDateTime::now_utc(),
    }
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one file through every step, checked as it goes"
)]
fn every_level_up_to_lta_and_each_signature_stays_intact() {
    let ca = LocalCa::new("Test root").expect("ca");
    let tsa = LocalTsa::new(&ca).expect("tsa");
    let seal = ca
        .issue(
            &[
                (oid::COUNTRY, "NL"),
                (oid::ORGANIZATION, "WeldSuite"),
                (oid::COMMON_NAME, "WeldSuite seal"),
            ],
            Profile::Seal { qualified: true },
        )
        .expect("seal");
    let person = ca
        .issue(
            &[
                (oid::COUNTRY, "BE"),
                (oid::GIVEN_NAME, "Ann"),
                (oid::SURNAME, "Peeters"),
                (oid::COMMON_NAME, "Ann Peeters"),
            ],
            Profile::Signer { qualified: false },
        )
        .expect("person");

    // Revision 1: an empty signature field for the person, a text field.
    let mut revision = Revision::open(blank_pdf()).expect("open");
    let sig_field = revision
        .add_form_field(FieldKind::Signature, "ws_sig_rcp1", 0, [0.0; 4])
        .expect("sig field");
    revision
        .add_form_field(FieldKind::Text, "ws_name", 0, [72.0, 600.0, 272.0, 620.0])
        .expect("text field");
    let prepared = revision.write().expect("prepared");

    // Revision 2: the seal, timestamped (B-T).
    let pending = prepare_signature(
        Revision::open(prepared).expect("open"),
        &SignatureSpec {
            field_name: "ws_seal".to_owned(),
            field: None,
            kind: cades("WeldSuite"),
            contents_size: SIGNATURE_SIZE,
        },
        &seal.certificate,
        &seal.chain,
    )
    .expect("prepare seal");
    let value = seal.sign(pending.data_to_be_signed()).expect("sign");
    let token = tsa
        .token(&signing::signature_timestamp_digest(&value))
        .expect("token");
    let sealed = pending.finish(&value, Some(&token)).expect("sealed");
    let reports = verify_pdf(&sealed).expect("verify");
    assert_eq!(reports.len(), 1);
    assert!(reports[0].intact, "{:?}", reports[0].error);
    assert!(reports[0].qualified());
    assert!(reports[0].timestamp.is_some());

    // Revision 3: the person fills the text field and signs their field.
    let mut revision = Revision::open(sealed).expect("open");
    let name_field = revision.find_field("ws_name").expect("found");
    assert_eq!(revision.find_field("ws_sig_rcp1"), Some(sig_field));
    revision
        .fill_text(
            name_field,
            "Ann Peeters",
            Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![Object::Integer(72), Object::Integer(600), Object::Integer(272), Object::Integer(620)] },
                b"BT /Helv 10 Tf 74 605 Td (Ann Peeters) Tj ET".to_vec(),
            ),
        )
        .expect("fill");
    let pending = prepare_signature(
        revision,
        &SignatureSpec {
            field_name: "ws_sig_rcp1".to_owned(),
            field: Some(sig_field),
            kind: cades("Ann Peeters"),
            contents_size: SIGNATURE_SIZE,
        },
        &person.certificate,
        &person.chain,
    )
    .expect("prepare signer");
    let value = person.sign(pending.data_to_be_signed()).expect("sign");
    let signed = pending.finish(&value, None).expect("signed");

    // B-LT and B-LTA.
    let mut data = ValidationData::default();
    for cert in [
        &seal.certificate,
        &person.certificate,
        ca.root(),
        tsa.certificate(),
    ] {
        data.certificates.push(cert.der.clone());
    }
    let with_dss = add_validation_data(signed, &data).expect("dss");
    let stamp = prepare_document_timestamp(Revision::open(with_dss).expect("open"), "ws_ts_1")
        .expect("doc ts");
    let token = tsa.token(&stamp.digest(Hash::Sha256)).expect("token");
    let done = stamp.embed(&token).expect("embedded");

    let reports = verify_pdf(&done).expect("verify");
    assert_eq!(reports.len(), 3, "{reports:#?}");
    for report in &reports {
        assert!(report.intact, "{:?}", report.error);
    }
    assert_eq!(reports[0].field_name.as_deref(), Some("ws_seal"));
    assert_eq!(reports[1].field_name.as_deref(), Some("ws_sig_rcp1"));
    assert_eq!(
        reports[1].signer.as_ref().map(|c| c.subject.display()),
        Some("Ann Peeters".to_owned())
    );
    assert!(!reports[1].qualified());
    assert!(reports[2].document_timestamp);
    assert_eq!(reports[2].covers, done.len());
    assert_eq!(reports[0].chain.len(), 2);
    lopdf::Document::load_mem(&done).expect("still a PDF");

    // Change one byte the seal covers: the seal breaks.
    let mut tampered = done.clone();
    let at = 40;
    tampered[at] = tampered[at].wrapping_add(1);
    let reports = verify_pdf(&tampered).expect("verify");
    assert!(!reports[0].intact);
}

#[test]
fn a_signature_value_for_other_bytes_is_refused() {
    let ca = LocalCa::new("Test root").expect("ca");
    let seal = ca
        .issue(
            &[(oid::COMMON_NAME, "Seal")],
            Profile::Seal { qualified: false },
        )
        .expect("seal");
    let pending = prepare_signature(
        Revision::open(blank_pdf()).expect("open"),
        &SignatureSpec {
            field_name: "ws_seal".to_owned(),
            field: None,
            kind: cades("WeldSuite"),
            contents_size: SIGNATURE_SIZE,
        },
        &seal.certificate,
        &seal.chain,
    )
    .expect("prepare");
    let wrong = seal.sign(b"something else").expect("sign");
    assert!(pending.finish(&wrong, None).is_err());
}

#[test]
fn pem_round_trips_and_timestamp_requests_are_answered() {
    let ca = LocalCa::new("Test root").expect("ca");
    let pem = ca.root().to_pem();
    let read = weldsuite_pades::Certificate::from_pem(&pem).expect("pem");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].der, ca.root().der);
    assert!(read[0].is_self_issued());

    let tsa = LocalTsa::new(&ca).expect("tsa");
    let digest = weldsuite_pades::crypto::sha256(b"hello");
    let request = weldsuite_pades::tsp::request(&digest, &[1, 2, 3, 4]);
    let response = tsa.respond(&request).expect("respond");
    let token = weldsuite_pades::tsp::token_from_response(&response).expect("token");
    let stamp =
        weldsuite_pades::tsp::verify_token(&token, |hash| hash.digest(b"hello")).expect("valid");
    assert!(
        stamp
            .tsa
            .extensions
            .ext_key_usage
            .iter()
            .any(|k| k == oid::KP_TIME_STAMPING)
    );
    assert!(weldsuite_pades::tsp::verify_token(&token, |hash| hash.digest(b"other")).is_err());
}
