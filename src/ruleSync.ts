import { App, Modal, Notice } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ── 类型 ──

interface ProfileConfig {
  chunks: string[];
  globs: string[];
}

interface DeployResult {
  profile: string;
  target: string;
  action: "skip" | "auto-deploy" | "confirm-deploy" | "confirm-skipped";
  sourceHash: string;
  deployedHash: string | null;
  sourceMtime: string | null;
  localMtime: string | null;
}

interface LogEntry {
  timestamp: string;
  event_type: string;
  profile?: string;
  action?: string;
  target?: string;
  machine: string;
  path?: string;
  source_hash?: string;
  deployed_hash?: string;
  local_hash?: string;
  source_mtime?: string | null;
  local_mtime?: string | null;
  source_mapping?: string;
}

export interface RuleSyncSettings {
  ruleSyncEnabled: boolean;
  ruleSyncAtomsPath: string;
  ruleSyncProfilesPath: string;
  ruleSyncGlobalIndexPath: string;
  ruleSyncLogPath: string;
  ruleReportOutboxPath: string;
  ruleSyncDebounceMs: number;
  localRuleWatchEnabled: boolean;
  localRuleWatchPaths: string[];
  localRuleReportOutboxPath: string;
  ruleSyncTargets: {
    claudeGlobal: boolean;
    claudeProfiles: boolean;
    geminiGlobal: boolean;
  };
}

export const DEFAULT_RULE_SYNC_SETTINGS: RuleSyncSettings = {
  ruleSyncEnabled: false,
  ruleSyncAtomsPath: "0_harness/factory/atoms/rules",
  ruleSyncProfilesPath: "0_harness/factory/compositions/profiles",
  ruleSyncGlobalIndexPath: "0_harness/factory/atoms/global_policy_index.md",
  ruleSyncLogPath: ".obsidian/plugins/obsidian-ai-terminal/rule-sync-log.jsonl",
  ruleReportOutboxPath: "0_harness/factory/data/rule_reports/pc2.jsonl",
  ruleSyncDebounceMs: 5000,
  localRuleWatchEnabled: false,
  localRuleWatchPaths: [],
  localRuleReportOutboxPath: "0_harness/factory/data/rule_reports/pc2.jsonl",
  ruleSyncTargets: {
    claudeGlobal: true,
    claudeProfiles: true,
    geminiGlobal: true,
  },
};

// ── 一级显式映射（按 profile） ──

const PROFILE_MATRIX: Record<string, ProfileConfig> = {
  company: {
    chunks: ["core", "coding", "accounting", "vault"],
    globs: ["**/dev/company/**", "**/공업사스토어/**"],
  },
  mbo: {
    chunks: ["core", "coding", "accounting", "governance"],
    globs: ["**/dev/mbo/**"],
  },
  personal: {
    chunks: ["core", "coding", "governance"],
    globs: ["**/dev/personal/**"],
  },
  myarchive: {
    chunks: ["core", "vault", "accounting"],
    globs: ["**/MyArchive/**"],
  },
};

// ── 部署目标 → canonical source 映射（用于 drift detect） ──

function getDeployedTargetSourceMapping(absPath: string): string {
  const home = os.homedir();
  const claudeGlobal = path.join(home, ".claude", "CLAUDE.md");
  const claudeRulesDir = path.join(home, ".claude", "rules");
  const geminiGlobal = path.join(home, ".gemini.md");

  if (absPath === claudeGlobal) return "claude-global";
  if (absPath === geminiGlobal) return "gemini-global";
  if (absPath.startsWith(claudeRulesDir)) {
    const profile = path.basename(absPath, ".md");
    return `claude-profile:${profile}`;
  }
  return "none";
}

// ── 工具函数 ──

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? md.slice(match[0].length) : md;
}

function nowKST(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

function fileMtime(filePath: string): Date | null {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const LOCAL_WATCH_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".prompt",
]);

