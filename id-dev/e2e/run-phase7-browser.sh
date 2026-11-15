#!/bin/bash
# Starts PostgreSQL DB + Google stand-in + backend + dev server, runs the browser check, stops everything. Run from the repository parent of cloud/ and the site.
# Usage: CLOUD=/path/to/cloud SITE_DIR=/path/to/site bash run-phase7-browser.sh
set -u
# stop leftovers of an earlier run (they would keep the ports and their rate-limit counters)
pkill -f 'src/[s]erver.ts' 2>/dev/null; pkill -f 'google-mock-[s]erver' 2>/dev/null; pkill -f 'dev-[s]erver.mjs' 2>/dev/null; sleep 1
CLOUD=${CLOUD:-/home/claude/work/app-and-cloud/cloud}; SITE_DIR=${SITE_DIR:-/home/claude/work/landing-page-and-petali-id}
pg_lsclusters | grep -q online || { service postgresql start >/dev/null 2>&1; sleep 3; }
su postgres -c "psql -q -c 'DROP DATABASE IF EXISTS petali_e2e'" ; su postgres -c "psql -q -c 'CREATE DATABASE petali_e2e OWNER petali'"
export DATABASE_URL=postgres://petali:petali@127.0.0.1:5432/petali_e2e
cd "$CLOUD"
export NODE_ENV=development HOST=127.0.0.1 PORT=8788 JWT_ACCESS_SECRET=$(head -c 48 /dev/urandom | base64) WEB_ALLOWED_ORIGINS=http://localhost:8899 EMAIL_PROVIDER=none LOG_LEVEL=warn \
  GOOGLE_WEB_CLIENT_ID=mock-web-client.apps.googleusercontent.com GOOGLE_WEB_CLIENT_SECRET=mock-secret-not-real GOOGLE_WEB_REDIRECT_URI=http://localhost:8899/id/api/v1/web/google/callback \
  GOOGLE_TOKEN_URL=http://127.0.0.1:8790/token GOOGLE_JWKS_URL=http://127.0.0.1:8790/certs
cd "$CLOUD" && npx tsx src/db/migrate-cli.ts up >/tmp/e2e-migrate.log 2>&1 || { cat /tmp/e2e-migrate.log; exit 2; }
PORT=8790 npx tsx test/google-mock-server.ts >/tmp/e2e-mock.log 2>&1 & MOCK=$!
sleep 3
npx tsx src/server.ts >/tmp/e2e-backend.log 2>&1 & BACK=$!
cd "$SITE_DIR/id-dev" && PORT=8899 node dev-server.mjs >/tmp/e2e-dev.log 2>&1 & DEV=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8788/v1/health >/dev/null 2>&1 && curl -sf http://localhost:8899/ >/dev/null 2>&1 && break; sleep 1; done
curl -s http://127.0.0.1:8788/v1/auth/providers; echo
cd "$SITE_DIR/id-dev" && node e2e/seed-demo.mjs
python3 e2e/phase7-browser.py; RC=$?
pkill -f 'src/[s]erver.ts' 2>/dev/null; pkill -f 'google-mock-[s]erver' 2>/dev/null; pkill -f 'dev-[s]erver.mjs' 2>/dev/null; kill $MOCK $BACK $DEV 2>/dev/null; wait 2>/dev/null
exit $RC
