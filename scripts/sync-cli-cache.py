#!/usr/bin/env python3
"""Match the host CLI version using a shared, atomically published Linux cache."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

VERSION = re.compile(r"(?<![\w.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.])")


def run(args, *, capture=False, timeout=60):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None, timeout=timeout).stdout


def version_of(args):
    output = run(args, capture=True, timeout=30)
    match = VERSION.search(output)
    if not match:
        raise ValueError("Could not read CLI version")
    return match.group(1)


def host_command(runtime):
    # Finder-launched desktop builds may not inherit ~/.local/bin in PATH.
    found = shutil.which(runtime)
    if found:
        return found
    for directory in (Path.home() / ".local/bin", Path("/opt/homebrew/bin"), Path("/usr/local/bin")):
        candidate = directory / runtime
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise FileNotFoundError("Host " + runtime + " is not installed")


def say(message):
    print("  " + message, flush=True)


@contextlib.contextmanager
def cache_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            say("Waiting for another launcher to finish preparing this CLI cache...")
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def executable(runtime, root):
    if runtime == "claude":
        return str(root) + "/claude"
    return str(root) + "/node_modules/@openai/codex/bin/codex.js"


def helper(image, stage, command, *args):
    # No user credentials or workspaces are mounted into the download helper.
    name = "autodex-cli-cache-" + uuid.uuid4().hex[:12]
    try:
        return run(["docker", "run", "--rm", "--name", name, "--user", str(os.getuid()) + ":" + str(os.getgid()),
                    "--entrypoint", "/bin/bash", "-e", "HOME=/tmp/cli-home",
                    "-e", "CLAUDE_CONFIG_DIR=/tmp/cli-home/.claude",
                    "-e", "XDG_DATA_HOME=/tmp/cli-home/.local/share",
                    "-e", "XDG_CACHE_HOME=/tmp/cli-home/.cache",
                    "--mount", "type=bind,src=" + str(stage) + ",dst=/cache",
                    image, "-ceu", command, "--", *args], timeout=1200)
    finally:
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)


def seed_from_container(runtime, version, container, stage):
    """Reuse an already matching Linux installation before downloading anything."""
    if version_of(["docker", "exec", container, runtime, "--version"]) != version:
        return False
    if runtime == "claude":
        source = run(["docker", "exec", container, "sh", "-c",
                      'readlink -f "$(command -v claude)"'], capture=True).strip()
        # Only seed a native binary, not our launcher wrapper or another shim.
        magic = run(["docker", "exec", container, "sh", "-c",
                     'od -An -tx1 -N4 "$1"', "--", source], capture=True).split()
        if magic != ["7f", "45", "4c", "46"]:
            return False
        run(["docker", "cp", container + ":" + source, str(stage / "claude")])
    else:
        root = run(["docker", "exec", container, "npm", "root", "-g"], capture=True).strip()
        package = root + "/@openai/codex"
        metadata = json.loads(run(["docker", "exec", container, "cat", package + "/package.json"], capture=True))
        if metadata.get("version") != version:
            return False
        destination = stage / "node_modules/@openai/codex"
        destination.mkdir(parents=True)
        run(["docker", "cp", container + ":" + package + "/.", str(destination)])
    say("Reusing matching Linux " + runtime + " " + version + " from " + container)
    return True


def prepare_cache(runtime, version, platform, image, container, cache):
    destination = cache / runtime / platform / version
    marker = destination / ".ready.json"
    if marker.is_file() and Path(executable(runtime, destination)).is_file():
        say("Using cached Linux " + runtime + " " + version)
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".download-", dir=destination.parent))
    try:
        seeded = False
        try:
            seeded = seed_from_container(runtime, version, container, stage)
        except (subprocess.SubprocessError, ValueError, OSError):
            # A nonstandard or incomplete installation is not a usable seed.
            shutil.rmtree(stage)
            stage.mkdir()
        if not seeded:
            say("Downloading Linux " + runtime + " " + version + " once; subsequent sessions reuse this cache...")
            if runtime == "codex":
                helper(image, stage,
                       'npm install --prefix /cache --package-lock=false --no-audit --no-fund "@openai/codex@$1"', version)
            else:
                helper(image, stage,
                       'mkdir -p "$HOME"; /home/node/.local/bin/claude install "$1"; '
                       'cp "$HOME/.local/share/claude/versions/$1" /cache/claude', version)
        # Check the actual Linux executable before publishing. Failed/partial downloads
        # never become visible to another launcher as a complete cache entry.
        helper(image, stage,
               'actual=$("$1" --version); printf "%s\n" "$actual"; '
               'case "$actual" in "$2 "*|"codex-cli $2"|"$2") ;; *) exit 1 ;; esac',
               executable(runtime, "/cache"), version)
        (stage / ".ready.json").write_text(json.dumps({"runtime": runtime, "version": version, "platform": platform}) + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        stage.rename(destination)
        return destination
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def install_cached(runtime, version, container, cached):
    base = "/opt/autodex-cli/" + runtime
    destination = base + "/" + version
    marker = destination + "/.ready.json"
    # Containers keep versioned installs too, so reconnects don't copy large binaries.
    exists = subprocess.run(["docker", "exec", container, "test", "-f", marker],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not exists:
        stage = base + "/.install-" + uuid.uuid4().hex
        try:
            run(["docker", "exec", "-u", "0", container, "mkdir", "-p", stage])
            run(["docker", "cp", str(cached) + "/.", container + ":" + stage], timeout=180)
            run(["docker", "exec", "-u", "0", container, "chmod", "-R", "a+rX", stage])
            actual = version_of(["docker", "exec", container, executable(runtime, stage), "--version"])
            if actual != version:
                raise ValueError("Cached CLI version mismatch: " + actual)
            run(["docker", "exec", "-u", "0", container, "sh", "-ceu",
                 'chmod -R a+rX "$1"; rm -rf "$2"; mv "$1" "$2"', "--", stage, destination])
        finally:
            subprocess.run(["docker", "exec", "-u", "0", container, "rm", "-rf", stage],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    # Never overwrite an executable in use. Swap only a small wrapper atomically.
    binary = executable(runtime, destination)
    wrapper = "#!/bin/sh\n"
    if runtime == "claude":
        wrapper += "export DISABLE_AUTOUPDATER=1\n"
    wrapper += "exec " + shlex.quote(binary) + ' "$@"\n'
    link = "/home/node/.local/bin/claude" if runtime == "claude" else "/usr/local/bin/codex"
    script = ('mkdir -p "$(dirname "$1")"; tmp="$1.cache-$$"; '
              'printf "%s" "$2" > "$tmp"; chmod 755 "$tmp"; mv -Tf "$tmp" "$1"')
    run(["docker", "exec", "-u", "0", container, "sh", "-ceu", script, "--", link, wrapper])
    actual = version_of(["docker", "exec", container, runtime, "--version"])
    if actual != version:
        raise ValueError("Activated CLI version mismatch: " + actual)
    say(runtime + " " + version + " ready (matches host)")


def sync(runtime, container, cache):
    try:
        version = version_of([host_command(runtime), "--version"])
    except (subprocess.SubprocessError, ValueError, OSError):
        say("Host " + runtime + " unavailable; keeping the container's installed CLI")
        return
    say("Host " + runtime + " version: " + version)
    image = run(["docker", "inspect", "--format", "{{.Image}}", container], capture=True).strip()
    platform = run(["docker", "image", "inspect", "--format", "{{.Os}}-{{.Architecture}}", image], capture=True).strip()
    if platform not in ("linux-arm64", "linux-amd64"):
        raise ValueError("Unsupported container platform: " + platform)
    with cache_lock(cache / runtime / (platform + ".lock")):
        cached = prepare_cache(runtime, version, platform, image, container, cache)
        install_cached(runtime, version, container, cached)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", choices=("claude", "codex"))
    parser.add_argument("container")
    parser.add_argument("--cache-dir", type=Path,
                        default=Path(__file__).resolve().parent.parent / "cli-data/linux-cli-cache")
    args = parser.parse_args()
    try:
        sync(args.runtime, args.container, args.cache_dir.resolve())
    except (subprocess.SubprocessError, ValueError, OSError) as error:
        say("Could not prepare matching " + args.runtime + ": " + str(error))
        # Keep an offline startup usable, but never claim that the versions match.
        try:
            installed = version_of(["docker", "exec", args.container, args.runtime, "--version"])
        except (subprocess.SubprocessError, ValueError, OSError):
            return 1
        say("Continuing with installed " + args.runtime + " " + installed + "; will retry matching host on next launch")
    return 0


if __name__ == "__main__":
    sys.exit(main())
