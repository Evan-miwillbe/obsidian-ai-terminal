import { ItemView, WorkspaceLeaf, App, TFile, Notice } from "obsidian";
import type { AITerminalSettings } from "./settings";

export const VIEW_TYPE_ROADMAP = "roadmap-view";

// ── 태스크 프론트매터 스키마 ──

interface TaskNode {
  id: string;
  name: string;
  parent: string | null;
  nodeType: "project" | "phase" | "epic" | "task" | "subtask";
  phase: string;
  status: "todo" | "doing" | "done" | "blocked";
  progress: number;   // 0-100
  assignee: string;
  dependsOn: string[];
  sprintStart: number;
  sprintEnd: number;
  tags: string[];
  filePath: string;
  depth: number;       // 렌더링용 (parent chain depth)
}

// ── SVG 상수 ──

const GANTT = {
  rowH: 32,
  labelW: 260,
  sprintW: 80,
  padX: 16,
  padY: 48,
  barH: 20,
  barR: 4,
  headerH: 36,
} as const;

const GCOLORS = {
  bg: "#1a1f2e",
  headerBg: "#222840",
  headerText: "#c0c8e0",
  gridLine: "#2a3050",
  rowEven: "#1e2338",
  rowOdd: "#222840",
  labelText: "#d0d8e8",
  labelMuted: "#8090a8",
  barTodo: "#4a5a7a",
  barDoing: "#3a8a5a",
  barDone: "#2a6a4a",
  barBlocked: "#8a3a3a",
  progressBg: "#ffffff18",
  progressFg: "#8ac8a8",
  depLine: "#6a7a9a",
} as const;

const STATUS_BAR: Record<string, string> = {
  todo: GCOLORS.barTodo,
  doing: GCOLORS.barDoing,
  done: GCOLORS.barDone,
  blocked: GCOLORS.barBlocked,
};

// ── RoadmapView ──

