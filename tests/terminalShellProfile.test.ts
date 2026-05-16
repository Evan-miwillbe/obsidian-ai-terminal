import assert from "node:assert/strict";
import { withInteractiveShellProfile } from "../src/terminalShellProfile";

{
  const shell = withInteractiveShellProfile("powershell.exe", "win32");

  assert.match(shell, /^powershell\.exe -NoLogo -NoExit -EncodedCommand /);
  assert.ok(shell.length > "powershell.exe".length, "PowerShell should receive the short prompt profile");
}

{
  const shell = withInteractiveShellProfile("pwsh.exe", "win32");

  assert.match(shell, /^pwsh\.exe -NoLogo -NoExit -EncodedCommand /);
}

{
  const shell = withInteractiveShellProfile("powershell.exe -NoProfile", "win32");

  assert.equal(shell, "powershell.exe -NoProfile", "custom shell arguments should be left alone");
}

{
  const shell = withInteractiveShellProfile("/bin/zsh", "darwin");

  assert.equal(shell, "/bin/zsh", "non-Windows shells should be left alone");
}

console.log("terminalShellProfile tests passed");
