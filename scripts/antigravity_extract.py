#!/usr/bin/env python3
"""
Antigravity Conversation Extractor
===================================
通过 Go Language Server 的 GetCascadeTrajectory gRPC API，
将本地加密的 .pb 对话文件解密并提取为 JSON/Markdown 格式。

用法：
  python antigravity_extract.py                    # 提取全部对话
  python antigravity_extract.py --id 71b49a5a...   # 仅提取特定对话
  python antigravity_extract.py --list              # 仅列出对话
  python antigravity_extract.py --format md         # Markdown 输出
  python antigravity_extract.py --output ./out      # 指定输出目录

原理：
  1. 从运行中的 language_server_windows_x64.exe 进程提取端口/CSRF 令牌
  2. 调用 GetCascadeTrajectory gRPC/Connect API（HTTPS, localhost）
  3. LS 对 .pb 文件进行 AES-GCM 解密 → protobuf 反序列化 → 返回 JSON
  4. 从 JSON 中提取 user/assistant 文本 → 保存到文件

限制：
  - 需要正在运行 Antigravity 应用（需要 LS 进程）
  - 仅在当前 Windows 用户会话中运行
  - 不修改原始 .pb 文件（只读）
"""

import argparse
import glob
import json
import os
import re
import ssl
import subprocess
import sys
import io
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# 强制 UTF-8 stdout（防止 Windows 终端乱码）
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

KST = timezone(timedelta(hours=9))
ANTIGRAVITY_DIR = Path.home() / ".gemini" / "antigravity"
CONVERSATIONS_DIR = ANTIGRAVITY_DIR / "conversations"
IMPLICIT_DIR = ANTIGRAVITY_DIR / "implicit"
ANNOTATIONS_DIR = ANTIGRAVITY_DIR / "annotations"


# ---------------------------------------------------------------------------
# 1. LS 进程检测
# ---------------------------------------------------------------------------

def discover_ls_instances():
    """从运行中的 language_server 进程提取端口和 CSRF 令牌。"""
    try:
        result = subprocess.run(
            ["powershell", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='language_server_windows_x64.exe'\" "
             "| Select-Object ProcessId, CommandLine | ConvertTo-Json"],
            capture_output=True, text=True, timeout=10
        )
        procs = json.loads(result.stdout)
        if isinstance(procs, dict):
            procs = [procs]
    except Exception as e:
        print(f"[ERROR] LS 进程检测失败：{e}", file=sys.stderr)
        return []

    instances = []
    for proc in procs:
        cmd = proc.get("CommandLine", "")
        pid = proc.get("ProcessId")

        csrf_match = re.search(r"--csrf_token\s+(\S+)", cmd)
        workspace_match = re.search(r"--workspace_id\s+(\S+)", cmd)

        if not csrf_match:
            continue

        csrf = csrf_match.group(1)
        workspace = workspace_match.group(1) if workspace_match else "unknown"

        # 端口检测：netstat
        ports = _get_listening_ports(pid)
        if not ports:
            continue

        instances.append({
            "pid": pid,
            "csrf": csrf,
            "workspace": workspace,
            "ports": sorted(ports),
        })

    return instances


def _get_listening_ports(pid):
    """返回指定 PID 正在监听的 TCP 端口列表。"""
    try:
        result = subprocess.run(
            ["powershell", "-Command",
             f"Get-NetTCPConnection -OwningProcess {pid} -State Listen -ErrorAction SilentlyContinue "
             "| Select-Object LocalPort | ConvertTo-Json"],
            capture_output=True, text=True, timeout=10
        )
        data = json.loads(result.stdout)
        if isinstance(data, dict):
            data = [data]
        return [d["LocalPort"] for d in data]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# 2. gRPC/Connect API 调用
# ---------------------------------------------------------------------------

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


def call_ls_api(port, csrf, method, payload=None):
    """调用 LS 的 Connect API 并返回 JSON 响应。"""
    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
    headers = {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": csrf,
    }
    body = json.dumps(payload or {}).encode("utf-8")
    req = Request(url, data=body, headers=headers, method="POST")

    try:
        resp = urlopen(req, timeout=60, context=_SSL_CTX)
        raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else {}
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return {"_error": e.code, "_message": err_body}
    except Exception as e:
        return {"_error": -1, "_message": str(e)}


def find_working_port(instance):
    """找到响应 Heartbeat 的 HTTPS 端口。"""
    for port in instance["ports"]:
        result = call_ls_api(port, instance["csrf"], "Heartbeat")
        if "_error" not in result:
            return port
    return None


def get_trajectory(port, csrf, cascade_id):
    """通过 GetCascadeTrajectory 调用返回解密后的对话数据。"""
    return call_ls_api(port, csrf, "GetCascadeTrajectory", {"cascadeId": cascade_id})


