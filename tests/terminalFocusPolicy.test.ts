import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/TerminalView.ts", "utf8");

function methodBlock(name: string, nextMarker: string): string {
  const start = source.indexOf(`private ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${name} should have a stable end marker`);
  return source.slice(start, end);
}

const activateTerminal = methodBlock("activateTerminal", "\n  addTab(");
assert.doesNotMatch(activateTerminal, /focusTerminal/, "opening a terminal should not permanently focus xterm");
assert.match(activateTerminal, /primeTerminalRender/, "opening a terminal should prime xterm rendering before leaving it hollow");
assert.match(
  activateTerminal,
  /this\.fitTab\(tab\);[\s\S]*tab\.pty\.start\(\);/,
  "terminal should fit to the visible pane before starting PTY so PowerShell receives the real column count",
);

const showTabInMain = methodBlock("showTabInMain", "\n  private splitOutTab");
assert.doesNotMatch(showTabInMain, /focusTerminal/, "switching tabs should not permanently focus xterm");
assert.match(showTabInMain, /primeTerminalRender/, "switching tabs should prime xterm rendering before leaving it hollow");
assert.match(showTabInMain, /clearUserFocusedTabs/, "switching terminal tabs should return the cursor to the slow hollow state until the user clicks the terminal");

const primeTerminalRender = methodBlock("primeTerminalRender", "\n  /** Create terminal infrastructure");
assert.doesNotMatch(primeTerminalRender, /tab\.terminal\.focus\(\)/, "render priming should not create a focus flicker when returning to Claude Code");
assert.match(primeTerminalRender, /tab\.terminal\.refresh/, "render priming should repaint xterm without focusing it");
assert.match(primeTerminalRender, /tab\.terminal\.blur\(\)/, "render priming should leave the cursor hollow");
assert.match(primeTerminalRender, /activeEl === textarea/, "render priming should not blur a terminal the user already clicked");
assert.match(primeTerminalRender, /is-user-focused/, "render priming should only preserve textarea focus after an explicit terminal click");
assert.match(primeTerminalRender, /document\.querySelector\("\.modal"\)/, "render priming should not steal focus while a modal is open");

const createTerminalInstance = methodBlock("createTerminalInstance", "\n  /** Start PTY");
assert.match(createTerminalInstance, /mousedown[\s\S]*setUserFocusedTab/, "only an explicit mouse click inside xterm should switch to the solid cursor state");
assert.match(createTerminalInstance, /focusout[\s\S]*setUserFocusedTab/, "leaving xterm should switch back to the slow hollow cursor state");
assert.match(createTerminalInstance, /--ai-terminal-cursor-empty-fill/, "the cursor overlay should mask native black cursor flashes with the terminal background");
assert.match(createTerminalInstance, /terminal\.onCursorMove[\s\S]*syncCursorOverlayNow/, "cursor overlay should immediately follow xterm's real cursor position");
assert.match(createTerminalInstance, /terminal\.onRender[\s\S]*scheduleCursorOverlaySync/, "cursor overlay should be resynced after xterm redraws Claude Code");
const dataHandler = /pty\.on\("data",\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\);/.exec(createTerminalInstance)?.[0] ?? "";
assert.match(dataHandler, /scheduleTerminalRenderPrime/, "PTY output should prime rendering after text arrives");
assert.match(dataHandler, /scheduleCursorOverlaySync/, "PTY output should keep the cursor overlay aligned with Claude Code redraws");

assert.match(source, /active-leaf-change[\s\S]*clearUserFocusedTabs/, "returning from another Obsidian tab should not leave Claude Code in solid cursor mode");
assert.match(source, /ensureCursorOverlay/, "the visible terminal cursor should be owned by a stable overlay rather than Claude Code's blinking reverse-video cell");
assert.match(source, /cancelAnimationFrame\(tab\.cursorFrameId\)/, "immediate cursor sync should cancel a pending frame so Claude Code cannot expose a stale black cursor between frames");
assert.doesNotMatch(source, /new MutationObserver|ai-terminal-claude-cursor-cell|includes\("\\u276f"\)/, "cursor handling should not depend on a specific Claude prompt glyph or mutate xterm rows");

console.log("terminalFocusPolicy tests passed");
