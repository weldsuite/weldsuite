//! `pairing.ts`: who emails whom. Never within one domain; otherwise a pair
//! off its cool-down, spread over domains, another workspace and mailbox
//! type, and the recipient that has received least for what it sends. Pure.

use std::collections::{HashMap, HashSet};

use super::clock::Rng;

/// `PairingMailbox`.
#[derive(Debug, Clone, PartialEq)]
pub struct PairingMailbox {
    pub id: String,
    pub workspace_id: String,
    pub domain: String,
    pub mailbox_type: String,
    /// What it sends today: the balance reference.
    pub capacity: i64,
}

/// `PairingState`.
#[derive(Debug, Clone, Default)]
pub struct PairingState {
    pub received: HashMap<String, i64>,
    pub cooling_pairs: HashSet<String>,
    pub domain_uses: HashMap<String, i64>,
}

const COOLING: f64 = 1000.0;
const DOMAIN_USE: f64 = 100.0;
const SAME_WORKSPACE: f64 = 30.0;
const SAME_TYPE: f64 = 20.0;
const BALANCE: f64 = 40.0;
const JITTER: f64 = 10.0;
/// `RECEIVE_HEADROOM`.
pub const RECEIVE_HEADROOM: f64 = 1.25;

/// `pairKey(a, b)`.
pub fn pair_key(a: &str, b: &str) -> String {
    if a < b {
        format!("{a}|{b}")
    } else {
        format!("{b}|{a}")
    }
}

impl PairingState {
    /// `createPairingState(received, coolingPairs)`.
    pub fn new(received: HashMap<String, i64>, cooling_pairs: HashSet<String>) -> Self {
        Self {
            received,
            cooling_pairs,
            domain_uses: HashMap::new(),
        }
    }

    fn received_by(&self, id: &str) -> i64 {
        self.received.get(id).copied().unwrap_or(0)
    }

    fn has_headroom(&self, candidate: &PairingMailbox) -> bool {
        let limit = ((candidate.capacity.max(1) as f64) * RECEIVE_HEADROOM).ceil() as i64 + 1;
        self.received_by(&candidate.id) < limit
    }

    fn score(&self, sender: &PairingMailbox, candidate: &PairingMailbox, rng: Rng<'_>) -> f64 {
        let mut penalty = 0.0;
        if self
            .cooling_pairs
            .contains(&pair_key(&sender.id, &candidate.id))
        {
            penalty += COOLING;
        }
        penalty += self
            .domain_uses
            .get(&candidate.domain)
            .copied()
            .unwrap_or(0) as f64
            * DOMAIN_USE;
        if candidate.workspace_id == sender.workspace_id {
            penalty += SAME_WORKSPACE;
        }
        if candidate.mailbox_type == sender.mailbox_type {
            penalty += SAME_TYPE;
        }
        let fill = (self.received_by(&candidate.id) + 1) as f64 / candidate.capacity.max(1) as f64;
        penalty += fill.min(3.0) * BALANCE;
        penalty + rng() * JITTER
    }

    /// `recordPick(sender, recipient, state)`.
    pub fn record_pick(&mut self, sender: &PairingMailbox, recipient: &PairingMailbox) {
        *self.received.entry(recipient.id.clone()).or_insert(0) += 1;
        *self
            .domain_uses
            .entry(recipient.domain.clone())
            .or_insert(0) += 1;
        self.cooling_pairs
            .insert(pair_key(&sender.id, &recipient.id));
    }
}

/// `pickRecipient(sender, pool, state, rng)`: the best recipient for one
/// more message, recorded in `state`; `None` when nobody is on another
/// domain.
pub fn pick_recipient<'p>(
    sender: &PairingMailbox,
    pool: &'p [PairingMailbox],
    state: &mut PairingState,
    rng: Rng<'_>,
) -> Option<&'p PairingMailbox> {
    let other_domains: Vec<&PairingMailbox> = pool
        .iter()
        .filter(|c| c.id != sender.id && c.domain != sender.domain)
        .collect();
    if other_domains.is_empty() {
        return None;
    }
    let with_room: Vec<&PairingMailbox> = other_domains
        .iter()
        .copied()
        .filter(|c| state.has_headroom(c))
        .collect();
    let candidates = if with_room.is_empty() {
        other_domains
    } else {
        with_room
    };
    let mut best: Option<&PairingMailbox> = None;
    let mut best_score = f64::INFINITY;
    for candidate in candidates {
        let score = state.score(sender, candidate, rng);
        if score < best_score {
            best = Some(candidate);
            best_score = score;
        }
    }
    if let Some(best) = best {
        state.record_pick(sender, best);
    }
    best
}

/// `pickThreadId(threadIds, usedByPair, usedThisRun, rng)`.
#[allow(clippy::implicit_hasher)] // the planner's own maps
pub fn pick_thread_id(
    thread_ids: &[String],
    used_by_pair: &HashSet<String>,
    used_this_run: &mut HashMap<String, i64>,
    rng: Rng<'_>,
) -> Option<String> {
    if thread_ids.is_empty() {
        return None;
    }
    let fresh: Vec<&String> = thread_ids
        .iter()
        .filter(|id| !used_by_pair.contains(*id))
        .collect();
    let pool: Vec<&String> = if fresh.is_empty() {
        thread_ids.iter().collect()
    } else {
        fresh
    };
    let used = |id: &String| used_this_run.get(id).copied().unwrap_or(0);
    let lowest = pool.iter().map(|id| used(id)).min().unwrap_or(0);
    let least: Vec<&String> = pool.into_iter().filter(|id| used(id) == lowest).collect();
    let index = ((rng() * least.len() as f64).floor() as usize).min(least.len() - 1);
    let chosen = least[index].clone();
    *used_this_run.entry(chosen.clone()).or_insert(0) += 1;
    Some(chosen)
}
