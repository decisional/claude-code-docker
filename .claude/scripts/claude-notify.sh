#!/bin/bash
# Notify the host terminal that Claude Code needs attention.
# Sends a terminal bell and iTerm2 RequestAttention escape sequence.
# Write directly to /dev/tty to bypass any stdout capture by Claude Code.
printf '\a' > /dev/tty 2>/dev/null
printf '\033]1337;RequestAttention=yes\a' > /dev/tty 2>/dev/null
