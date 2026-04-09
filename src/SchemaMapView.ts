import { ItemView, Modal, SuggestModal, WorkspaceLeaf, App, Notice, TFile } from "obsidian";
import {
  DeployRegistryManager,
  DeployEntry,
  PcEntry,
  ChatSourceEntry,
  DimensionEntry,
  HubConfig,
  ALL_TOOLS,
  TOOL_LABELS,
  getToolTargetPath,
  generateEntryId,
} from "./deployRegistry";
import type { AITerminalSettings } from "./settings";
import * as path from "path";

export const VIEW_TYPE_SCHEMA_MAP = "schema-map-view";

/* ── SVG Graph 상수 ─────────────────────────────── */

const NODE_W = 140;
const NODE_H_BASE = 36;
const PROP_LINE_H = 18;
const COL_GAP = 60;
const ROW_GAP = 16;
const PAD = 24;
const EDGE_LABEL_H = 20;
const EDGE_LABEL_W = 56;
const CORNER_R = 8;

const COLORS = {
  bg: "#1a1f2e",
  nodeFill: "#2a4a3a",
  nodeStroke: "#3d6a5e",
  projectFill: "#2a3a5a",
  projectStroke: "#4a6a8a",
  deployActive: "#2a5a3a",
  deployBroken: "#5a2a2a",
  deployNone: "#2a2a3a",
  text: "#e8e8e8",
  textMuted: "#9a9aaa",
  textProp: "#c0d0c0",
  line: "#4a7a6a",
  labelBg: "#1e2a3a",
  labelBorder: "#4a6a7a",
  labelText: "#b0c0d0",
};

/* ── 그래프 데이터 타입 ──────────────────────────── */

interface GNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  props: string[];
  fill: string;
  stroke: string;
  data?: any;
}

interface GEdge {
  from: string;
  to: string;
  label: string;
}

/* ── SchemaMapView ───────────────────────────────── */

