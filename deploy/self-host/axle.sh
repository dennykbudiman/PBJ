#!/usr/bin/env bash
# Axle on your own server. Run with sudo from this folder:  sudo bash axle.sh <command>
#
#   install              set up everything (Docker, Supabase, the app, HTTPS) and start it
#   create-owner         make the first Owner login (or another Owner, e.g. if locked out)
#   update               after copying in a newer Axle: back up, rebuild the app, apply new migrations
#   migrate              apply any database migrations not applied yet (update does this too)
#   backup               save all data + uploaded files to one file in the backups folder
#   restore <file>       replace ALL data with a backup file (asks first; saves current data first)
#   import-cloud         copy all data + files from a supabase.co project into this server
#   enable-nightly-backup  run a backup every night at 02:30 and keep the newest few
#   status | start | stop | logs [service] | studio
#
# Settings: axle.conf in this folder (copy axle.conf.example). Guide: README.md in this folder.

set -Eeuo pipefail

SUPABASE_REF="self-hosted/v0.8.2"                 # Supabase release this kit was built and checked against
NODE_IMAGE="node:22-alpine"                        # used to copy uploaded files (same image Supabase's tools use)

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ME="sudo bash axle.sh"                              # how commands are shown in messages (run from this folder)
APP_DIR="$(cd "$KIT_DIR/../.." && pwd)"
CONF_FILE="$KIT_DIR/axle.conf"
MIGRATIONS_DIR="$APP_DIR/supabase/migrations"
FUNCTIONS_SRC="$APP_DIR/supabase/functions"
TEST_MODE="${AXLE_TEST:-}"                          # local test harness only: talk to a plain Postgres, no Docker

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "stopped at line $LINENO (see the message above)."' ERR
CLEANUP=()
cleanup() { local d; for d in "${CLEANUP[@]}"; do [[ -n "$d" && -d "$d" ]] && rm -rf "$d"; done; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------- settings
declare -A CONF=()
load_conf() {
  [[ -f "$CONF_FILE" ]] || die "No settings file. Copy axle.conf.example to axle.conf in $KIT_DIR and fill it in."
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "axle.conf: can't read this line: $line"
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    # strip one pair of surrounding quotes; nothing else is interpreted (passwords may contain $ etc.)
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    CONF[$key]="$val"
  done < "$CONF_FILE"
}
conf() { printf '%s' "${CONF[$1]:-${2:-}}"; }

set_paths() {
  AXLE_HOME="$(conf AXLE_HOME "$(dirname "$APP_DIR")")"
  STACK_DIR="$AXLE_HOME/supabase"
  BACKUP_DIR="$(conf AXLE_BACKUP_DIR "$AXLE_HOME/backups")"
  BACKUP_KEEP="$(conf AXLE_BACKUP_KEEP 14)"
  [[ "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -ge 1 ]] || die "AXLE_BACKUP_KEEP must be a number of 1 or more."
}

need_root() { [[ -n "$TEST_MODE" || "$(id -u)" == 0 ]] || die "Run this with sudo:  $ME $*"; }
need_stack() { [[ -n "$TEST_MODE" || -f "$STACK_DIR/.env" ]] || die "Axle isn't installed in $STACK_DIR yet. Run: $ME install"; }

# ---------------------------------------------------------------- stack .env
env_get() {  # value of KEY in the stack's .env, without surrounding quotes
  local v
  v="$(grep -E "^$1=" "$STACK_DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '\r')" || true
  if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  printf '%s' "$v"
}
env_set() {  # set KEY=VALUE in the stack's .env (replaces the first KEY= line, or appends)
  local key="$1" val="$2" line
  ( umask 077; : > "$STACK_DIR/.env.axle-tmp" )
  [[ "$val" != *$'\n'* && "$val" != *"'"* ]] || die "$key can't contain a single quote (') or a line break."
  if [[ "$val" =~ ^[A-Za-z0-9@._:/,+=*-]*$ ]]; then line="$key=$val"; else line="$key='$val'"; fi  # quoted: no $-expansion
  K="$key" L="$line" awk 'BEGIN { k = ENVIRON["K"] "="; l = ENVIRON["L"]; done = 0 }
    !done && index($0, k) == 1 { print l; done = 1; next } { print }
    END { if (!done) print l }' "$STACK_DIR/.env" > "$STACK_DIR/.env.axle-tmp"   # created 600 below
  cat "$STACK_DIR/.env.axle-tmp" > "$STACK_DIR/.env"; rm -f "$STACK_DIR/.env.axle-tmp"
}

# ---------------------------------------------------------------- docker / database helpers
dc() { (cd "$STACK_DIR" && docker compose "$@"); }

# psql as a database role, reading SQL from stdin. Roles: postgres (owns the app, like the SQL Editor on
# supabase.co) or supabase_admin (superuser, for restore/pg_cron). Extra args go to psql.
db_psql() {
  local role="$1"; shift
  if [[ -n "$TEST_MODE" ]]; then
    # shellcheck disable=SC2086
    $AXLE_TEST_PSQL -v ON_ERROR_STOP=1 -X -q "$@"
  else
    dc exec -T db psql -h localhost -U "$role" -d postgres -v ON_ERROR_STOP=1 -X -q "$@"
  fi
}
db_value() { db_psql "$1" -tA -c "$2"; }

# pg_dump of the app data. $1 = "local", or "url" to dump the database whose address is in $AXLE_SRC_URL.
db_dump() {
  local src="$1"; shift
  local args=(--data-only --no-owner --no-privileges -t 'public.*' -t auth.users -t auth.identities)
  if [[ -n "$TEST_MODE" ]]; then
    # shellcheck disable=SC2086
    $AXLE_TEST_PGDUMP "${args[@]}"
  elif [[ "$src" == local ]]; then
    dc exec -T db pg_dump -h localhost -U supabase_admin -d postgres "${args[@]}"
  else
    # The address (with its password) is passed through the environment, not the command line.
    dc exec -T -e AXLE_SRC_URL db sh -c '[ -n "$AXLE_SRC_URL" ] || exit 9; exec pg_dump "$AXLE_SRC_URL" "$@"' pg_dump "${args[@]}"
  fi
}
fingerprint() {  # $1 = local | url
  if [[ "$1" == local || -n "$TEST_MODE" ]]; then
    db_psql postgres -tA < "$KIT_DIR/sql/schema-fingerprint.sql"
  else
    dc exec -T -e AXLE_SRC_URL db sh -c '[ -n "$AXLE_SRC_URL" ] || exit 9; exec psql "$AXLE_SRC_URL" -X -tA -v ON_ERROR_STOP=1' < "$KIT_DIR/sql/schema-fingerprint.sql"
  fi
}

# Copy uploaded files. $1 = download|upload, $2 = folder, $3 = API address, $4 = service key.
storage_sync() {
  local mode="$1" dir="$2" url="$3" key="$4"
  if [[ -n "$TEST_MODE" ]]; then
    if [[ -n "${AXLE_TEST_SKIP_STORAGE:-}" ]]; then mkdir -p "$dir/files"; echo '[]' > "$dir/buckets.json"; echo '[]' > "$dir/objects.json"; return; fi
    SB_URL="$url" SB_KEY="$key" node "$KIT_DIR/tools/storage-sync.mjs" "$mode" "$dir"
  else
    SB_URL="$url" SB_KEY="$key" docker run --rm --network host -e SB_URL -e SB_KEY \
      -v "$KIT_DIR/tools:/tools:ro" -v "$dir:/work" "$NODE_IMAGE" node /tools/storage-sync.mjs "$mode" /work
  fi
}
local_api() { printf 'http://127.0.0.1:%s' "$(env_get API_GW_HTTP_PORT || true)" | sed 's/:$/:8000/'; }

wait_for_db() {
  [[ -n "$TEST_MODE" ]] && return 0
  local i
  for i in $(seq 1 90); do
    if [[ "$(db_value postgres "select to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null" 2>/dev/null || true)" == t ]]; then
      return 0
    fi
    sleep 2
  done
  die "The database didn't become ready (auth/storage tables missing). Check: $ME logs db"
}

# ---------------------------------------------------------------- install
is_ip() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$1" == *:* ]]; }

check_conf() {
  local d t
  d="$(conf AXLE_DOMAIN)"; t="$(conf AXLE_TLS auto)"
  [[ -n "$d" ]] || die "axle.conf: fill in AXLE_DOMAIN (a domain name, office network name, or the server's IP address)."
  [[ "$d" =~ ^[A-Za-z0-9.-]+$ ]] || die "axle.conf: AXLE_DOMAIN should be just the name or IP, e.g. axle.example.co.id (no http://, no slashes)."
  case "$t" in
    auto)
      is_ip "$d" && die "axle.conf: AXLE_TLS=auto needs a domain name, not an IP address. Use AXLE_TLS=internal for an IP."
      [[ "$(conf AXLE_ACME_EMAIL)" == *@* ]] || die "axle.conf: AXLE_TLS=auto needs AXLE_ACME_EMAIL (an email for certificate notices)." ;;
    internal|off) ;;
    *) die "axle.conf: AXLE_TLS must be auto, internal or off." ;;
  esac
  if [[ -n "$(conf SMTP_HOST)" ]]; then
    [[ "$(conf SMTP_ADMIN_EMAIL)" == *@* ]] || die "axle.conf: SMTP_ADMIN_EMAIL (the address emails are sent from) is needed when SMTP_HOST is set."
    [[ "$(conf SMTP_PORT 587)" =~ ^[0-9]+$ ]] || die "axle.conf: SMTP_PORT must be a number."
  fi
}

