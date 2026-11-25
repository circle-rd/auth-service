#!/usr/bin/env bash
#
# Deploy auth-service (and optionally the LiteLLM gateway and reverse-relay).
#
# The script operates on a deployment directory holding `compose.yml` and
# `.env`. When `.env` does not exist it is created with freshly generated
# secrets; when it exists its values are never overwritten, so a redeploy
# cannot rotate credentials accidentally. Missing derived settings may be
# appended. Change options by editing `.env`.
#
# Examples:
#   ./deploy.sh --domain example.com
#   ./deploy.sh --domain example.com --litellm
#   ./deploy.sh --domain example.com --litellm --resource-sharing --relay
#   ./deploy.sh --domain example.com --litellm --relay --dir /srv/circle
#   ./deploy.sh --dir /srv/circle              # redeploy an existing .env

set -euo pipefail
umask 022

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_TEMPLATE="$SCRIPT_DIR/compose.yml"

TARGET_DIR=""
DOMAIN=""
AUTH_HOST=""
LLM_HOST=""
RELAY_HOST=""
ADMIN_EMAIL=""
ACME_EMAIL=""
AUTH_TAG="nightly"

ENABLE_LITELLM=0
ENABLE_RESOURCE_SHARING=0
ENABLE_RELAY=0
RESOURCE_SHARING_REQUESTED=0

START=1
PULL=1
UPDATE_COMPOSE=0
OPTIONS_PROVIDED=0

DEFAULT_LITELLM_IMAGE="ghcr.io/berriai/litellm:v1.108.8"
DEFAULT_RELAY_IMAGE="ghcr.io/circle-rd/ai-reverse-relay:nightly"
DEFAULT_TRAEFIK_IMAGE="traefik:v3"

note() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy.sh [options]

Creates or reuses a deployment directory containing compose.yml and .env, then
runs `docker compose pull` and `docker compose up -d`.

Creation options (used only when .env does not exist yet):
  --domain DOMAIN          Base domain. Defaults auth.<DOMAIN>, llm.<DOMAIN>
                           and relay.<DOMAIN>. Required to create .env.
  --auth-host HOST         Override the auth-service host (default auth.DOMAIN).
  --llm-host HOST          Override the LiteLLM host (default llm.DOMAIN).
  --relay-host HOST        Override the relay host (default relay.DOMAIN).
  --admin-email EMAIL      Bootstrap superadmin e-mail (default admin.DOMAIN).
  --acme-email EMAIL       Let's Encrypt contact e-mail (default admin.DOMAIN).
  --auth-tag TAG           auth-service image tag (default nightly).
  --litellm                Enable the LiteLLM gateway (profile: llm). Also
                           enables resource sharing, which user-token
                           authorization requires.
  --resource-sharing       Enable cross-application resource sharing. Without
                           --litellm no built-in LiteLLM-backed scheme is
                           enabled.
  --relay                  Enable reverse-relay (implies --litellm and
                           --resource-sharing; profiles: llm,relay).

Execution options:
  --dir PATH               Deployment directory (default: this script's dir).
  --update-compose         Replace an existing compose.yml, keeping a backup.
  --no-pull                Skip `docker compose pull`.
  --no-start               Validate the configuration only; skips pull and
                           start.
  -h, --help               Show this help.

An existing .env is never overwritten: its values are preserved and only
missing derived settings are appended. Creation options are ignored in that
case; edit .env directly to change the domain, profiles or feature flags.
EOF
}

require_value() {
  local option=$1 value=${2-}
  [[ -n $value ]] || die "$option requires a value"
}

