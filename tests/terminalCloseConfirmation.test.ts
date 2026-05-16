import assert from "node:assert/strict";
import {
  getTerminalCloseConfirmation,
  shouldCloseTerminalTab,
} from "../src/terminalCloseConfirmation";

const content = getTerminalCloseConfirmation("Claude Code");

assert.equal(content.title, "Close terminal?");
assert.equal(content.confirmLabel, "Close");
assert.equal(content.cancelLabel, "Cancel");
assert.match(content.message, /Claude Code/);
assert.match(content.message, /running process/);

assert.equal(
  shouldCloseTerminalTab(false),
  false,
  "canceling the confirmation should keep the terminal tab open",
);

assert.equal(
  shouldCloseTerminalTab(true),
  true,
  "confirming the modal should close the terminal tab",
);

console.log("terminalCloseConfirmation tests passed");
