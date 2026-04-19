import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/* ── 类型 ────────────────────────────────────────── */

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
  note: string;           // 用户备注
}

export interface DimensionEntry {
  path: string;        // Vault 相对路径 (e.g., "10_Project/하네스팩토리/아키텍처_설계.md")
  label: string;       // 显示名称 (basename)
  addedAt: string;     // ISO 8601
}

export interface HubConfig {
  dimensions: DimensionEntry[];
  lastBuild: string | null;     // ISO 8601
  hubPath: string | null;       // 已构建的 HUB .md 路径
  buildStatus: "synced" | "stale" | "never";
}

export interface DeployRegistry {
  pcs: PcEntry[];
  entries: DeployEntry[];
  sources: Record<string, ChatSourceEntry[]>;  // project → sources
  hubs: Record<string, HubConfig>;             // project → hub config
}

/* ── 常量 ────────────────────────────────────────── */

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
  private registry: DeployRegistry = { pcs: [], entries: [], sources: {}, hubs: {} };
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

  /* ── Sources 管理 ── */

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
        this.registry = { pcs: [], entries: [], sources: {}, hubs: {}, ...parsed };
      } else {
        this.registry = { pcs: [], entries: [], sources: {}, hubs: {} };
      }
    } catch {
      this.registry = { pcs: [], entries: [], sources: {}, hubs: {} };
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

  /* ── PC 管理 ── */

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

  /* ── Hub / Dimension CRUD ── */

  getHubConfig(project: string): HubConfig {
    if (!this.registry.hubs[project]) {
      this.registry.hubs[project] = {
        dimensions: [],
        lastBuild: null,
        hubPath: null,
        buildStatus: "never",
      };
    }
    return this.registry.hubs[project];
  }

  addDimension(project: string, vaultPath: string, label: string): void {
    const hub = this.getHubConfig(project);
    if (hub.dimensions.some((d) => d.path === vaultPath)) return;
    hub.dimensions.push({
      path: vaultPath,
      label,
      addedAt: new Date().toISOString(),
    });
    hub.buildStatus = "stale";
  }

  removeDimension(project: string, vaultPath: string): void {
    const hub = this.getHubConfig(project);
    hub.dimensions = hub.dimensions.filter((d) => d.path !== vaultPath);
    hub.buildStatus = hub.dimensions.length > 0 ? "stale" : "never";
  }

  /** 比较 dimension 文件的 mtime 与 hub 构建时间，更新 buildStatus */
  async checkDimensionFreshness(project: string): Promise<void> {
    const hub = this.getHubConfig(project);
    if (hub.dimensions.length === 0) {
      hub.buildStatus = "never";
      return;
    }
    if (!hub.lastBuild) {
      hub.buildStatus = "stale";
      return;
    }

    const buildTime = new Date(hub.lastBuild).getTime();

    for (const dim of hub.dimensions) {
      try {
        const stat = await this.app.vault.adapter.stat(dim.path);
        if (stat && stat.mtime > buildTime) {
          hub.buildStatus = "stale";
          return;
        }
      } catch {
        hub.buildStatus = "stale";
        return;
      }
    }

    hub.buildStatus = "synced";
  }

  /** 读取 dimension 文件并构建 hub 笔记 */
  async buildHub(project: string): Promise<string> {
    const hub = this.getHubConfig(project);
    if (hub.dimensions.length === 0) {
      throw new Error("没有 dimension，请先添加 dimension。");
    }

    const sections: string[] = [];
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // frontmatter
    sections.push("---");
    sections.push(`id: hub_${project}`);
    sections.push(`type: hub`);
    sections.push(`dimensions:`);
    for (const dim of hub.dimensions) {
      sections.push(`  - "${dim.path}"`);
    }
    sections.push(`last_build: ${now.toISOString()}`);
    sections.push(`status: synced`);
    sections.push("---");
    sections.push("");
    sections.push(`# Hub: ${project}`);
    sections.push(`> 自动构建 (${dateStr}) — ${hub.dimensions.length} 个 dimension`);
    sections.push("");

    // 合并各 dimension 内容
    for (const dim of hub.dimensions) {
      try {
        const content = await this.app.vault.adapter.read(dim.path);
        // 移除 frontmatter
        const stripped = content.replace(/^---[\s\S]*?---\n*/m, "");
        sections.push(`## ${dim.label}`);
        sections.push("");
        sections.push(stripped.trim());
        sections.push("");
        sections.push("---");
        sections.push("");
      } catch {
        sections.push(`## ${dim.label}`);
        sections.push(`> ⚠️ 无法读取文件: ${dim.path}`);
        sections.push("");
      }
    }

    const hubContent = sections.join("\n");

    // 确定 hub 笔记路径
    const projectName = project.split("/").pop() ?? project;
    const hubPath = hub.hubPath || `${project}/HUB_${projectName}.md`;

    // 确保目录存在
    const dir = hubPath.substring(0, hubPath.lastIndexOf("/"));
    if (dir) {
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }
    }

    await this.app.vault.adapter.write(hubPath, hubContent);

    // 更新状态
    hub.hubPath = hubPath;
    hub.lastBuild = now.toISOString();
    hub.buildStatus = "synced";

    return hubPath;
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

  /* ── 验证 ── */

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
        // 普通文件 (copy 方式 Deploy)
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

  /* ── Deploy ── */

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
      // 已不存在
    }
    entry.status = "none";
    entry.lastVerified = null;
    await this.saveRegistry();
  }

  /* ── Symlink (平台分支) ── */

  private createSymlink(target: string, linkPath: string): void {
    if (fs.existsSync(linkPath)) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // 通过 lstat 尝试删除 broken symlink
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

/* ── 工具函数 ── */

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
