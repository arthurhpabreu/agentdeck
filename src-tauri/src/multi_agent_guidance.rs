//! Deliver routing instructions once per accepted conversation context/profile.
use crate::multi_agent::Profile;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

type Key = (String, String);
type Signature = Option<String>;

#[derive(Clone, Debug)]
pub struct Delivery {
    pub text: String,
    pub signature: Signature,
}

const DISABLED_GUIDANCE: &str = "\n[Agentdeck multi-agent economy]\nAgentdeck model distribution is off. Disregard only the prior model-routing and delegation guidance inside Agentdeck multi-agent economy blocks. Preserve the user's own instructions about agents, all permissions and the selected knowledge scope.\n[/Agentdeck multi-agent economy]\n";

pub fn disabled_guidance() -> &'static str {
    DISABLED_GUIDANCE
}

#[derive(Default)]
struct Ledger(HashMap<Key, Signature>);

impl Ledger {
    fn prepare(
        &mut self,
        key: Key,
        signature: Signature,
        new_context: bool,
        slash: bool,
    ) -> Option<Delivery> {
        if new_context {
            self.0.remove(&key);
        }
        if slash {
            return None;
        }
        let previous = self.0.get(&key);
        if previous == Some(&signature) {
            return None;
        }
        // An empty delivery records a freshly accepted disabled context without
        // sending a revocation into a conversation that has never received rules.
        let text = if signature.is_none() && !new_context {
            DISABLED_GUIDANCE.into()
        } else {
            String::new()
        };
        Some(Delivery { text, signature })
    }

    fn commit(&mut self, key: Key, delivery: &Delivery) {
        if self.0.len() >= 1024 && !self.0.contains_key(&key) {
            if let Some(key_to_remove) = self.0.keys().next().cloned() {
                self.0.remove(&key_to_remove);
            }
        }
        self.0.insert(key, delivery.signature.clone());
    }
}

static DELIVERED: OnceLock<Mutex<Ledger>> = OnceLock::new();

pub fn prepare(
    profile: Option<&Profile>,
    provider: &str,
    session_id: &str,
    new_context: bool,
    slash: bool,
) -> Option<Delivery> {
    if !matches!(provider, "codex" | "claude-code") {
        return None;
    }
    let signature = profile
        .map(|profile| serde_json::to_string(profile).expect("serializable routing profile"));
    let key = (provider.into(), session_id.into());
    let mut delivery = match DELIVERED.get_or_init(Default::default).lock() {
        Ok(mut ledger) => ledger.prepare(key, signature, new_context, slash),
        Err(_) => Ledger::default().prepare(key, signature, new_context, slash),
    }?;
    if let Some(profile) = profile {
        delivery.text = crate::multi_agent::guidance(profile, provider);
    }
    Some(delivery)
}

/// Called only after the provider acknowledges receipt of the initial input.
pub fn commit(provider: &str, session_id: &str, delivery: &Delivery) {
    if let Ok(mut ledger) = DELIVERED.get_or_init(Default::default).lock() {
        ledger.commit((provider.into(), session_id.into()), delivery);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(provider: &str, session: &str) -> Key {
        (provider.into(), session.into())
    }
    fn on(profile: &str) -> Signature {
        Some(profile.into())
    }

    #[test]
    fn accepted_on_off_on_transitions_are_delivered_once_per_profile() {
        let mut ledger = Ledger::default();
        let id = key("codex", "conversation");
        let first = ledger
            .prepare(id.clone(), on("sol-luna-astra"), true, false)
            .unwrap();
        assert!(
            ledger.0.get(&id).is_none(),
            "Preparing input must not claim delivery"
        );
        assert!(
            ledger
                .prepare(id.clone(), on("sol-luna-astra"), false, false)
                .is_some(),
            "Failed input delivery must remain retryable"
        );
        ledger.commit(id.clone(), &first);
        assert!(ledger
            .prepare(id.clone(), on("sol-luna-astra"), false, false)
            .is_none());
        let off = ledger.prepare(id.clone(), None, false, false).unwrap();
        assert!(off.text.contains("Disregard only the prior model-routing"));
        assert!(off
            .text
            .contains("Preserve the user's own instructions about agents"));
        ledger.commit(id.clone(), &off);
        assert!(ledger.prepare(id.clone(), None, false, false).is_none());
        let again = ledger
            .prepare(id.clone(), on("sol-luna-astra"), false, false)
            .unwrap();
        ledger.commit(id.clone(), &again);
        assert!(ledger
            .prepare(id, on("sol-luna-astra"), false, false)
            .is_none());
    }

    #[test]
    fn new_context_and_compaction_reset_the_delivered_signature() {
        let mut ledger = Ledger::default();
        let id = key("claude-code", "conversation");
        let initial = ledger
            .prepare(id.clone(), on("sonnet-haiku-opus"), true, false)
            .unwrap();
        ledger.commit(id.clone(), &initial);
        assert!(ledger
            .prepare(id.clone(), on("sonnet-haiku-opus"), true, false)
            .is_some());
        // A slash command can reset context, but must receive no appended prose.
        assert!(ledger
            .prepare(id.clone(), on("sonnet-haiku-opus"), true, true)
            .is_none());
        assert!(ledger
            .prepare(id.clone(), on("sonnet-haiku-opus"), false, false)
            .is_some());
        let disabled = ledger.prepare(id.clone(), None, true, false).unwrap();
        assert!(
            disabled.text.is_empty(),
            "Fresh disabled conversations need no revocation text"
        );
        ledger.commit(id.clone(), &disabled);
        assert!(ledger.prepare(id, None, false, false).is_none());
    }

    #[test]
    fn resumed_unknown_context_is_revoked_and_profile_or_provider_changes_are_independent() {
        let mut ledger = Ledger::default();
        let codex = key("codex", "same-session");
        let unknown = ledger.prepare(codex.clone(), None, false, false).unwrap();
        assert_eq!(unknown.text, DISABLED_GUIDANCE);
        ledger.commit(codex.clone(), &unknown);
        let initial = ledger
            .prepare(codex.clone(), on("profile-a"), false, false)
            .unwrap();
        ledger.commit(codex.clone(), &initial);
        assert!(ledger
            .prepare(codex.clone(), on("profile-b"), false, false)
            .is_some());
        assert!(ledger
            .prepare(
                key("claude-code", "same-session"),
                on("profile-a"),
                false,
                false
            )
            .is_some());
        assert!(ledger
            .prepare(key("codex", "other-session"), on("profile-a"), false, false)
            .is_some());
        assert!(ledger
            .prepare(codex.clone(), on("profile-b"), false, true)
            .is_none());
        assert!(ledger
            .prepare(codex, on("profile-b"), false, false)
            .is_some());
    }
}
