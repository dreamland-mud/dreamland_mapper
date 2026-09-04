#!/bin/bash
# Regenerate the mudjs graph-map JSON from current area XML and deploy to the web root.
#
# Runs daily via cron on the live server (crontab: 30 4 * * *). Builds into the repo's
# public/data, then rsyncs to the web root ONLY on a complete build, so a parse crash
# never wipes the live maps. On any failure it posts to the Discord "code" channel
# (same hook drone uses) so a silent nightly break doesn't leave the maps stale.
#
# This script is version-controlled in the dreamland_mapper repo; the live copy at
# /home/dreamland/dreamland_mapper is a git checkout. NOTE: cron does NOT auto-pull --
# after changing build-graph.ts or this script upstream, on live run:
#   cd ~/dreamland_mapper && git pull && npm ci
set -uo pipefail

export PATH=/home/dreamland/.nodejs/current/bin:$PATH
REPO=/home/dreamland/dreamland_mapper
WEBROOT=/var/www/dreamland_web/static/maps/graph
# Overridable so a developer can watch what the nightly build would say without a
# webhook: IDISCORD=./local-discord.sh ./regen-graph.sh prints the payload instead.
IDISCORD=${IDISCORD:-/home/dreamland/runtime/bin/idiscord-code}

# Notify Discord + log, then exit non-zero. Message must stay quote-free (raw JSON).
fail() {
  echo "$(date '+%F %T') REGEN FAILED: $1" >&2
  if [ -x "$IDISCORD" ]; then
    printf '{"embeds":[{"color":13632027,"title":"Map graph regen failed","description":"%s"}],"username":"Map Bot"}' \
      "$1" | "$IDISCORD" >/dev/null 2>&1 || true
  fi
  exit 1
}

cd "$REPO" || fail "cannot cd to $REPO"
export AREAS_DIR=/home/dreamland/dreamland_areas

rm -rf public/data
npm run build:graph || fail "build:graph errored -- kept existing live maps"

count=$(ls public/data/area-*.json 2>/dev/null | wc -l)
if [ ! -f public/data/index.json ] || [ "$count" -lt 100 ]; then
  fail "incomplete build ($count areas) -- kept existing live maps"
fi

rsync -a --delete public/data/ "$WEBROOT"/ || fail "rsync to web root failed"
echo "$(date '+%F %T') deployed $count area graphs"

# LAYOUT HINTS: one message for the whole run, and only when there is something to say.
# hints-report.json carries a `summary` line when some hint file has gone stale (the plain
# layout now beats it) or contains entries the build had to drop. Posting per area would
# get the channel muted, and then the one line that mattered goes unread.
REPORT=public/data/hints-report.json
if [ -f "$REPORT" ] && [ -x "$IDISCORD" ]; then
  payload=$(node -e '
    const fs = require("fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    if (!report.summary) process.exit(0);
    process.stdout.write(JSON.stringify({
      embeds: [{ color: 16764108, title: "Map layout hints need a look", description: report.summary.slice(0, 3800) }],
      username: "Map Bot",
    }));
  ' "$REPORT") || payload=""
  if [ -n "$payload" ]; then
    printf '%s' "$payload" | "$IDISCORD" >/dev/null 2>&1 || true
  fi
fi
