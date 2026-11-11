//! A managed device as asset fields (`mapIntuneDevice`, `assetTypeFor`,
//! `mapCompliance`, `deviceChecksum` of
//! `@weldsuite/core-domain/asset-sources`).
//!
//! Device facts (name, serial number, manufacturer, model, OS, compliance,
//! last check-in, primary user, Intune id) are written on every change; the
//! asset type and the status only when the record is created, so a person's
//! corrections are never overwritten. A fact the device does not report is
//! not written.

use serde_json::Value;
use sha2::{Digest, Sha256};
use weldsuite_kit::validation::js_trim;

use crate::js::{Js, js_date, js_string, stringify};

/// The `status` of a record the import creates.
pub(crate) const CREATED_STATUS: &str = "in_use";

/// `COMPLIANCE_OPTIONS`: `(value, label)`.
pub(crate) const COMPLIANCE_OPTIONS: [(&str, &str); 7] = [
    ("compliant", "Compliant"),
    ("noncompliant", "Non-compliant"),
    ("in_grace_period", "In grace period"),
    ("conflict", "Conflict"),
    ("error", "Error"),
    ("config_manager", "Managed by Configuration Manager"),
    ("unknown", "Unknown"),
];

/// `mapCompliance`: Graph's `complianceState` as the field's option.
pub(crate) fn map_compliance(state: Option<&Value>) -> &'static str {
    // `String(state ?? '').toLowerCase()`.
    let state = match state {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.to_lowercase(),
        Some(other) => js_string(&Js::from_jsonb(other)).to_lowercase(),
    };
    match state.as_str() {
        "compliant" => "compliant",
        "noncompliant" => "noncompliant",
        "ingraceperiod" => "in_grace_period",
        "conflict" => "conflict",
        "error" => "error",
        "configmanager" => "config_manager",
        _ => "unknown",
    }
}

/// Is `needle` in `text` at a place `allowed` accepts, given the characters
/// before and after the match?
fn found(text: &str, needle: &str, allowed: impl Fn(Option<char>, Option<char>) -> bool) -> bool {
    text.match_indices(needle).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + needle.len()..].chars().next();
        allowed(before, after)
    })
}

/// `/imac|mac ?mini|mac ?studio|mac ?pro(?![a-z])|optiplex|thinkcentre|
/// prodesk|elitedesk|\bnuc(?![a-z])|desktop|tower/i`: a model that sits on a
/// desk.
fn is_desktop_model(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    let letter = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase());
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    [
        "imac",
        "macmini",
        "mac mini",
        "macstudio",
        "mac studio",
        "optiplex",
        "thinkcentre",
        "prodesk",
        "elitedesk",
        "desktop",
        "tower",
    ]
    .iter()
    .any(|name| model.contains(name))
        || ["macpro", "mac pro"]
            .iter()
            .any(|name| found(&model, name, |_, after| !letter(after)))
        || found(&model, "nuc", |before, after| {
            !word(before) && !letter(after)
        })
}

/// `assetTypeFor`: the asset type of a new record, from the operating system
/// and the model.
pub(crate) fn asset_type_for(operating_system: Option<&str>, model: Option<&str>) -> &'static str {
    let os = operating_system.unwrap_or_default().to_lowercase();
    let hardware = model.unwrap_or_default();
    let letter = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase());
    if os.contains("android") {
        return "phone";
    }
    // `/(^|[^a-z])ios([^a-z]|$)/`.
    if os.contains("ipados")
        || found(&os, "ios", |before, after| {
            !letter(before) && !letter(after)
        })
    {
        return if js_trim(hardware).to_lowercase().starts_with("ipad") {
            "tablet"
        } else {
            "phone"
        };
    }
    if ["windows", "macos", "mac os", "linux"]
        .iter()
        .any(|name| os.contains(name))
    {
        return if is_desktop_model(hardware) {
            "desktop"
        } else {
            "laptop"
        };
    }
    "other"
}

/// `text(value)`: a string, trimmed; `None` when it is empty or not one.
pub(crate) fn text(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(raw)) = value else {
        return None;
    };
    let trimmed = js_trim(raw);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `checkIn(value)`: the last check-in as `toISOString()`. Graph reports
