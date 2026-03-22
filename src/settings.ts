import { App, PluginSettingTab, Setting } from "obsidian";
import type AITerminalPlugin from "./main";
import { DEFAULT_PRESETS } from "./presets";

export interface Preset {
  name: string;
  command: string;
  icon: string;
}

export interface AITerminalSettings {
  defaultShell: string;
  defaultCwd: string;
  fontSize: number;
  fontFamily: string;
  presets: Preset[];
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
