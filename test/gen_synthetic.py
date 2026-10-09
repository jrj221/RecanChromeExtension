"""Write synthetic recordings that exercise paths real recordings may not.

Usage: python3 gen_synthetic.py <out-dir>
"""
import gzip
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def write(name, events, members=3):
    lines = [json.dumps(e, ensure_ascii=False) + "\n" for e in events]
    # Multi-member gzip, like the real recorder output.
    size = max(1, len(lines) // members)
    blob = b"".join(
        gzip.compress("".join(lines[i:i + size]).encode("utf-8"))
        for i in range(0, len(lines), size)
    )
    (out / name).write_bytes(blob)


def edit(ts, offset, old, new, doc="C:\\Users\\s\\hw\\syn.py", **kw):
    return {"type": "edit", "editor": "jetbrains", "recorderVersion": "x",
            "timestamp": ts, "document": doc, "offset": offset,
            "oldFragment": old, "newFragment": new, **kw}


def focus(ts, focused):
    return {"type": "focusStatus", "editor": "jetbrains", "recorderVersion": "x",
            "timestamp": ts, "focused": focused}


# IDE actions, internal/unapproved pastes, focus loss, idle gaps, nanosecond and
# non-monotonic timestamps, refresh edits, accented text.
a = [
    edit("2026-01-01T10:00:00.000000000Z", 0, "", "# café\n"),
    edit("2026-01-01T10:00:00.000000000Z", 0, "# café\n", "# café\n"),  # refresh: ignored
    edit("2026-01-01T10:00:01.100Z", 7, "", "d"),
    edit("2026-01-01T10:00:01.100Z", 8, "", "ef f():\n    pass"),      # IDE create-function-ish
    edit("2026-01-01T10:00:01.200Z", 8, "", "\n"),
    edit("2026-01-01T10:00:03.000Z", 0, "", "x = [i * 2 for i in range(10)]\n"),  # paste
    edit("2026-01-01T10:00:03.100Z", 0, "", "x = [i * 2 for i in range(10)]\n"),  # internal paste
    focus("2026-01-01T10:00:04.000Z", False),
    focus("2026-01-01T10:00:20.000Z", True),
    edit("2026-01-01T10:00:30.000Z", 0, "", "if __name__ == '__main__':\n    main()\n"),
    edit("2026-01-01T09:59:59.000Z", 0, "", "y"),                      # goes backwards
]
write("synthetic_a.gz", a)

# Naive timestamps, legacy events without "type", initial snapshot, no extension.
b = [
    {"timestamp": "2026-02-02T08:00:00", "document": "/home/s/notes", "offset": 0,
     "oldFragment": "hello\n", "newFragment": "hello\n"},
    {"timestamp": "2026-02-02T08:00:01", "document": "/home/s/notes", "offset": 5,
     "oldFragment": "", "newFragment": "!"},
    {"timestamp": "2026-02-02T08:00:02", "focused": False},
    {"timestamp": "2026-02-02T08:00:09", "focused": True},
    {"timestamp": "2026-02-02T08:00:10", "document": "/home/s/notes", "offset": 0,
     "oldFragment": "hello", "newFragment": "def foo():\n    pass\n"},
]
write("synthetic_b.gz", b, members=2)