validate_host() {
  local value=$1 label=$2
  [[ $value =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    die "$label must be a host name without scheme or path: $value"
  [[ $value != *..* ]] || die "$label contains an empty label: $value"
}

validate_email() {
  local value=$1 label=$2
  [[ $value =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] ||
    die "$label must be an e-mail address: $value"
}

while (($# > 0)); do
  case "$1" in
    --domain)
      require_value "$1" "${2-}"
      DOMAIN=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --domain=*)
      DOMAIN=${1#*=}
      [[ -n $DOMAIN ]] || die "--domain requires a value"
      OPTIONS_PROVIDED=1
      shift
      ;;
    --auth-host)
      require_value "$1" "${2-}"
      AUTH_HOST=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --auth-host=*)
      AUTH_HOST=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --llm-host)
      require_value "$1" "${2-}"
      LLM_HOST=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --llm-host=*)
      LLM_HOST=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --relay-host)
      require_value "$1" "${2-}"
      RELAY_HOST=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --relay-host=*)
      RELAY_HOST=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --admin-email)
      require_value "$1" "${2-}"
      ADMIN_EMAIL=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --admin-email=*)
      ADMIN_EMAIL=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --acme-email)
      require_value "$1" "${2-}"
      ACME_EMAIL=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --acme-email=*)
      ACME_EMAIL=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --auth-tag)
      require_value "$1" "${2-}"
      AUTH_TAG=$2
      OPTIONS_PROVIDED=1
      shift 2
      ;;
    --auth-tag=*)
      AUTH_TAG=${1#*=}
      OPTIONS_PROVIDED=1
      shift
      ;;
    --litellm)
      ENABLE_LITELLM=1
      OPTIONS_PROVIDED=1
      shift
      ;;
    --resource-sharing)
      ENABLE_RESOURCE_SHARING=1
      RESOURCE_SHARING_REQUESTED=1
      OPTIONS_PROVIDED=1
      shift
      ;;
    --relay)
      ENABLE_RELAY=1
      OPTIONS_PROVIDED=1
      shift
      ;;
    --dir)
      require_value "$1" "${2-}"
      TARGET_DIR=$2
      shift 2
      ;;
    --dir=*)
      TARGET_DIR=${1#*=}
      [[ -n $TARGET_DIR ]] || die "--dir requires a value"
      shift
      ;;
    --update-compose)
      UPDATE_COMPOSE=1
      shift
      ;;
    --no-pull)
      PULL=0
      shift
      ;;
    --no-start)
      START=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

if ((ENABLE_RELAY)); then
  ((ENABLE_LITELLM)) || note "--relay implies --litellm"
  ((ENABLE_RESOURCE_SHARING)) || note "--relay implies --resource-sharing"
  ENABLE_LITELLM=1
  ENABLE_RESOURCE_SHARING=1
fi

if ((ENABLE_LITELLM)); then
  if ((RESOURCE_SHARING_REQUESTED == 0 && ENABLE_RELAY == 0)); then
    note "--litellm enables --resource-sharing (required by gateway user tokens)"
  fi
  ENABLE_RESOURCE_SHARING=1
fi

if [[ -n $TARGET_DIR ]]; then
  mkdir -p -- "$TARGET_DIR"
  TARGET_DIR=$(cd -- "$TARGET_DIR" && pwd)
else
  TARGET_DIR=$SCRIPT_DIR
fi

[[ -f $COMPOSE_TEMPLATE ]] || die "missing compose template: $COMPOSE_TEMPLATE"
command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is not available"

TARGET_COMPOSE="$TARGET_DIR/compose.yml"
if [[ $TARGET_COMPOSE != "$COMPOSE_TEMPLATE" ]]; then
  if [[ ! -e $TARGET_COMPOSE ]]; then
    cp -- "$COMPOSE_TEMPLATE" "$TARGET_COMPOSE"
    note "Wrote $TARGET_COMPOSE"
  elif cmp -s -- "$COMPOSE_TEMPLATE" "$TARGET_COMPOSE"; then
    :
  elif ((UPDATE_COMPOSE)); then
    backup="$TARGET_COMPOSE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p -- "$TARGET_COMPOSE" "$backup"
    cp -- "$COMPOSE_TEMPLATE" "$TARGET_COMPOSE"
    note "Replaced $TARGET_COMPOSE (backup: $backup)"
  else
    warn "keeping existing $TARGET_COMPOSE (use --update-compose to replace it)"
  fi
fi

ENV_FILE="$TARGET_DIR/.env"

env_get() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

ensure_env_line() {
  local key=$1 value=$2
  if ! grep -q -- "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
    note "Added missing $key to existing .env"
  fi
}