# ---------------------------------------------------------------------------
# 3. 本地元数据收集
# ---------------------------------------------------------------------------

def list_conversations():
    """返回 conversations/ 目录下的 .pb 文件列表和元数据。"""
    convs = []
    for pb in sorted(CONVERSATIONS_DIR.glob("*.pb"), key=os.path.getmtime, reverse=True):
        cascade_id = pb.stem
        stat = pb.stat()
        annotation = _read_annotation(cascade_id)

        convs.append({
            "cascade_id": cascade_id,
            "file_size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=KST).isoformat(),
            "last_viewed": annotation,
            "has_brain": (ANTIGRAVITY_DIR / "brain" / cascade_id).is_dir(),
        })
    return convs


def _read_annotation(cascade_id):
    """从 annotations/{id}.pbtxt 读取 last_user_view_time。"""
    pbtxt = ANNOTATIONS_DIR / f"{cascade_id}.pbtxt"
    if not pbtxt.exists():
        return None
    try:
        text = pbtxt.read_text(encoding="utf-8")
        match = re.search(r"seconds:(\d+)", text)
        if match:
            ts = int(match.group(1))
            return datetime.fromtimestamp(ts, tz=KST).isoformat()
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# 4. 转换：Trajectory → Markdown
# ---------------------------------------------------------------------------

def trajectory_to_markdown(traj_data, cascade_id):
    """将 Trajectory JSON 转换为易读的 Markdown 格式。"""
    traj = traj_data.get("trajectory", {})
    steps = traj.get("steps", [])

    lines = []
    lines.append(f"# Antigravity Conversation: {cascade_id[:8]}...")
    lines.append(f"**Trajectory ID**: {traj.get('trajectoryId', 'N/A')}")
    lines.append(f"**Type**: {traj.get('trajectoryType', 'N/A')}")
    lines.append(f"**Total Steps**: {len(steps)}")
    lines.append("")

    turn = 0
    for step in steps:
        stype = step.get("type", "UNKNOWN")
        ts = step.get("metadata", {}).get("createdAt", "")
        ts_display = _format_ts(ts)

        if "userInput" in step:
            turn += 1
            text = step["userInput"].get("userResponse", "")
            lines.append(f"---\n## Turn {turn} — User ({ts_display})\n")
            lines.append(text)
            lines.append("")

        elif "plannerResponse" in step:
            pr = step["plannerResponse"]
            response = pr.get("modifiedResponse") or pr.get("response", "")
            thinking = pr.get("thinking", "")
            lines.append(f"### Assistant ({ts_display})\n")
            if thinking:
                lines.append("<details><summary>Thinking</summary>\n")
                lines.append(thinking[:2000])
                if len(thinking) > 2000:
                    lines.append(f"\n... ({len(thinking)} chars total)")
                lines.append("\n</details>\n")
            lines.append(response)
            lines.append("")

        elif "generic" in step:
            text = step["generic"].get("text", "")
            if text:
                lines.append(f"### Agent Step: {stype} ({ts_display})\n")
                lines.append(text[:1000])
                lines.append("")

        elif "suggestedResponses" in step:
            suggestions = step["suggestedResponses"].get("suggestedResponses", [])
            if suggestions:
                lines.append(f"### Suggested Responses ({ts_display})\n")
                for s in suggestions:
                    lines.append(f"- {s.get('text', '')}")
                lines.append("")

        elif "conversationHistory" in step:
            content = step["conversationHistory"].get("content", "")
            if content:
                lines.append(f"### Conversation History Context ({ts_display})\n")
                lines.append("<details><summary>History</summary>\n")
                lines.append(content[:3000])
                lines.append("\n</details>\n")

    return "\n".join(lines)


def trajectory_to_summary(traj_data, cascade_id):
    """返回单行摘要。"""
    traj = traj_data.get("trajectory", {})
    steps = traj.get("steps", [])
    user_steps = [s for s in steps if "userInput" in s]
    first_msg = ""
    if user_steps:
        first_msg = user_steps[0]["userInput"].get("userResponse", "")[:80]
    return {
        "cascade_id": cascade_id,
        "steps": len(steps),
        "user_turns": len(user_steps),
        "first_message": first_msg,
    }


def _format_ts(iso_str):
    """ISO timestamp → KST 显示用字符串。"""
    if not iso_str:
        return ""
    try:
        # Remove nanoseconds beyond microseconds
        clean = re.sub(r"(\.\d{6})\d+", r"\1", iso_str)
        dt = datetime.fromisoformat(clean.replace("Z", "+00:00"))
        return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")
    except Exception:
        return iso_str[:19]


