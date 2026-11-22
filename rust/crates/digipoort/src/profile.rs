//! The protocol constants of Digipoort's WUS koppelvlak 1.2, in one place,
//! each with its source. Sources:
//!
//! - [WUS]: Logius, "WUS 2.0 voor bedrijven v1.2" (koppelvlak XSD, WSDLs,
//!   Koppelvlakbeschrijving and the sample OB request and response).
//! - [STAT]: Logius, "Statussen en foutcodes van Digipoort" v1.6 (8 February 2022).
//! - [DIALOOG]: Belastingdienst, "Generiek Dialoogmodel Aanleveren via
//!   Digipoort WUS voor bedrijven" v2.1 (28 February 2023).
//! - [KVK]: SBR-NL, "Projectachtergrond uitbreiding elektronische deponering
//!   handelsregister" v1.0 (26 October 2022).
//!
//! Not verified against Logius' Aansluit Suite (it was out of reach while
//! this was written): run its dialogues and a pre-production submission per
//! message type before going live. The values marked UNVERIFIED are the ones
//! to check first.

/// SOAP 1.1 [WUS].
pub const SOAP_NS: &str = "http://schemas.xmlsoap.org/soap/envelope/";
/// WS-Addressing 1.0 [WUS].
pub const WSA_NS: &str = "http://www.w3.org/2005/08/addressing";
/// `wsa:ReplyTo`: Digipoort answers on the same connection only [WUS].
pub const WSA_ANONYMOUS: &str = "http://www.w3.org/2005/08/addressing/anonymous";
/// The message types of the koppelvlakservices 1.2, shared by aanleveren
/// and statusinformatie (`elementFormDefault="qualified"`) [WUS].
pub const TYPES_NS: &str = "http://logius.nl/digipoort/koppelvlakservices/1.2/";
/// `SOAPAction` and `wsa:Action` of `aanleveren` [WUS WSDL].
pub const AANLEVER_ACTION: &str =
    "http://logius.nl/digipoort/wus/2.0/aanleverservice/1.2/AanleverService/aanleverenRequest";
/// `SOAPAction` and `wsa:Action` of `getStatussenProces` [WUS WSDL].
pub const STATUS_ACTION: &str = "http://logius.nl/digipoort/wus/2.0/statusinformatieservice/1.2/StatusinformatieService/getStatussenProcesRequest";
/// "Geen autorisatie adres": statuses are read, never pushed to us [WUS sample].
pub const NO_AUTHORISATION_ADDRESS: &str = "http://geenausp.nl";
/// How long a message's `wsu:Timestamp` is valid.
pub const TIMESTAMP_TTL_SECONDS: i64 = 300;

/// The Belastingdienst's BTW-aangifte [WUS sample request].
pub const BERICHTSOORT_OB: &str = "Omzetbelasting";
/// The Opgaaf ICP. UNVERIFIED: Logius lists the flow as "Opgaaf Intra
/// communautaire Prestaties"; the code comes from the Berichtsoortentabel in
/// the Aansluit Suite.
pub const BERICHTSOORT_ICP: &str = "ICP";
/// The KvK deposit of a jaarrekening in the NT taxonomy (an `.xbrl`
/// instance over aanleverservice 1.2) [KVK].
pub const BERICHTSOORT_KVK: &str = "Jaarrekening";

/// Fiscal number: the Belastingdienst identifies the belanghebbende of an
/// OB message by its omzetbelastingnummer without "NL" (`001000044B37`)
/// [WUS sample request].
pub const IDENTITY_FISCAL: &str = "Fi";
/// The KvK number (eight digits). UNVERIFIED for the deposit flow.
pub const IDENTITY_KVK: &str = "KvK";
/// The belanghebbende delivers itself (through its software); no
/// machtiging is registered for submitting [WUS sample request,
/// Servicebeschrijving Aanleveren §3.5].
pub const ROLE_COMPANY: &str = "Bedrijf";

/// Statuses that end a delivery in failure [STAT]: the message was refused
/// and nothing was filed. 510 is the receiving party's refusal (the
/// Belastingdienst's or the KvK's), with its answer in `statusdetails`.
const FAILED: &[&str] = &[
    "210", "230", "311", "321", "410", "425", "510", "810", "910", "1010", "1210", "1260", "1270",
    "1310", "4110", "4125",
];

/// Whether `code` is a final failure.
pub fn is_failure(code: &str) -> bool {
    if FAILED.contains(&code) {
        return true;
    }
    // The x10 and x20 codes of the 2000–2699 range [STAT].
    let bytes = code.as_bytes();
    code.len() == 4
        && bytes[0] == b'2'
        && (b'0'..=b'6').contains(&bytes[1])
        && (&code[2..] == "10" || &code[2..] == "20")
}

/// The final success: "validatie bij uitvragende partij gelukt", the
/// Belastingdienst's ontvangstbevestiging or the KvK's acceptance
/// [STAT, DIALOOG]. 400 (delivered) is not final: the message can still be
/// refused.
pub const ACCEPTED: &str = "500";
/// "U bent niet gerechtigd": the status of a delivery made with another
/// certificate [STAT].
pub const NOT_AUTHORISED: &str = "000";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_final_failures() {
        for code in ["210", "311", "510", "2010", "2620", "4125"] {
            assert!(is_failure(code), "{code}");
        }
        for code in [
            "100", "200", "400", "405", "500", "2000", "2710", "2015", "",
        ] {
            assert!(!is_failure(code), "{code}");
        }
    }
}
