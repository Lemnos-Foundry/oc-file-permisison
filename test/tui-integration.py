"""Manual PTY smoke test. Uses a disposable conversation without invoking a model."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def api(method, route, body=None):
    args = ["opencode", "api", method, route]
    if body is not None:
        args += ["--data", json.dumps(body)]
    result = subprocess.run(args, capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout) if result.stdout.strip() else None


directory = sys.argv[1]
session = api("post", "/api/session", {
    "title": "Session folder plugin terminal smoke test", "location": {"directory": directory}, "agent": "build",
})["data"]
session_id = session["id"]
resource = "/session-folder-permissions-tui-test/reference/*"
pid = None
fd = None
output = bytearray()


def drain(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([fd], [], [], min(0.1, max(0, end - time.monotonic())))[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)


def text():
    value = output.decode("utf-8", errors="replace")
    value = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", value)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)


def ask():
    return api("post", f"/api/session/{session_id}/permission", {
        "action": "external_directory", "resources": [resource], "save": [resource],
    })["data"]


try:
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
        os.execvp("opencode", ["opencode", directory, "--session", session_id])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    drain(6)
    assert ask()["effect"] == "ask"
    drain(2)
    # Kitty/CSI-u encoding for Ctrl+Alt+A, supported by OpenTUI's input parser.
    os.write(fd, b"\x1b[97;7u")
    drain(2)
    assert "Allow external folder for this session?" in text(), "Temporary approval dialog did not open"
    print("PASS: Ctrl+Alt+A opens the confirmation while a permission request is pending")
    os.write(fd, b"\r")
    drain(2)
    assert ask()["effect"] == "allow", "Terminal confirmation did not grant temporary access"
    print("PASS: terminal confirmation grants temporary access")
    # Exceed the lease TTL to confirm that a live terminal really sends heartbeats.
    drain(14)
    assert ask()["effect"] == "allow", "Live terminal did not maintain its lease"
    print("PASS: live terminal heartbeat maintains the grant")
    os.write(fd, b"\x03")
    drain(1)
    exited, status = os.waitpid(pid, os.WNOHANG)
    if exited != pid:
        try:
            os.write(fd, b"\x03")
        except OSError:
            # The terminal may close its PTY before the CLI wrapper finishes exiting.
            pass
        drain(3)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited == pid:
                break
            time.sleep(0.1)
    assert exited == pid, "Terminal did not shut down normally"
    pid = None
    assert os.waitstatus_to_exitcode(status) == 0, "Terminal exited with an error"
    assert ask()["effect"] == "ask", "Normal terminal exit did not immediately revoke the grant"
    print("PASS: normal terminal closure immediately revokes access for the same conversation")
except Exception:
    # Only this test's empty session is rendered here. No prompts or file contents are sent.
    print(text()[-8000:], file=sys.stderr)
    raise
finally:
    if pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    if fd is not None:
        os.close(fd)
    api("delete", f"/api/session/{session_id}")