public_url() {
  if [[ "$(conf AXLE_TLS auto)" == off ]]; then printf 'http://%s' "$(conf AXLE_DOMAIN)"; else printf 'https://%s' "$(conf AXLE_DOMAIN)"; fi
}

fetch_supabase() {
  if [[ -f "$STACK_DIR/.env" ]]; then info "Supabase already set up in $STACK_DIR"; return; fi
  [[ -e "$STACK_DIR" ]] && die "$STACK_DIR exists but has no .env (an earlier install stopped half-way). Move it aside and run install again."
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -qq -y curl; } || die "Please install curl first."
  say "Setting up Supabase ($SUPABASE_REF): installs Docker if needed, creates secrets, downloads images. This takes a while."
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://raw.githubusercontent.com/supabase/supabase/$SUPABASE_REF/docker/setup.sh" -o "$tmp/setup.sh" \
    || die "Couldn't download Supabase's setup script from GitHub. Is the server online?"
  mkdir -p "$AXLE_HOME"
  (cd "$AXLE_HOME" && sh "$tmp/setup.sh" -y --ref "$SUPABASE_REF" --project-dir supabase)
  rm -rf "$tmp"
  [[ -f "$STACK_DIR/.env" ]] || die "Supabase setup didn't finish (no $STACK_DIR/.env)."
  chmod 600 "$STACK_DIR/.env"
  rm -f "$STACK_DIR/.env.old" "$STACK_DIR/.env.example.old"   # setup's key tools leave a readable copy of the secrets
}

