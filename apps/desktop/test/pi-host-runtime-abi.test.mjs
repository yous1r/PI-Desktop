import assert from "node:assert/strict";
import test from "node:test";
import { assertCompatibleSymbols } from "../../../scripts/check-linux-pi-host-runtime.mjs";
const report = requirements => `Symbol table '.dynsym' contains 5 entries:\n${requirements.map((requirement, i) => ` ${i}: 0000000000000000 0 FUNC GLOBAL DEFAULT UND symbol@${requirement} (2)`).join("\n")}`;

test("remote runtime permits the Node glibc 2.28 floor and matching C++ ABI", () => {
  assert.doesNotThrow(() => assertCompatibleSymbols(report(["GLIBC_2.2.5", "GLIBC_2.28", "GLIBCXX_3.4.25", "CXXABI_1.3.11"]), "pty"));
});
test("remote runtime rejects the published PTY regression and newer C++ runtimes", () => {
  for (const version of ["GLIBC_2.32", "GLIBC_2.34", "GLIBC_2.100", "GLIBCXX_3.4.26", "CXXABI_1.3.13", "GLIBC_PRIVATE"]) {
    assert.throws(() => assertCompatibleSymbols(report([version]), "fixture pty.node"), /fixture pty.node/);
  }
});
test("defined symbols do not impose imports and unreadable ELF reports fail closed", () => {
  assert.doesNotThrow(() => assertCompatibleSymbols("Symbol table '.dynsym' contains 1 entries:\n 1: 123 4 FUNC GLOBAL DEFAULT 12 symbol@GLIBC_2.40", "pty"));
  for (const value of ["", "readelf failed", null]) assert.throws(() => assertCompatibleSymbols(value, "pty"), /missing ELF/);
});
