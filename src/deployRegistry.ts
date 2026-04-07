import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/* ── 타입 ────────────────────────────────────────── */

export interface PcEntry {
  id: string;
  hostname: string;
  os: string;
  vaultPath: string;
  devRoots: string[];
  lastSeen: string;
}

export interface DeployEntry {
  id: string;
  project: string;
  tool: string;
  pc: string;
  symlinkPath: string;
  targetPath: string;
  method: "symlink" | "copy";
  files: string[];
  status: "active" | "unverified" | "broken" | "none" | "deferred";
  lastVerified: string | null;
}

export interface ChatSourceEntry {
  tool: string;
  status: "extractable" | "reference_only" | "unavailable";
  rootPath: string;       // e.g. "$CLAUDE_ROOT/projects/..."
  format: string;         // e.g. "JSONL", "JSON", "protobuf"
  note: string;           // 사용자 메모
}

export interface DeployRegistry {
  pcs: PcEntry[];
  entries: DeployEntry[];
  sources: Record<string, ChatSourceEntry[]>;  // project → sources
}

/* ── 상수 ────────────────────────────────────────── */

export const TOOL_TARGET_MAP: Record<string, (repo: string) => string> = {
  "claude-code": (repo) => path.join(repo, ".claude", "hub.md"),
  "codex": (repo) => path.join(repo, "AGENTS.md"),
  "gemini-cli": (repo) => path.join(repo, "GEMINI.md"),
  "cursor": (repo) => path.join(repo, ".cursorrules"),
};

export const TOOL_LABELS: Record<string, string> = {
  "claude-code": "CC",
  "codex": "Cx",
  "gemini-cli": "Gm",
  "cursor": "Cu",
};

export const ALL_TOOLS = ["claude-code", "codex", "gemini-cli", "cursor"];

export function getToolTargetPath(tool: string, repoPath: string): string {
  const fn = TOOL_TARGET_MAP[tool];
  return fn ? fn(repoPath) : path.join(repoPath, "hub.md");
}

export function generateEntryId(pc: string, tool: string, project: string): string {
  return `${pc}:${tool}:${project}`;
}

/* ── Manager ─────────────────────────────────────── */

export class DeployRegistryManager {
  private registry: DeployRegistry = { pcs: [], entries: [], sources: {} };
  private currentPcId: string = "";

  constructor(
    private app: App,
    private registryPath: string,
  ) {}

  get pcs(): PcEntry[] {
    return this.registry.pcs;
  }

  get entries(): DeployEntry[] {
    return this.registry.entries;
  }

  getCurrentPcId(): string {
    return this.currentPcId;
  }

  getAllProjects(): string[] {
    const set = new Set([
      ...this.registry.entries.map((e) => e.project),
      ...Object.keys(this.registry.sources),
    ]);
    return [...set].sort();
  }

  /* ── Sources 관리 ── */

  getSources(project: string): ChatSourceEntry[] {
    return this.registry.sources[project] ?? getDefaultSources();
  }

  setSources(project: string, sources: ChatSourceEntry[]): void {
    this.registry.sources[project] = sources;
  }

  updateSource(project: string, tool: string, update: Partial<ChatSourceEntry>): void {
    if (!this.registry.sources[project]) {
      this.registry.sources[project] = getDefaultSources();
    }
    const src = this.registry.sources[project].find((s) => s.tool === tool);
    if (src) {
      Object.assign(src, update);
    }
  }

  /* ── Load / Save ── */

  async loadRegistry(): Promise<DeployRegistry> {
    try {
      const exists = await this.app.vault.adapter.exists(this.registryPath);
      if (exists) {
        const raw = await this.app.vault.adapter.read(this.registryPath);
        const parsed = JSON.parse(raw);
        this.registry = { pcs: [], entries: [], sources: {}, ...parsed };
      } else {
        this.registry = { pcs: [], entries: [], sources: {} };
      }
    } catch {
      this.registry = { pcs: [], entries: [], sources: {} };
    }
    return this.registry;
  }

  async saveRegistry(): Promise<void> {
    const dir = path.dirname(this.registryPath);
    const dirExists = await this.app.vault.adapter.exists(dir);
    if (!dirExists) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const json = JSON.stringify(this.registry, null, 2);
    await this.app.vault.adapter.write(this.registryPath, json);
  }

  /* ── PC 관리 ── */