configure_stack() {
  local url d t
  url="$(public_url)"; d="$(conf AXLE_DOMAIN)"; t="$(conf AXLE_TLS auto)"
  say "Writing settings for $url"
  env_set SUPABASE_PUBLIC_URL "$url"
  env_set API_EXTERNAL_URL "$url/auth/v1"
  env_set SITE_URL "$url"
  env_set ADDITIONAL_REDIRECT_URLS "$url/set-password,$url/**"
  env_set DISABLE_SIGNUP true              # logins are made by invitation (Settings → Users) only
  env_set ENABLE_EMAIL_SIGNUP true         # = email + password sign-in on
  env_set ENABLE_EMAIL_AUTOCONFIRM false
  env_set ENABLE_ANONYMOUS_USERS false
  env_set ENABLE_PHONE_SIGNUP false
  env_set ENABLE_PHONE_AUTOCONFIRM false
  env_set STUDIO_DEFAULT_ORGANIZATION Axle
  env_set STUDIO_DEFAULT_PROJECT Axle
  env_set PROXY_DOMAIN "$d"
  if [[ -n "$(conf SMTP_HOST)" ]]; then
    env_set SMTP_HOST "$(conf SMTP_HOST)"
    env_set SMTP_PORT "$(conf SMTP_PORT 587)"
    env_set SMTP_USER "$(conf SMTP_USER)"
    env_set SMTP_PASS "$(conf SMTP_PASS)"
    env_set SMTP_ADMIN_EMAIL "$(conf SMTP_ADMIN_EMAIL)"
    env_set SMTP_SENDER_NAME "$(conf SMTP_SENDER_NAME Axle)"
  else
    warn "No SMTP_HOST in axle.conf: staff invites and password-reset emails won't send until you add it and run: $ME update"
  fi
  env_set COMPOSE_FILE "docker-compose.yml:docker-compose.axle.yml"
  env_set AXLE_APP_DIR "$APP_DIR"
  if [[ "$t" == off ]]; then env_set AXLE_SITE_ADDRESS "http://$d"; else env_set AXLE_SITE_ADDRESS "$d"; fi
  env_set AXLE_TLS_MODE "$t"
  env_set AXLE_ACME_EMAIL "$(conf AXLE_ACME_EMAIL)"
  env_set AXLE_DEFAULT_SNI "$d"
  chmod 600 "$STACK_DIR/.env"
  rm -f "$STACK_DIR/.env.old"
}