export class RoadmapView extends ItemView {
  private settings: AITerminalSettings;
  private tasks: TaskNode[] = [];
  private graphEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, settings: AITerminalSettings) {
    super(leaf);
    this.settings = settings;
  }

  getViewType(): string { return VIEW_TYPE_ROADMAP; }
  getDisplayText(): string { return "Roadmap"; }
  getIcon(): string { return "gantt-chart"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("roadmap-container");

    // 툴바
    const toolbar = container.createDiv({ cls: "roadmap-toolbar" });
    const refreshBtn = toolbar.createEl("button", { text: "Refresh", cls: "schema-map-btn" });
    refreshBtn.addEventListener("click", () => this.refresh());
    const addTaskBtn = toolbar.createEl("button", { text: "+ Task", cls: "schema-map-btn" });
    addTaskBtn.addEventListener("click", () => this.handleAddTask());

    this.graphEl = container.createDiv({ cls: "roadmap-graph" });

    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.graphEl = null;
  }

  async refresh(): Promise<void> {
    this.tasks = await this.scanTasks();
    this.render();
  }

  // ── 태스크 스캔: 볼트에서 node_type 프론트매터를 가진 .md 수집 ──

  private async scanTasks(): Promise<TaskNode[]> {
    const files = this.app.vault.getMarkdownFiles();
    const tasks: TaskNode[] = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm?.node_type) continue;

      tasks.push({
        id: fm.id || file.basename,
        name: fm.name || file.basename,
        parent: fm.parent || null,
        nodeType: fm.node_type || "task",
        phase: fm.phase || "",
        status: fm.status || "todo",
        progress: fm.progress ?? 0,
        assignee: fm.assignee || "",
        dependsOn: Array.isArray(fm.depends_on) ? fm.depends_on : [],
        sprintStart: fm.sprint_start ?? 1,
        sprintEnd: fm.sprint_end ?? 1,
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        filePath: file.path,
        depth: 0,
      });
    }

    // depth 계산
    this.computeDepth(tasks);

    // 정렬: phase → depth → sprintStart
    tasks.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.sprintStart - b.sprintStart;
    });

    return tasks;
  }

  private computeDepth(tasks: TaskNode[]): void {
    const map = new Map(tasks.map((t) => [t.id, t]));
    const getDepth = (t: TaskNode): number => {
      if (t.depth > 0) return t.depth;
      if (!t.parent) {
        t.depth = t.nodeType === "project" ? 0 : t.nodeType === "phase" ? 1 : 2;
        return t.depth;
      }
      const parent = map.get(t.parent);
      t.depth = parent ? getDepth(parent) + 1 : 2;
      return t.depth;
    };
    tasks.forEach(getDepth);
  }

  // ── 렌더 ──

  private render(): void {
    if (!this.graphEl) return;
    this.graphEl.empty();

    if (this.tasks.length === 0) {
      this.graphEl.createEl("p", {
        text: "로드맵에 표시할 태스크가 없습니다. node_type 프론트매터가 있는 .md 파일을 생성하세요.",
        cls: "roadmap-empty-msg",
      });

      // 예시 표시
      const example = this.graphEl.createEl("pre");
      example.style.fontSize = "12px";
      example.style.color = "#8090a8";
      example.textContent = `---
id: task_001
name: React 트리 컴포넌트
parent: epic_002
node_type: task
phase: Phase 1
status: doing
progress: 60
assignee: claude-code
depends_on: [task_000]
sprint_start: 2
sprint_end: 3
tags: [frontend]
---`;
      return;
    }

    // 스프린트 범위 계산
    const maxSprint = Math.max(...this.tasks.map((t) => t.sprintEnd), 4);
    const sprintCount = maxSprint + 1;

    const svgW = GANTT.labelW + sprintCount * GANTT.sprintW + GANTT.padX * 2;
    const svgH = GANTT.padY + GANTT.headerH + this.tasks.length * GANTT.rowH + GANTT.padX;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(svgW));
    svg.setAttribute("height", String(svgH));
    svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
    svg.classList.add("roadmap-svg");

    // 배경
    svg.appendChild(svgEl("rect", {
      x: "0", y: "0", width: String(svgW), height: String(svgH),
      rx: "8", fill: GCOLORS.bg,
    }));

    // 헤더 배경
    svg.appendChild(svgEl("rect", {
      x: String(GANTT.labelW), y: String(GANTT.padY),
      width: String(sprintCount * GANTT.sprintW), height: String(GANTT.headerH),
      fill: GCOLORS.headerBg,
    }));

    // 스프린트 헤더
    for (let s = 0; s < sprintCount; s++) {
      const x = GANTT.labelW + s * GANTT.sprintW;
      const label = svgEl("text", {
        x: String(x + GANTT.sprintW / 2), y: String(GANTT.padY + 24),
        "text-anchor": "middle", fill: GCOLORS.headerText,
        "font-size": "11", "font-family": "sans-serif",
      });
      label.textContent = `S${s + 1}`;
      svg.appendChild(label);

      // 세로 그리드
      svg.appendChild(svgEl("line", {
        x1: String(x), y1: String(GANTT.padY),
        x2: String(x), y2: String(svgH - GANTT.padX),
        stroke: GCOLORS.gridLine, "stroke-width": "1",
      }));
    }

    // 태스크 행
    const rowY0 = GANTT.padY + GANTT.headerH;
    const taskYMap = new Map<string, number>();

    this.tasks.forEach((task, i) => {
      const y = rowY0 + i * GANTT.rowH;
      taskYMap.set(task.id, y + GANTT.rowH / 2);

      // 행 배경 (짝/홀)
      svg.appendChild(svgEl("rect", {
        x: "0", y: String(y),
        width: String(svgW), height: String(GANTT.rowH),
        fill: i % 2 === 0 ? GCOLORS.rowEven : GCOLORS.rowOdd,
      }));

      // 라벨 (indent by depth)
      const indent = GANTT.padX + task.depth * 16;
      const typeIcon = task.nodeType === "phase" ? "▸ " : task.nodeType === "epic" ? "◆ " : task.nodeType === "project" ? "◉ " : "  ";
      const labelEl = svgEl("text", {
        x: String(indent), y: String(y + 21),
        fill: task.depth <= 1 ? GCOLORS.labelText : GCOLORS.labelMuted,
        "font-size": task.depth <= 1 ? "12" : "11",
        "font-weight": task.depth <= 1 ? "bold" : "normal",
        "font-family": "sans-serif",
        cursor: "pointer",
      });
      labelEl.textContent = `${typeIcon}${task.name}`;
      labelEl.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(task.filePath);
        if (file) this.app.workspace.getLeaf(false).openFile(file as TFile);
      });
      svg.appendChild(labelEl);

      // 상태 뱃지
      const statusX = GANTT.labelW - 60;
      const statusEl = svgEl("text", {
        x: String(statusX), y: String(y + 21),
        "text-anchor": "end", fill: STATUS_BAR[task.status] || GCOLORS.labelMuted,
        "font-size": "10", "font-family": "sans-serif",
      });
      statusEl.textContent = task.status;
      svg.appendChild(statusEl);

      // 간트 바
      if (task.nodeType !== "project") {
        const barX = GANTT.labelW + (task.sprintStart - 1) * GANTT.sprintW;
        const barW = (task.sprintEnd - task.sprintStart + 1) * GANTT.sprintW - 4;
        const barY = y + (GANTT.rowH - GANTT.barH) / 2;

        // 바 배경
        svg.appendChild(svgEl("rect", {
          x: String(barX), y: String(barY),
          width: String(barW), height: String(GANTT.barH),
          rx: String(GANTT.barR), fill: STATUS_BAR[task.status] || GCOLORS.barTodo,
          opacity: "0.7",
        }));

        // 진행률 오버레이
        if (task.progress > 0) {
          const progressW = barW * (task.progress / 100);
          svg.appendChild(svgEl("rect", {
            x: String(barX), y: String(barY),
            width: String(progressW), height: String(GANTT.barH),
            rx: String(GANTT.barR), fill: GCOLORS.progressFg,
            opacity: "0.3",
          }));
        }

        // 진행률 텍스트
        if (task.progress > 0) {
          const pctEl = svgEl("text", {
            x: String(barX + barW / 2), y: String(barY + 14),
            "text-anchor": "middle", fill: "#ffffff",
            "font-size": "10", "font-family": "sans-serif",
          });
          pctEl.textContent = `${task.progress}%`;
          svg.appendChild(pctEl);
        }
      }
    });

    // 의존성 화살표
    for (const task of this.tasks) {
      for (const depId of task.dependsOn) {
        const fromY = taskYMap.get(depId);
        const toY = taskYMap.get(task.id);
        if (fromY === undefined || toY === undefined) continue;

        const depTask = this.tasks.find((t) => t.id === depId);
        if (!depTask) continue;

        const x1 = GANTT.labelW + depTask.sprintEnd * GANTT.sprintW - 2;
        const x2 = GANTT.labelW + (task.sprintStart - 1) * GANTT.sprintW;

        // 베지어 커브
        const path = svgEl("path", {
          d: `M ${x1} ${fromY} C ${x1 + 20} ${fromY}, ${x2 - 20} ${toY}, ${x2} ${toY}`,
          fill: "none", stroke: GCOLORS.depLine,
          "stroke-width": "1.5", "stroke-dasharray": "4,3",
          "marker-end": "url(#arrowhead)",
        });
        svg.appendChild(path);
      }
    }

    // 화살표 마커 정의
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "4");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "2");
    marker.setAttribute("orient", "auto");
    const arrow = svgEl("polygon", {
      points: "0 0, 6 2, 0 4", fill: GCOLORS.depLine,
    });
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.insertBefore(defs, svg.firstChild);

    this.graphEl.appendChild(svg);
  }

  // ── 태스크 추가 ──

  private async handleAddTask(): Promise<void> {
    const name = window.prompt("태스크 이름:");
    if (!name) return;

    const id = `task_${Date.now().toString(36)}`;
    const content = [
      "---",
      `id: ${id}`,
      `name: ${name}`,
      `node_type: task`,
      `phase: Phase 1`,
      `status: todo`,
      `progress: 0`,
      `assignee: ""`,
      `depends_on: []`,
      `sprint_start: 1`,
      `sprint_end: 1`,
      `tags: []`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n");

    // 00_인박스에 생성
    const filePath = `00_인박스/${id}.md`;
    await this.app.vault.create(filePath, content);
    new Notice(`태스크 생성: ${filePath}`);
    await this.refresh();
  }
}

// ── SVG 유틸 ──

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
