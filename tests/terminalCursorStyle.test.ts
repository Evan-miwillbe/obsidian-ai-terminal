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
  /\.ai-terminal-xterm\.is-user-focused \.xterm \.xterm-cursor,[\s\S]*\.ai-terminal-xterm\.is-user-focused \.xterm-rows span\.xterm-bg-257\.xterm-fg-257[\s\S]*background-color:\s*var\(--interactive-accent\)\s*!important[\s\S]*animation:\s*none\s*!important/,
  "focused terminal cursor should be solid purple and not blink, including Claude's reverse-video cursor",
);

assert.match(
  styles,
  /\.ai-terminal-xterm:not\(\.is-user-focused\) \.xterm \.xterm-cursor,[\s\S]*\.ai-terminal-xterm:not\(\.is-user-focused\) \.xterm \.xterm-cursor\.xterm-cursor-block,[\s\S]*\.ai-terminal-xterm:not\(\.is-user-focused\) \.xterm-rows span\.xterm-bg-257\.xterm-fg-257[\s\S]*outline:\s*1px solid var\(--interactive-accent\)\s*!important[\s\S]*animation:\s*ai-terminal-cursor-fill-pulse/,
  "unfocused terminal cursor should keep a fixed purple outline while the fill pulses, including Claude's reverse-video cursor",
);

assert.match(
  styles,
  /@keyframes ai-terminal-cursor-fill-pulse[\s\S]*box-shadow:\s*inset 0 0 0 999px transparent[\s\S]*color-mix\(in srgb, var\(--interactive-accent\) 55%, transparent\)/,
  "unfocused cursor blinking should pulse only the inner fill while the outline stays visible",
);

assert.doesNotMatch(
  styles,
  /ai-terminal-cursor-block-blink|ai-terminal-cursor-empty-fill|ai-terminal-cursor-outline-blink|focus-within[\s\S]*xterm-cursor/,
  "cursor styling should not use the old fake block animation, outline visibility blink, or raw xterm focus state",
);

console.log("terminalCursorStyle tests passed");
