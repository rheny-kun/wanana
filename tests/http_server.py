"""Local-only HTTP integration fixture. Run: python tests/http_server.py"""
import json
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/tests/api":
            if query.get("action") != ["logs"]:
                return self.reply({"ok": True, "service": "fixture; action=logs required"})
            self.send_response(302)
            self.send_header("Location", "/tests/api-data?" + url.query)
            self.end_headers()
            return
        if url.path == "/tests/api-fail":
            return self.reply({"error": "fixture unavailable"}, 503)
        if url.path == "/tests/api-data":
            now = datetime.now(timezone(timedelta(hours=9)))
            def row(node, session, seconds, **values):
                return dict(timestamp=(now - timedelta(seconds=seconds)).strftime("%Y-%m-%d %H:%M:%S"), node=node,
                            sessionId=session, event="HEALTH_TIMER", sensor="CLOSED", battery=8.1,
                            batteryStatus="NORMAL", temperature=20.3, temperatureStatus="NORMAL",
                            messageId=1, boot=1, send=1, wifiRssi=-29, loraRssi=-87, **values)
            rows = [row("trap-01", "4000000000", 3600), row("trap-01", "100", 4), row("trap-02", "B", 3)]
            receiver = row("receiver-01", "R", 2)
            receiver.update(event="RECEIVER_HEALTH", sensor=None, battery=None, batteryStatus=None,
                            temperature=None, temperatureStatus=None, loraRssi=None, wifiRssi=-35)
            rows.append(receiver)
            limit = min(2000, max(1, int(query.get("limit", [1000])[0])))
            return self.reply(rows[-limit:])
        return super().do_GET()

    def reply(self, value, status=200):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("Open http://127.0.0.1:8766/tests/dashboard.html")
    ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
