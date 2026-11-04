# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"""Private throwaway transaction fixture. No app DB, secrets, or retained-state claim."""
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

BOOT = str(uuid.uuid4())
SHA = os.environ.get("APP_BUILD_SHA", "")
DB = os.environ.get("FIXTURE_DB", os.path.join(tempfile.gettempdir(), "qualification.sqlite"))
PORT = int(os.environ.get("PORT", "9101"))
MAX_ROWS = 256


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def emit(event, **fields):
    print(json.dumps(dict(event=event, buildSha=SHA, bootId=BOOT, **fields)), flush=True)


with sqlite3.connect(DB) as db:
    db.execute("CREATE TABLE IF NOT EXISTS fixture (release TEXT PRIMARY KEY, receipt TEXT NOT NULL)")


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *_):
        pass

    def reply(self, code, value):
        data = canonical(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/version":
            return self.reply(200, dict(buildSha=SHA, bootId=BOOT))
        if self.path in ("/readyz", "/readyz-alt"):
            return self.reply(200, dict(buildSha=SHA, bootId=BOOT, ready=True))
        # Select this actual path in Score to exercise a real failed readiness response.
        if self.path == "/readyz-fail":
            return self.reply(503, dict(buildSha=SHA, bootId=BOOT, ready=False))
        if self.path.startswith("/fixture/"):
            release = unquote(self.path[len("/fixture/"):])
            with sqlite3.connect(DB, timeout=2) as db:
                row = db.execute("SELECT receipt FROM fixture WHERE release = ?", (release,)).fetchone()
            return self.reply(200 if row else 404, json.loads(row[0]) if row else dict(error="absent"))
        self.reply(404, dict(error="unknown_path"))

    def do_POST(self):
        reserve = self.path == "/fixture/reserve"
        commit = self.path.startswith("/fixture/") and self.path.endswith("/commit")
        if not (reserve or commit):
            return self.reply(404, dict(error="unknown_path"))
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 0 < size <= 8192:
                raise ValueError("body_size")
            subject = json.loads(self.rfile.read(size))
            if not isinstance(subject, dict) or subject.get("helperBootId") != BOOT or subject.get("sourceSha") != SHA:
                raise ValueError("wrong_helper")
            release = subject.get("releaseId", "")
            if not isinstance(release, str) or not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", release):
                raise ValueError("release_id")
            if commit and unquote(self.path) != "/fixture/" + release + "/commit":
                raise ValueError("release_path")
            inserted = False
            worked = False
            with sqlite3.connect(DB, timeout=2) as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT receipt FROM fixture WHERE release = ?", (release,)).fetchone()
                if row:
                    receipt = json.loads(row[0])
                    if receipt["subject"] != subject:
                        return self.reply(409, dict(error="subject_changed"))
                    if commit and receipt["value"] == 0:
                        receipt["value"] = 1
                        db.execute("UPDATE fixture SET receipt = ? WHERE release = ?", (canonical(receipt), release))
                        worked = True
                else:
                    if not reserve:
                        return self.reply(409, dict(error="not_reserved"))
                    if db.execute("SELECT count(*) FROM fixture").fetchone()[0] >= MAX_ROWS:
                        return self.reply(507, dict(error="fixture_full"))
                    # Reserve the release PK; only the confirmed commit winner may ask for work.
                    receipt = dict(subject=subject, value=0,
                                   evidenceId=hashlib.sha256(canonical(subject).encode()).hexdigest())
                    db.execute("INSERT INTO fixture VALUES (?, ?)", (release, canonical(receipt)))
                    inserted = True
            # Success is returned only after the transaction context committed.
            if worked:
                emit("fixture.useful_work", releaseId=release, attemptId=subject.get("attemptId"),
                     allocation=subject.get("allocation"), env=subject.get("env"),
                     nodeId=subject.get("nodeId"), evidenceId=receipt["evidenceId"],
                     observedAt=datetime.now(timezone.utc).isoformat())
            self.reply(200, dict(inserted=inserted) if reserve else receipt)
        except (ValueError, TypeError, sqlite3.Error, TimeoutError):
            self.reply(400, dict(error="fixture_refused"))


if __name__ == "__main__":
    if not re.fullmatch(r"[a-f0-9]{40}", SHA):
        raise SystemExit("full APP_BUILD_SHA required")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    emit("fixture.helper_boot", port=server.server_port)
    server.serve_forever()
