import { App, PluginSettingTab, Setting } from "obsidian";
import type AITerminalPlugin from "./main";
import { DEFAULT_PRESETS } from "./presets";
import { DEFAULT_RULE_SYNC_SETTINGS, type RuleSyncSettings } from "./ruleSync";

export interface Preset {
  name: string;
  command: string;
  icon: string;
}

export interface AITerminalSettings extends RuleSyncSettings {
  defaultShell: string;
  defaultCwd: string;
  fontSize: number;
  fontFamily: string;
  presets: Preset[];
  vaultIndexEnabled: boolean;
  vaultIndexPath: string;
  schedulerEnabled: boolean;
  schedulerPollMs: number;
  dailyNotePath: string;
}

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

export const DEFAULT_SETTINGS: AITerminalSettings = {
  defaultShell: getDefaultShell(),
  defaultCwd: "",
  fontSize: 14,
  fontFamily: "'MesloLGS NF', Menlo, Monaco, 'Courier New', monospace",
  presets: DEFAULT_PRESETS,
  vaultIndexEnabled: false,
  vaultIndexPath: ".obsidian/plugins/obsidian-ai-terminal/vault-index.json",
  schedulerEnabled: false,
  schedulerPollMs: 60_000,
  dailyNotePath: "00_Area/01_시간축/일일_노트",
  ...DEFAULT_RULE_SYNC_SETTINGS,
};

export class AITerminalSettingTab extends PluginSettingTab {
  plugin: AITerminalPlugin;

