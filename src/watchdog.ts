import { App, TFile, debounce } from "obsidian";

// ── ContextIndex 模式定义 ──

export interface ContextIndex {
  timestamp: string;
  activeNote: ActiveNoteContext | null;
  recentNotes: string[];           // 最近修改的笔记路径（最多10个）
  projectHubs: ProjectHubRef[];    // 项目 Hub 列表
  vaultStats: VaultStats;
}

export interface ActiveNoteContext {
  path: string;
  basename: string;
  frontmatter: Record<string, any> | null;
  tags: string[];
  links: string[];        // outgoing links
  backlinks: string[];    // incoming links
  headings: string[];     // h1~h3
  excerpt: string;        // 前200字
}

export interface ProjectHubRef {
  project: string;
  hubPath: string;
  lastBuild: string | null;
}

export interface VaultStats {
  totalNotes: number;
  totalTags: number;
}

// ── Watchdog: Vault 变更检测 → ContextIndex 更新 ──

export class Watchdog {
  private index: ContextIndex;
  private listeners: ((index: ContextIndex) => void)[] = [];
  private activeFilePath: string | null = null;

  constructor(private app: App) {
    this.index = this.emptyIndex();
  }

  get currentIndex(): ContextIndex {
    return this.index;
  }

  /** 订阅变更通知 */
  onIndexChange(listener: (index: ContextIndex) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** 设置活动笔记（从 Obsidian 的 active-leaf-change 事件中调用） */
  setActiveNote(filePath: string | null): void {
    this.activeFilePath = filePath;
    this.rebuild();
  }

  /** 全量索引重建 */
  rebuild(): void {
    const now = new Date().toISOString();
    const files = this.app.vault.getMarkdownFiles();

    // 活动笔记上下文
    let activeNote: ActiveNoteContext | null = null;
    if (this.activeFilePath) {
      const file = this.app.vault.getAbstractFileByPath(this.activeFilePath);
      if (file instanceof TFile) {
        activeNote = this.buildNoteContext(file);
      }
    }

    // 最近修改的笔记（按 mtime 排序前10个）
    const sorted = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const recentNotes = sorted.slice(0, 10).map((f) => f.path);

    // 探索项目 Hub
    const projectHubs: ProjectHubRef[] = [];
    for (const file of files) {
      if (file.basename.startsWith("HUB_") || file.basename.startsWith("허브_")) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        projectHubs.push({
          project: fm?.id?.replace("hub_", "") || file.basename.replace(/^(HUB_|허브_)/, ""),
          hubPath: file.path,
          lastBuild: fm?.last_build || null,
        });
      }
    }

    // Vault 统计
    const allTags = new Set<string>();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        for (const t of cache.tags) allTags.add(t.tag);
      }
    }

    this.index = {
      timestamp: now,
      activeNote,
      recentNotes,
      projectHubs,
      vaultStats: {
        totalNotes: files.length,
        totalTags: allTags.size,
      },
    };

    // 通知监听器
    for (const listener of this.listeners) {
      try { listener(this.index); } catch { /* ignore */ }
    }
  }

  /** 构建特定笔记的上下文 */
  private buildNoteContext(file: TFile): ActiveNoteContext {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? null;

    // 标签
    const tags: string[] = [];
    if (fm?.tags) {
      const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      tags.push(...fmTags.map((t: string) => t.replace(/^#/, "")));
    }
    if (cache?.tags) {
      for (const t of cache.tags) {
        const tag = t.tag.replace(/^#/, "");
        if (!tags.includes(tag)) tags.push(tag);
      }
    }

    // 链接
    const links: string[] = [];
    if (cache?.links) {
      for (const l of cache.links) {
        if (!links.includes(l.link)) links.push(l.link);
      }
    }

    // 反向链接
    const backlinks: string[] = [];
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const sourcePath in resolved) {
      if (resolved[sourcePath][file.path]) {
        const src = this.app.vault.getAbstractFileByPath(sourcePath);
        if (src instanceof TFile) backlinks.push(src.basename);
      }
    }

    // 标题
    const headings = (cache?.headings ?? [])
      .filter((h) => h.level <= 3)
      .map((h) => h.heading);

    return {
      path: file.path,
      basename: file.basename,
      frontmatter: fm,
      tags,
      links,
      backlinks,
      headings,
      excerpt: "", // 需要异步读取，暂留空字符串（后续扩展）
    };
  }

  private emptyIndex(): ContextIndex {
    return {
      timestamp: new Date().toISOString(),
      activeNote: null,
      recentNotes: [],
      projectHubs: [],
      vaultStats: { totalNotes: 0, totalTags: 0 },
    };
  }
}
