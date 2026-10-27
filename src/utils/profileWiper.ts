import { lstat, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { exportDataRoot } from './dataPortability';

// Whole-root wipe (wipeProfile / wipeUserProfile). Deletes the entire canonical
// data root after an explicit confirmation and an automatic tar backup; the
// confirmation gate lives in the CLI/MCP surfaces, this module owns only the
// mechanics (inventory -> backup -> delete). A missing root is a no-op, and a
// failed backup aborts before anything is deleted.

export interface DataRootInventory {
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

export interface WipeDataRootOptions {
  rootPath: string;
  // Skip the automatic backup. Without this, a backup failure aborts the wipe.
  noBackup?: boolean;
  // Injected for deterministic backup file names in tests.
  now?: Date;
}

export interface WipeDataRootResult {
  rootPath: string;
  // False when the root did not exist (clean no-op, nothing deleted).
  wiped: boolean;
  inventory: DataRootInventory;
  backupPath: string | null;
}

const emptyInventory: DataRootInventory = { fileCount: 0, dirCount: 0, totalBytes: 0 };

// Returns the root's file/directory/byte counts, or null when it does not
// exist. Read-only.
export async function inventoryDataRoot(rootPath: string): Promise<DataRootInventory | null> {
  const resolvedRoot = resolve(rootPath);
  try {
    const rootStat = await lstat(resolvedRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  const inventory: DataRootInventory = { ...emptyInventory };
  await walk(resolvedRoot, inventory);
  return inventory;
}

async function walk(dirPath: string, inventory: DataRootInventory): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      inventory.dirCount += 1;
      await walk(entryPath, inventory);
      continue;
    }
    // lstat, not stat: a dangling symlink is still an entry to report, and it
    // is never followed while counting.
    const entryStat = await lstat(entryPath);
    inventory.fileCount += 1;
    inventory.totalBytes += entryStat.size;
  }
}

// Backs up (unless noBackup) and then deletes the root. The backup is written
// next to the root, so a failed backup throws before rm runs.
export async function wipeDataRoot(options: WipeDataRootOptions): Promise<WipeDataRootResult> {
  const rootPath = resolve(options.rootPath);
  assertSafeWipeTarget(rootPath);
  const inventory = await inventoryDataRoot(rootPath);
  if (inventory === null) {
    return { rootPath, wiped: false, inventory: { ...emptyInventory }, backupPath: null };
  }

  let backupPath: string | null = null;
  if (options.noBackup !== true) {
    backupPath = join(
      dirname(rootPath),
      `${basename(rootPath)}-backup-${backupTimestamp(options.now ?? new Date())}.tar.gz`,
    );
    await exportDataRoot({ rootPath, archivePath: backupPath });
  }

  await rm(rootPath, { recursive: true, force: true });
  return { rootPath, wiped: true, inventory, backupPath };
}

// Cheap data-loss guard: the tool only ever wipes a data-root directory, never
// a filesystem root or the user's home directory.
function assertSafeWipeTarget(rootPath: string): void {
  if (dirname(rootPath) === rootPath || rootPath === resolve(homedir())) {
    throw new Error(
      `Refusing to wipe '${rootPath}': that is a filesystem root or the home directory, not a data root.`,
    );
  }
}

// Local-time YYYYMMDD-HHmmss, matching the documented backup file name.
function backupTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}
