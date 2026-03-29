import { Plugin, Notice, debounce } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import { AITerminalSettings, AITerminalSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { Preset } from "./settings";
import { dumpVaultIndex } from "./vaultIndexer";
import { Scheduler } from "./scheduler";
import * as path from "path";

export default class AITerminalPlugin extends Plugin {
  settings: AITerminalSettings = DEFAULT_SETTINGS;
  scheduler: Scheduler | null = null;

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

  onunload(): void {
    this.scheduler?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
  }

  private setupScheduler(): void {
    if (!this.settings.schedulerEnabled) return;

    this.scheduler = new Scheduler(
      this.app,
      this.pluginDir,
      this.settings.dailyNotePath,
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
