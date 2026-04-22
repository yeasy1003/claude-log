#!/usr/bin/env bash
# Release pipeline: verify → bump version → publish → push.
# Usage: ./scripts/release.sh [patch|minor|major]  (default: patch)
set -euo pipefail

BUMP="${1:-patch}"
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "usage: $0 [patch|minor|major]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

step() { printf "\n\033[1;36m→ %s\033[0m\n" "$*"; }
ok()   { printf "\033[0;32m✓ %s\033[0m\n" "$*"; }
die()  { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

step "checking working tree is clean"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree has uncommitted changes — commit or stash first"
fi

step "checking branch"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  die "must be on 'main', currently on '$BRANCH'"
fi
ok "on main"

step "pulling latest"
git pull --ff-only

step "verifying npm auth"
if ! npm whoami >/dev/null 2>&1; then
  die "not logged into npm. Run: npm login --auth-type=web"
fi
ok "authed as $(npm whoami)"

step "typecheck"
pnpm typecheck

step "tests"
pnpm test

step "bumping version ($BUMP)"
NEW_VERSION=$(npm version "$BUMP")      # creates a commit + annotated tag
ok "new version: $NEW_VERSION"

step "publishing to npm (prepack will rebuild dist)"
if ! npm publish; then
  printf "\n\033[0;31m✗ publish failed.\033[0m\n"
  printf "The version commit and tag were created locally but nothing is pushed.\n"
  printf "To roll back and retry later:\n"
  printf "    git tag -d %s && git reset --hard HEAD~1\n" "$NEW_VERSION"
  exit 1
fi
ok "published $NEW_VERSION"

step "pushing commits and tags to GitHub"
git push origin main
git push origin "$NEW_VERSION"

printf "\n\033[1;32m🎉 released %s\033[0m\n" "$NEW_VERSION"
printf "  npm:    https://www.npmjs.com/package/%s\n" "$(node -p "require('./package.json').name")"
printf "  github: https://github.com/yeasy1003/claude-log/releases/tag/%s\n" "$NEW_VERSION"
