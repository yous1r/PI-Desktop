import assert from "node:assert/strict";
import test from "node:test";
import {
  GlibcUnsupportedError,
  LINUX_GLIBC_DISTROS,
  MIN_LINUX_GLIBC,
  assertLinuxGlibcSupported,
  formatGlibcVersion,
  glibcAtLeast,
  glibcMissingSymbol,
  hostGlibcWithinFloor,
  isGlibcUnsupportedError,
  isStaticElfReport,
  maxNeededGlibc,
  parseGlibcVersion,
  readRuntimeGlibcVersion,
  resolvesNoSharedLibrary,
} from "../electron/main/linux-glibc.ts";

test("glibc 2.35 is the packaged Linux floor", () => {
  assert.deepEqual(MIN_LINUX_GLIBC, { major: 2, minor: 35 });
  assert.match(LINUX_GLIBC_DISTROS, /Ubuntu 22\.04/);
  assert.match(LINUX_GLIBC_DISTROS, /Debian 12/);
  assert.match(LINUX_GLIBC_DISTROS, /Fedora 36\+/);
  assert.equal(glibcAtLeast({ major: 2, minor: 35 }, MIN_LINUX_GLIBC), true);
  assert.equal(glibcAtLeast({ major: 2, minor: 39 }, MIN_LINUX_GLIBC), true);
  assert.equal(glibcAtLeast({ major: 2, minor: 31 }, MIN_LINUX_GLIBC), false);
  assert.equal(glibcAtLeast({ major: 2, minor: 34 }, MIN_LINUX_GLIBC), false);
});

test("parseGlibcVersion reads ldd and loader output", () => {
  assert.deepEqual(
    parseGlibcVersion("ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35"),
    { major: 2, minor: 35 },
  );
  assert.deepEqual(parseGlibcVersion("2.39"), { major: 2, minor: 39 });
  assert.equal(parseGlibcVersion("not a version"), null);
  assert.equal(formatGlibcVersion({ major: 2, minor: 35 }), "2.35");
});

test("maxNeededGlibc reads objdump symbol versions", () => {
  const dump = `
0000000000000000  w   DF *UND*  0000000000000000  GLIBC_2.2.5  memcpy
0000000000000000      DF *UND*  0000000000000000  GLIBC_2.33   lseek64
0000000000000000      DF *UND*  0000000000000000  GLIBC_2.35   fcntl64
`;
  assert.deepEqual(maxNeededGlibc(dump), { major: 2, minor: 35 });
  assert.equal(hostGlibcWithinFloor({ major: 2, minor: 35 }), true);
  assert.equal(hostGlibcWithinFloor({ major: 2, minor: 31 }), true);
  assert.equal(hostGlibcWithinFloor({ major: 2, minor: 39 }), false);
  assert.equal(hostGlibcWithinFloor(null), true);
});

test("GLIBC loader errors are recognized from stderr", () => {
  assert.equal(
    glibcMissingSymbol(
      "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.35' not found",
    ),
    true,
  );
  assert.equal(glibcMissingSymbol("host-core exited"), false);
  assert.equal(
    isGlibcUnsupportedError(new GlibcUnsupportedError("2.31")),
    true,
  );
  assert.equal(
    isGlibcUnsupportedError(new Error("version `GLIBC_2.35' not found")),
    true,
  );
  assert.equal(isGlibcUnsupportedError(new Error("host-core exited")), false);
});

test("assertLinuxGlibcSupported throws only below the floor on Linux", () => {
  if (process.platform !== "linux") {
    assert.doesNotThrow(() =>
      assertLinuxGlibcSupported({ header: { glibcVersionRuntime: "2.31" } }),
    );
    return;
  }
  assert.doesNotThrow(() =>
    assertLinuxGlibcSupported({ header: { glibcVersionRuntime: "2.35" } }),
  );
  assert.throws(
    () => assertLinuxGlibcSupported({ header: { glibcVersionRuntime: "2.31" } }),
    GlibcUnsupportedError,
  );
  assert.deepEqual(
    readRuntimeGlibcVersion({ header: { glibcVersionRuntime: "2.41" } }),
    { major: 2, minor: 41 },
  );
});

test("a static musl build names no interpreter and needs no shared library", () => {
  // The Rust musl target emits a static PIE, so `file` says "static-pie
  // linked" rather than "statically linked"; both forms must pass.
  assert.equal(
    isStaticElfReport(
      "ELF 64-bit LSB pie executable, x86-64, version 1 (GNU/Linux), static-pie linked, BuildID[sha1]=d7e50bd5, for GNU/Linux 3.2.0, not stripped",
    ),
    true,
  );
  assert.equal(
    isStaticElfReport(
      "ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, stripped",
    ),
    true,
  );
  assert.equal(
    isStaticElfReport(
      "ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, for GNU/Linux 3.7.0, with debug_info, not stripped",
    ),
    false,
  );
  // A static-PIE keeps a dynamic section for self-relocation but never asks
  // the loader for a library.
  assert.equal(
    resolvesNoSharedLibrary(
      [
        "Dynamic section at offset 0xaed88 contains 22 entries:",
        "  0x0000000000000019 (INIT_ARRAY)         0xac530",
        "",
      ].join("\n"),
    ),
    true,
  );
  assert.equal(
    resolvesNoSharedLibrary(
      [
        "Dynamic section at offset 0x1a2b8 contains 27 entries:",
        "  0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
        "",
      ].join("\n"),
    ),
    false,
  );
});