/// "never" as 0001-01-01; anything before 1970 is not a check-in.
fn check_in(value: Option<&Value>) -> Option<String> {
    let iso = js_date(&text(value)?)?;
    // `time < 0`: a negative year, or a four-digit one before 1970 (a year
    // past 9999 starts with `+`).
    let before_epoch = iso.starts_with('-') || (!iso.starts_with('+') && &iso[..4] < "1970");
    (!before_epoch).then_some(iso)
}

/// `MappedDevice`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MappedDevice {
    /// The managedDevice id.
    pub(crate) external_id: String,
    pub(crate) serial_number: Option<String>,
    /// The email the owner is looked up by (`emailAddress`, else
    /// `userPrincipalName`), lower-cased.
    pub(crate) user_email: Option<String>,
    /// Every device fact by field slug, in the order the checksum is taken
    /// over; `None` where the device reports nothing.
    pub(crate) values: Vec<(&'static str, Option<String>)>,
    /// The asset type of a record this device creates.
    pub(crate) asset_type: &'static str,
}

impl MappedDevice {
    /// `factsOf(values)`: the facts the device reports, which is what a
    /// write sends.
    pub(crate) fn facts(&self) -> Vec<(String, Js)> {
        self.values
            .iter()
            .filter_map(|(slug, value)| {
                value
                    .as_ref()
                    .map(|value| ((*slug).to_owned(), Js::String(value.clone())))
            })
            .collect()
    }

    /// `deviceChecksum(values)`: SHA-256 (hex) of the values as
    /// `JSON.stringify` writes them, in their fixed key order. Stored with
    /// the mapping, so an unchanged device is not written again, by either
    /// backend.
    pub(crate) fn checksum(&self) -> String {
        let values = Js::Object(
            self.values
                .iter()
                .map(|(slug, value)| {
                    let value = value.clone().map_or(Js::Null, Js::String);
                    ((*slug).to_owned(), value)
                })
                .collect(),
        );
        hex::encode(Sha256::digest(stringify(&values).as_bytes()))
    }
}

/// `mapIntuneDevice`: the managedDevice as asset fields; `None` when it has
/// no id (TypeScript throws).
pub(crate) fn map_intune_device(device: &Value) -> Option<MappedDevice> {
    let field = |name: &str| text(device.get(name));
    let id = field("id")?;
    let serial_number = field("serialNumber");
    let operating_system = field("operatingSystem");
    let model = field("model");
    let upn = field("userPrincipalName");
    let email = field("emailAddress");

    let name = field("deviceName")
        .or_else(|| field("managedDeviceName"))
        .or_else(|| serial_number.clone())
        .unwrap_or_else(|| id.clone());
    let asset_type = asset_type_for(operating_system.as_deref(), model.as_deref());
    let values = vec![
        ("name", Some(name)),
        ("serial_number", serial_number.clone()),
        ("manufacturer", field("manufacturer")),
        ("model", model),
        ("operating_system", operating_system),
        ("os_version", field("osVersion")),
        (
            "compliance",
            Some(map_compliance(device.get("complianceState")).to_owned()),
        ),
        ("last_check_in", check_in(device.get("lastSyncDateTime"))),
        ("primary_user", upn.clone().or_else(|| email.clone())),
        ("intune_device_id", Some(id.clone())),
    ];
    Some(MappedDevice {
        external_id: id,
        serial_number,
        user_email: email.or(upn).map(|address| address.to_lowercase()),
        values,
        asset_type,
    })
}

#[cfg(test)]
mod tests {
    //! The mapper's cases of `asset-sources.test.ts`.

    use serde_json::json;

    use super::*;