export class SchemaMapView extends ItemView {
  private registry: DeployRegistryManager;
  private settings: AITerminalSettings;
  private graphEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    settings: AITerminalSettings,
    registry: DeployRegistryManager,
  ) {
    super(leaf);
    this.settings = settings;
    this.registry = registry;
  }

  getViewType(): string {
    return VIEW_TYPE_SCHEMA_MAP;
  }

  getDisplayText(): string {
    return "Schema Map";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("schema-map-container");

    // 툴바
    const toolbar = container.createDiv({ cls: "schema-map-toolbar" });
    const addDimBtn = toolbar.createEl("button", { text: "+ Dimension", cls: "schema-map-btn" });
    addDimBtn.addEventListener("click", () => this.handleAddDimension());
    const buildBtn = toolbar.createEl("button", { text: "Build Hub", cls: "schema-map-btn" });
    buildBtn.addEventListener("click", () => this.handleBuildHub());
    const verifyBtn = toolbar.createEl("button", { text: "Verify All", cls: "schema-map-btn" });
    verifyBtn.addEventListener("click", () => this.handleVerifyAll());
    const addBtn = toolbar.createEl("button", { text: "+ Project", cls: "schema-map-btn" });
    addBtn.addEventListener("click", () => this.handleAddProject());

    // 그래프 영역
    this.graphEl = container.createDiv({ cls: "schema-map-graph" });

    // 데이터 로드
    await this.registry.loadRegistry();
    this.registry.registerCurrentPc();
    await this.registry.verifyAll();

    // 디멘션 freshness 체크
    for (const project of this.registry.getAllProjects()) {
      await this.registry.checkDimensionFreshness(project);
    }

    await this.registry.saveRegistry();
    this.renderAllGraphs();
  }

  async onClose(): Promise<void> {
    this.graphEl = null;
  }

  /* ── 전체 렌더 ── */

  private renderAllGraphs(): void {
    if (!this.graphEl) return;
    this.graphEl.empty();

    const projects = this.registry.getAllProjects();
    if (projects.length === 0) {
      this.graphEl.createEl("p", {
        text: 'No projects. Click "+ Add Project" to start.',
        cls: "schema-map-empty-msg",
      });
      return;
    }

    for (const project of projects) {
      this.renderProjectGraph(project);
    }
  }

  /* ── 프로젝트별 그래프 ── */

  private renderProjectGraph(project: string): void {
    if (!this.graphEl) return;

    const pcs = this.registry.pcs;
    const currentPcId = this.registry.getCurrentPcId();
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];

    // ── 노드 배치 계산 ──

    // 1열: 디멘션 노드
    const hub = this.registry.getHubConfig(project);
    const dims = hub.dimensions;

    const dimX = PAD;
    dims.forEach((dim, i) => {
      const y = PAD + i * (NODE_H_BASE + PROP_LINE_H + ROW_GAP);
      nodes.push({
        id: `dim-${i}`,
        x: dimX,
        y,
        w: NODE_W,
        h: NODE_H_BASE + PROP_LINE_H,
        title: dim.label,
        props: [dim.path.split("/").slice(-2).join("/")],
        fill: "#2a3a4a",
        stroke: hub.buildStatus === "stale" ? "#aa8a2a" : "#4a6a7a",
        data: { type: "dimension", project, dimension: dim, index: i },
      });
    });

    // 2열: Chat Sources (레지스트리에서 로드)
    const sources = this.registry.getSources(project);

    const leftX = dimX + (dims.length > 0 ? NODE_W + COL_GAP : 0);
    sources.forEach((src, i) => {
      const badge = sourceBadge(src.status);
      const y = PAD + i * (NODE_H_BASE + PROP_LINE_H * 2 + ROW_GAP);
      nodes.push({
        id: `src-${src.tool}`,
        x: leftX,
        y,
        w: NODE_W,
        h: NODE_H_BASE + PROP_LINE_H * 2,
        title: TOOL_LABELS[src.tool] ?? src.tool,
        props: [`${badge} ${src.status}`, src.format],
        fill: src.status === "extractable" ? COLORS.nodeFill : "#3a3a2a",
        stroke: COLORS.nodeStroke,
        data: { type: "source", project, source: src },
      });
    });

    // 3열: Project + Hub 파일
    const centerX = leftX + NODE_W + COL_GAP;
    const hubFiles = ["HUB.md", "SOURCES.md", "CONTEXT.md"];
    const projectNodeH = NODE_H_BASE + hubFiles.length * PROP_LINE_H;

    const totalLeftH = sources.length * (NODE_H_BASE + PROP_LINE_H * 2 + ROW_GAP) - ROW_GAP;
    const projectY = PAD + Math.max(0, (totalLeftH - projectNodeH) / 2);

    nodes.push({
      id: "project",
      x: centerX,
      y: projectY,
      w: NODE_W,
      h: projectNodeH,
      title: project,
      props: hubFiles.map((f) => `\u2022 ${f}`),
      fill: COLORS.projectFill,
      stroke: COLORS.projectStroke,
    });

    // 오른쪽 열: Deploy Targets (현재 PC 우선)
    const rightX = centerX + NODE_W + COL_GAP;
    const sortedPcs = [...pcs].sort((a, b) => (a.id === currentPcId ? -1 : b.id === currentPcId ? 1 : 0));

    let deployIdx = 0;
    for (const pc of sortedPcs) {
      for (const tool of ALL_TOOLS) {
        const entry = this.registry.findEntry(project, tool, pc.id);
        const status = entry?.status ?? "none";
        const badge = statusBadge(status);
        const statusText = `${badge} ${status}`;

        let fill = COLORS.deployNone;
        if (status === "active") fill = COLORS.deployActive;
        else if (status === "broken") fill = COLORS.deployBroken;

        const y = PAD + deployIdx * (NODE_H_BASE + PROP_LINE_H * 2 + ROW_GAP);
        const nodeId = `deploy-${pc.id}-${tool}`;

        nodes.push({
          id: nodeId,
          x: rightX,
          y,
          w: NODE_W,
          h: NODE_H_BASE + PROP_LINE_H * 2,
          title: `${TOOL_LABELS[tool]} @ ${pc.id}`,
          props: [getToolTargetPath(tool, "...").split(/[/\\]/).pop() ?? "", statusText],
          fill,
          stroke: status === "broken" ? "#8a4a4a" : COLORS.nodeStroke,
          data: { project, tool, pc, entry },
        });

        deployIdx++;
      }
    }

    // ── 엣지 ──
    // Dimensions → Project (빌드 상태에 따라 색상 변경)
    dims.forEach((_, i) => {
      const label = hub.buildStatus === "stale" ? "stale" : hub.buildStatus === "synced" ? "synced" : "build";
      edges.push({ from: `dim-${i}`, to: "project", label });
    });
    // Sources → Project
    for (const src of sources) {
      edges.push({ from: `src-${src.tool}`, to: "project", label: "source" });
    }
    // Project → Deploy targets
    for (const pc of sortedPcs) {
      for (const tool of ALL_TOOLS) {
        edges.push({ from: "project", to: `deploy-${pc.id}-${tool}`, label: "deploy" });
      }
    }

    // ── SVG 크기 ──
    const maxNodeBottom = Math.max(
      ...nodes.map((n) => n.y + n.h),
    );
    const svgW = rightX + NODE_W + PAD;
    const svgH = maxNodeBottom + PAD;

    // ── SVG 렌더 ──
    const wrapper = this.graphEl.createDiv({ cls: "schema-map-project-wrapper" });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(svgW));
    svg.setAttribute("height", String(svgH));
    svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
    svg.classList.add("schema-map-svg");

    // 배경
    const bgRect = svgEl("rect", {
      x: "0", y: "0", width: String(svgW), height: String(svgH),
      rx: "8", fill: COLORS.bg,
    });
    svg.appendChild(bgRect);

    // 엣지 먼저 (노드 아래에 깔림)
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (!fromNode || !toNode) continue;

      const x1 = fromNode.x + fromNode.w;
      const y1 = fromNode.y + fromNode.h / 2;
      const x2 = toNode.x;
      const y2 = toNode.y + toNode.h / 2;

      // 엣지 색상: synced=녹색, stale=노란색, 기본=청록
      let edgeColor = COLORS.line;
      if (edge.label === "synced") edgeColor = "#4a8a4a";
      else if (edge.label === "stale") edgeColor = "#aa8a2a";
      else if (edge.label === "build") edgeColor = "#6a6a8a";

      const line = svgEl("line", {
        x1: String(x1), y1: String(y1),
        x2: String(x2), y2: String(y2),
        stroke: edgeColor, "stroke-width": "1.5", "stroke-opacity": "0.6",
      });
      svg.appendChild(line);

      // 엣지 라벨
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const labelG = svgEl("g", {});

      const labelBg = svgEl("rect", {
        x: String(mx - EDGE_LABEL_W / 2), y: String(my - EDGE_LABEL_H / 2),
        width: String(EDGE_LABEL_W), height: String(EDGE_LABEL_H),
        rx: "4", fill: COLORS.labelBg, stroke: COLORS.labelBorder, "stroke-width": "1",
      });
      labelG.appendChild(labelBg);

      const labelText = svgEl("text", {
        x: String(mx), y: String(my + 4),
        "text-anchor": "middle", fill: COLORS.labelText,
        "font-size": "10", "font-family": "sans-serif",
      });
      labelText.textContent = edge.label;
      labelG.appendChild(labelText);

      svg.appendChild(labelG);
    }

    // 노드
    for (const node of nodes) {
      const g = svgEl("g", { cursor: "pointer" });

      // 카드 배경
      const rect = svgEl("rect", {
        x: String(node.x), y: String(node.y),
        width: String(node.w), height: String(node.h),
        rx: String(CORNER_R), fill: node.fill, stroke: node.stroke, "stroke-width": "1.5",
      });
      g.appendChild(rect);

      // 타이틀
      const title = svgEl("text", {
        x: String(node.x + 10), y: String(node.y + 22),
        fill: COLORS.text, "font-size": "13", "font-weight": "bold", "font-family": "sans-serif",
      });
      title.textContent = node.title;
      g.appendChild(title);

      // 속성 (bullet list)
      node.props.forEach((prop, i) => {
        const propText = svgEl("text", {
          x: String(node.x + 10), y: String(node.y + 22 + (i + 1) * PROP_LINE_H),
          fill: COLORS.textProp, "font-size": "11", "font-family": "sans-serif",
        });
        propText.textContent = prop;
        g.appendChild(propText);
      });

      // 클릭 핸들러
      if (node.data) {
        g.addEventListener("click", () => {
          this.handleNodeClick(node);
        });
      }

      svg.appendChild(g);
    }

    wrapper.appendChild(svg);
  }

  /* ── 노드 클릭 ── */

  private handleNodeClick(node: GNode): void {
    if (node.data?.type === "dimension") {
      // 디멘션 클릭: 해당 노트를 에디터에서 열기
      const dim = node.data.dimension as DimensionEntry;
      const file = this.app.vault.getAbstractFileByPath(dim.path);
      if (file) {
        this.app.workspace.getLeaf(false).openFile(file as any);
      } else {
        new Notice(`파일을 찾을 수 없습니다: ${dim.path}`);
      }
      return;
    }

    if (node.data?.type === "source") {
      this.openSourceModal(node.data.project, node.data.source);
      return;
    }

    const { project, tool, pc, entry } = node.data;
    const status = entry?.status ?? "none";
    const currentPcId = this.registry.getCurrentPcId();

    if (pc.id !== currentPcId) {
      new Notice(`${tool} @ ${pc.id}: ${status} (other PC \u2014 read only)`);
      return;
    }

    if (status === "none") {
      this.openDeployModal(project, tool, pc, null);
    } else if (status === "active" && entry) {
      const msg = [
        `${entry.tool} @ ${entry.pc}`,
        `Status: ${statusBadge(status)} ${status}`,
        `Link: ${entry.symlinkPath}`,
        `Target: ${entry.targetPath}`,
      ].join("\n");
      new Notice(msg, 10_000);
    } else if (status === "broken" && entry) {
      this.openDeployModal(project, tool, pc, entry);
    }
  }

  /* ── Source 편집 모달 ── */

  private openSourceModal(project: string, source: ChatSourceEntry): void {
    new SourceEditModal(this.app, source, async (updated) => {
      this.registry.updateSource(project, source.tool, updated);
      await this.registry.saveRegistry();
      this.renderAllGraphs();
      new Notice(`Source updated: ${source.tool}`);
    }).open();
  }

  /* ── Deploy 모달 ── */

  private openDeployModal(
    project: string, tool: string, pc: PcEntry, existingEntry: DeployEntry | null,
  ): void {
    new DeployModal(this.app, project, tool, pc, existingEntry, async (config) => {
      const targetPath = getToolTargetPath(tool, config.repoPath);
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const hubPath = this.findHubPath(project);

      // hubPath 없으면 볼트 프로젝트 폴더 기반으로 추정
      const hubTarget = hubPath
        ? path.join(vaultPath, hubPath)
        : path.join(vaultPath, "10_Project", project, "HUB.md");

      const entryId = generateEntryId(pc.id, tool, project);
      const newEntry: DeployEntry = existingEntry ?? {
        id: entryId,
        project,
        tool,
        pc: pc.id,
        symlinkPath: targetPath,
        targetPath: hubTarget,
        method: config.method,
        files: config.files,
        status: "none",
        lastVerified: null,
      };

      if (existingEntry) {
        newEntry.symlinkPath = targetPath;
        newEntry.method = config.method;
        newEntry.files = config.files;
      }

      this.registry.addEntry(newEntry);

      try {
        await this.registry.deployEntry(newEntry);
        new Notice(`Deployed: ${project} \u2192 ${tool} @ ${pc.id}`);
      } catch (err: any) {
        new Notice(`Deploy failed: ${err.message}`);
      }

      this.renderAllGraphs();
    }).open();
  }

  /* ── Verify All ── */

  private async handleVerifyAll(): Promise<void> {
    await this.registry.verifyAll();
    this.renderAllGraphs();
    new Notice("Deploy registry verified");
  }

  /* ── Add Project ── */

  private handleAddProject(): void {
    new AddProjectModal(this.app, async (projectName) => {
      const currentPcId = this.registry.getCurrentPcId();
      for (const tool of ALL_TOOLS) {
        const id = generateEntryId(currentPcId, tool, projectName);
        if (!this.registry.findEntry(projectName, tool, currentPcId)) {
          this.registry.addEntry({
            id, project: projectName, tool, pc: currentPcId,
            symlinkPath: "", targetPath: "",
            method: "symlink", files: ["HUB"],
            status: "none", lastVerified: null,
          });
        }
      }
      await this.registry.saveRegistry();
      this.renderAllGraphs();
      new Notice(`Project added: ${projectName}`);
    }).open();
  }

  /* ── Dimension 추가 ── */

  private handleAddDimension(): void {
    const projects = this.registry.getAllProjects();
    if (projects.length === 0) {
      new Notice("먼저 프로젝트를 추가하세요");
      return;
    }

    // 프로젝트가 1개면 바로, 여러 개면 선택
    const project = projects.length === 1 ? projects[0] : null;
    if (project) {
      this.openDimensionPicker(project);
    } else {
      new SelectProjectModal(this.app, projects, (selected) => {
        this.openDimensionPicker(selected);
      }).open();
    }
  }

  private openDimensionPicker(project: string): void {
    // 볼트의 모든 .md 파일에서 선택
    const files = this.app.vault.getMarkdownFiles();
    new DimensionPickerModal(this.app, files, async (selected) => {
      for (const file of selected) {
        this.registry.addDimension(project, file.path, file.basename);
      }
      await this.registry.saveRegistry();
      this.renderAllGraphs();
      new Notice(`${selected.length}개 디멘션 추가됨`);
    }).open();
  }

  /* ── Hub 빌드 ── */

  private async handleBuildHub(): Promise<void> {
    const projects = this.registry.getAllProjects();
    if (projects.length === 0) {
      new Notice("프로젝트가 없습니다");
      return;
    }

    for (const project of projects) {
      const hub = this.registry.getHubConfig(project);
      if (hub.dimensions.length === 0) continue;

      try {
        const hubPath = await this.registry.buildHub(project);
        new Notice(`빌드 완료: ${hubPath}`);
      } catch (err: any) {
        new Notice(`빌드 실패 (${project}): ${err.message}`);
      }
    }

    await this.registry.saveRegistry();
    this.renderAllGraphs();
  }

  /* ── 유틸 ── */

  private findHubPath(project: string): string | null {
    const mdFiles = this.app.vault.getMarkdownFiles();
    const hub = mdFiles.find(
      (f) =>
        (f.name === "HUB.md" && f.parent?.name === project) ||
        f.name === `\uD5C8\uBE0C_${project}.md`,
    );
    return hub?.path ?? null;
  }
}

