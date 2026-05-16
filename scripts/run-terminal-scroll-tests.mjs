import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const entryPoints = [
  "tests/terminalScrollState.test.ts",
  "tests/terminalCloseConfirmation.test.ts",
];

await mkdir(".tmp", { recursive: true });

for (const entryPoint of entryPoints) {
  const outfile = `.tmp/${entryPoint.replace(/[\\/]/g, "-").replace(/\.ts$/, ".cjs")}`;
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });

  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