if [[ -s $ENV_FILE ]]; then
  note "Using existing $ENV_FILE (existing values are preserved)"
  if ((OPTIONS_PROVIDED)); then
    warn "creation options were ignored because .env exists; edit .env to change the deployment"
  fi

  profiles_value=$(env_get COMPOSE_PROFILES)
  if [[ ,${profiles_value:-}, == *,relay,* && ,${profiles_value:-}, != *,llm,* ]]; then
    die "COMPOSE_PROFILES enables relay without llm; use COMPOSE_PROFILES=llm,relay"
  fi

  auth_host=$(env_get AUTH_HOST)
  cors_origins=$(env_get CORS_ORIGINS)
  cors_list=",${cors_origins//[[:space:]]/},"
  if [[ -n $auth_host && -n $cors_origins && $cors_list != *",https://$auth_host,"* ]]; then
    warn "CORS_ORIGINS does not include https://$auth_host; update it after changing AUTH_HOST"
  fi

  relay_host=$(env_get RELAY_HOST)
  reverse_resource=$(env_get REVERSE_AGENT_RESOURCE)
  if [[ -n $relay_host && -n $reverse_resource && $reverse_resource != "https://$relay_host" ]]; then
    warn "REVERSE_AGENT_RESOURCE does not match RELAY_HOST; update it after changing RELAY_HOST"
  fi

  if [[ ,${profiles_value:-}, == *,llm,* ]]; then
    ensure_env_line LITELLM_URL "http://litellm:4000"
    ensure_env_line LITELLM_INVENTORY_KEY_FILE "/run/litellm-provisioner/inventory-key"
  elif [[ -n "$(env_get LITELLM_URL)" ]]; then
    warn "LITELLM_URL is set while the llm profile is off; auth-service will keep retrying inventory sync"
  fi

  if [[ ,${profiles_value:-}, != *,llm,* && $(env_get RESOURCE_SHARING_ENABLED) == "true" ]]; then
    warn "RESOURCE_SHARING_ENABLED=true but COMPOSE_PROFILES does not include llm; LiteLLM and relay services will not start"
  fi
else
  [[ -n $DOMAIN ]] || die "--domain is required to create .env (try --help)"
  validate_host "$DOMAIN" "--domain"
  AUTH_HOST=${AUTH_HOST:-auth.$DOMAIN}
  LLM_HOST=${LLM_HOST:-llm.$DOMAIN}
  RELAY_HOST=${RELAY_HOST:-relay.$DOMAIN}
  ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$DOMAIN}
  ACME_EMAIL=${ACME_EMAIL:-admin@$DOMAIN}
  validate_host "$AUTH_HOST" "--auth-host"
  validate_host "$LLM_HOST" "--llm-host"
  validate_host "$RELAY_HOST" "--relay-host"
  validate_email "$ADMIN_EMAIL" "--admin-email"
  validate_email "$ACME_EMAIL" "--acme-email"
  [[ $AUTH_TAG =~ ^[A-Za-z0-9._-]+$ ]] || die "--auth-tag is not a valid tag: $AUTH_TAG"

  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"

  better_auth_secret=$(openssl rand -hex 32)
  postgres_password=$(openssl rand -hex 24)
  admin_password=$(openssl rand -hex 24)
  relay_api_key=$(openssl rand -hex 32)

  profiles=()
  ((ENABLE_LITELLM)) && profiles+=(llm)
  ((ENABLE_RELAY)) && profiles+=(relay)
  old_ifs=$IFS
  IFS=,
  profiles_csv="${profiles[*]}"
  IFS=$old_ifs

  if ((ENABLE_RESOURCE_SHARING)); then
    if ((ENABLE_LITELLM)); then
      schemes="llm,agent,mcp"
    else
      warn "resource sharing is enabled without LiteLLM; no built-in gateway-backed schemes are enabled"
      schemes=""
    fi
    resource_sharing=true
  else
    schemes=""
    resource_sharing=false
  fi

  if ((ENABLE_LITELLM)); then
    litellm_env=$'LITELLM_URL=http://litellm:4000\nLITELLM_INVENTORY_KEY_FILE=/run/litellm-provisioner/inventory-key'
  else
    litellm_env='# LiteLLM inventory sync is disabled while the llm profile is off.'
  fi

  if ((ENABLE_RELAY)); then
    device_grant=true
  else
    device_grant=false
  fi

  tmp_env=$(mktemp "$TARGET_DIR/.env.XXXXXX")
  trap 'rm -f -- "$tmp_env"' EXIT
  {
    cat <<EOF
# Generated by deploy.sh. Keep this file private; it holds every secret of the
# stack. It is never overwritten by a later deploy.

# ── Deployment ───────────────────────────────────────────────────────────────
AUTH_IMAGE=ghcr.io/circle-rd/auth-service:$AUTH_TAG
AUTH_HOST=$AUTH_HOST
LLM_HOST=$LLM_HOST
RELAY_HOST=$RELAY_HOST
ACME_EMAIL=$ACME_EMAIL
COMPOSE_PROFILES=$profiles_csv
# Optional: trust the Traefik address or a narrow CIDR for rate limiting.
# Leave empty to ignore forwarded headers (secure default).
# TRUST_PROXY=10.0.0.10/32

TRAEFIK_IMAGE=$DEFAULT_TRAEFIK_IMAGE
LITELLM_IMAGE=$DEFAULT_LITELLM_IMAGE
RELAY_IMAGE=$DEFAULT_RELAY_IMAGE

# ── auth-service ─────────────────────────────────────────────────────────────
BETTER_AUTH_SECRET=$better_auth_secret
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$admin_password
APP_NAME="CIRCLE Auth"
SHOWCASE=true
LOG_LEVEL=info
BETTER_AUTH_RATE_LIMIT_ENABLED=true

REQUIRE_EMAIL_VERIFICATION=false
MAGIC_LINK_ENABLED=false
EMAIL_OTP_ENABLED=false

# ── Database ─────────────────────────────────────────────────────────────────
POSTGRES_USER=auth
POSTGRES_PASSWORD=$postgres_password
POSTGRES_DB=auth

# ── LiteLLM ──────────────────────────────────────────────────────────────────
# litellm-setup generates the master and salt keys on first start and keeps them
# on the litellm_config volume. Set them here only to choose them yourself; the
# salt key must never change once models have been added.
# LITELLM_MASTER_KEY=
# LITELLM_SALT_KEY=
LITELLM_SSO_ENABLED=true
LITELLM_ADMIN_CIDR=10.0.0.0/8
$litellm_env

# ── Resource sharing and reverse-relay ───────────────────────────────────────
RESOURCE_SHARING_ENABLED=$resource_sharing
RESOURCE_SCHEMES_ENABLED=$schemes
DEVICE_AUTHORIZATION_ENABLED=false
OAUTH_DEVICE_GRANT_ENABLED=$device_grant
REVERSE_AGENT_CLIENT_ID=reverse-agent
# REVERSE_AGENT_RESOURCE is derived by compose from RELAY_HOST.
REVERSE_AGENT_RESOURCE_NAME=reverse-relay
REVERSE_AGENT_ACCESS_TOKEN_TTL_SECONDS=900
RELAY_API_KEY=$relay_api_key

# ── Optional integrations ────────────────────────────────────────────────────
# Fill in as needed; empty values are omitted so each service keeps its default.
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=
# MAIL_REPLY_TO=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# LINKEDIN_CLIENT_ID=
# LINKEDIN_CLIENT_SECRET=
# MICROSOFT_CLIENT_ID=
# MICROSOFT_CLIENT_SECRET=
# APPLE_CLIENT_ID=
# APPLE_CLIENT_SECRET=
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
# WALLET_USD_TO_EUR_RATE=
# WALLET_MARGIN_PERCENT=
# WALLET_TOPUP_MIN_EUR=
# WALLET_TOPUP_MAX_EUR=
# APP_LOGO_URL=
# APP_LOGO_DARK_URL=
EOF
  } >"$tmp_env"

  mv -- "$tmp_env" "$ENV_FILE"
  trap - EXIT
  chmod 600 -- "$ENV_FILE"
  note "Wrote $ENV_FILE (mode 600)"
