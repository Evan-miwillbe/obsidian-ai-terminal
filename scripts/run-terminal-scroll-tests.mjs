import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const outfile = ".tmp/terminalScrollState.test.cjs";

await mkdir(".tmp", { recursive: true });
await build({
  entryPoints: ["tests/terminalScrollState.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
