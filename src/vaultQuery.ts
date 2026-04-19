import { App, TFile, FuzzyMatch, FuzzySuggestModal } from "obsidian";

// ── ANSI 颜色 ──

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

// ── 查询结果类型 ──

export interface QueryResult {
  query: string;
  type: "search" | "backlinks" | "links";
  results: ResultEntry[];
  elapsed: number; // ms
}

interface ResultEntry {
  name: string;
  path: string;
  context?: string; // 匹配上下文 (tag, heading 等)
}

// ── 查询函数 ──

/**
 * /search — 按标签、标题、frontmatter 搜索
 * 格式: /search tag:재고실사 | /search 关键词
 */
export function searchVault(app: App, query: string): QueryResult {
  const start = performance.now();
  const results: ResultEntry[] = [];
  const files = app.vault.getMarkdownFiles();

  // tag: 前缀处理
  const tagMatch = query.match(/^tag:(.+)/i);

  if (tagMatch) {
    const searchTag = tagMatch[1].trim().toLowerCase();

    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache) continue;

      const fileTags: string[] = [];
      if (cache.frontmatter?.tags) {
        const fmTags = Array.isArray(cache.frontmatter.tags)
          ? cache.frontmatter.tags
          : [cache.frontmatter.tags];
        fileTags.push(...fmTags.map((t: string) => t.replace(/^#/, "").toLowerCase()));
      }
      if (cache.tags) {
        for (const t of cache.tags) {
          fileTags.push(t.tag.replace(/^#/, "").toLowerCase());
        }
      }

      if (fileTags.some((t) => t.includes(searchTag))) {
        results.push({
          name: file.basename,
          path: file.path,
          context: `tags: ${fileTags.join(", ")}`,
        });
      }
    }
  } else {
    // 普通关键词搜索: 标题 + heading + aliases
    const searchLower = query.toLowerCase();

    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      const nameLower = file.basename.toLowerCase();

      if (nameLower.includes(searchLower)) {
        results.push({
          name: file.basename,
          path: file.path,
          context: "title match",
        });
        continue;
      }

      // aliases
      const aliases = cache?.frontmatter?.aliases;
      if (aliases) {
        const aliasList = Array.isArray(aliases) ? aliases : [aliases];
        if (aliasList.some((a: string) => a.toLowerCase().includes(searchLower))) {
          results.push({
            name: file.basename,
            path: file.path,
            context: `alias: ${aliasList.join(", ")}`,
          });
          continue;
        }
      }

      // headings
      if (cache?.headings) {
        const match = cache.headings.find((h) =>
          h.heading.toLowerCase().includes(searchLower)
        );
        if (match) {
          results.push({
            name: file.basename,
            path: file.path,
            context: `h${match.level}: ${match.heading}`,
          });
        }
      }
    }
  }

  return {
    query,
    type: "search",
    results,
    elapsed: performance.now() - start,
  };
}

/**
 * /backlinks — 指向特定笔记的所有笔记
 */
export function queryBacklinks(app: App, noteName: string): QueryResult {
  const start = performance.now();
  const results: ResultEntry[] = [];

  // 查找目标笔记
  const targetFile = app.metadataCache.getFirstLinkpathDest(noteName, "");
  if (!targetFile) {
    return { query: noteName, type: "backlinks", results: [], elapsed: performance.now() - start };
  }

  // 从 resolvedLinks 反向追踪
  const resolved = app.metadataCache.resolvedLinks;
  for (const sourcePath in resolved) {
    if (resolved[sourcePath][targetFile.path]) {
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (sourceFile instanceof TFile) {
        results.push({
          name: sourceFile.basename,
          path: sourceFile.path,
        });
      }
    }
  }

  return {
    query: noteName,
    type: "backlinks",
    results,
    elapsed: performance.now() - start,
  };
}

/**
 * /links — 从特定笔记出发的所有链接
 */
export function queryLinks(app: App, noteName: string): QueryResult {
  const start = performance.now();
  const results: ResultEntry[] = [];

  // 查找目标笔记
  const targetFile = app.metadataCache.getFirstLinkpathDest(noteName, "");
  if (!targetFile) {
    return { query: noteName, type: "links", results: [], elapsed: performance.now() - start };
  }

  const cache = app.metadataCache.getFileCache(targetFile);
  if (!cache?.links) {
    return { query: noteName, type: "links", results: [], elapsed: performance.now() - start };
  }

  const seen = new Set<string>();
  for (const link of cache.links) {
    if (seen.has(link.link)) continue;
    seen.add(link.link);

    const dest = app.metadataCache.getFirstLinkpathDest(link.link, targetFile.path);
    results.push({
      name: link.link,
      path: dest?.path ?? "(unresolved)",
    });
  }

  return {
    query: noteName,
    type: "links",
    results,
    elapsed: performance.now() - start,
  };
}

// ── ANSI 格式化 ──

export function formatQueryResult(result: QueryResult): string {
  const lines: string[] = [];
  const { type, query, results, elapsed } = result;

  const typeLabel = type === "search" ? "Search" : type === "backlinks" ? "Backlinks" : "Links";
  const color = type === "search" ? ANSI.cyan : type === "backlinks" ? ANSI.magenta : ANSI.blue;

  lines.push("");
  lines.push(`${color}${ANSI.bold}/${typeLabel}${ANSI.reset} ${ANSI.dim}${query}${ANSI.reset}`);
  lines.push(`${ANSI.dim}${"─".repeat(50)}${ANSI.reset}`);

  if (results.length === 0) {
    lines.push(`${ANSI.yellow}  (no results)${ANSI.reset}`);
  } else {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const num = `${ANSI.dim}${String(i + 1).padStart(3)}${ANSI.reset}`;
      const name = `${ANSI.green}${ANSI.bold}${r.name}${ANSI.reset}`;
      const path = `${ANSI.dim}${r.path}${ANSI.reset}`;

      lines.push(`${num}  ${name}`);
      lines.push(`      ${path}`);
      if (r.context) {
        lines.push(`      ${ANSI.yellow}${r.context}${ANSI.reset}`);
      }
    }
  }

  lines.push(`${ANSI.dim}${"─".repeat(50)}${ANSI.reset}`);
  lines.push(`${ANSI.dim}${results.length} results in ${elapsed.toFixed(0)}ms${ANSI.reset}`);
  lines.push("");

  return lines.join("\r\n");
}

// ── 笔记选择弹窗 ──

export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("请输入笔记名称...");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
