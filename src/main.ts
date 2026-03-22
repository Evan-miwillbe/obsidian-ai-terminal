import { Plugin, normalizePath } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import { AITerminalSettings, AITerminalSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { Preset } from "./settings";
import * as path from "path";

export default class AITerminalPlugin extends Plugin {
  settings: AITerminalSettings = DEFAULT_SETTINGS;

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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
