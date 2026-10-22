#!/usr/bin/env python3
"""NOT-513 AC5: run real interactive claude on this branch's bridge + status line."""
import os, pty, select, subprocess, time, datetime
E = "/tmp/not513-e2e"
CMD = ["claude", "--settings", E + "/settings.json", "--mcp-config", E + "/mcp.json", "--strict-mcp-config"]
for k in ("CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "MUSE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_PROJECT_DIR"):
    os.environ.pop(k, None)
def now(): return datetime.datetime.now(datetime.UTC).replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"
ev = open(E + "/logs/driver-events.log", "a")
def mark(msg): ev.write(f"{now()} {msg}\n"); ev.flush()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(E + "/ws")
    os.execvp(CMD[0], CMD)
    os._exit(127)
mark("claude spawned (folder use.json = Launched Deck; sibling bridge live on Other Session)")
out = open(E + "/logs/pty-out.bin", "wb")
steps = {"trust": False, "default": False, "prompt": False, "exit": False}
start = time.time()
try:
    while time.time() - start < 75:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            out.write(data)
        t = time.time() - start
        if t > 5 and not steps["trust"]:
            os.write(fd, b"\x1b[B"); time.sleep(0.5); os.write(fd, b"\r"); steps["trust"] = True; mark("selected Yes, I trust this folder")
        if t > 22 and not steps["default"]:
            subprocess.run([E + "/scripts/ad", "use", "Folder Default"], cwd=E + "/ws", capture_output=True)
            steps["default"] = True; mark("agent-deck use 'Folder Default' (folder default now differs from launched deck)")
        if t > 30 and not steps["prompt"]:
            os.write(fd, b"reply with the single word ok"); time.sleep(0.3); os.write(fd, b"\r")
            steps["prompt"] = True; mark("sent prompt")
        if t > 62 and not steps["exit"]:
            os.write(fd, b"/exit"); time.sleep(0.3); os.write(fd, b"\r"); steps["exit"] = True; mark("sent /exit")
finally:
    out.close()
    try: os.close(fd)
    except OSError: pass
mark("driver done")
