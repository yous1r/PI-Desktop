//! The target mode owns its entire argv surface; every capability and identity
//! must arrive on the inherited framed channel instead.
use super::*;
use std::ffi::OsString;

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn target_flag_is_recognized_only_as_the_sole_argument() {
    assert!(requested(&args(&[FLAG])).unwrap());
    assert!(!requested(&args(&[])).unwrap());
    // Ordinary Host launches pass unrelated flags; only the target flag selects
    // the restricted mode.
    assert!(!requested(&args(&["--inspect"])).unwrap());
    assert!(!requested(&args(&["--inspect", "--trace"])).unwrap());
}

#[test]
fn target_flag_refuses_every_other_argument_in_any_position() {
    for other in [
        "--owner-handoff",
        "--owner-source",
        "--owner-status",
        "--owner-control",
        "--execution-fence",
        "--relocate-data",
        "--internal-execution-runner",
        "--internal-tool-runner",
        "--unknown",
    ] {
        refused(requested(&args(&[FLAG, other])), "usage: --owner-target");
        refused(requested(&args(&[other, FLAG])), "usage: --owner-target");
    }
    // Duplicates and positional values are not part of the contract either.
    refused(requested(&args(&[FLAG, FLAG])), "usage: --owner-target");
    refused(requested(&args(&[FLAG, "value"])), "usage: --owner-target");
    refused(requested(&args(&["value", FLAG])), "usage: --owner-target");
}
