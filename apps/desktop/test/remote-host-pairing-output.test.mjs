import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseBootstrapOutput } = await import("../electron/main/remote/pi-host-bootstrap-script.ts");
const { parsePairingLine } = await import("../../pi-host/scripts/deploy-recovery.mjs");
const { DeviceTokenAuthenticator, MemoryCredentialStore } = await import("@pi-desktop/racp");

test("deployment and Desktop accept the Host's issued ISO pairing expiry", async () => {
  const authenticator = new DeviceTokenAuthenticator(new MemoryCredentialStore(), () => 1_800_000_000_000);
  const { token, expiresAt } = await authenticator.issuePairingToken(600_000);
  assert.equal(typeof expiresAt, "string");
  const line = `PI_HOST_PAIRING_TOKEN ${JSON.stringify({ token, expiresAt })}`;
  assert.deepEqual(parsePairingLine(line), { token, expiresAt: Date.parse(expiresAt) });
  assert.deepEqual(parseBootstrapOutput(line).pairing, { token, expiresAt: Date.parse(expiresAt) });
});

test("pairing parsing accepts legacy numeric expiry and rejects malformed records", () => {
  assert.deepEqual(parsePairingLine('PI_HOST_PAIRING_TOKEN {"token":"ppt1.fixture","expiresAt":123}'),
    { token: "ppt1.fixture", expiresAt: 123 });
  for (const value of [null, {}, { token: "", expiresAt: 123 }, { token: "x", expiresAt: "garbage" },
    { token: "x", expiresAt: null }, { token: "x", expiresAt: -1 }]) {
    const line = `PI_HOST_PAIRING_TOKEN ${JSON.stringify(value)}`;
    assert.equal(parsePairingLine(line), null);
    assert.equal(parseBootstrapOutput(line).pairing, null);
  }
});