/* ── DeployModal ─────────────────────────────────── */

interface DeployConfig {
  repoPath: string;
  method: "symlink" | "copy";
  files: string[];
}

class DeployModal extends Modal {
  private repoPathInput: HTMLInputElement | null = null;
  private methodValue: "symlink" | "copy" = "symlink";
  private selectedFiles = new Set(["HUB", "SOURCES", "CONTEXT"]);

  constructor(
    app: App,
    private project: string,
    private tool: string,
    private pc: PcEntry,
    private existingEntry: DeployEntry | null,
    private onDeploy: (config: DeployConfig) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Deploy Configuration" });

    const info = contentEl.createDiv({ cls: "deploy-modal-info" });
    info.createEl("p", { text: `Project: ${this.project}` });
    info.createEl("p", { text: `Tool: ${this.tool} (${TOOL_LABELS[this.tool]})` });
    info.createEl("p", { text: `PC: ${this.pc.id}` });

    // 레포 경로
    const repoGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    repoGroup.createEl("label", { text: "Repository path:" });
    this.repoPathInput = repoGroup.createEl("input", { type: "text", cls: "deploy-modal-input" });
    this.repoPathInput.placeholder = process.platform === "win32"
      ? "C:\\dev\\project-name" : "/Users/me/dev/project-name";

    if (this.existingEntry?.symlinkPath) {
      const repo = extractRepoPath(this.existingEntry.symlinkPath, this.tool);
      if (repo) this.repoPathInput.value = repo;
    }

    // 자동 대상 경로
    const targetGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    targetGroup.createEl("label", { text: "Target path (auto):" });
    const targetDisplay = targetGroup.createEl("code", { cls: "deploy-modal-target", text: "..." });

    this.repoPathInput.addEventListener("input", () => {
      const repo = this.repoPathInput!.value;
      targetDisplay.textContent = repo ? getToolTargetPath(this.tool, repo) : "...";
    });
    if (this.repoPathInput.value) {
      targetDisplay.textContent = getToolTargetPath(this.tool, this.repoPathInput.value);
    }

    // 파일 체크박스
    const filesGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    filesGroup.createEl("label", { text: "Files to deploy:" });
    const filesRow = filesGroup.createDiv({ cls: "deploy-modal-checkbox-row" });
    for (const file of ["HUB", "SOURCES", "CONTEXT"]) {
      const label = filesRow.createEl("label", { cls: "deploy-modal-checkbox" });
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = this.selectedFiles.has(file);
      cb.addEventListener("change", () => {
        if (cb.checked) this.selectedFiles.add(file); else this.selectedFiles.delete(file);
      });
      label.appendText(` ${file}`);
    }

    // 방법 라디오
    const methodGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    methodGroup.createEl("label", { text: "Method:" });
    const methodRow = methodGroup.createDiv({ cls: "deploy-modal-radio-row" });
    for (const m of ["symlink", "copy"] as const) {
      const label = methodRow.createEl("label", { cls: "deploy-modal-radio" });
      const radio = label.createEl("input", { type: "radio" });
      radio.name = "deploy-method";
      radio.value = m;
      radio.checked = m === this.methodValue;
      radio.addEventListener("change", () => { this.methodValue = m; });
      label.appendText(` ${m}${m === "symlink" ? " (recommended)" : ""}`);
    }

    // 버튼
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    btnRow.createEl("button", { text: "Deploy", cls: "mod-cta" }).addEventListener("click", () => {
      const repoPath = this.repoPathInput?.value?.trim();
      if (!repoPath) { new Notice("Repository path is required"); return; }
      this.close();
      this.onDeploy({ repoPath, method: this.methodValue, files: [...this.selectedFiles] });
    });
    btnRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void { this.contentEl.empty(); }
}

/* ── AddProjectModal ─────────────────────────────── */

class AddProjectModal extends Modal {
  constructor(app: App, private onConfirm: (name: string) => void) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add Project" });
    const field = contentEl.createDiv({ cls: "deploy-modal-field" });
    field.createEl("label", { text: "Project name:" });
    const input = field.createEl("input", { type: "text", cls: "deploy-modal-input" });
    input.placeholder = "e.g. obsidian-ai-terminal";
    input.focus();

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    btnRow.createEl("button", { text: "Add", cls: "mod-cta" }).addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) { new Notice("Project name is required"); return; }
      this.close();
      this.onConfirm(name);
    });
    btnRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") btnRow.querySelector(".mod-cta")?.dispatchEvent(new Event("click")); });
  }

  onClose(): void { this.contentEl.empty(); }
}