    #[test]
    fn the_asset_type_follows_the_operating_system_and_the_model() {
        for (os, model, expected) in [
            (Some("iOS/iPadOS"), Some("iPad Pro 11-inch"), "tablet"),
            (Some("iOS/iPadOS"), Some("iPhone 15"), "phone"),
            (Some("iOS"), None, "phone"),
            (Some("Android"), Some("Pixel 8"), "phone"),
            (Some("Android"), Some("Galaxy Tab S9"), "phone"),
            (Some("Windows"), Some("Latitude 7440"), "laptop"),
            (Some("Windows"), Some("OptiPlex 7010"), "desktop"),
            (Some("Windows"), Some("ThinkCentre M70q"), "desktop"),
            (Some("Windows"), Some("HP ProDesk 400 G9"), "desktop"),
            (Some("Windows"), Some("EliteDesk 800"), "desktop"),
            (Some("Windows"), Some("Intel NUC11"), "desktop"),
            (Some("Windows"), Some("Precision Tower 5860"), "desktop"),
            (Some("Windows"), Some("Surface Laptop 5"), "laptop"),
            (Some("macOS"), Some("MacBookPro18,1"), "laptop"),
            (Some("macOS"), Some("MacBook Air"), "laptop"),
            (Some("macOS"), Some("iMac21,1"), "desktop"),
            (Some("macOS"), Some("Macmini9,1"), "desktop"),
            (Some("macOS"), Some("Mac Studio"), "desktop"),
            (Some("macOS"), Some("MacPro7,1"), "desktop"),
            (Some("Linux"), Some("ThinkPad T14"), "laptop"),
            (Some("ChromeOS"), Some("Chromebook"), "other"),
            (None, None, "other"),
            // The lookaheads and the word boundary of the model pattern.
            (Some("Windows"), Some("Mac Pro"), "desktop"),
            (Some("Windows"), Some("Mac Processor"), "laptop"),
            (Some("Windows"), Some("Nucleus 5"), "laptop"),
            (Some("Windows"), Some("ANUC 1"), "laptop"),
            (Some("Windows"), Some("NUC"), "desktop"),
            (Some("Mac OS X"), Some("iMac"), "desktop"),
            // `ios` only as a word of its own.
            (Some("Adios"), Some("iPad"), "other"),
            (Some("iOS 17"), Some("  iPad Air"), "tablet"),
        ] {
            assert_eq!(asset_type_for(os, model), expected, "{os:?} / {model:?}");
        }
    }

    #[test]
    fn compliance_maps_every_graph_state_and_falls_back_to_unknown() {
        for (state, expected) in [
            (json!("compliant"), "compliant"),
            (json!("noncompliant"), "noncompliant"),
            (json!("inGracePeriod"), "in_grace_period"),
            (json!("conflict"), "conflict"),
            (json!("error"), "error"),
            (json!("configManager"), "config_manager"),
            (json!("unknown"), "unknown"),
            (json!("somethingNew"), "unknown"),
            (json!(null), "unknown"),
            (json!(3), "unknown"),
        ] {
            assert_eq!(map_compliance(Some(&state)), expected, "{state}");
        }
        assert_eq!(map_compliance(None), "unknown");
    }

    fn device() -> Value {
        json!({
            "id": "dev-1",
            "deviceName": " LAPTOP-01 ",
            "managedDeviceName": "user_Windows_1",
            "serialNumber": "SN123",
            "manufacturer": "Dell",
            "model": "Latitude 7440",
            "operatingSystem": "Windows",
            "osVersion": "10.0.22631",
            "complianceState": "inGracePeriod",
            "lastSyncDateTime": "2026-11-01T08:30:00Z",
            "userPrincipalName": "Sanne@Example.com",
            "emailAddress": "sanne.jansen@example.com",
        })
    }

