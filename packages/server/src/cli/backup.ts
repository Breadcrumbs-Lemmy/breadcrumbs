/**
 * Backup / restore CLI for the local data directory.
 *
 * For a single-user, self-hosted install this IS the "dump and restore your
 * database" tool — the data is a directory of JSON files, so the operations are
 * copy-out and copy-back, made safe (snapshots live outside the data dir; a
 * restore snapshots the current data first) by persistence/backup.
 *
 * Usage:
 *   pnpm --filter @ai-fin-os/server backup [label]   # snapshot the data dir
 *   pnpm --filter @ai-fin-os/server backup list       # list snapshots, newest first
 *   pnpm --filter @ai-fin-os/server backup restore <name|path>
 *
 * Honors BREADCRUMBZ_LOCAL_DATA_DIR and BREADCRUMBZ_BACKUP_DIR.
 */
import "../load-env";

import { isAbsolute, join } from "node:path";

import { defaultLocalDataDir } from "../local/store-provider";
import { backupDataDir, defaultBackupRootDir, listBackups, restoreDataDir } from "../persistence/backup";

await main();

async function main(): Promise<void> {
  const [command = "create", arg] = process.argv.slice(2);
  const dataDir = defaultLocalDataDir();
  const backupRoot = defaultBackupRootDir(dataDir);

  switch (command) {
    case "create": {
      const result = await backupDataDir(dataDir, { label: arg });
      if (!result) {
        console.log(`Nothing to back up — no data directory at ${dataDir} yet.`);
        return;
      }
      console.log(`Backed up ${dataDir}\n     → ${result.path}`);
      return;
    }

    case "list": {
      const backups = await listBackups(dataDir, { backupRoot });
      if (backups.length === 0) {
        console.log(`No backups found in ${backupRoot}.`);
        return;
      }
      console.log(`Backups in ${backupRoot} (newest first):`);
      for (const backup of backups) {
        console.log(`  ${backup.name}\t${backup.createdAt}`);
      }
      return;
    }

    case "restore": {
      if (!arg) {
        console.error("Usage: backup restore <name|path>");
        process.exit(1);
      }
      // Accept either a bare snapshot name (resolved under the backup root) or a
      // full path.
      const source = isAbsolute(arg) || arg.includes("/") ? arg : join(backupRoot, arg);
      const { safetyBackup } = await restoreDataDir(source, dataDir);
      console.log(`Restored ${dataDir}\n     ← ${source}`);
      if (safetyBackup) console.log(`Previous data saved to ${safetyBackup.path}`);
      return;
    }

    default: {
      console.error(`Unknown command "${command}". Use: create [label] | list | restore <name|path>`);
      process.exit(1);
    }
  }
}
