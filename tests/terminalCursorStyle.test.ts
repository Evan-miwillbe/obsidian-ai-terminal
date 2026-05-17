import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const styles = readFileSync("styles.css", "utf8");

assert.match(
  styles,
  /\.xterm \.xterm-helper-textarea[\s\S]*caret-color:\s*transparent\s*!important/,
  "xterm's hidden textarea caret should not leak as a black native cursor",
);

assert.match(
  styles,
  /\.ai-terminal-xterm \.xterm \.xterm-cursor[\s\S]*opacity:\s*0\s*!important[\s\S]*animation:\s*none\s*!important/,
  "xterm's native cursor should be hidden so the plugin cursor overlay controls the visible cursor",
);

assert.match(
  styles,
  /\.ai-terminal-cursor-overlay[\s\S]*border:\s*1px solid var\(--interactive-accent\)[\s\S]*background-color:\s*var\(--ai-terminal-cursor-empty-fill, var\(--background-primary\)\)/,
  "terminal cursor overlay should keep a fixed purple frame and mask the fast native cursor underneath",
);

assert.match(
  styles,
  /\.ai-terminal-cursor-overlay::after[\s\S]*animation:\s*ai-terminal-cursor-fill-pulse 1\.15s ease-in-out infinite/,
  "unfocused terminal cursor should pulse only the overlay's inner fill",
);

assert.match(
  styles,
  /\.ai-terminal-xterm\.is-user-focused \.ai-terminal-cursor-overlay[\s\S]*background-color:\s*var\(--interactive-accent\)[\s\S]*\.ai-terminal-xterm\.is-user-focused \.ai-terminal-cursor-overlay::after[\s\S]*animation:\s*none/,
  "focused terminal cursor should be solid purple and not blink",
);

assert.match(
  styles,
  /@keyframes ai-terminal-cursor-fill-pulse[\s\S]*0%, 100%\s*\{\s*opacity:\s*0;[\s\S]*50%\s*\{\s*opacity:\s*0\.55;/,
  "unfocused cursor blinking should pulse only the inner fill while the outline stays visible",
);

assert.doesNotMatch(
  styles,
  /ai-terminal-cursor-block-blink|ai-terminal-cursor-outline-blink|focus-within[\s\S]*xterm-cursor|xterm-rows span\.xterm-bg-257/,
  "cursor styling should not use the old fake block animation, outline visibility blink, raw xterm focus state, or Claude-specific reverse-video spans",
);

console.log("terminalCursorStyle tests passed");
