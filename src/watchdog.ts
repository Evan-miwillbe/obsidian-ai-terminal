import { App, TFile, debounce } from "obsidian";

// ── 컨텍스트 인덱스 스키마 ──

export interface ContextIndex {
  timestamp: string;
  activeNote: ActiveNoteContext | null;
  recentNotes: string[];           // 최근 수정된 노트 경로 (최대 10개)
  projectHubs: ProjectHubRef[];    // 프로젝트 허브 목록
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
  excerpt: string;        // 첫 200자
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

// ── Watchdog: 볼트 변경 감지 → 컨텍스트 인덱스 갱신 ──

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

  /** 변경 알림 구독 */
  onIndexChange(listener: (index: ContextIndex) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** 활성 노트 설정 (옵시디언의 active-leaf-change 이벤트에서 호출) */
  setActiveNote(filePath: string | null): void {
    this.activeFilePath = filePath;
    this.rebuild();
  }

  /** 전체 인덱스 재빌드 */
  rebuild(): void {
    const now = new Date().toISOString();
    const files = this.app.vault.getMarkdownFiles();

    // 활성 노트 컨텍스트
    let activeNote: ActiveNoteContext | null = null;
    if (this.activeFilePath) {
      const file = this.app.vault.getAbstractFileByPath(this.activeFilePath);
      if (file instanceof TFile) {
        activeNote = this.buildNoteContext(file);
      }
    }

    // 최근 수정 노트 (mtime 기준 상위 10개)
    const sorted = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const recentNotes = sorted.slice(0, 10).map((f) => f.path);

    // 프로젝트 허브 탐색
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

    // 볼트 통계
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

    // 리스너에 알림
    for (const listener of this.listeners) {
      try { listener(this.index); } catch { /* ignore */ }
    }
  }

  /** 특정 노트의 컨텍스트 빌드 */
  private buildNoteContext(file: TFile): ActiveNoteContext {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? null;

    // 태그
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

    // 링크
    const links: string[] = [];
    if (cache?.links) {
      for (const l of cache.links) {
        if (!links.includes(l.link)) links.push(l.link);
      }
    }

    // 백링크
    const backlinks: string[] = [];
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const sourcePath in resolved) {
      if (resolved[sourcePath][file.path]) {
        const src = this.app.vault.getAbstractFileByPath(sourcePath);
        if (src instanceof TFile) backlinks.push(src.basename);
      }
    }

    // 헤딩
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
      excerpt: "", // 비동기 읽기가 필요해서 빈 문자열 (나중에 확장)
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
