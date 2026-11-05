# ADR: Plugin-owned agent extension calls

- Status: Accepted for implementation by the approved ai-memory plan
- Scope: Generic plugin and Agent runtime boundary

## Context

Agent extensions run in the sidecar while resident plugin services run in their own child process. Existing ExtensionAPI events cannot safely reach a plugin service or carry authoritative runtime generation identity. Detached SDK calls are correctly rejected after their callback finishes; relaxing that safeguard would reintroduce stale mutations.

## Decision

Add an optional, versioned owner capability to plugin-contributed extensions. The host binds the extension to its owning loaded plugin, session, current turn, mode, project and runtime generation. Only manifest-declared operations can be dispatched. Calls and cancellation travel over the existing stdio/plugin IPC channels, not a local network listener. Plan and Goal allow declared read-only operations only. Both request and result are bounded and stale results are discarded. Plugin unload and runtime retirement revoke calls.

The owning service handles domain logic and durable queues. The extension awaits local admission within its original callback. Context injection uses the existing context result contract; no historical text becomes a new system instruction. Runtime retirement carries a reason and is not synonymous with a durable conversation ending.

Main keeps a generation's last authorized turn for bounded terminal cleanup. Replacement launch facts cannot rewrite that identity. Retirement permits one declared `retire` call per extension for at most two seconds, subject to the live Host mode and plugin permissions. Explicit session deletion waits for this cleanup before deleting the Host record; model changes, transcript rewrites and reload use `reconfigure`. Normal application shutdown keeps the plugin service and Host available until this bounded sidecar cleanup finishes.

## Alternatives

A loopback proxy and credential files add another authorization/lifecycle surface. Running plugin service code inside every Runner duplicates shared resources. Broad host RPC access permits impersonation. None is necessary for this capability.

## Consequences

Existing extensions are unaffected when they do not declare owner operations. New plugins must detect this capability and state their minimum host requirements. This trusted-code boundary does not create an OS sandbox for raw Node APIs. The host still enforces its own capabilities, invocation lifetime, and plugin activation scope.
