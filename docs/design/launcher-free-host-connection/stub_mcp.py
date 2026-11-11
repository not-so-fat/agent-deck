#!/usr/bin/env python3
"""Recording stub streamable-HTTP MCP server. Usage: stub_mcp.py PORT LOGFILE [--restart-after-first-call]
Logs one JSON line per request: method, path, selected headers, JSON-RPC method, response status.
With --restart-after-first-call it forgets all sessions after the first tools/call (simulated daemon restart),
so the next request carrying the old Mcp-Session-Id gets 404 (spec: client MUST re-initialize)."""
import json, sys, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]
RESTART = "--restart-after-first-call" in sys.argv
sessions, state = set(), {"calls": 0}
KEEP = ("x-agent-deck-workspace", "x-agent-deck-deck-id", "mcp-session-id", "user-agent", "authorization")


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, code, body=None, extra=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        if body is not None:
            self.send_header("content-type", "application/json")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        hdrs = {k: v for k, v in self.headers.items() if k.lower() in KEEP}
        sid = self.headers.get("mcp-session-id")
        code = 405 if (sid in sessions or not sid) else 404
        log({"http": "GET", "headers": hdrs, "status": code})
        self.reply(code)

    def do_DELETE(self):
        log({"http": "DELETE", "status": 200})
        self.reply(200)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n)
        try:
            msg = json.loads(raw)
        except Exception:
            msg = {}
        method, mid = msg.get("method"), msg.get("id")
        hdrs = {k: v for k, v in self.headers.items() if k.lower() in KEEP}
        sid = self.headers.get("mcp-session-id")
        rec = {"http": "POST", "rpc": method, "headers": hdrs}
        if method == "initialize":
            new = uuid.uuid4().hex
            sessions.add(new)
            rec.update(status=200, issued_session=new)
            log(rec)
            return self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "stub", "version": "0"}}},
                {"Mcp-Session-Id": new})
        if sid not in sessions:
            rec.update(status=404, note="unknown session id")
            log(rec)
            return self.reply(404, {"jsonrpc": "2.0", "id": mid, "error": {"code": -32001, "message": "Session expired; re-initialize"}},
                              {"mcp-session-status": "expired"})
        rec["status"] = 200 if mid is not None else 202
        if method == "tools/list":
            log(rec)
            return self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
                "name": "ping", "description": "Returns pong. Call it when asked to ping.",
                "inputSchema": {"type": "object", "properties": {}}}]}})
        if method == "tools/call":
            state["calls"] += 1
            log(rec)
            if RESTART and state["calls"] == 1:
                sessions.clear()
                log({"event": "SIMULATED_RESTART: all sessions forgotten"})
            return self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "pong"}]}})
        log(rec)
        if mid is None:
            return self.reply(202)
        return self.reply(200, {"jsonrpc": "2.0", "id": mid, "result": {}})


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