fi

mkdir -p -- "$TARGET_DIR/data/postgres" "$TARGET_DIR/templates"

compose=(
  docker compose
  --project-directory "$TARGET_DIR"
  --env-file "$ENV_FILE"
  -f "$TARGET_COMPOSE"
)

note "Validating configuration"
"${compose[@]}" config --quiet

if ((PULL && START)); then
  note "Pulling images"
  "${compose[@]}" pull
fi

if ((START)); then
  note "Starting the stack"
  "${compose[@]}" up -d
else
  note "Configuration valid; skipping start (--no-start)"
fi

auth_host=$(env_get AUTH_HOST)
llm_host=$(env_get LLM_HOST)
relay_host=$(env_get RELAY_HOST)
profiles_value=$(env_get COMPOSE_PROFILES)
admin_email=$(env_get ADMIN_EMAIL)

printf '\n'
note "Deployment directory: $TARGET_DIR"
printf '    auth-service: https://%s\n' "${auth_host:-<unset>}"
if [[ ,${profiles_value:-}, == *,llm,* ]]; then
  printf '    LiteLLM:      https://%s\n' "${llm_host:-<unset>}"
fi
if [[ ,${profiles_value:-}, == *,relay,* ]]; then
  printf '    reverse-relay: https://%s\n' "${relay_host:-<unset>}"
fi
printf '    admin login:  %s\n' "${admin_email:-<unset>}"
printf '    admin password and all secrets: %s\n' "$ENV_FILE"
printf '\n'
printf 'Next: docker compose --project-directory %q -f %q ps\n' "$TARGET_DIR" "$TARGET_COMPOSE"
printf '      docker compose --project-directory %q -f %q logs -f auth\n' "$TARGET_DIR" "$TARGET_COMPOSE"
