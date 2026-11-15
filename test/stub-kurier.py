#!/usr/bin/env python3
"""Fake kurier.py for the test harness.

Prints the same JSON envelope shape as the real helper:
{"http_status": N, "body": ...} and exits 0 whenever it "answers".

Env:
  STUB_LOG  — file to append one line per invocation (the argv).
  STUB_MODE — "ok" (default) or "401" (simulate the rejected-key case).

Invoked exactly like the real helper:
  stub-kurier.py submit-proof --proof <f> --public-signals <f> [--vk-hash <h>]
  stub-kurier.py job-status --job-id <id>
"""
import json
import os
import sys


def main() -> int:
    log_path = os.environ.get("STUB_LOG", "")
    mode = os.environ.get("STUB_MODE", "ok")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(" ".join(sys.argv[1:]) + "\n")
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"http_status": 400, "body": {"error": "no command"}}))
        return 0
    if mode == "401":
        print(json.dumps({"http_status": 401, "body": {"error": "Unauthorized"}}))
        return 0
    cmd = args[0]
    if cmd == "submit-proof":
        print(
            json.dumps(
                {
                    "http_status": 200,
                    "body": {"jobId": "stub-job-123", "status": "Submitted"},
                }
            )
        )
    elif cmd == "job-status":
        job_id = args[args.index("--job-id") + 1] if "--job-id" in args else "?"
        print(
            json.dumps(
                {
                    "http_status": 200,
                    "body": {"jobId": job_id, "status": "Finalized"},
                }
            )
        )
    else:
        print(json.dumps({"http_status": 400, "body": {"error": "unknown command"}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
