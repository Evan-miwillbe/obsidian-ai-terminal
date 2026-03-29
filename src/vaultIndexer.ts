import { App, TFile } from "obsidian";

export interface VaultIndex {
  generated: string;
  noteCount: number;
  notes: Record<string, NoteEntry>;
  backlinks: Record<string, string[]>;
  tags: Record<string, string[]>;
}

interface NoteEntry {
  path: string;
  frontmatter: Record<string, any> | null;
  tags: string[];
  links: string[];
  headings: { level: number; text: string }[];
  aliases: string[];
}

export function buildVaultIndex(app: App): VaultIndex {
  const notes: Record<string, NoteEntry> = {};
  const tagsMap: Record<string, Set<string>> = {};
  const backlinks: Record<string, Set<string>> = {};

  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    const name = file.basename;
    const cache = app.metadataCache.getFileCache(file);

    // frontmatter
    const fm = cache?.frontmatter ?? null;

    // tags: frontmatter tags + inline tags
    const fileTags: string[] = [];
    if (fm?.tags) {
      const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      fileTags.push(...fmTags.map((t: string) => t.replace(/^#/, "")));
    }
    if (cache?.tags) {
      for (const t of cache.tags) {
        const tag = t.tag.replace(/^#/, "");
        if (!fileTags.includes(tag)) fileTags.push(tag);
      }
    }

    // links: outgoing wikilinks
    const fileLinks: string[] = [];
    if (cache?.links) {
      for (const link of cache.links) {
        if (!fileLinks.includes(link.link)) fileLinks.push(link.link);
      }
    }

    // headings
    const headings = (cache?.headings ?? []).map((h) => ({
      level: h.level,
      text: h.heading,
    }));

    // aliases
    const aliases: string[] = fm?.aliases
      ? Array.isArray(fm.aliases) ? fm.aliases : [fm.aliases]
      : [];

    notes[name] = { path: file.path, frontmatter: fm, tags: fileTags, links: fileLinks, headings, aliases };

    // tag index
    for (const tag of fileTags) {
      if (!tagsMap[tag]) tagsMap[tag] = new Set();
      tagsMap[tag].add(name);
    }
  }

  // backlinks from resolvedLinks
  const resolved = app.metadataCache.resolvedLinks;
  for (const sourcePath in resolved) {
    const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) continue;
    const sourceName = sourceFile.basename;

    for (const destPath in resolved[sourcePath]) {
      const destFile = app.vault.getAbstractFileByPath(destPath);
      if (!(destFile instanceof TFile)) continue;
      const destName = destFile.basename;

      if (!backlinks[destName]) backlinks[destName] = new Set();
      backlinks[destName].add(sourceName);
    }
  }

  // convert sets to arrays
  const tagsResult: Record<string, string[]> = {};
  for (const tag in tagsMap) tagsResult[tag] = [...tagsMap[tag]];

  const backlinksResult: Record<string, string[]> = {};
  for (const name in backlinks) backlinksResult[name] = [...backlinks[name]];

  return {
    generated: new Date().toISOString(),
    noteCount: files.length,
    notes,
    backlinks: backlinksResult,
    tags: tagsResult,
  };
}

export async function dumpVaultIndex(app: App, outputPath: string): Promise<void> {
  const index = buildVaultIndex(app);
  const json = JSON.stringify(index, null, 2);
  await app.vault.adapter.write(outputPath, json);
}