  registerCurrentPc(): PcEntry {
    const hostname = os.hostname();
    this.currentPcId = hostname.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const vaultPath = (this.app.vault.adapter as any).basePath as string;

    let existing = this.registry.pcs.find((p) => p.id === this.currentPcId);
    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.vaultPath = vaultPath;
      return existing;
    }

    const entry: PcEntry = {
      id: this.currentPcId,
      hostname,
      os: detectOs(),
      vaultPath,
      devRoots: [],
      lastSeen: new Date().toISOString(),
    };
    this.registry.pcs.push(entry);
    return entry;
  }

  /* ── Entry CRUD ── */

  addEntry(entry: DeployEntry): void {
    const idx = this.registry.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.registry.entries[idx] = entry;
    } else {
      this.registry.entries.push(entry);
    }
  }

  removeEntry(entryId: string): void {
    this.registry.entries = this.registry.entries.filter((e) => e.id !== entryId);
  }

  findEntry(project: string, tool: string, pcId: string): DeployEntry | null {
    return (
      this.registry.entries.find(
        (e) => e.project === project && e.tool === tool && e.pc === pcId,
      ) ?? null
    );
  }

  /* ── 검증 ── */

  verifyEntry(entry: DeployEntry): DeployEntry {
    if (entry.pc !== this.currentPcId) {
      entry.status = "unverified";
      return entry;
    }

    try {
      const stat = fs.lstatSync(entry.symlinkPath);
      if (stat.isSymbolicLink()) {
        const targetExists = fs.existsSync(entry.symlinkPath);
        entry.status = targetExists ? "active" : "broken";
      } else {
        // 일반 파일(copy 배포)
        entry.status = "active";
      }
    } catch {
      entry.status = "none";
    }

    entry.lastVerified = new Date().toISOString();
    return entry;
  }

  async verifyAll(): Promise<DeployEntry[]> {
    const results: DeployEntry[] = [];
    for (const entry of this.registry.entries) {
      results.push(this.verifyEntry(entry));
    }
    await this.saveRegistry();
    return results;
  }

  /* ── 배포 ── */

  async deployEntry(entry: DeployEntry): Promise<void> {
    const dir = path.dirname(entry.symlinkPath);
    fs.mkdirSync(dir, { recursive: true });

    if (entry.method === "symlink") {
      this.createSymlink(entry.targetPath, entry.symlinkPath);
    } else {
      if (fs.existsSync(entry.symlinkPath)) {
        fs.unlinkSync(entry.symlinkPath);
      }
      fs.copyFileSync(entry.targetPath, entry.symlinkPath);
    }

    entry.status = "active";
    entry.lastVerified = new Date().toISOString();
    await this.saveRegistry();
  }

  async removeDeployment(entry: DeployEntry): Promise<void> {
    try {
      if (fs.existsSync(entry.symlinkPath) || fs.lstatSync(entry.symlinkPath)) {
        fs.unlinkSync(entry.symlinkPath);
      }
    } catch {
      // 이미 없음
    }
    entry.status = "none";
    entry.lastVerified = null;
    await this.saveRegistry();
  }

  /* ── 심링크 (플랫폼 분기) ── */

  private createSymlink(target: string, linkPath: string): void {
    if (fs.existsSync(linkPath)) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // lstat로 broken symlink 삭제 시도
        try { fs.unlinkSync(linkPath); } catch { /* noop */ }
      }
    }

    if (process.platform === "win32") {
      try {
        fs.symlinkSync(target, linkPath, "file");
      } catch {
        try {
          fs.symlinkSync(target, linkPath, "junction");
        } catch {
          fs.copyFileSync(target, linkPath);
        }
      }
    } else {
      fs.symlinkSync(target, linkPath);
    }
  }
}

/* ── 유틸 ── */

export function getDefaultSources(): ChatSourceEntry[] {
  return [
    { tool: "claude-code", status: "extractable", rootPath: "$CLAUDE_ROOT/projects/", format: "JSONL", note: "" },
    { tool: "codex", status: "extractable", rootPath: "$CODEX_ROOT/", format: "JSONL+SQLite", note: "" },
    { tool: "gemini-cli", status: "extractable", rootPath: "$GEMINI_ROOT/tmp/", format: "JSON", note: "" },
    { tool: "antigravity", status: "reference_only", rootPath: "$ANTIGRAVITY_ROOT/conversations/", format: "protobuf", note: "" },
  ];
}

function detectOs(): string {
  switch (process.platform) {
    case "win32":
      return "win11";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}
