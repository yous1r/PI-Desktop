import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { basename, dirname, join, parse, resolve } from "node:path";
import { ErrorCodes, type AgentInstructionFile } from "@pi-desktop/shared";

const MAX_EDITOR_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
type ExpectedInstruction = Pick<AgentInstructionFile, "content" | "exists">;
type Snapshot = { file: AgentInstructionFile; signature?: string; mode?: number };
type FileStat = Stats;
const signature = (stat: FileStat): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink, stat.mode].join(":");
const invalid = (message: string) => Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
const conflict = () => Object.assign(new Error("Instructions changed on disk; reload before saving."), { errorCode: ErrorCodes.CONFLICT });

async function assertNoLinks(filePath: string): Promise<void> {
  const absolute = resolve(filePath);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw invalid("Instruction paths must not traverse symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function inspect(scope: AgentInstructionFile["scope"], filePath: string): Promise<Snapshot> {
  await assertNoLinks(filePath);
  let before: FileStat;
  try { before = await lstat(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: { scope, path: filePath, content: "", exists: false } };
    throw error;
  }
  if (!before.isFile() || before.nlink !== 1) throw invalid("Instructions must be an unlinked regular file.");
  if (before.size > MAX_EDITOR_BYTES) throw invalid("Instruction document exceeds the editor's 1 MiB limit.");
  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (signature(opened) !== signature(before)) throw conflict();
    const bytes = await handle.readFile();
    if (signature(await handle.stat()) !== signature(before) || bytes.length > MAX_EDITOR_BYTES) throw conflict();
    if (!isUtf8(bytes) || bytes.includes(0)) throw invalid("Instructions must be UTF-8 text.");
    return { file: { scope, path: filePath, content: bytes.toString("utf8"), exists: true }, signature: signature(before), mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function readInstructionFile(scope: AgentInstructionFile["scope"], filePath: string): Promise<AgentInstructionFile> {
  return (await inspect(scope, filePath)).file;
}

/** Compatibility keeps expected optional; current editors always supply their last-read snapshot. */
export async function saveInstructionFile(
  scope: AgentInstructionFile["scope"], filePath: string, content: unknown, expected?: unknown,
): Promise<AgentInstructionFile> {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_EDITOR_BYTES) throw invalid("Instruction content must be text of at most 1 MiB.");
  let snapshot: ExpectedInstruction | undefined;
  if (expected !== undefined) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw invalid("Invalid expected instruction snapshot.");
    const candidate = expected as Partial<ExpectedInstruction>;
    if (typeof candidate.content !== "string" || typeof candidate.exists !== "boolean") throw invalid("Invalid expected instruction snapshot.");
    snapshot = { content: candidate.content, exists: candidate.exists };
  }
  const prior = await inspect(scope, filePath);
  if (snapshot && (snapshot.content !== prior.file.content || snapshot.exists !== prior.file.exists)) throw conflict();
  await mkdir(dirname(filePath), { recursive: true });
  await assertNoLinks(filePath);
  if (!prior.file.exists) {
    try { await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
      throw error;
    }
  } else {
    const temporary = join(dirname(filePath), `.${basename(filePath)}.pi-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: prior.mode });
      await assertNoLinks(filePath);
      let fd: number | undefined;
      try {
        fd = openSync(filePath, constants.O_RDWR | NOFOLLOW);
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || signature(opened) !== prior.signature) throw conflict();
        if (readFileSync(fd, "utf8") !== prior.file.content) throw conflict();
        const named = lstatSync(filePath);
        if (named.isSymbolicLink() || signature(named) !== prior.signature || signature(fstatSync(fd)) !== prior.signature) throw conflict();
        closeSync(fd);
        fd = undefined;
        const final = lstatSync(filePath);
        if (final.isSymbolicLink() || signature(final) !== prior.signature) throw conflict();
        // No await between the final check and atomic replacement. This is not OS CAS for arbitrary external writers.
        renameSync(temporary, filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ELOOP") throw conflict();
        throw error;
      } finally { if (fd !== undefined) closeSync(fd); }
    } finally { await rm(temporary, { force: true }); }
  }
  return { ...prior.file, content, exists: true };
}
