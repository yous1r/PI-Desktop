# Plugin self-query for effective permission metadata

- Status: Accepted
- Scope: Additive plugin metadata contract; no new capability or grant

## Context

A plugin that optionally synchronizes managed global instructions must not infer
consent from its manifest. Declarations can exceed the permissions a user
actually approved. The existing metadata API exposes the manifest but not the
effective permission set held by the broker.

## Decision

Expose optional `pi.plugin.getPermissions(): Promise<string[]>`. The process
bridge calls the allowlisted broker operation, which returns a sorted fresh copy
of the calling plugin's effective grants. It has no arguments, credentials,
foreign-plugin lookup, mutation, or grant effect. Older hosts may omit the method;
plugins must feature-detect it and skip consent-dependent provisioning when it
is unavailable rather than guess from the declaration.

## Consequences

Existing SDK consumers remain compatible because the method is optional. Host
permission checks remain authoritative. Automated process/broker tests cover
declarations differing from grants and mutation of the returned copy. Global
instruction synchronization is a plugin implementation, not a generic new
filesystem permission.