    fn value<'a>(mapped: &'a MappedDevice, slug: &str) -> Option<&'a str> {
        mapped
            .values
            .iter()
            .find(|(key, _)| *key == slug)
            .and_then(|(_, value)| value.as_deref())
    }

    #[test]
    fn a_device_maps_to_the_asset_fields() {
        let Some(mapped) = map_intune_device(&device()) else {
            panic!("a device with an id");
        };
        assert_eq!(mapped.external_id, "dev-1");
        assert_eq!(mapped.serial_number.as_deref(), Some("SN123"));
        assert_eq!(
            mapped.values,
            [
                ("name", Some("LAPTOP-01".to_owned())),
                ("serial_number", Some("SN123".to_owned())),
                ("manufacturer", Some("Dell".to_owned())),
                ("model", Some("Latitude 7440".to_owned())),
                ("operating_system", Some("Windows".to_owned())),
                ("os_version", Some("10.0.22631".to_owned())),
                ("compliance", Some("in_grace_period".to_owned())),
                ("last_check_in", Some("2026-11-01T08:30:00.000Z".to_owned())),
                ("primary_user", Some("Sanne@Example.com".to_owned())),
                ("intune_device_id", Some("dev-1".to_owned())),
            ]
        );
        assert_eq!(mapped.asset_type, "laptop");
        // The owner is looked up by the email address first, lower-cased.
        assert_eq!(
            mapped.user_email.as_deref(),
            Some("sanne.jansen@example.com")
        );
    }

    #[test]
    fn the_record_is_named_by_device_name_managed_name_serial_number_then_id() {
        let name = |device: Value| {
            map_intune_device(&device).and_then(|mapped| value(&mapped, "name").map(str::to_owned))
        };
        assert_eq!(
            name(json!({ "id": "a", "managedDeviceName": "M", "serialNumber": "S" })).as_deref(),
            Some("M")
        );
        assert_eq!(
            name(json!({ "id": "a", "deviceName": "  ", "serialNumber": "S" })).as_deref(),
            Some("S")
        );
        assert_eq!(name(json!({ "id": "a" })).as_deref(), Some("a"));
    }

    #[test]
    fn the_primary_user_and_the_owner_email_fall_back_to_each_other() {
        let mapped = map_intune_device(&json!({ "id": "a", "emailAddress": "x@example.com" }));
        assert_eq!(
            mapped
                .as_ref()
                .and_then(|mapped| value(mapped, "primary_user")),
            Some("x@example.com")
        );
        let mapped = map_intune_device(&json!({ "id": "a", "userPrincipalName": "U@Example.com" }));
        assert_eq!(
            mapped.and_then(|mapped| mapped.user_email).as_deref(),
            Some("u@example.com")
        );
        let mapped = map_intune_device(&json!({ "id": "a" }));
        assert_eq!(mapped.and_then(|mapped| mapped.user_email), None);
    }

    #[test]
    fn what_the_device_does_not_report_is_left_out() {
        let Some(mapped) = map_intune_device(
            &json!({ "id": "a", "lastSyncDateTime": "0001-01-01T00:00:00Z", "serialNumber": "" }),
        ) else {
            panic!("a device with an id");
        };
        assert_eq!(value(&mapped, "last_check_in"), None);
        assert_eq!(value(&mapped, "serial_number"), None);
        assert_eq!(value(&mapped, "manufacturer"), None);
        assert_eq!(mapped.asset_type, "other");
        // Only the facts are written.
        let slugs: Vec<String> = mapped.facts().into_iter().map(|(slug, _)| slug).collect();
        assert_eq!(slugs, ["name", "compliance", "intune_device_id"]);
    }

    #[test]
    fn a_device_without_an_id_is_refused() {
        assert_eq!(map_intune_device(&json!({ "deviceName": "x" })), None);
        assert_eq!(map_intune_device(&json!({ "id": " " })), None);
        assert_eq!(map_intune_device(&json!({ "id": 7 })), None);
        assert_eq!(map_intune_device(&json!("dev-1")), None);
    }

    #[test]
    fn the_checksum_is_typescripts_and_changes_with_the_values_only() {
        let Some(mapped) = map_intune_device(&device()) else {
            panic!("a device with an id");
        };
        // `deviceChecksum(mapIntuneDevice(device).values)` on TypeScript.
        assert_eq!(
            mapped.checksum(),
            "09d0e9adc303229790ad775d0fb7be2f140658bb37045f0d7cf90ade0cb6c6c8"
        );
        // A device that reports next to nothing: the nulls are part of it.
        assert_eq!(
            map_intune_device(&json!({ "id": "a" })).map(|bare| bare.checksum()),
            Some("f966abdabcaecb6b9cbb90fce12f3946ee4f80ee915e0da9d6f8118cdd8f22fa".to_owned())
        );
        assert_eq!(
            map_intune_device(&device()).map(|again| again.checksum()),
            Some(mapped.checksum())
        );
        let mut changed = device();
        changed["osVersion"] = json!("10.0.26100");
        assert_ne!(
            map_intune_device(&changed).map(|changed| changed.checksum()),
            Some(mapped.checksum())
        );
    }
}
