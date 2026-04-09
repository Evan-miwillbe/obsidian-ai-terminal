#!/usr/bin/env node
/**
 * MCP Schedule Server — schedule CRUD over stdio (JSON-RPC 2.0)
 *
 * Claude Code MCP 설정에 등록하여 사용:
 *   claude mcp add schedule-server node scripts/mcp-schedule-server.mjs --vault-path <볼트경로>
 *
 * 또는 ~/.claude/settings.json에 직접 추가:
 *   "mcpServers": {
 *     "schedule": {
 *       "command": "node",
 *       "args": ["<플러그인경로>/scripts/mcp-schedule-server.mjs", "--vault-path", "<볼트경로>"]
 *     }
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

// ── 인자 파싱 ──

function parseArgs() {
  const args = process.argv.slice(2);
  let vaultPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault-path" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    }
  }

  if (!vaultPath) {
    // 환경변수 폴백
    vaultPath = process.env.OBSIDIAN_VAULT_PATH || "";
  }

  if (!vaultPath) {
    process.stderr.write("Error: --vault-path <path> 또는 OBSIDIAN_VAULT_PATH 환경변수 필요\n");
    process.exit(1);
  }

  return { vaultPath };
}

const { vaultPath } = parseArgs();
const SCHEDULES_PATH = join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal", "schedules.json");
const SCHEDULES_DIR = join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal", "schedules");

// ── Schedules I/O ──

function loadSchedules() {
  try {
    const raw = readFileSync(SCHEDULES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, schedules: [] };
  }
}

function saveSchedules(table) {
  const dir = join(vaultPath, ".obsidian", "plugins", "obsidian-ai-terminal");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SCHEDULES_PATH, JSON.stringify(table, null, 2), "utf-8");
}

function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `mcp-${ts}-${rand}`;
}

// ── MCP Tool 정의 ──

const TOOLS = [
  {
    name: "schedule/set",
    description: "반복 작업을 cron 스케줄로 등록/수정한다.",
    inputSchema: {
      type: "object",
      required: ["name", "cron"],
      properties: {
        name: {
          type: "string",
          description: "스케줄 식별 이름",
        },
        cron: {
          type: "string",
          description: "cron 표현식 (5필드: 분 시 일 월 요일)",
        },
        action: {
          type: "string",
          enum: ["claude-prompt", "hub-generate", "weekly-summary", "monthly-summary"],
          description: "실행할 액션. 기본값 claude-prompt",
        },
        actionInput: {
          type: "object",
          description: "액션 파라미터. hub-generate: {project, depth}",
        },
        output: {
          type: "string",
          enum: ["daily-note", "notice", "none"],
          description: "결과 출력 방식. 기본값 daily-note",
        },
        enabled: {
          type: "boolean",
          description: "활성화 여부. 기본값 true",
        },
        prompt: {
          type: "string",
          description: "claude-prompt 액션일 때 프롬프트 텍스트",
        },
      },
    },
  },
  {
    name: "schedule/list",
    description: "등록된 스케줄 목록을 반환한다.",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: {
          type: "boolean",
          description: "활성 스케줄만 조회. 기본값 false",
        },
      },
    },
  },
  {
    name: "schedule/delete",
    description: "스케줄을 삭제한다.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "삭제할 스케줄 이름 또는 ID",
        },
      },
    },
  },
];

// ── Tool 핸들러 ──

function handleScheduleSet(args) {
  const table = loadSchedules();
  const { name, cron, action, actionInput, output, enabled, prompt } = args;

  if (!name || !cron) {
    return { isError: true, content: [{ type: "text", text: "name과 cron은 필수입니다" }] };
  }

  // cron 검증
  const cronParts = cron.trim().split(/\s+/);
  if (cronParts.length !== 5) {
    return { isError: true, content: [{ type: "text", text: `cron은 5필드여야 합니다: "${cron}"` }] };
  }

  // 기존 항목 찾기 (이름으로)
  let entry = table.schedules.find((e) => e.name === name);

  if (entry) {
    // 업데이트
    entry.cron = cron;
    if (action !== undefined) entry.action = action;
    if (actionInput !== undefined) entry.actionInput = actionInput;
    if (output !== undefined) entry.output = output;
    if (enabled !== undefined) entry.enabled = enabled;
  } else {
    // 새 항목
    entry = {
      id: generateId(),
      name,
      cron,
      output: output || "daily-note",
      enabled: enabled !== false,
      lastRun: null,
      createdAt: new Date().toISOString(),
      source: "mcp",
      action: action || "claude-prompt",
      actionInput: actionInput || undefined,
    };
    table.schedules.push(entry);
  }

  saveSchedules(table);

  // 프롬프트 파일 저장
  if (prompt && (!action || action === "claude-prompt")) {
    if (!existsSync(SCHEDULES_DIR)) mkdirSync(SCHEDULES_DIR, { recursive: true });
    writeFileSync(join(SCHEDULES_DIR, `${entry.id}.md`), prompt, "utf-8");
  }

  return {
    content: [{
      type: "text",
      text: `스케줄 ${entry ? "수정" : "등록"} 완료: "${name}" [${cron}] (ID: ${entry.id})`,
    }],
  };
}

function handleScheduleList(args) {
  const table = loadSchedules();
  let schedules = table.schedules;

  if (args?.enabled_only) {
    schedules = schedules.filter((e) => e.enabled);
  }

  if (schedules.length === 0) {
    return { content: [{ type: "text", text: "등록된 스케줄이 없습니다." }] };
  }

  const lines = schedules.map((e) => {
    const status = e.enabled ? "✓" : "✗";
    const action = e.action || "claude-prompt";
    const lastRun = e.lastRun ? new Date(e.lastRun).toLocaleString("ko-KR") : "없음";
    return `${status} ${e.name} [${e.cron}] (${action}) — 마지막 실행: ${lastRun}`;
  });

  return {
    content: [{
      type: "text",
      text: `스케줄 ${schedules.length}개:\n\n${lines.join("\n")}`,
    }],
  };
}

function handleScheduleDelete(args) {
  const { name } = args;
  if (!name) {
    return { isError: true, content: [{ type: "text", text: "name은 필수입니다" }] };
  }

  const table = loadSchedules();
  const idx = table.schedules.findIndex((e) => e.name === name || e.id === name);

  if (idx < 0) {
    return { isError: true, content: [{ type: "text", text: `스케줄 "${name}"을 찾을 수 없습니다` }] };
  }

  const removed = table.schedules.splice(idx, 1)[0];
  saveSchedules(table);

  // 프롬프트 파일 삭제
  try {
    const promptPath = join(SCHEDULES_DIR, `${removed.id}.md`);
    if (existsSync(promptPath)) unlinkSync(promptPath);
  } catch { /* ignore */ }

  return {
    content: [{
      type: "text",
      text: `스케줄 삭제 완료: "${removed.name}" (ID: ${removed.id})`,
    }],
  };
}

// ── JSON-RPC 2.0 ──

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "obsidian-ai-terminal-schedule",
            version: "0.1.0",
          },
        },
      };

    case "notifications/initialized":
      return null; // 알림은 응답 없음

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = params;
      let result;

      switch (name) {
        case "schedule/set":
          result = handleScheduleSet(args || {});
          break;
        case "schedule/list":
          result = handleScheduleList(args || {});
          break;
        case "schedule/delete":
          result = handleScheduleDelete(args || {});
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${name}` },
          };
      }

      return { jsonrpc: "2.0", id, result };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
  }
}

// ── stdio transport ──

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const request = JSON.parse(line);
    const response = handleRequest(request);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
    process.stdout.write(JSON.stringify(errorResponse) + "\n");
  }
});

process.stderr.write("MCP Schedule Server started\n");
