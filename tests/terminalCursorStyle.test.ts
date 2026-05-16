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
  /\.ai-terminal-xterm \.xterm\.focus \.xterm-cursor\.xterm-cursor-blink\.xterm-cursor-block[\s\S]*animation:\s*ai-terminal-cursor-block-blink/,
  "focused block cursor should blink with the AI Terminal purple cursor animation",
);

assert.match(
  styles,
  /@keyframes ai-terminal-cursor-block-blink[\s\S]*background-color:\s*var\(--interactive-accent\)[\s\S]*outline:\s*1px solid var\(--interactive-accent\)/,
  "cursor blink should alternate between purple solid and purple outline",
);

assert.match(
  styles,
  /box-shadow:\s*inset 0 0 0 999px var\(--ai-terminal-cursor-empty-fill/,
  "outline phase should cover the solid cursor fill with the terminal background",
);

console.log("terminalCursorStyle tests passed");
