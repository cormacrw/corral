#!/usr/bin/env bash
# `docker compose` with the same CORRAL_BUILD_SHA auto-deploy.sh would use. Use
# it for every manual build or `up`: without the SHA an image is stamped
# `development`, which restarts everything and marks every runner behind.
#
# Usage, from the checkout root: scripts/deploy/compose.sh up -d --build
set -euo pipefail

CORRAL_BUILD_SHA=$("$(dirname "$0")/build-sha.sh")
export CORRAL_BUILD_SHA
exec docker compose "$@"
