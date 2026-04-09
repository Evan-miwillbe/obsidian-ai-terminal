import { Plugin, Notice, TFile, debounce } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import { SchemaMapView, VIEW_TYPE_SCHEMA_MAP } from "./SchemaMapView";
import { RoadmapView, VIEW_TYPE_ROADMAP } from "./RoadmapView";
import { AITerminalSettings, AITerminalSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { Preset } from "./settings";
import { dumpVaultIndex } from "./vaultIndexer";
import { Scheduler } from "./scheduler";
import { RuleSync } from "./ruleSync";
import { DeployRegistryManager } from "./deployRegistry";
import { writeSyncScript } from "./contextSync";
import { OtModal } from "./otCommand";
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
  scheduler: Scheduler | null = null;
  ruleSync: RuleSync | null = null;
  deployRegistry: DeployRegistryManager | null = null;

  private get pluginDir(): string {
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    return path.join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal");
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // 터미널 뷰 등록
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      const preset = (leaf as any)._aiTerminalPreset as Preset | null || null;
      return new TerminalView(leaf, this.settings, this.pluginDir, preset);
    });

    // 기본 터미널 열기 커맨드
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      callback: () => this.openTerminal(null),
    });

    // 프리셋별 커맨드 등록
    this.registerPresetCommands();

    // 설정 탭
    this.addSettingTab(new AITerminalSettingTab(this.app, this));

    // 리본 아이콘
    this.addRibbonIcon("terminal", "Open AI Terminal", () => {
      this.openTerminal(null);
    });

    // Vault Index 커맨드
    this.addCommand({
      id: "dump-vault-index",
      name: "Dump vault index to JSON",
      callback: async () => {
        await dumpVaultIndex(this.app, this.settings.vaultIndexPath);
        new Notice("Vault index saved");
      },
    });

    // 자동 Vault Index 덤프
    this.setupVaultIndexAutoSync();

    // Rule Sync
    this.setupRuleSync();

    // Schema Map
    this.setupSchemaMap();

    // 로드맵 뷰
    this.setupRoadmap();

    // 스케줄러
    this.setupScheduler();

    // 스케줄러 커맨드
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

    // Rule Sync 커맨드
    this.addCommand({
      id: "force-sync-rules",
      name: "Force sync all rules",
      callback: async () => {
        if (!this.ruleSync) {
          new Notice("Rule Sync is disabled");
          return;
        }
        new Notice("Rule Sync: 강제 동기화 시작...");
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
        new Notice(`Claude rules: ${deployed.length}개 배포`);
      },
    });

    // Context Sync 커맨드
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

    // ── 볼트 쿼리 커맨드 ──

    this.addCommand({
      id: "vault-search",
      name: "Search vault (/search)",
      callback: () => {
        const input = window.prompt("검색어 (tag:태그 또는 키워드):");
        if (!input) return;
        const result = searchVault(this.app, input.trim());
        const output = formatQueryResult(result);
        if (!this.writeToActiveTerminal(output)) {
          new Notice(
            result.results.length > 0
              ? result.results.map((r) => r.name).join("\n")
              : "검색 결과 없음",
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
                : "백링크 없음",
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
                : "링크 없음",
              10_000,
            );
          }
        }).open();
      },
    });

    // /ot 커맨드 — 자연어 스케줄 등록
    this.addCommand({
      id: "ot-schedule",
      name: "Register schedule with natural language (/ot)",
      callback: () => {
        if (!this.scheduler) {
          // scheduler가 비활성이면 임시 생성
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
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    // 프리셋 정보를 leaf에 임시 저장
    (leaf as any)._aiTerminalPreset = preset;

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  /** 활성 터미널 뷰의 xterm에 텍스트 출력 */
  private writeToActiveTerminal(text: string): boolean {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (leaves.length === 0) return false;
    const view = leaves[0].view as TerminalView;
    view.writeOutput(text);
    return true;
  }

  onunload(): void {
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

  private setupVaultIndexAutoSync(): void {
    if (!this.settings.vaultIndexEnabled) return;

    const debouncedDump = debounce(
      () => dumpVaultIndex(this.app, this.settings.vaultIndexPath),
      5000,
      true
    );

    // 캐시 완전 로드 후 최초 덤프
    this.app.metadataCache.on("resolved", () => {
      dumpVaultIndex(this.app, this.settings.vaultIndexPath);
    });

    // 파일 변경 시 디바운스 덤프
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
