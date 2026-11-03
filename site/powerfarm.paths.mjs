// One definition of where this installation keeps its data. astro.config.mjs,
// scripts/backup.mjs and scripts/restore.mjs all read it, so the running
// instance, the setup wizard, the seed, media, backups and restores always
// refer to the same files.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function powerfarmPaths(env = process.env) {
	const dataDir = path.resolve(here, env.POWERFARM_DATA_DIR ?? "./data");
	return {
		dataDir,
		database: path.join(dataDir, "emdash.db"),
		uploads: path.join(dataDir, "uploads"),
		databaseUrl: env.DATABASE_URL ?? null,
	};
}
