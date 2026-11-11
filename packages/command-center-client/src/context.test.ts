import { describe, expect, it } from "vitest";
import {
  bindCommandCenterObservationOwner, createCommandCenterObservationContext,
  createCommandCenterInterventionAttempt, invalidateCommandCenterObservationContext,
} from "./index.js";
import { requireBoundContext } from "./context.js";

const owner = { hostId: "host-observer", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" };

describe("authenticated observation context binding", () => {
  it("supports read-only observation without a fake intervention", () => {
    const context = createCommandCenterObservationContext();
    expect(() => requireBoundContext(context)).toThrow("CONTEXT_OWNER_REQUIRED");
    bindCommandCenterObservationOwner(context, owner);
    bindCommandCenterObservationOwner(context, { ...owner });
    expect(() => requireBoundContext(context)).not.toThrow();
    expect(() => bindCommandCenterObservationOwner(context, { ...owner, hostId: "other" })).toThrow("OWNER_MISMATCH");
    invalidateCommandCenterObservationContext(context);
    expect(() => requireBoundContext(context)).toThrow("CONTEXT_INVALIDATED");
  });

  it("rejects invalid owner input without pinning its context", () => {
    const context = createCommandCenterObservationContext();
    expect(() => bindCommandCenterObservationOwner(context, { ...owner, role: "owner" })).toThrow("INVALID_OWNER");
    expect(() => requireBoundContext(context)).toThrow("OWNER_REQUIRED");
    bindCommandCenterObservationOwner(context, owner);
    invalidateCommandCenterObservationContext(context);
  });

  it("copies identity and refuses rebinding when the original input changes", () => {
    const context = createCommandCenterObservationContext();
    const source = { ...owner };
    bindCommandCenterObservationOwner(context, source);
    source.hostId = "replacement";
    expect(() => bindCommandCenterObservationOwner(context, source)).toThrow("OWNER_MISMATCH");
    bindCommandCenterObservationOwner(context, owner);
    invalidateCommandCenterObservationContext(context);
  });

  it("rechecks revocation triggered while parsing the supplied owner", () => {
    const context = createCommandCenterObservationContext();
    const source = { ...owner, get hostId() { invalidateCommandCenterObservationContext(context); return owner.hostId; } };
    expect(() => bindCommandCenterObservationOwner(context, source)).toThrow("CONTEXT_INVALIDATED");
  });

  it("shares the same owner fence between monitoring and interventions", async () => {
    const context = createCommandCenterObservationContext();
    bindCommandCenterObservationOwner(context, owner);
    const request = {
      version: 1, requestId: "b4a1c8d2-5e6f-4a70-8b93-1c2d3e4f5a60", ...owner,
      commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31", expectedMembershipRevision: 1,
      target: { kind: "session", sessionId: "s1", turnId: "t1" }, intent: { kind: "stop", scope: "target" },
    };
    const attempt = await createCommandCenterInterventionAttempt(context, request);
    expect(attempt.getState().kind).toBe("active");
    await expect(createCommandCenterInterventionAttempt(context, { ...request, expectedHostEpoch: "4f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" })).rejects.toThrow("OWNER_MISMATCH");
    invalidateCommandCenterObservationContext(context);
    expect(attempt.getState().kind).toBe("invalidated");
  });
});
