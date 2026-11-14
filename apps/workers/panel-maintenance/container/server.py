"""The HTTP face of the maintenance job, on port 8080.

  POST /jobs        a spec (src/spec.ts); starts it in the background, 202 {"jobId": <runId>}.
                    The same runId again answers the job that exists; a different one while
                    a job runs is refused with 409, so two rewrites never overlap.
  GET  /jobs/<id>   {"state": "running"} | {"state": "done", "result": {...}}
                    | {"state": "failed", "error": "..."}
  GET  /health      200
"""

import json
import re
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import maintenance

PORT = 8080
JOBS = {}
LOCK = threading.Lock()
# A Workflow run id: letters, digits, dash and underscore. Anything else is refused,
# so nothing a caller sends is ever echoed back unchecked.
RUN_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def run_job(run_id, spec):
    try:
        result = maintenance.run(spec)
        outcome = {"state": "done", "result": result}
    except Exception as error:  # reported to the worker, which fails the run
        traceback.print_exc()
        outcome = {"state": "failed", "error": f"{type(error).__name__}: {error}"[:500]}
    with LOCK:
        JOBS[run_id] = outcome


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        if self.path.startswith("/jobs/"):
            with LOCK:
                job = JOBS.get(self.path.removeprefix("/jobs/"))
            return self.reply(200, job) if job else self.reply(404, {"error": "unknown job"})
        return self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/jobs":
            return self.reply(404, {"error": "not found"})
        try:
            spec = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            match = RUN_ID.fullmatch(str(spec["runId"]))
            for key in ("erasures", "retention", "maxRetentionMonths", "now"):
                spec[key]  # a missing key is a bad spec
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"error": "not a maintenance spec"})
        if match is None:
            return self.reply(400, {"error": "not a maintenance spec"})
        run_id = match.group(0)
        with LOCK:
            if run_id in JOBS:
                return self.reply(200, {"jobId": run_id})
            if any(job["state"] == "running" for job in JOBS.values()):
                return self.reply(409, {"error": "another job is running"})
            JOBS[run_id] = {"state": "running"}
        threading.Thread(target=run_job, args=(run_id, spec), daemon=True).start()
        return self.reply(202, {"jobId": run_id})

    def log_message(self, format, *args):  # request lines only, never bodies
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
