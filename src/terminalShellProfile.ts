const POWERSHELL_SHORT_PROMPT =
  "ZgB1AG4AYwB0AGkAbwBuACAAcAByAG8AbQBwAHQAIAB7ACAAJwBQAFMAPgAgACcAIAB9AA==";

function hasArguments(shell: string): boolean {
  const trimmed = shell.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    return closingQuote === -1 || trimmed.slice(closingQuote + 1).trim().length > 0;
  }

  return /\s/.test(trimmed);
}

function shellBasename(shell: string): string {
  const unquoted = shell.trim().replace(/^"|"$/g, "");
  return unquoted.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

export function withInteractiveShellProfile(
  shell: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = shell.trim();
  if (platform !== "win32" || !trimmed || hasArguments(trimmed)) {
    return shell;
  }

  const basename = shellBasename(trimmed);
  if (basename !== "powershell.exe" && basename !== "powershell" && basename !== "pwsh.exe" && basename !== "pwsh") {
    return shell;
  }

  return `${trimmed} -NoLogo -NoExit -EncodedCommand ${POWERSHELL_SHORT_PROMPT}`;
}
