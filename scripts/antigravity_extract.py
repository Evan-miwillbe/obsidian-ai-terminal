#!/usr/bin/env python3
"""
Antigravity Conversation Extractor
===================================
Go Language Server의 GetCascadeTrajectory gRPC API를 통해
로컬 암호화된 .pb 대화 파일을 복호화하여 JSON/Markdown으로 추출한다.

사용법:
  python antigravity_extract.py                    # 전체 대화 추출
  python antigravity_extract.py --id 71b49a5a...   # 특정 대화만
  python antigravity_extract.py --list              # 대화 목록만
  python antigravity_extract.py --format md         # 마크다운 출력
  python antigravity_extract.py --output ./out      # 출력 디렉토리 지정

원리:
  1. 실행 중인 language_server_windows_x64.exe 프로세스에서 포트/CSRF 토큰 추출
  2. GetCascadeTrajectory gRPC/Connect API 호출 (HTTPS, localhost)
  3. LS가 .pb 파일을 AES-GCM 복호화 → protobuf 역직렬화 → JSON 반환
  4. JSON에서 user/assistant 텍스트 추출 → 파일 저장

제약:
  - Antigravity 앱이 실행 중이어야 함 (LS 프로세스 필요)
  - 현재 Windows 유저 세션에서만 동작
  - 원본 .pb 파일은 일절 수정하지 않음 (read-only)
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

# UTF-8 stdout 강제 (Windows 터미널 mojibake 방지)
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

KST = timezone(timedelta(hours=9))
ANTIGRAVITY_DIR = Path.home() / ".gemini" / "antigravity"
CONVERSATIONS_DIR = ANTIGRAVITY_DIR / "conversations"
IMPLICIT_DIR = ANTIGRAVITY_DIR / "implicit"
ANNOTATIONS_DIR = ANTIGRAVITY_DIR / "annotations"


# ---------------------------------------------------------------------------
# 1. LS 프로세스 탐지
# ---------------------------------------------------------------------------

def discover_ls_instances():
    """실행 중인 language_server 프로세스에서 포트와 CSRF 토큰을 추출한다."""
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
        print(f"[ERROR] LS 프로세스 탐지 실패: {e}", file=sys.stderr)
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

        # 포트 탐지: netstat
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
    """특정 PID가 리슨하는 TCP 포트 목록을 반환한다."""
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
# 2. gRPC/Connect API 호출
# ---------------------------------------------------------------------------

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


def call_ls_api(port, csrf, method, payload=None):
    """LS의 Connect API를 호출하고 JSON 응답을 반환한다."""
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
    """Heartbeat로 응답하는 HTTPS 포트를 찾는다."""
    for port in instance["ports"]:
        result = call_ls_api(port, instance["csrf"], "Heartbeat")
        if "_error" not in result:
            return port
    return None


def get_trajectory(port, csrf, cascade_id):
    """GetCascadeTrajectory 호출로 복호화된 대화 데이터를 반환한다."""
    return call_ls_api(port, csrf, "GetCascadeTrajectory", {"cascadeId": cascade_id})


# ---------------------------------------------------------------------------
# 3. 로컬 메타데이터 수집
# ---------------------------------------------------------------------------

def list_conversations():
    """conversations/ 디렉토리의 .pb 파일 목록과 메타데이터를 반환한다."""
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
    """annotations/{id}.pbtxt에서 last_user_view_time을 읽는다."""
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
# 4. 변환: Trajectory → Markdown
# ---------------------------------------------------------------------------

def trajectory_to_markdown(traj_data, cascade_id):
    """Trajectory JSON을 읽기 쉬운 마크다운으로 변환한다."""
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
    """한 줄 요약을 반환한다."""
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
    """ISO timestamp → KST 표시용 문자열."""
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
# 5. 메인
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Antigravity 대화 추출기")
    parser.add_argument("--list", action="store_true", help="대화 목록만 출력")
    parser.add_argument("--id", type=str, help="특정 cascade_id만 추출")
    parser.add_argument("--format", choices=["json", "md", "both"], default="both", help="출력 형식")
    parser.add_argument("--output", type=str, default=None, help="출력 디렉토리")
    parser.add_argument("--implicit", action="store_true", help="implicit 대화도 포함")
    args = parser.parse_args()

    # 출력 디렉토리
    if args.output:
        out_dir = Path(args.output)
    else:
        out_dir = Path.home() / ".gemini" / "antigravity" / "_extracted"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 대화 목록
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

    # LS 탐지
    print("[1/4] LS 프로세스 탐지 중...")
    instances = discover_ls_instances()
    if not instances:
        print("[ERROR] 실행 중인 Antigravity LS가 없습니다. 앱을 먼저 실행하세요.", file=sys.stderr)
        sys.exit(1)

    # 작동하는 포트 찾기
    working = []
    for inst in instances:
        port = find_working_port(inst)
        if port:
            working.append({"port": port, "csrf": inst["csrf"], "workspace": inst["workspace"]})
            print(f"  LS 발견: port={port}, workspace={inst['workspace'][:30]}")

    if not working:
        print("[ERROR] 응답하는 LS를 찾을 수 없습니다.", file=sys.stderr)
        sys.exit(1)

    # 추출 대상 필터
    if args.id:
        targets = [c for c in convs if c["cascade_id"].startswith(args.id)]
        if not targets:
            print(f"[ERROR] ID '{args.id}'에 해당하는 대화가 없습니다.", file=sys.stderr)
            sys.exit(1)
    else:
        targets = convs

    print(f"[2/4] {len(targets)}개 대화 추출 시작...")

    # 추출
    success = 0
    fail = 0
    summaries = []

    for i, conv in enumerate(targets, 1):
        cid = conv["cascade_id"]
        label = f"[{i}/{len(targets)}] {cid[:12]}..."

        # 아무 LS에서든 시도
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

        # JSON 저장
        if args.format in ("json", "both"):
            json_path = out_dir / f"{cid}.json"
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(traj_data, f, ensure_ascii=False, indent=2)

        # Markdown 저장
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

    # 인덱스 저장
    print(f"[3/4] 인덱스 저장...")
    index_path = out_dir / "_index.json"
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({
            "extracted_at": datetime.now(KST).isoformat(),
            "total": len(targets),
            "success": success,
            "fail": fail,
            "conversations": summaries,
        }, f, ensure_ascii=False, indent=2)

    print(f"[4/4] 완료!")
    print(f"  성공: {success}, 실패/스킵: {fail}")
    print(f"  출력: {out_dir}")


if __name__ == "__main__":
    main()