copy_overlay() {
  cp "$KIT_DIR/docker-compose.axle.yml" "$STACK_DIR/docker-compose.axle.yml"
  local f
  for f in "$FUNCTIONS_SRC"/*/; do
    f="$(basename "$f")"
    [[ "$f" =~ ^[a-z0-9-]+$ && "$f" != main ]] || continue
    rm -rf "${STACK_DIR:?}/volumes/functions/$f"
    cp -r "$FUNCTIONS_SRC/$f" "$STACK_DIR/volumes/functions/$f"
    info "edge function: $f"
  done
}

start_stack() {
  say "Building the app and starting everything (first time: several minutes)"
  dc build web
  dc up -d --wait --wait-timeout 900 || die "Some services didn't start. See: $ME status   and   $ME logs <service>"
}

check_compose() {  # the override file needs Docker Compose 2.24.4 or newer (for "!override")
  local v; v="$(docker compose version --short 2>/dev/null | sed 's/^v//')" || true
  [[ -n "$v" ]] || die "Docker Compose isn't available. Install Docker from docker.com's instructions and run install again."
  printf '%s\n2.24.4\n' "$v" | sort -V -C 2>/dev/null && [[ "$v" != 2.24.4 ]] && \
    die "Docker Compose $v is too old (need 2.24.4+). Update it: sudo apt-get update && sudo apt-get install --only-upgrade docker-compose-plugin"
  return 0
}

cmd_install() {
  need_root install; load_conf; set_paths; check_conf
  [[ "$(uname -s)" == Linux ]] || die "This needs a Linux server (Ubuntu 22.04/24.04 or Debian 12 recommended)."
  fetch_supabase
  check_compose
  configure_stack
  copy_overlay
  start_stack
  cmd_migrate
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  say "Axle is running at $(public_url)"
  if [[ "$(db_value postgres "select count(*) from public.profiles p join public.roles r on r.id = p.role_id where r.name = 'Owner' and p.status = 'active'")" == 0 ]]; then
    if [[ -t 0 ]]; then
      echo
      read -r -p "Create the first Owner login now? [Y/n] " a
      if [[ ! "$a" =~ ^[Nn] ]]; then cmd_create_owner; else info "Later: $ME create-owner   (or bring data over: $ME import-cloud)"; fi
    else
      info "Next: $ME create-owner   (or bring data over: $ME import-cloud)"
    fi
  fi
  echo
  info "Turn on nightly backups:   $ME enable-nightly-backup"
  info "Database dashboard:        $ME studio"
  [[ "$(conf AXLE_TLS auto)" == internal ]] && info "Office-network certificate: see README.md → \"Office network certificates\"."
  return 0
}

# ---------------------------------------------------------------- migrations
cmd_migrate() {
  need_root migrate; [[ ${#CONF[@]} -gt 0 ]] || { load_conf; set_paths; }; need_stack
  [[ -n "$TEST_MODE" ]] || dc up -d --wait --wait-timeout 900 >/dev/null || die "Some services aren't running. See: $ME status"
  wait_for_db
  say "Database migrations"
  if [[ -n "$TEST_MODE" ]]; then db_psql postgres < "$KIT_DIR/sql/pre-migrate-admin.sql"
  else db_psql supabase_admin < "$KIT_DIR/sql/pre-migrate-admin.sql"; fi
  db_psql postgres -c "set client_min_messages = warning;" -f - < "$KIT_DIR/sql/migrations-table.sql"
  local f name sum have applied=0
  while IFS= read -r f; do
    name="$(basename "$f")"
    [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Unexpected migration file name: $name"
    sum="$(sha256sum "$f" | cut -c1-64)"
    have="$(db_value postgres "select checksum from axle_deploy.migrations where name = '$name'")"
    if [[ -n "$have" ]]; then
      [[ "$have" == "$sum" ]] || warn "$name was changed after it was applied. It is NOT re-run; ask your developer."
      continue
    fi
    info "applying $name"
    { echo "set client_min_messages = warning;"; cat "$f"; printf "\n;\ninsert into axle_deploy.migrations (name, checksum) values ('%s', '%s');\n" "$name" "$sum"; } \
      | db_psql postgres -1 -f - || die "$name failed and was rolled back (nothing from it was kept). Nothing after it was applied."
    applied=$((applied + 1))
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | LC_ALL=C sort)
  db_psql postgres -c "notify pgrst, 'reload schema';" >/dev/null
  if [[ $applied -eq 0 ]]; then info "up to date"; else info "$applied migration(s) applied"; fi
}

# ---------------------------------------------------------------- first owner
cmd_create_owner() {
  need_root create-owner; [[ ${#CONF[@]} -gt 0 ]] || { load_conf; set_paths; }; need_stack
  command -v jq >/dev/null 2>&1 || die "jq is missing (apt-get install jq)."
  say "New Owner login"
  local name username email pw pw2 taken json tmp res id
  read -r -p "    Full name: " name
  while :; do
    read -r -p "    Username (3-30: letters, numbers, . _ -): " username; username="${username,,}"
    [[ "$username" =~ ^[a-z0-9._-]{3,30}$ ]] || { info "That username isn't allowed."; continue; }
    taken="$(db_value postgres "select count(*) from public.profiles where lower(username) = '$username'")"
    [[ "$taken" == 0 ]] && break; info "That username is taken."
  done
  while :; do
    read -r -p "    Email: " email; email="${email,,}"
    [[ "$email" =~ ^[^[:space:]\'@]+@[^[:space:]\'@]+\.[^[:space:]\'@]+$ ]] || { info "That email doesn't look right."; continue; }
    taken="$(db_value postgres "select count(*) from auth.users where lower(email) = '$email'")"
    [[ "$taken" == 0 ]] && break; info "Someone already has that email."
  done
  while :; do
    read -r -s -p "    Password (8+ characters): " pw; echo
    [[ ${#pw} -ge 8 ]] || { info "Too short."; continue; }
    read -r -s -p "    Same password again: " pw2; echo
    [[ "$pw" == "$pw2" ]] && break; info "They don't match."
  done
  json="$(jq -n --arg e "$email" --arg p "$pw" --arg n "$name" --arg u "$username" \
    '{email:$e, password:$p, email_confirm:true, user_metadata:{name:$n}, app_metadata:{role:"Owner", username:$u}}')"
  tmp="$(mktemp -d)"; chmod 700 "$tmp"
  printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\n' "$(env_get SERVICE_ROLE_KEY)" "$(env_get SERVICE_ROLE_KEY)" > "$tmp/h"
  printf '%s' "$json" > "$tmp/b"
  res="$(curl -sS -X POST "$(local_api)/auth/v1/admin/users" -H @"$tmp/h" --data-binary @"$tmp/b" || true)"
  rm -rf "$tmp"
  id="$(printf '%s' "$res" | jq -r '.id // empty' 2>/dev/null || true)"
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || die "The login wasn't created: $(printf '%s' "$res" | jq -r '.msg // .message // .error_description // .' 2>/dev/null || printf '%s' "$res")"
  # Auth adds app_metadata after the row exists, so the new-user trigger made a plain invited profile:
  # make it an active Owner here (the same thing the invite function does).
  if ! db_psql postgres -v id="$id" -v name="$name" -v uname="$username" >/dev/null <<'SQL'
update public.profiles
   set name = :'name', username = :'uname', status = 'active',
       role_id = (select id from public.roles where name = 'Owner')
 where id = :'id';
SQL
  then
    db_psql postgres -c "delete from auth.users where id = '$id'" >/dev/null || true
    die "The profile couldn't be set up, so the login was removed again. Nothing was kept; try again."
  fi
  [[ "$(db_value postgres "select p.status || '/' || r.name from public.profiles p join public.roles r on r.id = p.role_id where p.id = '$id'")" == "active/Owner" ]] \
    || die "The login was made but its profile isn't an active Owner. Check Settings → Users in the app."
  say "Done. Sign in at $(public_url) as $username (or $email)."
}

# ---------------------------------------------------------------- backup / restore
# Writes a bundle folder: data.sql, fingerprint.txt, manifest.txt, buckets.json, objects.json, files/
export_bundle() {  # $1 = folder, $2 = local|url, $3 = API address, $4 = service key, $5 = label
  local out="$1" src="$2" api="$3" key="$4" label="$5"
  info "database..."
  db_dump "$src" > "$out/data.sql"
  grep -q 'COPY public\.\|INSERT INTO public\.' "$out/data.sql" || die "The database export looks empty; stopping."
  fingerprint "$src" > "$out/fingerprint.txt"
  info "uploaded files..."
  storage_sync download "$out" "$api" "$key"
  {
    echo "axle_bundle=1"
    echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "source=$label"
    echo "schema=$(cat "$out/fingerprint.txt")"
    echo "app_commit=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    if [[ "$src" == local ]]; then echo "migrations=$(db_value postgres "select string_agg(name, ' ' order by name) from axle_deploy.migrations" 2>/dev/null || true)"; fi
  } > "$out/manifest.txt"
}

make_backup() {  # $1 = file name prefix; prints the bundle path (progress goes to stderr)
  local prefix="$1" ts work file
  ts="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  work="$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")"; CLEANUP+=("$work")
  export_bundle "$work" local "$(local_api)" "$(env_get SERVICE_ROLE_KEY)" "this server ($(hostname))" >&2
  file="$BACKUP_DIR/$prefix-$ts.tar.gz"
  tar -czf "$file.part" -C "$work" .
  mv "$file.part" "$file"; chmod 600 "$file"; rm -rf "$work"
  echo "$file"
}

cmd_backup() {
  need_root backup; load_conf; set_paths; need_stack
  local quiet="${1:-}" file
  [[ "$quiet" == --quiet ]] || say "Backing up"
  file="$(make_backup axle-backup)"
  # keep the newest $BACKUP_KEEP nightly/manual backups (safety copies made by update/restore are kept)
  find "$BACKUP_DIR" -maxdepth 1 -name 'axle-backup-*.tar.gz' -type f -printf '%T@ %p\n' | sort -rn \
    | tail -n +"$((BACKUP_KEEP + 1))" | cut -d' ' -f2- | xargs -r rm -f
  # safety copies made before updates/restores: keep the newest 5 of each
  local kind
  for kind in axle-before-update axle-before-restore; do
    find "$BACKUP_DIR" -maxdepth 1 -name "$kind-*.tar.gz" -type f -printf '%T@ %p\n' | sort -rn \
      | tail -n +6 | cut -d' ' -f2- | xargs -r rm -f
  done
  find "$BACKUP_DIR" -maxdepth 1 -name '.work-*' -type d -mmin +720 -exec rm -rf {} + 2>/dev/null || true
  echo "$(date '+%F %T') backup ok: $file ($(du -h "$file" | cut -f1))"
}

check_bundle() {  # $1 = extracted folder, $2 = --ignore-schema-check or ""
  local dir="$1" force="$2" theirs ours
  [[ -f "$dir/data.sql" && -f "$dir/manifest.txt" && -f "$dir/fingerprint.txt" && -f "$dir/objects.json" ]] || die "That file isn't an Axle backup."
  theirs="$(cat "$dir/fingerprint.txt")"; ours="$(fingerprint local)"
  if [[ "$theirs" != "$ours" ]]; then
    [[ "$force" == --ignore-schema-check ]] \
      || die "The backup's tables don't match this server's (backup $theirs, server $ours). The two are on different Axle versions: update the older one first. Nothing was changed."
    warn "Table layout differs; continuing because of --ignore-schema-check."
  fi
  # Logins: every column the backup has must exist here (a newer Supabase Auth may have added some).
  local tbl cols missing
  for tbl in users identities; do
    cols="$(sed -n "s/^COPY auth\.$tbl (\(.*\)) FROM stdin;\$/\1/p" "$dir/data.sql" | head -n1 | tr -d '"' | tr -d ' ')"
    [[ -n "$cols" ]] || continue
    [[ "$cols" =~ ^[a-z0-9_,]+$ ]] || die "The backup's login table looks damaged."
    missing="$(db_value postgres "select string_agg(c, ', ') from unnest(string_to_array('$cols', ',')) c where c not in (select column_name from information_schema.columns where table_schema = 'auth' and table_name = '$tbl')")"
    [[ -z "$missing" ]] || die "The backup's logins come from a newer Supabase Auth (auth.$tbl has: $missing). Update Supabase on this server first (README section 8). Nothing was changed."
  done
}

restore_bundle() {  # $1 = extracted folder, $2 = --ignore-schema-check or ""
  local dir="$1" force="$2"
  check_bundle "$dir" "$force"
  [[ -n "$TEST_MODE" ]] || dc stop web >/dev/null 2>&1 || true
  info "loading data..."
  { echo "set client_min_messages = warning;"; cat "$KIT_DIR/sql/restore-wipe.sql" "$dir/data.sql"; echo "notify pgrst, 'reload schema';"; } \
    | db_psql supabase_admin -1 -f - >/dev/null \
    || { [[ -n "$TEST_MODE" ]] || dc start web >/dev/null 2>&1 || true; die "Loading failed and was rolled back: the data is as it was before. See the message above."; }
  info "uploaded files..."
  storage_sync upload "$dir" "$(local_api)" "$(env_get SERVICE_ROLE_KEY)" \
    || warn "Data is restored but some files (logo/attachments) didn't copy. Run the restore again to retry."
  [[ -n "$TEST_MODE" ]] || dc start web >/dev/null
  info "$(db_value postgres "select count(*) || ' logins, ' || (select count(*) from public.customers) || ' companies, ' || (select count(*) from public.repair_orders) || ' jobs' from public.profiles")"
}

confirm_replace() {  # $1 = description of where the data comes from
  [[ "${AXLE_ASSUME_YES:-}" == 1 ]] && return 0
  echo
  echo "  This REPLACES ALL DATA on this server (jobs, companies, stock, logins, settings) with:"
  echo "    $1"
  echo "  A safety backup of the current data is saved first."
  read -r -p "  Type REPLACE to continue: " a
  [[ "$a" == REPLACE ]] || die "Cancelled. Nothing was changed."
}

cmd_restore() {
  need_root restore; load_conf; set_paths; need_stack
  local file="${1:-}" force="${2:-}" work safety
  [[ -n "$file" && -f "$file" ]] || die "Usage: $ME restore /path/to/axle-backup-....tar.gz"
  work="$(mktemp -d)"; chmod 700 "$work"; CLEANUP+=("$work")
  tar -xzf "$file" -C "$work" --no-same-owner || die "Couldn't open $file."
  say "Restore from $(basename "$file")"
  [[ -f "$work/manifest.txt" ]] || die "That file isn't an Axle backup."
  sed 's/^/    /' "$work/manifest.txt"
  check_bundle "$work" "$force"
  confirm_replace "$(basename "$file") ($(grep '^created=' "$work/manifest.txt" | cut -d= -f2), from $(grep '^source=' "$work/manifest.txt" | cut -d= -f2-))"
  say "Safety backup of the current data"
  safety="$(make_backup axle-before-restore)"; info "$safety"
  say "Restoring"
  restore_bundle "$work" "$force"
  rm -rf "$work"
  say "Restored. Everyone signs in again with their usual password."
}

cmd_import_cloud() {
  need_root import-cloud; load_conf; set_paths; need_stack
  local url api key ts work file safety
  say "Copy everything from a supabase.co project to this server"
  info "Read-only on the supabase.co side: nothing there is changed."
  info "In the Supabase dashboard of the project: Connect → Session pooler → copy the URI, with your database password filled in."
  read -r -s -p "    Database URI (postgresql://postgres.xxxx:password@...pooler.supabase.com:5432/postgres): " url; echo
  [[ "$url" =~ ^postgres(ql)?:// ]] || die "That doesn't look like a postgresql:// address."
  read -r -p "    Project URL (https://xxxx.supabase.co): " api
  [[ "$api" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || die "That doesn't look like a project URL."
  info "Project Settings → API keys → service_role (legacy) or a secret key:"
  read -r -s -p "    Service key: " key; echo
  [[ -n "$key" ]] || die "The service key is needed to copy uploaded files."
  export AXLE_SRC_URL="$url"
  say "Checking the project's tables match this server's"
  local theirs ours; theirs="$(fingerprint url)" || die "Couldn't connect to that database. Check the URI and password (use the Session pooler address)."
  ours="$(fingerprint local)"
  [[ "$theirs" == "$ours" ]] || die "That project's tables don't match this server's Axle version ($theirs vs $ours). Both must be on the same migrations. Nothing was changed."
  ts="$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  work="$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")"; CLEANUP+=("$work")
  say "Downloading from ${api%/}"
  export_bundle "$work" url "${api%/}" "$key" "${api%/}"
  unset AXLE_SRC_URL
  file="$BACKUP_DIR/axle-cloud-export-$ts.tar.gz"
  tar -czf "$file" -C "$work" .; chmod 600 "$file"
  info "saved as $file"
  check_bundle "$work" ""
  confirm_replace "the data of ${api%/} (just downloaded)"
  say "Safety backup of the current data"
  safety="$(make_backup axle-before-restore)"; info "$safety"
  say "Loading"
  restore_bundle "$work" ""
  rm -rf "$work"
  say "Done. People sign in at $(public_url) with their usual username/email and password."
}

# ---------------------------------------------------------------- update & daily use
cmd_update() {
  need_root update; load_conf; set_paths; check_conf; need_stack
  say "Safety backup before updating"
  info "$(make_backup axle-before-update)"
  configure_stack
  copy_overlay
  start_stack
  dc restart functions >/dev/null
  cmd_migrate
  say "Updated. Axle is running at $(public_url)"
}

cmd_enable_nightly_backup() {
  need_root enable-nightly-backup; load_conf; set_paths; need_stack
  cat > /etc/cron.d/axle-backup <<EOF
# Axle nightly backup (installed by axle.sh). Remove this file to stop.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root /bin/bash "$KIT_DIR/axle.sh" backup --quiet >> /var/log/axle-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/axle-backup
  say "Nightly backup at 02:30 into $BACKUP_DIR (newest $BACKUP_KEEP kept). Log: /var/log/axle-backup.log"
  info "Copy that folder somewhere else regularly too (another computer, USB disk, cloud drive)."
}

cmd_studio() {
  load_conf; set_paths; need_stack
  say "Supabase Studio (database dashboard: tables, SQL editor, logins)"
  info "It only listens on the server itself. From your computer, open a tunnel:"
  info "    ssh -L 8000:127.0.0.1:8000 <your-user>@$(conf AXLE_DOMAIN)"
  info "then browse to http://localhost:8000"
  info "Username: $(env_get DASHBOARD_USERNAME)"
  info "Password: $(env_get DASHBOARD_PASSWORD)"
}

cmd_status() {
  load_conf; set_paths; need_stack
  dc ps --format 'table {{.Service}}\t{{.Status}}'
  echo; info "Address: $(public_url)"
  local last; last="$(find "$BACKUP_DIR" -maxdepth 1 -name 'axle-*.tar.gz' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
  info "Latest backup: ${last:-none yet}"
}

# ---------------------------------------------------------------- main
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0   # sourced by the test harness: define functions only
cmd="${1:-help}"; shift || true
case "$cmd" in
  install)               cmd_install ;;
  create-owner)          cmd_create_owner ;;
  migrate)               cmd_migrate ;;
  update)                cmd_update ;;
  backup)                cmd_backup "${1:-}" ;;
  restore)               cmd_restore "${1:-}" "${2:-}" ;;
  import-cloud)          cmd_import_cloud ;;
  enable-nightly-backup) cmd_enable_nightly_backup ;;
  status)                need_root status; cmd_status ;;
  start)                 need_root start; load_conf; set_paths; need_stack; dc up -d --wait --wait-timeout 900; say "Running at $(public_url)" ;;
  stop)                  need_root stop; load_conf; set_paths; need_stack; dc stop; say "Stopped (data is kept)." ;;
  logs)                  need_root logs; load_conf; set_paths; need_stack; dc logs -f --tail 200 "$@" ;;
  studio)                need_root studio; cmd_studio ;;
  help|-h|--help)        sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)                     die "Unknown command: $cmd   (try: $ME help)" ;;
esac
