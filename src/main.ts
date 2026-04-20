import { Plugin, Notice, TFile, debounce } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import { SchemaMapView, VIEW_TYPE_SCHEMA_MAP } from "./SchemaMapView";
import { RoadmapView, VIEW_TYPE_ROADMAP } from "./RoadmapView";
import { AITerminalSettings, AITerminalSettingTab, DEFAULT_SETTINGS } from "./Settings";
import type { Preset } from "./Settings";
import { dumpVaultIndex } from "./vaultIndexer";
import { Scheduler } from "./scheduler";
import { RuleSync } from "./ruleSync";
import { DeployRegistryManager } from "./deployRegistry";
import { writeSyncScript } from "./contextSync";
import { OtModal } from "./otCommand";
import { Watchdog } from "./watchdog";
import { ContextPipeServer, getPipePath } from "./contextPipeServer";
import { AcpLayer } from "./acpLayer";
import {
  searchVault,
  queryBacklinks,
  queryLinks,
  formatQueryResult,
  NoteSuggestModal,
} from "./vaultQuery";
import * as path from "path";

export default class AITerminalPlugin extends Plugin {
  settings: AITerminalSettings = DEFAULT_SETTINGS;
  static instance: AITerminalPlugin | null = null;
  scheduler: Scheduler | null = null;
  ruleSync: RuleSync | null = null;
  deployRegistry: DeployRegistryManager | null = null;
  watchdog: Watchdog | null = null;
  pipeServer: ContextPipeServer | null = null;
  acpLayer: AcpLayer | null = null;

  private get pluginDir(): string {
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    return path.join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal");
  }

