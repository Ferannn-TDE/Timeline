// Keep the documented Node entrypoint; reuse the same Google checks as the worker.
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--experimental-transform-types", new URL("./activate-docs.ts", import.meta.url).pathname], { stdio: "inherit" });
process.exit(result.status ?? 1);