  constructor(app: App, plugin: AITerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Terminal Settings" });

    const shellHint = process.platform === "win32"
      ? "e.g. powershell.exe, cmd.exe, pwsh.exe, wsl.exe"
      : "e.g. /bin/zsh, /bin/bash";

    new Setting(containerEl)
      .setName("Default shell")
      .setDesc(`Shell to use when opening a terminal (${shellHint})`)
      .addText((text) =>
        text
          .setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.defaultShell)
          .onChange(async (value) => {
            this.plugin.settings.defaultShell = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Default working directory (empty = vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Vault root")
          .setValue(this.plugin.settings.defaultCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultCwd = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider
          .setLimits(10, 24, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font family")
      .setDesc("Terminal font family (CSS format)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.fontFamily)
          .onChange(async (value) => {
            this.plugin.settings.fontFamily = value;
            await this.plugin.saveSettings();
          })
      );

    // Vault Index 섹션
    containerEl.createEl("h3", { text: "Vault Index" });

    new Setting(containerEl)
      .setName("Enable vault index")
      .setDesc("Automatically dump vault metadata (backlinks, tags, frontmatter) to a JSON file for AI tools")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.vaultIndexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.vaultIndexEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault index path")
      .setDesc("Output path for vault-index.json (relative to vault root)")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/obsidian-ai-terminal/vault-index.json")
          .setValue(this.plugin.settings.vaultIndexPath)
          .onChange(async (value) => {
            this.plugin.settings.vaultIndexPath = value;
            await this.plugin.saveSettings();
          })
      );

    // Scheduler 섹션
    containerEl.createEl("h3", { text: "Scheduler" });

    new Setting(containerEl)
      .setName("Enable scheduler")
      .setDesc("Run scheduled tasks via claude -p headless mode (requires restart)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.schedulerEnabled)
          .onChange(async (value) => {
            this.plugin.settings.schedulerEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often to check for due schedules")
      .addSlider((slider) =>
        slider
          .setLimits(30, 300, 30)
          .setValue(this.plugin.settings.schedulerPollMs / 1000)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.schedulerPollMs = value * 1000;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Daily note path")
      .setDesc("Folder for daily notes (relative to vault root)")
      .addText((text) =>
        text
          .setPlaceholder("00_Area/01_시간축/일일_노트")
          .setValue(this.plugin.settings.dailyNotePath)
          .onChange(async (value) => {
            this.plugin.settings.dailyNotePath = value;
            await this.plugin.saveSettings();
          })
      );

    // Rule Sync 섹션
    containerEl.createEl("h3", { text: "Rule Sync (Harness)" });

    new Setting(containerEl)
      .setName("Enable rule sync")
      .setDesc("Watch harness atoms and auto-deploy to ~/.claude/rules/, ~/.gemini.md")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ruleSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Atoms path")
      .setDesc("Vault-relative path to rule atoms")
      .addText((text) =>
        text
          .setPlaceholder("0_harness/factory/atoms/rules")
          .setValue(this.plugin.settings.ruleSyncAtomsPath)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncAtomsPath = value;
            await this.plugin.saveSettings();
          })
      );

    // Profiles path, Global policy index path:
    // 1차에서는 PROFILE_MATRIX 하드코딩 사용. output 생성에 반영하지 않으므로 UI 미노출.
    // 2차에서 동적 profile 읽기 구현 시 UI 추가한다.
    // settings 타입에는 유지하여 2차 전환 시 호환성 보장.

    new Setting(containerEl)
      .setName("Local sync log path")
      .setDesc("JSONL local log (vault-relative)")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/obsidian-ai-terminal/rule-sync-log.jsonl")
          .setValue(this.plugin.settings.ruleSyncLogPath)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncLogPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Shared report outbox")
      .setDesc("JSONL shared outbox for Harness-factory (vault-relative)")
      .addText((text) =>
        text
          .setPlaceholder("0_harness/factory/data/rule_reports/pc2.jsonl")
          .setValue(this.plugin.settings.ruleReportOutboxPath)
          .onChange(async (value) => {
            this.plugin.settings.ruleReportOutboxPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Delay before syncing after file change")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 30000, 1000)
          .setValue(this.plugin.settings.ruleSyncDebounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncDebounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Claude global")
      .setDesc("Sync ~/.claude/CLAUDE.md")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ruleSyncTargets.claudeGlobal)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncTargets.claudeGlobal = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Claude profiles")
      .setDesc("Sync ~/.claude/rules/{profile}.md")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ruleSyncTargets.claudeProfiles)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncTargets.claudeProfiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gemini global")
      .setDesc("Sync ~/.gemini.md")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ruleSyncTargets.geminiGlobal)
          .onChange(async (value) => {
            this.plugin.settings.ruleSyncTargets.geminiGlobal = value;
            await this.plugin.saveSettings();
          })
      );

    // Local Rule Watch 섹션
    containerEl.createEl("h3", { text: "Local Rule Watch" });

    new Setting(containerEl)
      .setName("Enable local rule watch")
      .setDesc("Detect changes to local LLM rule/prompt/config files and report to outbox")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.localRuleWatchEnabled)
          .onChange(async (value) => {
            this.plugin.settings.localRuleWatchEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Watch paths")
      .setDesc("Absolute paths to watch (one per line, ~ allowed)")
      .addTextArea((text) =>
        text
          .setPlaceholder("~/.claude/rules\n~/.gemini.md")
          .setValue(this.plugin.settings.localRuleWatchPaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.localRuleWatchPaths = value
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Local rule report outbox")
      .setDesc("JSONL outbox for local rule change events (vault-relative)")
      .addText((text) =>
        text
          .setPlaceholder("0_harness/factory/data/rule_reports/pc2.jsonl")
          .setValue(this.plugin.settings.localRuleReportOutboxPath)
          .onChange(async (value) => {
            this.plugin.settings.localRuleReportOutboxPath = value;
            await this.plugin.saveSettings();
          })
      );

    // 프리셋 섹션
    containerEl.createEl("h3", { text: "Presets" });

    this.plugin.settings.presets.forEach((preset, index) => {
      const s = new Setting(containerEl)
        .setName(preset.name)
        .setDesc(preset.command || "(default shell)")
        .addText((text) =>
          text
            .setPlaceholder("Name")
            .setValue(preset.name)
            .onChange(async (value) => {
              this.plugin.settings.presets[index].name = value;
              await this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder("Command")
            .setValue(preset.command)
            .onChange(async (value) => {
              this.plugin.settings.presets[index].command = value;
              await this.plugin.saveSettings();
            })
        );

      // 기본 Shell 프리셋은 삭제 불가
      if (index > 0) {
        s.addExtraButton((btn) =>
          btn.setIcon("trash").setTooltip("Delete preset").onClick(async () => {
            this.plugin.settings.presets.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }
    });

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Add preset").onClick(async () => {
        this.plugin.settings.presets.push({
          name: "New Preset",
          command: "",
          icon: "terminal",
        });
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