  async onload(): Promise<void> {
    AITerminalPlugin.instance = this;
    await this.loadSettings();

    // 注册终端视图
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      const preset = (leaf as any)._aiTerminalPreset as Preset | null || null;
      return new TerminalView(leaf, this.settings, this.pluginDir, preset);
    });

    // 默认打开终端命令
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      callback: () => this.openTerminal(null),
    });

    // Copy active note's absolute path to clipboard
    this.addCommand({
      id: "copy-note-path",
      name: "Copy note path to clipboard",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note"); return; }
        const vaultPath = (this.app.vault.adapter as any).basePath as string;
        const absPath = vaultPath + "/" + file.path;
        navigator.clipboard.writeText(absPath).then(() => {
          new Notice(`Copied: ${absPath}`, 3000);
        });
      },
    });

    // 注册预设命令
    this.registerPresetCommands();

    // 设置面板
    this.addSettingTab(new AITerminalSettingTab(this.app, this));

    // 侧边栏图标
    this.addRibbonIcon("terminal", "Open AI Terminal", () => {
      this.openTerminal(null);
    });

    // Vault Index 命令
    this.addCommand({
      id: "dump-vault-index",
      name: "Dump vault index to JSON",
      callback: async () => {
        await dumpVaultIndex(this.app, this.settings.vaultIndexPath);
        new Notice("Vault index saved");
      },
    });

    // Watchdog + Context Pipe Server
    this.setupContextPipe();

    // 自动 Vault Index 导出
    this.setupVaultIndexAutoSync();

    // Rule Sync
    this.setupRuleSync();

    // Schema Map
    this.setupSchemaMap();

    // 路线图视图
    this.setupRoadmap();

    // 调度器
    this.setupScheduler();

    // 调度器命令
    this.addCommand({
      id: "list-schedules",
      name: "List schedules",
      callback: async () => {
        if (!this.scheduler) {
          new Notice("Scheduler is disabled");
          return;
        }
        await this.scheduler.load();
        const entries = this.scheduler.entries;
        if (entries.length === 0) {
          new Notice("No schedules registered");
          return;
        }
        const list = entries
          .map((e) => `${e.enabled ? "✓" : "✗"} ${e.name} [${e.cron}]`)
          .join("\n");
        new Notice(list, 10_000);
      },
    });

    this.addCommand({
      id: "run-schedule",
      name: "Run next enabled schedule now",
      callback: async () => {
        if (!this.scheduler) {
          new Notice("Scheduler is disabled");
          return;
        }
        await this.scheduler.load();
        const entry = this.scheduler.entries.find((e) => e.enabled);
        if (!entry) {
          new Notice("No enabled schedules");
          return;
        }
        new Notice(`Running "${entry.name}"...`);
        await this.scheduler.execute(entry);
      },
    });

    // Rule Sync 命令
    this.addCommand({
      id: "force-sync-rules",
      name: "Force sync all rules",
      callback: async () => {
        if (!this.ruleSync) {
          new Notice("Rule Sync is disabled");
          return;
        }
        new Notice("Rule Sync: 强制同步开始...");
        await this.ruleSync.syncAll(true);
      },
    });

    this.addCommand({
      id: "sync-claude-rules",
      name: "Sync Claude rules",
      callback: async () => {
        if (!this.ruleSync) {
          new Notice("Rule Sync is disabled");
          return;
        }
        const results = [];
        if (this.settings.ruleSyncTargets.claudeGlobal) {
          results.push(await this.ruleSync.syncClaudeGlobal());
        }
        if (this.settings.ruleSyncTargets.claudeProfiles) {
          results.push(...await this.ruleSync.syncClaudeProfiles());
        }
        const deployed = results.filter((r) => r.action === "auto-deploy" || r.action === "confirm-deploy");
        new Notice(`Claude rules: ${deployed.length} 条已部署`);
      },
    });

    // Context Sync 命令
    this.addCommand({
      id: "generate-sync-script",
      name: "Generate context sync script",
      callback: async () => {
        if (!this.settings.contextSyncEnabled) {
          new Notice("Context Sync is disabled — enable in settings first");
          return;
        }
        const scriptPath = await writeSyncScript(
          this.app,
          this.settings.hostName,
          this.settings.contextSources,
        );
        new Notice(`sync-context.sh generated:\n${scriptPath}`, 8_000);
      },
    });

    // ── Vault 查询命令 ──

    this.addCommand({
      id: "vault-search",
      name: "Search vault (/search)",
      callback: () => {
        const input = window.prompt("搜索词 (tag:标签 或 关键词):");
        if (!input) return;
        const result = searchVault(this.app, input.trim());
        const output = formatQueryResult(result);
        if (!this.writeToActiveTerminal(output)) {
          new Notice(
            result.results.length > 0
              ? result.results.map((r) => r.name).join("\n")
              : "无搜索结果",
            10_000,
          );
        }
      },
    });

    this.addCommand({
      id: "vault-backlinks",
      name: "Show backlinks (/backlinks)",
      callback: () => {
        new NoteSuggestModal(this.app, (file) => {
          const result = queryBacklinks(this.app, file.basename);
          const output = formatQueryResult(result);
          if (!this.writeToActiveTerminal(output)) {
            new Notice(
              result.results.length > 0
                ? `Backlinks: ${result.results.map((r) => r.name).join(", ")}`
                : "无反向链接",
              10_000,
            );
          }
        }).open();
      },
    });

    this.addCommand({
      id: "vault-links",
      name: "Show outgoing links (/links)",
      callback: () => {
        new NoteSuggestModal(this.app, (file) => {
          const result = queryLinks(this.app, file.basename);
          const output = formatQueryResult(result);
          if (!this.writeToActiveTerminal(output)) {
            new Notice(
              result.results.length > 0
                ? `Links: ${result.results.map((r) => r.name).join(", ")}`
                : "无链接",
              10_000,
            );
          }
        }).open();
      },
    });

    // ACP 代理调用命令
    this.addCommand({
      id: "acp-invoke-agent",
      name: "Invoke AI agent (ACP)",
      callback: async () => {
        if (!this.acpLayer) {
          new Notice("ACP 尚未初始化");
          return;
        }
        const agents = this.acpLayer.getAgents().filter((a) => a.available);
        if (agents.length === 0) {
          new Notice("没有可用的代理（请安装 claude、codex 或 gemini 之一）");
          return;
        }

        const agentNames = agents.map((a) => a.name).join(", ");
        const input = window.prompt(`发送给代理的提示词:\n（可用: ${agentNames}）`);
        if (!input) return;

        // 传递给第一个可用的代理
        const agent = agents[0];
        new Notice(`正在传递给 ${agent.name}...`);

        try {
          const result = await this.acpLayer.invoke(agent.id, input);
          if (result.status === "completed") {
            // 将结果输出到终端
            this.writeToActiveTerminal(
              `\r\n\x1b[36m[${agent.name}]\x1b[0m\r\n${result.result}\r\n`,
            );
            new Notice(`${agent.name} 完成`);
          } else {
            new Notice(`${agent.name} 失败: ${result.error}`);
          }
        } catch (err: any) {
          new Notice(`代理调用失败: ${err.message}`);
        }
      },
    });

    // /ot 命令 — 自然语言注册定时任务
    this.addCommand({
      id: "ot-schedule",
      name: "Register schedule with natural language (/ot)",
      callback: () => {
        if (!this.scheduler) {
          // 若调度器未启用则临时创建
          this.scheduler = new Scheduler(
            this.app,
            this.pluginDir,
            this.settings.dailyNotePath,
          );
        }
        new OtModal(this.app, this.scheduler).open();
      },
    });

    this.addCommand({
      id: "sync-gemini-rules",
      name: "Sync Gemini rules",
      callback: async () => {
        if (!this.ruleSync) {
          new Notice("Rule Sync is disabled");
          return;
        }
        const result = await this.ruleSync.syncGeminiGlobal();
        new Notice(`Gemini: ${result.action}`);
      },
    });
  }

  private registerPresetCommands(): void {
    this.settings.presets.forEach((preset) => {
      if (preset.command) {
        this.addCommand({
          id: `open-preset-${preset.name.toLowerCase().replace(/\s+/g, "-")}`,
          name: `Open ${preset.name}`,
          callback: () => this.openTerminal(preset),
        });
      }
    });
  }

  async openTerminal(preset: Preset | null): Promise<void> {
    // Reuse existing terminal leaf, or create one if none exists
    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    const isNewLeaf = existingLeaves.length === 0;

    let leaf = existingLeaves[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
    }
    if (!leaf) return;

    if (isNewLeaf) {
      (leaf as any)._aiTerminalPreset = preset;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active: true,
    });

    if (isNewLeaf) {
      delete (leaf as any)._aiTerminalPreset;
    }

    this.app.workspace.revealLeaf(leaf);

    // Only add a tab if the view already existed (new views call addTab in onOpen)
    if (!isNewLeaf) {
      const view = leaf.view as TerminalView;
      if (view && view instanceof TerminalView) {
        view.addTab(preset);
      }
    }
  }

  /** 向活动终端视图的 xterm 输出文本 */
  private writeToActiveTerminal(text: string): boolean {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (leaves.length === 0) return false;
    const view = leaves[0].view as TerminalView;
    view.writeOutput(text);
    return true;
  }

  onunload(): void {
    this.pipeServer?.stop();
    this.scheduler?.stop();
    this.ruleSync?.stopLocalRuleWatch();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SCHEMA_MAP);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ROADMAP);
  }

  private setupSchemaMap(): void {
    if (!this.settings.schemaMapEnabled) return;

    this.deployRegistry = new DeployRegistryManager(
      this.app,
      this.settings.deployRegistryPath,
    );

    this.registerView(VIEW_TYPE_SCHEMA_MAP, (leaf) => {
      return new SchemaMapView(leaf, this.settings, this.deployRegistry!);
    });

    this.addCommand({
      id: "open-schema-map",
      name: "Open Schema Map",
      callback: () => this.openSchemaMap(),
    });

    this.addRibbonIcon("map", "Open Schema Map", () => {
      this.openSchemaMap();
    });
  }

  private setupRoadmap(): void {
    this.registerView(VIEW_TYPE_ROADMAP, (leaf) => {
      return new RoadmapView(leaf, this.settings);
    });

    this.addCommand({
      id: "open-roadmap",
      name: "Open Roadmap",
      callback: () => this.openRoadmap(),
    });
  }

  async openRoadmap(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_ROADMAP, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openSchemaMap(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({
      type: VIEW_TYPE_SCHEMA_MAP,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  private setupRuleSync(): void {
    if (!this.settings.ruleSyncEnabled && !this.settings.localRuleWatchEnabled) return;

    this.ruleSync = new RuleSync(this.app, this.settings);

    // vault source watcher (harness atoms, profiles, global index)
    if (this.settings.ruleSyncEnabled) {
      const debouncedSync = debounce(
        () => {
          if (this.ruleSync) this.ruleSync.syncAll();
        },
        this.settings.ruleSyncDebounceMs,
        true,
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && this.ruleSync?.isSourceWatchTarget(file.path)) {
            debouncedSync();
          }
        }),
      );
    }

    // local LLM rule watcher (filesystem paths outside vault)
    if (this.settings.localRuleWatchEnabled) {
      this.ruleSync.startLocalRuleWatch();
    }
  }

  private setupScheduler(): void {
    if (!this.settings.schedulerEnabled) return;

    this.scheduler = new Scheduler(
      this.app,
      this.pluginDir,
      this.settings.dailyNotePath,
      this.settings.hostName,
    );
    this.scheduler.start(this.settings.schedulerPollMs);
  }

  private setupContextPipe(): void {
    // Watchdog: Vault 变更检测 + 上下文索引
    this.watchdog = new Watchdog(this.app);

    // 活动笔记变更追踪
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const file = leaf?.view?.getState?.()?.file;
        this.watchdog?.setActiveNote(file || null);
      }),
    );

    // 文件变更时刷新索引（防抖）
    const debouncedRebuild = debounce(() => this.watchdog?.rebuild(), 2000, true);
    this.registerEvent(
      this.app.metadataCache.on("changed", () => debouncedRebuild()),
    );

    // 初始构建
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.watchdog?.rebuild();
      }),
    );

    // ACP Layer
    this.acpLayer = new AcpLayer(this.app, this.watchdog);
    this.acpLayer.checkAvailability(); // 异步，后台执行

    // 启动 Named Pipe Server
    this.pipeServer = new ContextPipeServer(this.watchdog, this.app);
    this.pipeServer.setAcpLayer(this.acpLayer);
    this.pipeServer.setTerminalViewGetter(() => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
      return leaves.length > 0 ? (leaves[0].view as TerminalView) : null;
    });
    try {
      this.pipeServer.start();
    } catch (err) {
      console.error("Context Pipe Server 启动失败:", err);
    }
  }

  private setupVaultIndexAutoSync(): void {
    if (!this.settings.vaultIndexEnabled) return;

    const debouncedDump = debounce(
      () => dumpVaultIndex(this.app, this.settings.vaultIndexPath),
      5000,
      true
    );

    // 缓存完全加载后首次导出
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        dumpVaultIndex(this.app, this.settings.vaultIndexPath);
      }),
    );

    // 文件变更时防抖导出
    this.registerEvent(
      this.app.metadataCache.on("changed", () => debouncedDump())
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
