//! Parity with reach-warmup-worker's pure rules. Its
//! `src/testing/rust-fixtures.test.ts` ran the TypeScript code (business
//! hours, the day's plan, send times, pairing, thread picks, rendering) on a
//! scripted random sequence and wrote what it answered into
//! `tests/fixtures/warmup_pure.json`; these tests run the Rust port on the
//! same input. Regenerate with `pnpm rust:reach-warmup-fixtures`.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use weldsuite_reach::warmup_network::clock::{
    add_days, business_window, business_window_on, daily_target_for, into_business_hours,
    local_parts, new_threads_for, next_business_date, plan_day, shuffled, spread_times,
    zoned_time_to_utc,
};
use weldsuite_reach::warmup_network::corpus::{
    CorpusPerson, corpus, fill_placeholders, find_thread, render_corpus_message,
};
use weldsuite_reach::warmup_network::pairing::{
    PairingMailbox, PairingState, pick_recipient, pick_thread_id,
};

fn fixture() -> Value {
    let path = format!(
        "{}/tests/fixtures/warmup_pure.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON")
}

/// The fixture's scripted source, from its beginning, cycling.
fn scripted(sequence: &[f64]) -> impl FnMut() -> f64 + Send + use<> {
    let sequence = sequence.to_vec();
    let mut i = 0;
    move || {
        let value = sequence[i % sequence.len()];
        i += 1;
        value
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

fn n(v: &Value) -> i64 {
    v.as_i64().unwrap_or_default()
}

fn check(label: &str, actual: &Value, expected: &Value) {
    assert_eq!(actual, expected, "{label}");
}

#[test]
fn time_zones_and_business_hours() {
    let f = fixture();
    let sequence: Vec<f64> = serde_json::from_value(f["sequence"].clone()).expect("sequence");
    let t = &f["time"];
    for c in t["parts"].as_array().expect("parts") {
        let p = local_parts(n(&c["at"]), s(&c["zone"]));
        let actual = json!({ "year": p.year, "month": p.month, "day": p.day, "hour": p.hour,
            "minute": p.minute, "second": p.second, "date": p.date, "weekday": p.weekday });
        check(&format!("parts {c}"), &actual, &c["parts"]);
    }
    for c in t["windows"].as_array().expect("windows") {
        let w = business_window(n(&c["at"]), s(&c["zone"]));
        let actual = json!({ "zone": c["zone"], "at": c["at"], "date": w.date,
            "businessDay": w.business_day, "start": w.start, "end": w.end });
        check("window", &actual, c);
    }
    for c in t["windowsOn"].as_array().expect("windowsOn") {
        let w = business_window_on(s(&c["date"]), s(&c["zone"]));
        let actual = json!({ "zone": c["zone"], "date": w.date,
            "businessDay": w.business_day, "start": w.start, "end": w.end });
        check("window on", &actual, c);
    }
    for c in t["zoned"].as_array().expect("zoned") {
        let at = zoned_time_to_utc(s(&c["date"]), n(&c["minute"]), s(&c["zone"]));
        check(&format!("zoned {c}"), &json!(at), &c["at"]);
    }
    for c in t["days"].as_array().expect("days") {
        check(
            &format!("addDays {c}"),
            &json!(add_days(s(&c["date"]), n(&c["n"]))),
            &c["out"],
        );
    }
    for c in t["nextBusiness"].as_array().expect("nextBusiness") {
        check(
            &format!("next {c}"),
            &json!(next_business_date(s(&c["date"]))),
            &c["out"],
        );
    }
    for c in t["pushed"].as_array().expect("pushed") {
        let mut rng = scripted(&sequence);
        let at = into_business_hours(n(&c["at"]), s(&c["zone"]), &mut rng);
        check(&format!("pushed {c}"), &json!(at), &c["out"]);
    }
}

#[test]
fn the_days_plan() {
    let f = fixture();
    let sequence: Vec<f64> = serde_json::from_value(f["sequence"].clone()).expect("sequence");
    let sc = &f["schedule"];
    for c in sc["threads"].as_array().expect("threads") {
        check(
            "newThreadsFor",
            &json!(new_threads_for(n(&c["n"]))),
            &c["out"],
        );
    }
    for c in sc["targets"].as_array().expect("targets") {
        let mut rng = scripted(&sequence);
        let maintaining = c["maintaining"].as_bool().unwrap_or_default();
        let out: Vec<i64> = (0..4)
            .map(|_| daily_target_for(maintaining, n(&c["rampDay"]), &mut rng))
            .collect();
        check(&format!("dailyTargetFor {c}"), &json!(out), &c["out"]);
    }
    for c in sc["plans"].as_array().expect("plans") {
        let window = business_window(n(&c["at"]), s(&c["zone"]));
        let plan = plan_day(n(&c["target"]), &window, n(&c["at"]));
        let actual = json!({ "zone": c["zone"], "at": c["at"], "target": c["target"],
            "count": plan.count, "from": plan.from, "until": plan.until });
        check("planDay", &actual, c);
    }
    for c in sc["spreads"].as_array().expect("spreads") {
        let mut rng = scripted(&sequence);
        let out = spread_times(n(&c["from"]), n(&c["until"]), n(&c["count"]), &mut rng);
        check(
            &format!("spreadTimes {}", c["count"]),
            &json!(out),
            &c["out"],
        );
    }
    for c in sc["shuffles"].as_array().expect("shuffles") {
        let mut rng = scripted(&sequence);
        let items: Vec<i64> = (0..n(&c["n"])).collect();
        check("shuffled", &json!(shuffled(&mut rng, &items)), &c["out"]);
    }
}

fn mailbox(v: &Value) -> PairingMailbox {
    PairingMailbox {
        id: s(&v["id"]).to_owned(),
        workspace_id: s(&v["workspaceId"]).to_owned(),
        domain: s(&v["domain"]).to_owned(),
        mailbox_type: s(&v["mailboxType"]).to_owned(),
        capacity: n(&v["capacity"]),
    }
}

fn sorted(map: &HashMap<String, i64>) -> Value {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    Value::Object(
        keys.into_iter()
            .map(|k| (k.clone(), json!(map[k])))
            .collect(),
    )
}

#[test]
fn pairing_and_thread_picks() {
    let f = fixture();
    let sequence: Vec<f64> = serde_json::from_value(f["sequence"].clone()).expect("sequence");
    let p = &f["pairing"];
    let pool: Vec<PairingMailbox> = p["pool"]
        .as_array()
        .expect("pool")
        .iter()
        .map(mailbox)
        .collect();
    for c in p["picks"].as_array().expect("picks") {
        let received: HashMap<String, i64> = c["received"]
            .as_object()
            .expect("received")
            .iter()
            .map(|(k, v)| (k.clone(), n(v)))
            .collect();
        let cooling: HashSet<String> = c["cooling"]
            .as_array()
            .expect("cooling")
            .iter()
            .map(|v| s(v).to_owned())
            .collect();
        let mut state = PairingState::new(received, cooling);
        let mut rng = scripted(&sequence);
        let sender = pool
            .iter()
            .find(|m| m.id == s(&c["sender"]))
            .expect("sender")
            .clone();
        let out: Vec<Value> = (0..n(&c["count"]))
            .map(|_| {
                json!(pick_recipient(&sender, &pool, &mut state, &mut rng).map(|m| m.id.clone()))
            })
            .collect();
        check(&format!("picks of {}", c["sender"]), &json!(out), &c["out"]);
        let mut cooling: Vec<&String> = state.cooling_pairs.iter().collect();
        cooling.sort();
        let actual = json!({ "received": sorted(&state.received), "domainUses": sorted(&state.domain_uses), "cooling": cooling });
        check(&format!("state of {}", c["sender"]), &actual, &c["state"]);
    }
    let mut rng = scripted(&sequence);
    let mut state = PairingState::default();
    let lonely = pick_recipient(&pool[0], &pool[..2], &mut state, &mut rng);
    check("lonely", &json!(lonely.map(|m| m.id.clone())), &p["lonely"]);
    let ids: Vec<String> = (1..=5).map(|i| format!("builtin-{i:03}")).collect();
    for c in p["threads"].as_array().expect("threads") {
        let used: HashSet<String> = c["used"]
            .as_array()
            .expect("used")
            .iter()
            .map(|v| s(v).to_owned())
            .collect();
        let mut run = HashMap::new();
        let mut rng = scripted(&sequence);
        let out: Vec<Option<String>> = (0..n(&c["count"]))
            .map(|_| pick_thread_id(&ids, &used, &mut run, &mut rng))
            .collect();
        check(&format!("threads {}", c["used"]), &json!(out), &c["out"]);
    }
    let mut rng = scripted(&sequence);
    check(
        "no threads",
        &json!(pick_thread_id(
            &[],
            &HashSet::new(),
            &mut HashMap::new(),
            &mut rng
        )),
        &p["noThreads"],
    );
}

fn person(v: &Value) -> CorpusPerson {
    CorpusPerson {
        first_name: s(&v["firstName"]).to_owned(),
        last_name: s(&v["lastName"]).to_owned(),
    }
}

#[test]
fn the_corpus_and_rendering() {
    let f = fixture();
    let r = &f["render"];
    assert!(corpus().len() >= 60, "the built-in corpus loads");
    let people: Vec<(CorpusPerson, CorpusPerson)> = r["people"]
        .as_array()
        .expect("people")
        .iter()
        .map(|pair| (person(&pair[0]), person(&pair[1])))
        .collect();
    for c in r["rendered"].as_array().expect("rendered") {
        let thread = find_thread(s(&c["thread"])).expect("the thread");
        let (sender, recipient) = &people[usize::try_from(n(&c["pair"])).expect("pair")];
        let out = render_corpus_message(thread, n(&c["step"]), sender, recipient).expect("renders");
        check(
            &format!("{} step {}", c["thread"], c["step"]),
            &json!({ "subject": out.subject, "text": out.text }),
            &c["out"],
        );
    }
    let values: Vec<(String, String)> = r["values"]
        .as_object()
        .expect("values")
        .iter()
        .map(|(k, v)| (k.clone(), s(v).to_owned()))
        .collect();
    let values: Vec<(&str, &str)> = values
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    for c in r["templates"].as_array().expect("templates") {
        check(
            &format!("template {}", c["template"]),
            &json!(fill_placeholders(s(&c["template"]), &values)),
            &c["out"],
        );
    }
    let (sender, recipient) = &people[0];
    let error =
        render_corpus_message(&corpus()[0], 9, sender, recipient).expect_err("out of range");
    check("out of range", &json!(error), &r["outOfRange"]);
}
