#!/usr/bin/env python3
"""Run claude interactive under a pty so the statusline command fires.
Sends one prompt, waits, then quits. Probe logs land in /tmp/not513-probe/.
"""
import os
import pty
import select
import sys
import time

CMD = [
    "claude",
    "--settings", "/tmp/not513-probe/settings.json",
    "--mcp-config", "/tmp/not513-probe/mcp.json",
]
LOG = "/tmp/not513-probe/interactive-out.txt"

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp/not513-probe")
    os.execvp(CMD[0], CMD)
    os._exit(127)

sent_hi = False
sent_exit = False
start = time.time()
out = open(LOG, "wb")
try:
    while time.time() - start < 45:
        r, _, _ = select.select([fd], [], [], 2.0)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data)
        elapsed = time.time() - start
        if elapsed > 6 and not sent_hi:
            os.write(fd, b"\x1b[B"); time.sleep(0.5); os.write(fd, b"\r")
            sent_hi = True
        if elapsed > 30 and not sent_exit:
            try:
                os.write(fd, b"/exit\r")
            except OSError:
                pass
            sent_exit = True
finally:
    out.close()
    try:
        os.close(fd)
    except OSError:
        pass
print("DONE sent_hi=%s sent_exit=%s" % (sent_hi, sent_exit))
