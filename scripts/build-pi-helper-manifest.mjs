import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_TARGETS = Object.freeze({
  'x86_64-unknown-linux-musl': 'x64',
  'aarch64-unknown-linux-musl': 'arm64',
})

export function buildManifest({ target, version, sha256 }) {
  if (!Object.hasOwn(SUPPORTED_TARGETS, target)) throw new Error('unsupported pi-helper target')
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('invalid pi-helper version')
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('invalid pi-helper SHA-256')
  }
  return {
    schemaVersion: 1,
    version,
    target,
    arch: SUPPORTED_TARGETS[target],
    file: `pi-helper-linux-${SUPPORTED_TARGETS[target]}`,
    sha256,
  }
}

async function sha256File(path) {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

async function main(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument: ${key}`)
    if (args.has(key)) throw new Error(`duplicate argument: ${key}`)
    args.set(key, argv[++index])
  }
  const target = args.get('--target')
  const binaryArg = args.get('--binary')
  const outArg = args.get('--out')
  const version = args.get('--version')
  if (!target || !binaryArg || !outArg || !version) {
    throw new Error('usage: build-pi-helper-manifest.mjs --target <target> --binary <path> --out <dir> --version <version>')
  }
  if (!Object.hasOwn(SUPPORTED_TARGETS, target)) throw new Error('unsupported pi-helper target')
  const binary = resolve(binaryArg)
  const out = resolve(outArg)
  const digest = await sha256File(binary)
  const manifest = buildManifest({ target, version, sha256: digest })
  await mkdir(out, { recursive: true })
  const outputBinary = resolve(out, manifest.file)
  await writeFile(outputBinary, await readFile(binary), { mode: 0o750, flag: 'wx' })
  await chmod(outputBinary, 0o750)
  await writeFile(resolve(out, `${manifest.file}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${basename(outputBinary)} ${manifest.sha256}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
