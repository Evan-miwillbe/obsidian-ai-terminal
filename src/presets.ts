import type { Preset } from "./Settings";

export const DEFAULT_PRESETS: Preset[] = [
  {
    name: "Shell",
    command: "",
    icon: "terminal",
  },
  {
    name: "Claude Code",
    command: "claude",
    icon: "bot",
  },
  {
    name: "Gemini CLI",
    command: "gemini",
    icon: "sparkles",
  },
];
