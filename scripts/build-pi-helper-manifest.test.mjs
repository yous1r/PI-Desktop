import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, SUPPORTED_TARGETS } from './build-pi-helper-manifest.mjs'

const checksum = 'a'.repeat(64)

test('builds a per-architecture manifest bound to binary digest and version', () => {
  assert.deepEqual(buildManifest({ target: 'x86_64-unknown-linux-musl', version: '0.22.0-beta.1', sha256: checksum }), {
    schemaVersion: 1,
    version: '0.22.0-beta.1',
    target: 'x86_64-unknown-linux-musl',
    arch: 'x64',
    file: 'pi-helper-linux-x64',
    sha256: checksum,
  })
  assert.deepEqual(SUPPORTED_TARGETS, {
    'x86_64-unknown-linux-musl': 'x64',
    'aarch64-unknown-linux-musl': 'arm64',
  })
})

test('rejects unsupported targets, malformed versions, and untrusted digests', () => {
  assert.throws(() => buildManifest({ target: 'x86_64-unknown-linux-gnu', version: '1.2.3', sha256: checksum }), /unsupported/)
  assert.throws(() => buildManifest({ target: 'x86_64-unknown-linux-musl', version: '../1.2', sha256: checksum }), /version/)
  for (const sha256 of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.throws(() => buildManifest({ target: 'x86_64-unknown-linux-musl', version: '1.2.3', sha256 }), /SHA-256/)
  }
})
