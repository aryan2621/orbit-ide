//! Setup-wizard checks shared by every toolchain: each one reports a status and, when something is
//! missing, the steps (with commands to copy) that fix it.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Missing,
    /// Can't be checked until an earlier step is done.
    Blocked,
}

#[derive(Serialize)]
pub struct Step {
    text: String,
    command: Option<String>,
}

pub fn step(text: impl Into<String>, command: Option<String>) -> Step {
    Step { text: text.into(), command }
}

#[derive(Serialize)]
pub struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub status: Status,
    pub detail: String,
    /// What to do when the check is missing.
    pub steps: Vec<Step>,
}

/// A check plus whether it's required. Optional checks (conveniences like code intelligence)
/// are shown in the wizard but don't count against "ready".
#[derive(Serialize)]
pub struct Item {
    #[serde(flatten)]
    pub check: Check,
    pub optional: bool,
}

impl Check {
    pub fn required(self) -> Item {
        Item { check: self, optional: false }
    }

    pub fn optional(self) -> Item {
        Item { check: self, optional: true }
    }

    /// Marks a missing check as waiting on an earlier step.
    pub fn block_unless(&mut self, ready: bool, reason: &str) {
        if !ready && self.status == Status::Missing {
            self.status = Status::Blocked;
            self.detail = reason.into();
        }
    }
}

pub fn sh_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}
