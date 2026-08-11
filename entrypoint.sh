#!/bin/sh
# Container entrypoint for agglayer-dev-ui.
#
# Contract (a1-runtime-config-design.md §6.3, binding):
#   - If a config.json is bind-mounted at MOUNTED_CONFIG, validate it and
#     copy it over the baked-in webroot config.json, then start nginx.
#   - If nothing is mounted, serve the baked-in default and warn LOUDLY --
#     the baked default (the repo's committed config.json) carries
#     https://PLACEHOLDER-* aggkit URLs, so it validates but does not work
#     end-to-end.
#   - This script does NOT synthesize config from environment variables.
#     No envsubst, no templating, no AGGKIT_API_URL-style knobs. The mounted
#     file (or the baked default) is the only configuration mechanism.
#
# Validation approach and its explicit limits:
#   This is the nginx:alpine runtime stage -- there is no Node here, so the
#   app's real validator (config/configSchema.mjs, a Zod schema) cannot run.
#   We use `jq` instead to do two things:
#     1. Confirm the mounted file is well-formed JSON (`jq empty`).
#     2. Confirm a small set of required top-level fields exist and have the
#        right JSON *type* (object/string), including that
#        appModes.configs contains the key named by appModes.default.
#   This is a STRUCTURAL check, NOT a substitute for full schema validation.
#   It will NOT catch: malformed URLs, wrong chain object shapes, dangling
#   chainKeys references into a nonexistent chain, wrong autoclaim/currency
#   field types, duplicate networkIds, or any of the other semantic rules
#   `config/configValidator.mjs` enforces. A config that passes this check
#   can still fail at the browser's AppConfigGate (which does run the real
#   Zod validation) and render the error screen. Operators should still run
#   the real validator from a dev-ui checkout against a candidate config.json
#   before mounting it into this image:
#       pnpm run validate:config -- /path/to/your/config.json
set -eu

WEBROOT_CONFIG="/usr/share/nginx/html/config.json"
MOUNTED_CONFIG="/etc/agglayer-dev-ui/config.json"

log() {
    printf '%s\n' "$*" >&2
}

# Runs the structural checks described above against $1. Returns non-zero
# and prints a diagnostic on the first failure.
validate_config() {
    file="$1"

    if ! jq empty "$file" 2>/tmp/agglayer-dev-ui-jq-error; then
        log "config validation failed: $file is not valid JSON:"
        cat /tmp/agglayer-dev-ui-jq-error >&2
        return 1
    fi

    if ! jq -e '
            (.chains? | type == "object") and ((.chains | length) > 0) and
            (.appModes? | type == "object") and
            (.appModes.default? | type == "string") and
            (.appModes.configs? | type == "object") and ((.appModes.configs | length) > 0) and
            (.appModes.configs[.appModes.default]? != null) and
            (.autoclaim? | type == "object") and
            (.externalLinks? | type == "object")
        ' "$file" >/dev/null 2>/tmp/agglayer-dev-ui-jq-error
    then
        log "config validation failed: $file is missing required top-level fields, or they have the wrong shape."
        log "Expected: chains (non-empty object), appModes.default (string), appModes.configs (non-empty object containing the appModes.default key), autoclaim (object), externalLinks (object)."
        log "Note: this is a structural check only -- it does not validate individual field values (see this script's header comment)."
        return 1
    fi

    return 0
}

if [ -f "$MOUNTED_CONFIG" ]; then
    log "agglayer-dev-ui: found mounted config at $MOUNTED_CONFIG"
    if ! validate_config "$MOUNTED_CONFIG"; then
        log "agglayer-dev-ui: FATAL - mounted config at $MOUNTED_CONFIG failed validation. Refusing to start."
        exit 1
    fi
    cp "$MOUNTED_CONFIG" "$WEBROOT_CONFIG"
    log "agglayer-dev-ui: serving mounted config from $MOUNTED_CONFIG"
elif [ -e "$MOUNTED_CONFIG" ]; then
    # Docker creates an empty directory at the container-side bind-mount
    # path when the host source path doesn't exist. This is the classic
    # "-v ./typo-config.json:/etc/..." mistake -- fail loudly instead of
    # silently falling through to the baked default.
    log "agglayer-dev-ui: FATAL - $MOUNTED_CONFIG exists but is not a regular file."
    log "This usually means the host path in your -v/--mount bind mount does not exist,"
    log "and Docker created an empty directory there instead of mounting your file."
    exit 1
else
    log "=============================================================================="
    log "WARNING: agglayer-dev-ui: no config mounted at $MOUNTED_CONFIG"
    log "WARNING: serving the BAKED-IN DEFAULT config.json, which contains placeholder"
    log "WARNING: aggkit URLs (https://PLACEHOLDER-*) and DOES NOT WORK end-to-end."
    log "WARNING: mount a real config.json at $MOUNTED_CONFIG to configure this deployment,"
    log "WARNING: e.g. docker run -v /path/to/your/config.json:$MOUNTED_CONFIG:ro ..."
    log "WARNING: see docs/config.md for the schema."
    log "=============================================================================="
fi

exec nginx -g 'daemon off;'
