import type { Preset } from "./settings";

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
