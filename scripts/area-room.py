#!/usr/bin/env python3
"""Inspect and edit room exits in a Dreamland area XML, scoped to the <rooms> section.

Companion to audit-defects.mjs: once the audit flags a reverse-direction mismatch or a
redundant double-link, use this to (1) read the room's exits + descriptions in every
language (so you can confirm the text agrees with the new direction — descriptions often
name the exit, e.g. "the corridor stretches east"), then (2) safely rename or remove the
exact exit, room-scoped so the same vnum in <mobiles>/<objects> is never touched.

  # Inspect — exits + all-language descriptions for one or more rooms
  python3 area-room.py <area.are.xml> show <vnum> [<vnum> ...]

  # Edit one exit (dry-run prints the match; add --apply to write). Preserves formatting.
  python3 area-room.py <area.are.xml> set-exit <vnum> <olddir> <target> <newdir> [--apply]
  python3 area-room.py <area.are.xml> rm-exit  <vnum> <dir>    <target>          [--apply]

Always re-run `npm run build:graph` + `audit-defects.mjs <area>` after editing, and
deploy via the dl-update-zones skill (area XML loads on boot).
"""
import re
import sys
import xml.etree.ElementTree as ET

DIRS = ("north", "south", "east", "west", "up", "down")


def find_rooms_span(lines):
    rs = next(i for i, l in enumerate(lines) if l.strip() == "<rooms>")
    re_ = next(i for i, l in enumerate(lines) if l.strip() == "</rooms>")
    return rs, re_


def find_room(lines, rs, re_, vnum):
    for i in range(rs, re_):
        if lines[i].strip() == '<node name="%s">' % vnum:
            return i
    return None


def find_exit_node(lines, room_i, re_, olddir, target):
    """Return (start, end) line indices of the exit <node name=olddir> targeting `target`,
    within this room's <exits>…</exits>. None if absent."""
    ei = next((i for i in range(room_i, re_) if lines[i].strip() == "<exits>"), None)
    if ei is None:
        return None
    ee = next(i for i in range(ei, re_) if lines[i].strip() == "</exits>")
    for i in range(ei, ee):
        if lines[i].strip() == '<node name="%s">' % olddir:
            j = next(k for k in range(i, ee + 1) if lines[k].strip() == "</node>")
            if "<target>%s</target>" % target in "\n".join(lines[i:j + 1]):
                return (i, j)
    return None


def cmd_show(path, vnums):
    root = ET.parse(path).getroot()
    rooms = root.find("rooms")
    want = set(vnums)
    for n in rooms.findall("node"):
        if n.get("name") not in want:
            continue
        names = {d.get("l"): (d.text or "").strip() for d in n.findall("name")}
        print("\n#### room %s — %s ####" % (n.get("name"), names))
        for d in n.findall("description"):
            print("  desc[%s]: %s" % (d.get("l"), (d.text or "").strip().replace("\n", " ")))
        ex = n.find("exits")
        exits = []
        if ex is not None:
            for e in ex.findall("node"):
                t = e.find("target")
                exits.append("%s→%s" % (e.get("name"), t.text if t is not None else "?"))
        print("  exits:", " ".join(exits))


def edit(path, vnum, olddir, target, newdir, apply):
    if olddir not in DIRS or (newdir not in DIRS and newdir != "REMOVE"):
        sys.exit("bad direction (must be one of %s, or REMOVE)" % ", ".join(DIRS))
    lines = open(path, encoding="utf-8").read().split("\n")
    rs, re_ = find_rooms_span(lines)
    room_i = find_room(lines, rs, re_, vnum)
    if room_i is None:
        sys.exit("room %s not found in <rooms>" % vnum)
    span = find_exit_node(lines, room_i, re_, olddir, target)
    if span is None:
        sys.exit("exit %s→%s not found in room %s" % (olddir, target, vnum))
    i, j = span
    if newdir == "REMOVE":
        print("REMOVE room %s exit %s→%s  (lines %d-%d)" % (vnum, olddir, target, i + 1, j + 1))
        if apply:
            out = lines[:i] + lines[j + 1:]
            open(path, "w", encoding="utf-8").write("\n".join(out))
    else:
        # Warn if the room already has an exit in the target direction (would collide).
        ei = next(i2 for i2 in range(room_i, re_) if lines[i2].strip() == "<exits>")
        ee = next(i2 for i2 in range(ei, re_) if lines[i2].strip() == "</exits>")
        has_newdir = any(lines[i2].strip() == '<node name="%s">' % newdir for i2 in range(ei, ee))
        if has_newdir and newdir != olddir:
            print("WARNING: room %s already has a '%s' exit — review before applying" % (vnum, newdir))
        print("RENAME room %s exit %s→%s  =>  %s→%s  (line %d)" % (vnum, olddir, target, newdir, target, i + 1))
        if apply:
            lines[i] = lines[i].replace('name="%s"' % olddir, 'name="%s"' % newdir)
            open(path, "w", encoding="utf-8").write("\n".join(lines))
    print("APPLIED" if apply else "DRY-RUN (add --apply to write)")
    if apply:
        ET.parse(path)  # raises if we produced malformed XML
        print("XML still well-formed ✓")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    path, cmd = sys.argv[1], sys.argv[2]
    apply = "--apply" in sys.argv
    args = [a for a in sys.argv[3:] if a != "--apply"]
    if cmd == "show":
        cmd_show(path, args)
    elif cmd == "set-exit":
        edit(path, args[0], args[1], args[2], args[3], apply)
    elif cmd == "rm-exit":
        edit(path, args[0], args[1], args[2], "REMOVE", apply)
    else:
        sys.exit("unknown command %r (show | set-exit | rm-exit)" % cmd)


if __name__ == "__main__":
    main()
