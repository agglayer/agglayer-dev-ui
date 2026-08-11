#!/usr/bin/env bash
# TEMPORARY -- remove per plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §5
#
# Populates .sdk-src/ (gitignored) with a tracked-files-only snapshot of an
# agglayer/sdk checkout, so `docker build .` can stage it into the
# `sdk-builder` stage (see Dockerfile). This is the local-dev equivalent of
# what CI does with a second `actions/checkout` of agglayer/sdk pinned to
# SDK_REF (plans/dev-ui-docker-ghcr/d2-adr-dependency-strategy.md §4.1) --
# both payloads are `git archive` snapshots of tracked source only, so the
# local and CI Docker build inputs are byte-comparable.
#
# Deliberately NOT `cp -r ../sdk`: that would drag in node_modules/ and a
# possibly-stale gitignored dist/ into the Docker build context (see the ADR
# §2 "Rejected options" and §3).
#
# Usage:
#   scripts/stage-sdk-src.sh [path-to-sdk-checkout]   # defaults to ../sdk
#
# Then build normally from the repo root:
#   docker build --build-arg SDK_REF="$(git -C ../sdk rev-parse HEAD)" -t agglayer-dev-ui .
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_CHECKOUT="${1:-$REPO_ROOT/../sdk}"
DEST_DIR="$REPO_ROOT/.sdk-src"

if [ ! -d "$SDK_CHECKOUT/.git" ]; then
  echo "error: '$SDK_CHECKOUT' is not a git checkout (expected a sibling agglayer/sdk clone)" >&2
  echo "usage: $0 [path-to-sdk-checkout]" >&2
  exit 1
fi

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
git -C "$SDK_CHECKOUT" archive --format=tar HEAD | tar -x -C "$DEST_DIR"

sdk_head="$(git -C "$SDK_CHECKOUT" rev-parse HEAD)"
echo "Staged $SDK_CHECKOUT@$sdk_head (tracked files only, no node_modules/dist) -> $DEST_DIR"
echo "SDK_REF=$sdk_head"