# ---------------------------------------------------------------------------
# 5. 主函数
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Antigravity 对话提取工具")
    parser.add_argument("--list", action="store_true", help="仅输出对话列表")
    parser.add_argument("--id", type=str, help="仅提取指定 cascade_id")
    parser.add_argument("--format", choices=["json", "md", "both"], default="both", help="输出格式")
    parser.add_argument("--output", type=str, default=None, help="输出目录")
    parser.add_argument("--implicit", action="store_true", help="同时包含 implicit 对话")
    args = parser.parse_args()

    # 输出目录
    if args.output:
        out_dir = Path(args.output)
    else:
        out_dir = Path.home() / ".gemini" / "antigravity" / "_extracted"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 对话列表
    convs = list_conversations()
    if args.implicit:
        for pb in sorted(IMPLICIT_DIR.glob("*.pb"), key=os.path.getmtime, reverse=True):
            convs.append({
                "cascade_id": pb.stem,
                "file_size": pb.stat().st_size,
                "modified": datetime.fromtimestamp(pb.stat().st_mtime, tz=KST).isoformat(),
                "last_viewed": None,
                "has_brain": False,
                "implicit": True,
            })

    if args.list:
        print(f"{'CASCADE_ID':<40} {'SIZE':>10} {'MODIFIED':>22} {'BRAIN'}")
        print("-" * 85)
        for c in convs:
            brain = "●" if c.get("has_brain") else ""
            imp = " [implicit]" if c.get("implicit") else ""
            print(f"{c['cascade_id']:<40} {c['file_size']:>10,} {c['modified'][:19]:>22} {brain}{imp}")
        print(f"\nTotal: {len(convs)} conversations")
        return

    # LS 检测
    print("[1/4] 正在检测 LS 进程...")
    instances = discover_ls_instances()
    if not instances:
        print("[ERROR] 未检测到运行中的 Antigravity LS。请先启动应用。", file=sys.stderr)
        sys.exit(1)

    # 查找可用端口
    working = []
    for inst in instances:
        port = find_working_port(inst)
        if port:
            working.append({"port": port, "csrf": inst["csrf"], "workspace": inst["workspace"]})
            print(f"  发现 LS：port={port}, workspace={inst['workspace'][:30]}")

    if not working:
        print("[ERROR] 未找到可响应的 LS。", file=sys.stderr)
        sys.exit(1)

    # 提取目标筛选
    if args.id:
        targets = [c for c in convs if c["cascade_id"].startswith(args.id)]
        if not targets:
            print(f"[ERROR] 未找到 ID 为 '{args.id}' 的对话。", file=sys.stderr)
            sys.exit(1)
    else:
        targets = convs

    print(f"[2/4] 开始提取 {len(targets)} 个对话...")

    # 提取
    success = 0
    fail = 0
    summaries = []

    for i, conv in enumerate(targets, 1):
        cid = conv["cascade_id"]
        label = f"[{i}/{len(targets)}] {cid[:12]}..."

        # 逐一尝试 LS
        traj_data = None
        for w in working:
            result = get_trajectory(w["port"], w["csrf"], cid)
            if "_error" not in result and result.get("trajectory"):
                traj_data = result
                break

        if not traj_data or not traj_data.get("trajectory"):
            print(f"  {label} SKIP (empty trajectory)")
            fail += 1
            continue

        steps = traj_data["trajectory"].get("steps", [])
        user_turns = sum(1 for s in steps if "userInput" in s)

        # 保存 JSON
        if args.format in ("json", "both"):
            json_path = out_dir / f"{cid}.json"
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(traj_data, f, ensure_ascii=False, indent=2)

        # 保存 Markdown
        if args.format in ("md", "both"):
            md_path = out_dir / f"{cid}.md"
            md_content = trajectory_to_markdown(traj_data, cid)
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(md_content)

        summary = trajectory_to_summary(traj_data, cid)
        summary["file_size"] = conv["file_size"]
        summary["modified"] = conv["modified"]
        summaries.append(summary)
        success += 1
        print(f"  {label} OK ({len(steps)} steps, {user_turns} user turns)")

    # 保存索引
    print(f"[3/4] 正在保存索引...")
    index_path = out_dir / "_index.json"
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({
            "extracted_at": datetime.now(KST).isoformat(),
            "total": len(targets),
            "success": success,
            "fail": fail,
            "conversations": summaries,
        }, f, ensure_ascii=False, indent=2)

    print(f"[4/4] 完成！")
    print(f"  成功：{success}，失败/跳过：{fail}")
    print(f"  输出目录：{out_dir}")


if __name__ == "__main__":
    main()
