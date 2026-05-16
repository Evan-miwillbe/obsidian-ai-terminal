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

const showTabInMain = methodBlock("showTabInMain", "\n  private splitOutTab");
assert.doesNotMatch(showTabInMain, /focusTerminal/, "switching tabs should not permanently focus xterm");
assert.match(showTabInMain, /primeTerminalRender/, "switching tabs should prime xterm rendering before leaving it hollow");

const primeTerminalRender = methodBlock("primeTerminalRender", "\n  /** Create terminal infrastructure");
assert.match(primeTerminalRender, /tab\.terminal\.focus\(\)/, "render priming should wake xterm's renderer");
assert.match(primeTerminalRender, /tab\.terminal\.blur\(\)/, "render priming should leave the cursor hollow");
assert.match(primeTerminalRender, /activeEl === textarea/, "render priming should not blur a terminal the user already clicked");
assert.match(primeTerminalRender, /document\.querySelector\("\.modal"\)/, "render priming should not steal focus while a modal is open");

const createTerminalInstance = methodBlock("createTerminalInstance", "\n  /** Start PTY");
const dataHandler = /pty\.on\("data",\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\);/.exec(createTerminalInstance)?.[0] ?? "";
assert.match(dataHandler, /scheduleTerminalRenderPrime/, "PTY output should prime rendering after text arrives");

console.log("terminalFocusPolicy tests passed");
