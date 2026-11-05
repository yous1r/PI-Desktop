import assert from "node:assert/strict";
import test from "node:test";
import { assertGlibcFloor } from "./verify-pty.mjs";

test("rejects the beta.6 PTY glibc 2.34 imports on a glibc 2.28 host", () => {
  assert.throws(() => assertGlibcFloor("Name: GLIBC_2.2.5 Name: GLIBC_2.28 Name: GLIBC_2.34"), /needs glibc 2\.34\.0, above 2\.28/);
});

test("accepts floor-compatible imports and compares versions numerically", () => {
  assert.equal(assertGlibcFloor("GLIBC_2.9 GLIBC_2.28 GLIBC_2.2.5 GLIBC_2.28"), "2.28.0");
  assert.throws(() => assertGlibcFloor("GLIBC_3.0"), /above 2\.28/);
  assert.throws(() => assertGlibcFloor("GLIBC_2.100"), /above 2\.28/);
});

test("refuses an unreadable or unrecognized native symbol report", () => {
  assert.throws(() => assertGlibcFloor(""), /No glibc requirement/);
  assert.throws(() => assertGlibcFloor("GLIBCXX_3.4.29"), /No glibc requirement/);
});
