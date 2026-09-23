"""Exercise keyboard handoff without starting Docker or a model request."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MARKER = "\x1b]1337;AutodexInputReady\x07"


class ClaudeStartupTest(unittest.TestCase):
    def launch(self, mode):
        source = (ROOT / "entrypoint.sh").read_text()
        helpers = source.split("emit_desktop_input_ready_marker() {", 1)[1]
        helpers = "emit_desktop_input_ready_marker() {" + helpers.split(
            "# Determine which LLM we're using", 1
        )[0]
        launcher = source.split("# Determine which LLM CLI to launch", 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name, body in {
                "claude": 'printf "CLAUDE_ARGS:%s\\n" "$*"',
                "tmux": '''
case " $* " in
  *" has-session "*)
    [ "$TEST_MODE" = reattach ] ||
      { [ "$TEST_MODE" = healthy ] && [ -f "$TEST_DIR/started" ]; } ;;
  *" new-session "*) touch "$TEST_DIR/started"; printf 'START_ARGS:%s\\n' "$*" ;;
  *" attach-session "*) printf 'ATTACHED\\n' ;;
  *" send-keys "*) echo 'UNEXPECTED_STARTUP_KEYS'; exit 9 ;;
esac
''',
            }.items():
                executable = work / name
                executable.write_text("#!/bin/bash\n" + body + "\n")
                executable.chmod(0o700)
            script = work / "launch.sh"
            script.write_text(
                "set -e\n" + helpers + launcher.replace(
                    'export TMUX_CONF="/tmp/.tmux.conf"',
                    'export TMUX_CONF="$TEST_DIR/tmux.conf"',
                )
            )
            result = subprocess.run(
                ["bash", str(script), "claude"],
                env={
                    **os.environ,
                    "PATH": str(work) + os.pathsep + os.environ["PATH"],
                    "TEST_DIR": str(work),
                    "TEST_MODE": mode,
                    "LLM_NAME": "claude",
                    "USE_TMUX": "false" if mode == "direct" else "true",
                    "RESET_TO_MAIN": "false",
                    "CLAUDE_SKIP_PERMISSIONS": "true",
                    "AUTODEX_DESKTOP_INPUT_READY_MARKER": "1",
                },
                capture_output=True, text=True, timeout=3,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.count(MARKER), 1)
            self.assertNotIn("UNEXPECTED_STARTUP_KEYS", result.stdout)
            destination = "CLAUDE_ARGS:" if mode in ("direct", "failed") else "ATTACHED"
            self.assertLess(result.stdout.index(MARKER), result.stdout.index(destination))
            if mode != "reattach":
                self.assertIn("--effort max --dangerously-skip-permissions", result.stdout)

    def test_keyboard_handoff_on_every_launch_path(self):
        for mode in ("direct", "failed", "healthy", "reattach"):
            with self.subTest(mode=mode):
                self.launch(mode)

    def test_container_settings_preaccept_bypass_prompt(self):
        settings = json.loads((ROOT / ".claude/settings.json").read_text())
        self.assertIs(settings["skipDangerousModePermissionPrompt"], True)


if __name__ == "__main__":
    unittest.main()
