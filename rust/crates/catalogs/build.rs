//! Turns `rust/catalogs/*.json` (written by `pnpm rust:catalogs` from the
//! TypeScript catalogs) into constants, so a typo in an event name, a
//! permission key or a flag fails to compile, as it does in TypeScript.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

use serde_json::Value;

fn main() {
    let catalogs =
        Path::new(&env::var("CARGO_MANIFEST_DIR").expect("set by cargo")).join("../../catalogs");
    let out = PathBuf::from(env::var("OUT_DIR").expect("set by cargo"));

    let entity_events = read(&catalogs, "entity-events.json");
    let permissions = read(&catalogs, "permissions.json");
    let flags = read(&catalogs, "feature-flags.json");
    let origins = read(&catalogs, "first-party-origins.json");
    // Parsed here too, so a malformed file fails the build, not a request.
    read(&catalogs, "api-modules.json");

    write(&out, "entity_events.rs", &entity_events_rs(&entity_events));
    write(
        &out,
        "permission_keys.rs",
        &permission_keys_rs(&permissions),
    );
    write(&out, "flags.rs", &flags_rs(&flags));
    write(&out, "origins.rs", &origins_rs(&origins));
}

fn read(dir: &Path, file: &str) -> Value {
    let path = dir.join(file);
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Run `pnpm rust:catalogs` from the repo root.",
            path.display()
        )
    });
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn write(out: &Path, file: &str, code: &str) {
    fs::write(out.join(file), code).unwrap_or_else(|e| panic!("{file}: {e}"));
}

/// `weldchat:channels:read` → `WELDCHAT_CHANNELS_READ`.
fn const_name(parts: &[&str]) -> String {
    let mut name = String::new();
    for c in parts.join("_").chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c.to_ascii_uppercase());
        } else if !name.ends_with('_') {
            name.push('_');
        }
    }
    let name = name.trim_matches('_').to_owned();
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        format!("_{name}")
    } else {
        name
    }
}

/// Fails the build when two catalog entries map to the same constant.
fn claim(names: &mut BTreeMap<String, String>, name: &str, source: &str) {
    if let Some(previous) = names.insert(name.to_owned(), source.to_owned()) {
        assert!(
            previous == source,
            "`{previous}` and `{source}` both become the constant {name}"
        );
    }
}

fn entity_events_rs(catalog: &Value) -> String {
    let map = catalog
        .as_object()
        .expect("entity-events.json is an object");
    let mut code = String::new();
    let mut names = BTreeMap::new();
    let mut all = String::new();
    for (entity_type, actions) in map {
        let actions = actions.as_array().expect("actions are an array");
        let mut list = String::new();
        for action in actions {
            let action = action.as_str().expect("an action is a string");
            let name = const_name(&[entity_type, action]);
            claim(&mut names, &name, &format!("{entity_type}:{action}"));
            writeln!(
                code,
                "pub const {name}: EventName = EventName {{ entity_type: {entity_type:?}, action: {action:?} }};"
            )
            .expect("write to string");
            write!(list, "{action:?}, ").expect("write to string");
        }
        writeln!(all, "    ({entity_type:?}, &[{list}]),").expect("write to string");
    }
    writeln!(
        code,
        "/// Every entity type with its actions, in catalog order.\npub const ALL: &[(&str, &[&str])] = &[\n{all}];"
    )
    .expect("write to string");
    code
}

fn permission_keys_rs(catalog: &Value) -> String {
    let objects = catalog["objects"]
        .as_array()
        .expect("permissions.json has objects");
    let mut code = String::new();
    let mut names = BTreeMap::new();
    let mut all = String::new();
    for object in objects {
        for permission in object["permissions"]
            .as_array()
            .expect("an object has permissions")
        {
            let key = permission["key"].as_str().expect("a permission has a key");
            let name = const_name(&[key]);
            claim(&mut names, &name, key);
            writeln!(code, "pub const {name}: &str = {key:?};").expect("write to string");
            writeln!(all, "    {key:?},").expect("write to string");
        }
    }
    writeln!(
        code,
        "/// Every permission key in the catalog, in catalog order.\npub const ALL: &[&str] = &[\n{all}];"
    )
    .expect("write to string");
    code
}

fn flags_rs(catalog: &Value) -> String {
    let map = catalog
        .as_object()
        .expect("feature-flags.json is an object");
    let mut code = String::new();
    let mut names = BTreeMap::new();
    for (key, definition) in map {
        let name = const_name(&[key]);
        claim(&mut names, &name, key);
        let default = &definition["default"];
        let line = match definition["type"].as_str() {
            Some("boolean") => format!(
                "pub const {name}: BoolFlag = BoolFlag {{ key: {key:?}, default: {} }};",
                default.as_bool().expect("boolean default")
            ),
            Some("string") => format!(
                "pub const {name}: StringFlag = StringFlag {{ key: {key:?}, default: {:?} }};",
                default.as_str().expect("string default")
            ),
            Some("number") => format!(
                "pub const {name}: NumberFlag = NumberFlag {{ key: {key:?}, default: {:?} }};",
                default.as_f64().expect("number default")
            ),
            Some("json") => format!(
                "pub const {name}: JsonFlag = JsonFlag {{ key: {key:?}, default_json: {:?} }};",
                default.to_string()
            ),
            other => panic!("flag {key}: unknown type {other:?}"),
        };
        writeln!(code, "{line}").expect("write to string");
    }
    code
}

fn origins_rs(catalog: &Value) -> String {
    let origins = catalog
        .as_array()
        .expect("first-party-origins.json is an array");
    let list: Vec<String> = origins
        .iter()
        .map(|o| format!("{:?}", o.as_str().expect("an origin is a string")))
        .collect();
    format!(
        "pub const FIRST_PARTY_ORIGINS: [&str; {}] = [{}];\n",
        list.len(),
        list.join(", ")
    )
}
