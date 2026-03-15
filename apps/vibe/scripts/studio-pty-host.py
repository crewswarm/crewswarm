#!/usr/bin/env python3
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
import fcntl


def set_winsize(fd, cols, rows):
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def main():
    if len(sys.argv) < 3:
        print("usage: studio-pty-host.py <cwd> <command> [args...]", file=sys.stderr)
        return 1

    cwd = sys.argv[1]
    command = sys.argv[2]
    command_args = sys.argv[2:]
    cols = max(1, int(os.environ.get("STUDIO_TERM_COLS", "120")))
    rows = max(1, int(os.environ.get("STUDIO_TERM_ROWS", "32")))
    control_fd = 3

    pid, master_fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("HISTFILE", "/dev/null")
        os.execvpe(command, command_args, env)
        return 0

    set_winsize(master_fd, cols, rows)
    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "pty")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "stdin")
    selector.register(control_fd, selectors.EVENT_READ, "control")
    control_buffer = b""
    exit_code = None

    while True:
        for key, _ in selector.select(0.1):
            if key.data == "pty":
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(master_fd)
                    continue
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                continue

            if key.data == "stdin":
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    selector.unregister(sys.stdin.fileno())
                    continue
                os.write(master_fd, data)
                continue

            if key.data == "control":
                chunk = os.read(control_fd, 4096)
                if not chunk:
                    selector.unregister(control_fd)
                    continue
                control_buffer += chunk
                while b"\n" in control_buffer:
                    line, control_buffer = control_buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError:
                        continue
                    if message.get("type") == "resize":
                        cols = max(1, int(message.get("cols", cols)))
                        rows = max(1, int(message.get("rows", rows)))
                        set_winsize(master_fd, cols, rows)
                        try:
                            os.kill(pid, signal.SIGWINCH)
                        except ProcessLookupError:
                            pass
                    elif message.get("type") == "close":
                        try:
                            os.kill(pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass

        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            if os.WIFEXITED(status):
                exit_code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                exit_code = 128 + os.WTERMSIG(status)
            else:
                exit_code = 1
            break

    try:
        os.close(master_fd)
    except OSError:
        pass

    return exit_code if exit_code is not None else 0


if __name__ == "__main__":
    raise SystemExit(main())