/* ── SourceEditModal ──────────────────────────────── */

class SourceEditModal extends Modal {
  constructor(
    app: App,
    private source: ChatSourceEntry,
    private onSave: (updated: Partial<ChatSourceEntry>) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Edit Source: ${this.source.tool}` });

    // Status 선택
    const statusGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    statusGroup.createEl("label", { text: "Status:" });
    const statusSelect = statusGroup.createEl("select", { cls: "deploy-modal-input" });
    for (const s of ["extractable", "reference_only", "unavailable"] as const) {
      const opt = statusSelect.createEl("option", { text: `${sourceBadge(s)} ${s}`, value: s });
      if (s === this.source.status) opt.selected = true;
    }

    // Root path
    const pathGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    pathGroup.createEl("label", { text: "Root path:" });
    const pathInput = pathGroup.createEl("input", { type: "text", cls: "deploy-modal-input" });
    pathInput.value = this.source.rootPath;

    // Format
    const fmtGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    fmtGroup.createEl("label", { text: "Format:" });
    const fmtInput = fmtGroup.createEl("input", { type: "text", cls: "deploy-modal-input" });
    fmtInput.value = this.source.format;

    // Note
    const noteGroup = contentEl.createDiv({ cls: "deploy-modal-field" });
    noteGroup.createEl("label", { text: "Note:" });
    const noteInput = noteGroup.createEl("input", { type: "text", cls: "deploy-modal-input" });
    noteInput.value = this.source.note;
    noteInput.placeholder = "optional memo";

    // 버튼
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    btnRow.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
      this.onSave({
        status: statusSelect.value as ChatSourceEntry["status"],
        rootPath: pathInput.value,
        format: fmtInput.value,
        note: noteInput.value,
      });
    });
    btnRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void { this.contentEl.empty(); }
}

/* ── SVG 유틸 ── */

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function sourceBadge(status: string): string {
  switch (status) {
    case "extractable": return "\u2705";
    case "reference_only": return "\u23F8\uFE0F";
    case "unavailable": return "\u2B1C";
    default: return "\u2753";
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case "active": return "\u{1F7E2}";
    case "unverified": return "\u{1F7E1}";
    case "broken": return "\u{1F534}";
    case "deferred": return "\u23F8\uFE0F";
    default: return "\u2B1C";
  }
}

/* ── SelectProjectModal ──────────────────────────── */

class SelectProjectModal extends Modal {
  constructor(
    app: App,
    private projects: string[],
    private onSelect: (project: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "프로젝트 선택" });
    for (const p of this.projects) {
      const btn = contentEl.createEl("button", { text: p, cls: "schema-map-btn" });
      btn.style.display = "block";
      btn.style.marginBottom = "4px";
      btn.style.width = "100%";
      btn.addEventListener("click", () => {
        this.close();
        this.onSelect(p);
      });
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

/* ── DimensionPickerModal ────────────────────────── */

class DimensionPickerModal extends SuggestModal<TFile> {
  private selected: TFile[] = [];

  constructor(
    app: App,
    private files: TFile[],
    private onDone: (selected: TFile[]) => void,
  ) {
    super(app);
    this.setPlaceholder("디멘션 .md 파일을 선택하세요 (Enter로 추가, Esc로 완료)");
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.files.filter((f) =>
      f.basename.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower)
    ).slice(0, 20);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl("div", { text: file.basename, cls: "suggestion-title" });
    el.createEl("small", { text: file.path, cls: "suggestion-note" });
  }

  onChooseSuggestion(file: TFile): void {
    this.selected.push(file);
    this.onDone(this.selected);
  }
}

function extractRepoPath(symlinkPath: string, tool: string): string | null {
  const suffixes: Record<string, string> = {
    "claude-code": ".claude/hub.md", "codex": "AGENTS.md",
    "gemini-cli": "GEMINI.md", "cursor": ".cursorrules",
  };
  const suffix = suffixes[tool];
  if (!suffix) return null;
  const norm = symlinkPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf(suffix.replace(/\\/g, "/"));
  if (idx < 0) return null;
  let repo = symlinkPath.slice(0, idx);
  if (repo.endsWith("/") || repo.endsWith("\\")) repo = repo.slice(0, -1);
  return repo;
}
