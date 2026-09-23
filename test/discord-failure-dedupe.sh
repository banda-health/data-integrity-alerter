#!/usr/bin/env bash
#
# discord-failure-dedupe.sh -- a failed Discord push must NOT mark a business
# partner as already reported.
#
# WHY THIS TEST EXISTS (INF-664). notifyOnDiscord used to call executeWebhook
# without awaiting it and `return true` immediately. The return value gates
# data.businessPartnerUUs -- the "already reported" list persisted to
# current-data.json and used to filter the next cycle -- so a partner whose push
# FAILED was still recorded as reported, and was never reported again. Silent,
# permanent loss of exactly the alerts this service exists to raise.
#
# A "does it crash?" test passes against that bug. This one does not: it forces
# the push to fail and then reads the dedupe file.
#
# PREREQUISITES: docker (for a throwaway postgres:16) and `npm install` already
# run in this checkout. No network access to Discord is needed -- an invalid
# webhook id is the point.
#
#     bash test/discord-failure-dedupe.sh
#
# To watch it FAIL, point it at the pre-fix source, which is the only way to
# know the test can fail at all:
#
#     git show <pre-fix-rev>:src/index.ts > src/.old-index.ts
#     TEST_ENTRY=src/.old-index.ts bash test/discord-failure-dedupe.sh
#
# Verified 2026-09-23: pre-fix -> POISONED (and no Discord failure logged at
# all, because the try/catch could not see an async rejection); fixed -> CLEAN.
set -u

ENTRY="${TEST_ENTRY:-src/index.ts}"
PGNAME="dia-test-pg"
PGPORT="${PGPORT:-55432}"
CANARY="UU-CANARY"

cd "$(dirname "$0")/.." || exit 1

command -v docker >/dev/null || { echo "SKIP: docker not available"; exit 77; }
[ -x ./node_modules/.bin/esrun ] || { echo "FAIL: run 'npm install' first"; exit 1; }

# shellcheck disable=SC2317  # invoked by the trap below, not inline
cleanup() { docker rm -f "$PGNAME" >/dev/null 2>&1; rm -f current-data.json; }
trap cleanup EXIT

echo "==> starting throwaway postgres"
docker rm -f "$PGNAME" >/dev/null 2>&1
docker run -d --name "$PGNAME" -e POSTGRES_PASSWORD=t -p "$PGPORT":5432 postgres:16 >/dev/null || exit 1
for _ in $(seq 1 40); do docker exec "$PGNAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

echo "==> creating the five tables the query touches, plus one partner with no location"
docker exec -i "$PGNAME" psql -U postgres -q <<SQL || exit 1
create schema adempiere;
create table adempiere.ad_client(ad_client_id int, name text, isactive char(1));
create table adempiere.c_bpartner(c_bpartner_id int, ad_client_id int, c_bpartner_uu text, name text, created timestamp, c_bp_group_id int);
create table adempiere.c_bpartner_location(c_bpartner_location_id int, c_bpartner_id int, c_location_id int);
create table adempiere.c_location(c_location_id int);
create table adempiere.c_bp_group(c_bp_group_id int);
insert into adempiere.ad_client values (1000001,'demo','Y');
insert into adempiere.c_bpartner values (1,1000001,'$CANARY','BP One', now() - interval '1 hour', 5);
insert into adempiere.c_bp_group values (5);
create role gstatsuser login password 't';
grant usage on schema adempiere to gstatsuser;
grant select on all tables in schema adempiere to gstatsuser;
SQL

echo "==> running $ENTRY with an INVALID webhook (cwd must be the repo root:"
echo "    current-data.json is read from and written to cwd, and esrun needs a"
echo "    relative entry path -- an absolute one makes it spawn with E2BIG)"
rm -f current-data.json
LOG="$(mktemp)"
DB_USER=gstatsuser DB_HOST=127.0.0.1 DB_DATABASE=postgres DB_PASSWORD=t DB_PORT="$PGPORT" \
DB_SCHEMA=adempiere STATUS_DIR="$(mktemp -d)" \
DISCORD_BOT_TOKEN="" DISCORD_HOOK_ID="000000000000000000" DISCORD_HOOK_TOKEN="invalid-token" \
timeout 30 ./node_modules/.bin/esrun "$ENTRY" > "$LOG" 2>&1

FAILURES=0

if grep -q "new results returned" "$LOG"; then
    echo "  [ OK ] the cycle ran and found the canary partner"
else
    echo "  [FAIL] the cycle never reached the Discord push -- this test proves nothing"
    tail -5 "$LOG" | sed 's/^/         /'
    FAILURES=$((FAILURES + 1))
fi

# A positive control on the test itself: if the push did not actually fail, a
# clean dedupe list below would mean nothing.
if grep -q "Error while forwarding to Discord" "$LOG"; then
    echo "  [ OK ] the Discord push failed, as intended"
else
    echo "  [WARN] no Discord failure was logged -- on pre-fix code this is expected,"
    echo "         because the try/catch could not see an async rejection at all"
fi

if [ ! -f current-data.json ]; then
    echo "  [FAIL] no current-data.json written, so the dedupe list cannot be checked"
    FAILURES=$((FAILURES + 1))
elif grep -q "$CANARY" current-data.json; then
    echo "  [FAIL] $CANARY IS in the dedupe list after a FAILED push -- it would never be reported again"
    FAILURES=$((FAILURES + 1))
else
    echo "  [ OK ] $CANARY is NOT in the dedupe list -- it will be retried next cycle"
fi

rm -f "$LOG"
echo
if [ "$FAILURES" -eq 0 ]; then echo "PASS"; else echo "FAIL ($FAILURES)"; fi
exit "$FAILURES"
