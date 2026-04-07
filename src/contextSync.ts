import { App, Notice } from "obsidian";
import * as os from "os";
import * as path from "path";

// ── 인터페이스 ──

export interface ContextSource {
  agent: string;       // "claude-code", "codex", "gemini", "gpt" 등
  localPath: string;   // 로컬 컨텍스트 경로 (~ 허용)
  enabled: boolean;
}

export const DEFAULT_CONTEXT_SOURCES: ContextSource[] = [
  { agent: "claude-code", localPath: "~/.claude", enabled: true },
];

export function getDefaultHostName(): string {
  return os.hostname().toLowerCase().replace(/[^a-z0-9\-]/g, "");
}

// ── 보안 제외 목록 ──

function getExcludes(agent: string): string[] {
  switch (agent) {
    case "claude-code":
      return [
        "credentials.json",
        "auth.json",
        "statsig/",
        "*.lock",
        ".credentials",
      ];
    case "codex":
      return ["auth/", "credentials/", "*.lock"];
    case "gemini":
      return ["credentials/", "*.lock"];
    default:
      return ["*.lock"];
  }
}

// ── 경로 유틸 ──

function toGitBashPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
}

/** 쉘 인젝션 방지: 안전한 문자만 허용 */
function sanitizeForShell(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-\/~]/g, "");
}

// ── 스크립트 생성 ──

export function generateSyncScript(
  hostName: string,
  sources: ContextSource[],
  vaultBasePath: string,
): string {
  const enabled = sources.filter((s) => s.enabled);
  const vaultUnix = toGitBashPath(vaultBasePath);

  const lines: string[] = [
    "#!/bin/bash",
    "# ── Context Sync Script ──",
    `# Host: ${hostName}`,
    `# Generated: ${new Date().toISOString()}`,
    "# Re-generate: Obsidian > AI Terminal > Settings > Context Sync > Generate script",
    "",
    "set -euo pipefail",
    "",
    `HOST="${sanitizeForShell(hostName)}"`,
    `VAULT="${sanitizeForShell(vaultUnix)}"`,
    'SYNC_BASE="${VAULT}/_context/${HOST}"',
    "",
    'NOW=$(date +"%Y-%m-%d %H:%M:%S")',
    "",
    'echo "=== Context Sync: ${HOST} ==="',
    'echo "Time: ${NOW}"',
    'echo ""',
    "",
  ];

  for (const src of enabled) {
    const safeAgent = sanitizeForShell(src.agent);
    const safePath = sanitizeForShell(src.localPath);
    const srcPath = safePath.replace(/^~/, '${HOME}');
    const excludes = getExcludes(src.agent);
    const excludeArgs = excludes
      .map((e) => `--exclude='${e}'`)
      .join(" ");
    // cp 폴백용: 제외 파일 삭제 명령 생성
    const cpCleanup = excludes
      .map((e) => {
        if (e.endsWith("/")) return `find "$DST" -type d -name '${e.slice(0, -1)}' -exec rm -rf {} + 2>/dev/null`;
        return `find "$DST" -name '${e}' -delete 2>/dev/null`;
      })
      .join("; ");

    lines.push(`# ── ${safeAgent} ──`);
    lines.push(`SRC="${srcPath}"`);
    lines.push(`DST="\${SYNC_BASE}/${safeAgent}"`);
    lines.push("");
    lines.push('if [ -e "$SRC" ]; then');
    lines.push('  mkdir -p "$DST"');
    lines.push('  if command -v rsync &>/dev/null; then');
    lines.push(`    rsync -av --update ${excludeArgs} "$SRC/" "$DST/"`);
    lines.push("  else");
    lines.push('    cp -ru "$SRC/"* "$DST/" 2>/dev/null || cp -R "$SRC/"* "$DST/"');
    lines.push(`    # cp는 exclude 미지원 → 복사 후 보안 파일 삭제`);
    lines.push(`    ${cpCleanup} || true`);
    lines.push("  fi");
    lines.push(`  echo "  ✓ ${safeAgent}"`);
    lines.push("else");
    lines.push(`  echo "  ✗ ${safeAgent}: not found ($SRC)"`);
    lines.push("fi");
    lines.push("");
  }

  lines.push("# sync log");
  lines.push('echo "${NOW} | sync | ${HOST}" >> "${SYNC_BASE}/_sync.log"');
  lines.push("");
  lines.push('echo ""');
  lines.push('echo "=== Done ==="');

  return lines.join("\n") + "\n";
}

// ── 스크립트 파일 쓰기 ──

export async function writeSyncScript(
  app: App,
  hostName: string,
  sources: ContextSource[],
): Promise<string> {
  const vaultPath = (app.vault.adapter as any).basePath as string;
  const content = generateSyncScript(hostName, sources, vaultPath);

  const scriptRelPath = ".obsidian/plugins/obsidian-ai-terminal/sync-context.sh";
  await app.vault.adapter.write(scriptRelPath, content);

  return path.join(vaultPath, scriptRelPath);
}
