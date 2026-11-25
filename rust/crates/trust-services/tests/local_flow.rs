//! The two-redirect signer flow against the local trust service, ending in
//! a qualified-looking PAdES signature that verifies, and a seal after it.

use weldsuite_pades::{
    Revision, SIGNATURE_SIZE, SignatureKind, SignatureSpec, prepare_signature, signing, verify_pdf,
};
use weldsuite_trust_services::local::LocalTrustService;
use weldsuite_trust_services::{AuthorizeRequest, Callback, IdentifyRequest, Level, TrustService};

fn blank_pdf() -> Vec<u8> {
    use lopdf::{Document, Object, dictionary};
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![Object::Integer(0), Object::Integer(0), Object::Integer(595), Object::Integer(842)],
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => Object::Integer(1) }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).expect("save");
    out
}

fn code_of(url: &str) -> String {
    url.split(['?', '&'])
        .find_map(|part| part.strip_prefix("code="))
        .map(|code| code.replace("%2E", "."))
        .expect("code")
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "the whole two-redirect flow and the seal, in order"
)]
async fn a_qualified_signer_then_the_seal() {
    let trust = LocalTrustService::new().expect("trust");
    let redirect = "https://sign.example/signature-callback";
    let url = trust
        .identify_url(&IdentifyRequest {
            level: Level::Qes,
            redirect_uri: redirect,
            state: "s1",
            code_challenge: "c",
            signer_name: Some("Ann Peeters"),
            signer_email: Some("ann@example.com"),
            locale: "nl",
        })
        .expect("identify url");
    assert!(url.starts_with(redirect));
    let code = code_of(&url);
    let credential = trust
        .identified(
            Level::Qes,
            Callback {
                code: &code,
                redirect_uri: redirect,
                code_verifier: "v",
            },
        )
        .await
        .expect("identified");
    assert_eq!(
        credential.identity.certificate.subject.display(),
        "Ann Peeters"
    );
    assert!(credential.identity.certificate.qualified_with_qscd());

    let pending = prepare_signature(
        Revision::open(blank_pdf()).expect("open"),
        &SignatureSpec {
            field_name: "ws_sig_rcp1".to_owned(),
            field: None,
            kind: SignatureKind::Cades {
                name: Some("Ann Peeters".to_owned()),
                reason: None,
                location: None,
                signing_time: time::OffsetDateTime::now_utc(),
            },
            contents_size: SIGNATURE_SIZE,
        },
        &credential.identity.certificate,
        &credential.identity.chain,
    )
    .expect("prepare");
    let url = trust
        .authorize_url(&AuthorizeRequest {
            credential: &credential,
            data_to_be_signed: pending.data_to_be_signed(),
            redirect_uri: redirect,
            state: "s2",
            code_challenge: "c",
            description: "Contract",
            locale: "nl",
        })
        .expect("authorize url");
    let code = code_of(&url);
    let value = trust
        .sign_authorized(
            &credential,
            pending.data_to_be_signed(),
            Callback {
                code: &code,
                redirect_uri: redirect,
                code_verifier: "v",
            },
        )
        .await
        .expect("signed");
    let token = trust
        .timestamp(&signing::signature_timestamp_digest(&value))
        .await
        .expect("tsa")
        .expect("token");
    let signed = pending.finish(&value, Some(&token)).expect("finish");

    let seal = trust.seal_identity().await.expect("seal");
    let pending = prepare_signature(
        Revision::open(signed).expect("open"),
        &SignatureSpec {
            field_name: "ws_seal".to_owned(),
            field: None,
            kind: SignatureKind::Cades {
                name: Some("WeldSuite".to_owned()),
                reason: None,
                location: None,
                signing_time: time::OffsetDateTime::now_utc(),
            },
            contents_size: SIGNATURE_SIZE,
        },
        &seal.certificate,
        &seal.chain,
    )
    .expect("prepare seal");
    let value = trust
        .seal_sign(pending.data_to_be_signed())
        .await
        .expect("seal sign");
    let sealed = pending.finish(&value, None).expect("sealed");

    let reports = verify_pdf(&sealed).expect("verify");
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|r| r.intact));
    assert!(reports[0].qualified());
    assert!(reports[0].timestamp.is_some());

    let data = trust
        .validation_data(&[reports[0].chain.clone()])
        .await
        .expect("validation data");
    assert!(data.certificates.len() >= 3);
}
