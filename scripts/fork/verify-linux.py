#!/usr/bin/env python3
"""Exercise the final CLI archive in clean Rocky Linux 8 userspace."""
import os
import pathlib
import re
import selectors
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

artifacts, logs = map(pathlib.Path, sys.argv[1:])
logs.mkdir(parents=True, exist_ok=True)
scripts = pathlib.Path(__file__).resolve().parent
assert subprocess.check_output(["getconf", "GNU_LIBC_VERSION"], text=True).strip() == "glibc 2.28"

def run(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, timeout=120, **kwargs)

def until_ready(args, markers, logfile, **kwargs):
    process = subprocess.Popen(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
    output = ""
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 120
            while not all(marker in output for marker in markers):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"Missing ready signal: {markers}")
                events = selector.select(remaining)
                if not events:
                    raise RuntimeError(f"No ready signal: {markers}")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(f"Process exited before readiness: {process.poll()}")
                output += chunk.decode(errors="replace")
        return process
    except BaseException:
        process.terminate()
        process.wait(timeout=15)
        raise
    finally:
        # Only temporary test credentials exist here, but keep them out of CI artifacts.
        safe = re.sub(r"(?im)^.*(?:Token:|Pairing URL:|App link:|Connection string:).*$", "[test pairing credential removed]", output)
        logfile.write_text(safe)

def stop(process):
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

with tempfile.TemporaryDirectory(prefix="t3-rhel8-") as temporary:
    scratch = pathlib.Path(temporary)
    env = {**os.environ, "HOME": str(scratch / "home"), "XDG_CONFIG_HOME": str(scratch / "config"), "XDG_CACHE_HOME": str(scratch / "cache"), "T3CODE_HOME": str(scratch / "state"), "T3CODE_TELEMETRY_ENABLED": "false", "DO_NOT_TRACK": "1"}
    pathlib.Path(env["HOME"]).mkdir()
    (scratch / "rhel8-native-probe.txt").touch()
    archive, = artifacts.glob("t3-*-linux-x64.tar.gz")
    with tarfile.open(archive) as bundle:
        bundle.extractall(scratch / "cli", filter="data")
    cli, = (scratch / "cli").iterdir()
    for file in cli.rglob("*"):
        if file.name.startswith(("libc.so", "ld-linux")):
            raise RuntimeError(f"The archive must not distribute glibc or its loader: {file.name}")
    run([sys.executable, scripts / "check-linux-abi.py", cli])
    run([cli / "t3", "--version"], env=env)
    dependencies = subprocess.check_output(["ldd", str(cli / "t3")], text=True)
    if "not found" in dependencies or str(cli / "lib/libatomic.so.1") not in dependencies:
        raise RuntimeError(f"CLI dependencies do not resolve to the bundled libatomic:\n{dependencies}")
    # The test driver has the same Node version as the SEA runtime. Only the archive supplies libatomic.
    run(["/opt/test-node/node", scripts / "verify-native.cjs", cli], cwd=scratch,
        env={**env, "LD_LIBRARY_PATH": str(cli / "lib")})
    monitor = cli / "resource-monitor/t3-resource-monitor"
    probe = subprocess.run([str(monitor)], input='{"type":"shutdown","version":2}\n', capture_output=True, text=True, check=True, timeout=10)
    if '\"type\":\"hello\"' not in probe.stdout:
        raise RuntimeError("Packaged resource monitor did not send its hello message")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    server = until_ready([cli / "t3", "serve", "--host", "127.0.0.1", "--port", str(port), "--no-browser"], ["T3 Code server is ready."], logs / "cli.log", cwd=cli, env={**env, "PATH": ""})
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as response:
            assert response.status == 200
    finally:
        stop(server)
    print("Final CLI archive passed RHEL 8 verification without host Node or a glibc replacement.")
(logs / "passed.txt").write_text("RHEL 8 final CLI artifact verification passed.\n")
