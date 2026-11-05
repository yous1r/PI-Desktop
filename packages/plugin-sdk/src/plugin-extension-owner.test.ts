import { describe, expect, it } from "vitest";
import { validateManifest } from "./index.js";

const manifest = { schemaVersion: 1, id: "demo.owner", name: "Owner", version: "1.0.0", main: "main.js",
  permissions: ["agent.extension"] };
const validate = (operations: unknown) => validateManifest({ ...manifest, contributes: { agentExtensionOperations: operations } });
describe("manifest owner operations", () => {
  it("accepts explicit read/write operations and keeps legacy manifests valid", () => {
    expect(validateManifest(manifest).ok).toBe(true);
    expect(validate([{ name: "recall", readOnly: true }, { name: "capture", readOnly: false }]).ok).toBe(true);
  });
  it("requires agent.extension even for an empty capability declaration", () => {
    expect(validateManifest({ ...manifest, permissions: [], contributes: { agentExtensionOperations: [] } }).error)
      .toMatch(/agent.extension/);
  });
  it.each([null, {}, [null], [{ name: "x" }], [{ name: "x", readOnly: "true" }],
    [{ name: "x/y", readOnly: true }], [{ name: "x".repeat(65), readOnly: true }],
    [{ name: "x", readOnly: true }, { name: "x", readOnly: false }],
    Array.from({ length: 33 }, (_, index) => ({ name: `op${index}`, readOnly: true })),
  ].map((value) => ({ value })))("refuses invalid/ambiguous declarations %#", ({ value }) => { expect(validate(value).ok).toBe(false); });
});