function isWatchableFile(filename: string): boolean {
  return LOCAL_WATCH_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// ── Claude Global 输出生成 ──

function generateClaudeGlobal(atoms: Map<string, string>): string {
  const core = atoms.get("core") ?? "";

  return `# Global Rules

## Policy Surface
- 此文件仅保留 \`always_on\` 最小规则。
- 详细策略从 \`linked\` 模块和 \`0_harness/factory/atoms/global_policy_index.md\` 中获取。
- generated 文件是投影，canonical source 是 \`policy_module\`。

## Always On

### Core minimum
${core.replace(/^#.*\n+/, "").trim()}

### Governance minimum
- 安全优先于速度。
- 一个议题在一个上下文中处理。
- reviewable proposal 默认遵循 FIFO。
- 重要变更必须可审计。
- proposal 处理状态默认保持无状态。

### Approval minimum
- 高影响操作需保持明确的审批边界。

## Linked Policy
- \`vault\`: 0_harness/factory/atoms/rules/vault.md
- \`coding\`: 0_harness/factory/atoms/rules/coding.md
- \`accounting\`: 0_harness/factory/atoms/rules/accounting.md
- \`governance\`: 0_harness/factory/atoms/rules/governance.md

## Retrieval Guidance
- 不要在此文件中堆积冗长规则，优先使用 linked module 或 MCP 查询。
- 项目级详细规则在 profile/project surface 中衔接。
`;
}

// ── Claude Profile 输出生成 ──

function generateClaudeProfile(profile: string, config: ProfileConfig, atoms: Map<string, string>): string {
  const globsYaml = config.globs.map((g) => `"${g}"`).join(", ");

  const header = `---
globs: [${globsYaml}]
---

# Generated from 0_harness/factory/atoms/rules
# Flow: generated file changes are allowed and can be reviewed back into the harness.
`;

  const bodies = config.chunks
    .map((chunk) => atoms.get(chunk))
    .filter((body): body is string => !!body)
    .map((body) => "\n" + body.trim())
    .join("\n\n---\n");

  return header + bodies + "\n";
}

// ── Gemini Global 输出生成 ──

function generateGeminiGlobal(atoms: Map<string, string>): string {
  const core = atoms.get("core") ?? "";

  return `# Global Rules
# Projection source: 0_harness/factory/atoms/rules/
# Generated file changes are allowed and can be reviewed back into the harness.

${core.trim()}

# Harness Skills
技能/规则源文件: 0_harness/
`;
}

// ── Confirm Modal ──

class ConfirmSyncModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private profile: string,
    private target: string,
    private onConfirm: () => void,
    private onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Rule Sync: 本地文件较新" });
    contentEl.createEl("p", {
      text: `"${this.profile}" (${this.target}) 本地文件比 harness 源文件更新。是否覆盖？`,
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    btnRow.createEl("button", { text: "覆盖", cls: "mod-warning" }).addEventListener("click", () => {
      this.resolved = true;
      this.close();
      this.onConfirm();
    });
    btnRow.createEl("button", { text: "跳过" }).addEventListener("click", () => {
      this.resolved = true;
      this.close();
      this.onCancel();
    });
  }

  onClose(): void {
    if (!this.resolved) this.onCancel();
  }
}

// ── RuleSync 主体 ──

export class RuleSync {
  private localRuleHashes = new Map<string, string>();
  private localWatchers: fs.FSWatcher[] = [];
  private selfWritePaths = new Set<string>();

  constructor(
    private app: App,
    private settings: RuleSyncSettings,
  ) {}

  // ── Vault 路径辅助函数 ──

  private get vaultPath(): string {
    return (this.app.vault.adapter as any).basePath as string;
  }

  private get claudeDir(): string {
    return path.join(os.homedir(), ".claude");
  }

  private get claudeRulesDir(): string {
    return path.join(this.claudeDir, "rules");
  }

  private get geminiPath(): string {
    return path.join(os.homedir(), ".gemini.md");
  }

  // ── Atom 读取 ──

  private async readAtoms(): Promise<Map<string, string>> {
    const atoms = new Map<string, string>();
    const atomNames = ["core", "coding", "accounting", "governance", "vault"];

    for (const name of atomNames) {
      const vaultRelPath = `${this.settings.ruleSyncAtomsPath}/${name}.md`;
      try {
        const raw = await this.app.vault.adapter.read(vaultRelPath);
        atoms.set(name, stripFrontmatter(raw));
      } catch {
        // atom 文件不存在则跳过
      }
    }
    return atoms;
  }

  // ── atom source 中最新 mtime ──
  // 一级: 仅针对 output 生成实际使用的 atoms。
  // profiles/*.md、global_policy_index.md 在一级中不用于 output 生成，因此排除。
  // 二级实现动态 profile 读取时在此处添加。

  private latestSourceMtime(): Date | null {
    let latest: Date | null = null;

    for (const name of ["core", "coding", "accounting", "governance", "vault"]) {
      const mt = fileMtime(path.join(this.vaultPath, this.settings.ruleSyncAtomsPath, `${name}.md`));
      if (mt && (!latest || mt > latest)) latest = mt;
    }

    return latest;
  }

  // ── 单目标部署 ──

  private async deploySingle(
    targetPath: string,
    content: string,
    profile: string,
    targetLabel: string,
  ): Promise<DeployResult> {
    const srcHash = contentHash(content);
    const existing = readFileOrNull(targetPath);
    const deployedHash = existing ? contentHash(existing) : null;

    // hash 相同 → 跳过
    if (deployedHash === srcHash) {
      return { profile, target: targetLabel, action: "skip", sourceHash: srcHash, deployedHash, sourceMtime: null, localMtime: null };
    }

    const atomMtime = this.latestSourceMtime();
    const localMtime = fileMtime(targetPath);
    const sourceMtimeStr = atomMtime?.toISOString() ?? null;
    const localMtimeStr = localMtime?.toISOString() ?? null;

    // hash 不同 + 本地较新 → 需确认
    if (localMtime && atomMtime && localMtime > atomMtime) {
      return new Promise((resolve) => {
        new ConfirmSyncModal(
          this.app,
          profile,
          targetLabel,
          () => {
            this.writeTarget(targetPath, content);
            resolve({ profile, target: targetLabel, action: "confirm-deploy", sourceHash: srcHash, deployedHash, sourceMtime: sourceMtimeStr, localMtime: localMtimeStr });
          },
          () => {
            resolve({ profile, target: targetLabel, action: "confirm-skipped", sourceHash: srcHash, deployedHash, sourceMtime: sourceMtimeStr, localMtime: localMtimeStr });
          },
        ).open();
      });
    }

    // 自动部署
    this.writeTarget(targetPath, content);
    return { profile, target: targetLabel, action: "auto-deploy", sourceHash: srcHash, deployedHash, sourceMtime: sourceMtimeStr, localMtime: localMtimeStr };
  }

  private writeTarget(targetPath: string, content: string): void {
    ensureDir(path.dirname(targetPath));
    this.selfWritePaths.add(targetPath);
    fs.writeFileSync(targetPath, content, "utf-8");
    // 短暂延迟后移除，避免检测到自身写入
    setTimeout(() => this.selfWritePaths.delete(targetPath), 2000);
  }

  // ── Claude Global Sync ──

  async syncClaudeGlobal(force = false): Promise<DeployResult> {
    const atoms = await this.readAtoms();
    const content = generateClaudeGlobal(atoms);
    const targetPath = path.join(this.claudeDir, "CLAUDE.md");

    if (force) {
      this.writeTarget(targetPath, content);
      return { profile: "global", target: "claude-global", action: "auto-deploy", sourceHash: contentHash(content), deployedHash: null, sourceMtime: null, localMtime: null };
    }

    return this.deploySingle(targetPath, content, "global", "claude-global");
  }

  // ── Claude Profile Sync ──

  async syncClaudeProfiles(force = false): Promise<DeployResult[]> {
    const atoms = await this.readAtoms();
    const results: DeployResult[] = [];

    for (const [profile, config] of Object.entries(PROFILE_MATRIX)) {
      const content = generateClaudeProfile(profile, config, atoms);
      const targetPath = path.join(this.claudeRulesDir, `${profile}.md`);

      if (force) {
        this.writeTarget(targetPath, content);
        results.push({ profile, target: "claude-rules", action: "auto-deploy", sourceHash: contentHash(content), deployedHash: null, sourceMtime: null, localMtime: null });
      } else {
        results.push(await this.deploySingle(targetPath, content, profile, "claude-rules"));
      }
    }
    return results;
  }

  // ── Gemini Global Sync ──

  async syncGeminiGlobal(force = false): Promise<DeployResult> {
    const atoms = await this.readAtoms();
    const content = generateGeminiGlobal(atoms);

    if (force) {
      this.writeTarget(this.geminiPath, content);
      return { profile: "global", target: "gemini-global", action: "auto-deploy", sourceHash: contentHash(content), deployedHash: null, sourceMtime: null, localMtime: null };
    }

    return this.deploySingle(this.geminiPath, content, "global", "gemini-global");
  }

  // ── 全量 Sync ──

  async syncAll(force = false): Promise<DeployResult[]> {
    const results: DeployResult[] = [];

    if (this.settings.ruleSyncTargets.claudeGlobal) {
      results.push(await this.syncClaudeGlobal(force));
    }
    if (this.settings.ruleSyncTargets.claudeProfiles) {
      results.push(...await this.syncClaudeProfiles(force));
    }
    if (this.settings.ruleSyncTargets.geminiGlobal) {
      results.push(await this.syncGeminiGlobal(force));
    }

    // 日志记录（本地 + 共享 outbox）
    const entries = results
      .filter((r) => r.action !== "skip")
      .map((r): LogEntry => ({
        timestamp: nowKST(),
        event_type: "rule-deploy",
        profile: r.profile,
        action: r.action,
        target: r.target,
        machine: os.hostname(),
        source_hash: r.sourceHash,
        deployed_hash: r.deployedHash ?? undefined,
        source_mtime: r.sourceMtime,
        local_mtime: r.localMtime,
      }));

    if (entries.length > 0) {
      await this.appendLocalLog(entries);
      await this.appendSharedOutbox(entries, this.settings.ruleReportOutboxPath);
    }

    // Notice 汇总
    const deployed = results.filter((r) => r.action === "auto-deploy" || r.action === "confirm-deploy");
    const skipped = results.filter((r) => r.action === "skip");
    if (deployed.length > 0) {
      new Notice(`Rule Sync: ${deployed.length} 个已部署, ${skipped.length} 个跳过`);
    }

    return results;
  }

  // ── Local LLM Rule Watch ──

  startLocalRuleWatch(): void {
    if (!this.settings.localRuleWatchEnabled) return;

    // 初始 hash 记录
    for (const rawPath of this.settings.localRuleWatchPaths) {
      const absPath = resolveHome(rawPath);
      const content = readFileOrNull(absPath);
      if (content) {
        this.localRuleHashes.set(absPath, contentHash(content));
      }
    }

    // 注册 fs.watch
    for (const rawPath of this.settings.localRuleWatchPaths) {
      const absPath = resolveHome(rawPath);

      // 目录情况下使用 recursive watch
      try {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          const watcher = fs.watch(absPath, { recursive: true }, (_, filename) => {
            if (filename && isWatchableFile(filename)) {
              this.handleLocalRuleChange(path.join(absPath, filename));
            }
          });
          this.localWatchers.push(watcher);
        } else if (isWatchableFile(absPath)) {
          const watcher = fs.watch(absPath, () => {
            this.handleLocalRuleChange(absPath);
          });
          this.localWatchers.push(watcher);
        }
      } catch {
        // 路径尚不存在则跳过
      }
    }
  }

  stopLocalRuleWatch(): void {
    for (const watcher of this.localWatchers) {
      watcher.close();
    }
    this.localWatchers = [];
  }

  private async handleLocalRuleChange(absPath: string): Promise<void> {
    // 忽略自身刚写入的文件
    if (this.selfWritePaths.has(absPath)) return;

    // debounce: 100ms 后处理（fs.watch 可能产生重复事件）
    await new Promise((r) => setTimeout(r, 100));

    const content = readFileOrNull(absPath);
    if (!content) return;

    const newHash = contentHash(content);
    const oldHash = this.localRuleHashes.get(absPath);

    // hash 相同 → 实际未变更
    if (oldHash === newHash) return;

    this.localRuleHashes.set(absPath, newHash);

    const mt = fileMtime(absPath);
    const sourceMapping = getDeployedTargetSourceMapping(absPath);

    const entry: LogEntry = {
      timestamp: nowKST(),
      event_type: "local-rule-modified",
      machine: os.hostname(),
      path: absPath,
      local_hash: newHash,
      local_mtime: mt?.toISOString() ?? null,
      source_mapping: sourceMapping,
    };

    await this.appendLocalLog([entry]);
    await this.appendSharedOutbox([entry], this.settings.localRuleReportOutboxPath);

    new Notice(`Local rule changed: ${path.basename(absPath)}`);
  }

  // ── JSONL 日志: 本地 ──

  private async appendLocalLog(entries: LogEntry[]): Promise<void> {
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const logPath = this.settings.ruleSyncLogPath;

    try {
      const existing = await this.app.vault.adapter.read(logPath);
      await this.app.vault.adapter.write(logPath, existing + lines);
    } catch {
      const dir = path.dirname(logPath);
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) await this.app.vault.adapter.mkdir(dir);
      await this.app.vault.adapter.write(logPath, lines);
    }
  }

  // ── JSONL 日志: 共享 outbox ──

  private async appendSharedOutbox(entries: LogEntry[], outboxPath: string): Promise<void> {
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

    try {
      const existing = await this.app.vault.adapter.read(outboxPath);
      await this.app.vault.adapter.write(outboxPath, existing + lines);
    } catch {
      const dir = path.dirname(outboxPath);
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) await this.app.vault.adapter.mkdir(dir);
      await this.app.vault.adapter.write(outboxPath, lines);
    }
  }

  // ── Watch 目标路径判定（vault 内 source） ──
  // 一级: 仅 watch output 生成实际使用的 atoms。
  // profiles/*.md、global_policy_index.md 在一级中不反映到 output，因此不 watch。
  // 二级实现动态 profile 读取时在此处添加。

  isSourceWatchTarget(filePath: string): boolean {
    return filePath.startsWith(this.settings.ruleSyncAtomsPath);
  }
}
