import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const styles = readFileSync("styles.css", "utf8");
const terminalChromeSelectors = [
  ".ai-terminal-tab-item",
  ".ai-terminal-tab-close",
  ".ai-terminal-tab-rename",
  ".ai-terminal-tab-copy",
  ".ai-terminal-split-copy",
  ".ai-terminal-split-restore",
  ".ai-terminal-tab-add",
  ".ai-terminal-split-close",
  '.ai-terminal-tab-item[draggable="true"]',
  '.ai-terminal-tab-item[draggable="true"]:active',
];

function declarationFor(selector: string): string {
  const blocks = styles.matchAll(/([^{}]+)\{([^}]*)\}/g);
  for (const block of blocks) {
    const selectors = block[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      return block[2];
    }
  }

  return "";
}

for (const selector of terminalChromeSelectors) {
  const declaration = declarationFor(selector);

  assert.ok(declaration, `${selector} should exist in styles.css`);
  assert.doesNotMatch(declaration, /cursor:\s*(pointer|grab|grabbing)\b/, `${selector} should keep the normal terminal cursor`);
}

console.log("terminalChromeCursor tests passed");
