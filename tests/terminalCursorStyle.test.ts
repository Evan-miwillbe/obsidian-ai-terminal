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
  /\.ai-terminal-cursor-overlay::after[\s\S]*animation:\s*ai-terminal-cursor-fill-blink 1\.05s steps\(1, end\) infinite/,
  "unfocused terminal cursor should blink the overlay's solid inner fill without pulsing",
);

assert.match(
  styles,
  /\.ai-terminal-xterm\.is-user-focused \.ai-terminal-cursor-overlay[\s\S]*background-color:\s*var\(--interactive-accent\)[\s\S]*\.ai-terminal-xterm\.is-user-focused \.ai-terminal-cursor-overlay::after[\s\S]*animation:\s*none/,
  "focused terminal cursor should be solid purple and not blink",
);

assert.match(
  styles,
  /@keyframes ai-terminal-cursor-fill-blink[\s\S]*0%, 49%\s*\{\s*opacity:\s*0;[\s\S]*50%, 100%\s*\{\s*opacity:\s*1;/,
  "unfocused cursor blinking should switch the inner fill between transparent and solid while the outline stays visible",
);

assert.doesNotMatch(
  styles,
  /ai-terminal-cursor-block-blink|ai-terminal-cursor-outline-blink|ai-terminal-cursor-fill-pulse|focus-within[\s\S]*xterm-cursor|xterm-rows span\.xterm-bg-257/,
  "cursor styling should not use the old fake block animation, pulse animation, outline visibility blink, raw xterm focus state, or Claude-specific reverse-video spans",
);

console.log("terminalCursorStyle tests passed");
