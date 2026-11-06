# Changelog

## Unreleased

- Cache verified Desktop-downloaded Host archives across retries, Host removal
  and restart; reuse them over SSH without another release request.
- Allow older prereleases to advance to a newer stable Desktop release, and
  expose idle-window confirmation when adding a legacy SSH Host.
- Accept ISO pairing expiry and execute deployment completion through the
  installed `current` link, avoiding false recovery failures after startup.

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
