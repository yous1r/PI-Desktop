# Changelog

## Unreleased

- Restore explicit SSH enrollment of an intact, stopped Host when its last
  startup failed and no Desktop pairing record or readiness identity remains.
  Preserve its durable identity, prior devices and data; keep saved-device,
  conflicting-evidence, process and downgrade checks intact.

- Keep remote host-core statically linked with musl and build the terminal
  addon against glibc 2.28 on both Linux architectures. Verify bundled Node,
  native ABI requirements and real PTY output before release archiving.

- Cache verified Desktop-downloaded Host archives across retries, Host removal
  and restart; reuse them over SSH without another release request.
- Allow older prereleases to advance to a newer stable Desktop release, and
  expose idle-window confirmation when adding a legacy SSH Host.
- Accept ISO pairing expiry and execute deployment completion through the
  installed `current` link, avoiding false recovery failures after startup.
- Ship deployment control scripts with Desktop so fixes also apply when the
  exact published Host archive predates them. Recover verified running
  post-start transactions, refreshing expired enrollment only under an idle
  maintenance lease and completing only after RACP authentication.

- Prepare the exact Desktop-version Host when a user opens or uses an SSH remote
  project. First download requires consent; later compatible upgrades reuse it.
  Passive startup and host inventory refresh do not install or upgrade.
- Download releases on Desktop using the existing global proxy, verify SHA-256,
  upload over SSH and verify again. Remote release internet access is unnecessary.
- Preserve enrolled identity and credentials across upgrades and safe offline
  repair. Maintenance leases refuse active clients or work and fence new client
  admission. Legacy Hosts require an explicitly confirmed idle window.
- Stage before activation and retain transaction recovery state after interrupted
  or failed startup. Newer Hosts are never downgraded; uncertain data state is
  never rolled back automatically.
- Show preparation phases, consent, retry and independent cancellation in folder
  selection and saved remote-project activation. Continue the requested operation
  only while its original caller still wants it.
- Gate release publication on workspace/Cargo/client version parity, both Linux
  Host architectures, checksums, archive versions and updater-feed versions.

Real Linux SSH transaction/recovery qualification remains required before release.
