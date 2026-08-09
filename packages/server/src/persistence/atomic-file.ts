/**
 * The one way every durable file in this app is written.
 *
 * Before this module the codebase had two behaviours: the auth and Plaid stores
 * (via `FileKeyValueStore`) wrote crash-safely at mode 0600, while the statement
 * store — which holds a user's actual accounts and transactions — wrote with a
 * plain `writeFile`: not atomic (a crash mid-write could truncate it to half a
 * JSON document) and mode 0644 (world-readable financial data). Centralising the
 * write here means every persisted file — financial history, session hashes,
 * bank access tokens, assistant memory — gets the same two guarantees:
 *
 *   atomic   Write a private per-call temp file, fsync it, then `rename` it over
 *            the target. `rename` within a directory is atomic on POSIX, so a
 *            reader (or a crash) never sees a partially written file: it sees
 *            either the old bytes or the complete new bytes, never a torn
 *            document. The fsync closes a subtler hole — without it the rename's
 *            metadata can reach the disk while the file's data pages are still
 *            dirty in the page cache, so a power loss leaves a zero-length or
 *            stale file at the live path on writeback filesystems (e.g. XFS). We
 *            fsync the data before the rename and the directory after it.
 *   private  Mode 0600. These files hold money data and bearer credentials; no
 *            other OS user on the box should be able to read them. `rename`
 *            keeps the temp file's mode, so the live file ends up 0600 too.
 */
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Owner-only. Financial data and bank access tokens live in these files. */
export const PRIVATE_FILE_MODE = 0o600;

/** Monotonic per-process counter feeding the temp-file name. A fixed `.tmp`
 *  suffix would let two concurrent writers to the SAME target share one temp
 *  path — one rename then persists the other's bytes, silent corruption. A name
 *  unique per process + call removes that race regardless of caller. */
let tempSeq = 0;

function tempPathFor(filePath: string): string {
  tempSeq = (tempSeq + 1) >>> 0;
  const unique = `${process.pid.toString(36)}.${tempSeq.toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  // Keep `.tmp` as the final suffix: backups and other scans skip `*.tmp`.
  return `${filePath}.${unique}.tmp`;
}

/**
 * Write `content` to `filePath` crash-safely and owner-only.
 *
 * Creates the parent directory if needed, writes a unique sibling temp file at
 * mode 0600, fsyncs it, then atomically renames it over the destination. A crash
 * at any point leaves either the previous complete file or the new complete file
 * — never a half-written or (after a power loss) an empty one.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = tempPathFor(filePath);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "w", PRIVATE_FILE_MODE);
    await handle.writeFile(content, "utf8");
    // Force the bytes to disk before we rename over the target. fdatasync (data
    // + size, not atime/mtime) is enough and cheaper than a full fsync.
    await handle.datasync();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();

  await rename(tmp, filePath);
  // Make the rename itself durable: a crash right after it can otherwise lose the
  // directory-entry update and resurface the old file (or none). Best-effort —
  // some platforms/filesystems disallow opening a directory for fsync.
  await syncDir(dir);
}

/** fsync a directory so a rename into it survives a power loss. Best-effort. */
async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Unsupported on some platforms; the rename is still atomic, only its
    // durability across a power cut is then best-effort.
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/** Serialise `value` as pretty JSON (trailing newline) and write it atomically. */
export function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read and JSON-parse `filePath`. Returns `fallback` when the file does not
 * exist yet (a first run) so callers do not each re-implement the ENOENT dance.
 * A file that exists but holds malformed JSON still throws — silently discarding
 * a user's corrupted-but-present financial data would be worse than a loud stop.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFile(error)) return fallback;
    throw error;
  }
}

/** True for a "file/directory does not exist" (ENOENT) error, and only that. */
export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
