#!/bin/sh
# outrun's GitHub Action (../action.yml): puts `outrun` on the job's PATH, nothing else. The CLI is
# this checkout of the action (the tag the workflow pins), run from its sources on a pinned Bun:
# Bun's release zip checked against its SHA-256 below (from Bun's SHASUMS256.txt), the CLI's
# dependencies installed from bun.lock (--frozen-lockfile checks their integrity). Bun is kept in
# the runner's tool cache and called by its path: the job's own `bun`, if any, is left as it is.
set -eu

BUN_VERSION=1.4.4
action=$(cd "$(dirname "$0")/.." && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-aarch64 sha256=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 binary=0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc ;;
  Linux-aarch64 | Linux-arm64) platform=linux-aarch64 sha256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
  Linux-x86_64) platform=linux-x64 sha256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
  *) echo "outrun: no Bun build is pinned for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

tools="${RUNNER_TOOL_CACHE:?}/outrun-bun/$BUN_VERSION"
bun="$tools/bun"
# The runner's own Bun at ~/.bun/bin (outrun's macOS image has it; setup-bun installs there), used
# as it is when it is this exact build, checked by its binary's SHA-256 (`binary` above, the bun of
# the release zip): no download. GitHub's release download answered 504 to outrun-macos jobs and
# took 11 s when it did not (OUT-45, 2026-11-09).
own="${HOME:-}/.bun/bin/bun"
if [ ! -x "$bun" ] && [ -n "${binary:-}" ] && [ -x "$own" ] && [ "$(shasum -a 256 "$own" | cut -d' ' -f1)" = "$binary" ]; then
  bun=$own
  echo "outrun: Bun $BUN_VERSION from the runner ($own), not downloaded"
fi
if [ ! -x "$bun" ]; then
  tmp=$(mktemp -d "${RUNNER_TEMP:?}/outrun-bun.XXXXXX")
  curl -fsSL --retry 3 -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$platform.zip"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/bun.zip" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$tmp/bun.zip" | cut -d' ' -f1)
  fi
  if [ "$actual" != "$sha256" ]; then
    echo "outrun: Bun $BUN_VERSION ($platform) has SHA-256 $actual, expected $sha256" >&2
    rm -rf "$tmp"
    exit 1
  fi
  unzip -q "$tmp/bun.zip" -d "$tmp"
  mkdir -p "$tools"
  # Renamed into place within one folder, so a job beside this one never runs half a copy.
  mv "$tmp/bun-$platform/bun" "$tools/bun.$$"
  mv "$tools/bun.$$" "$bun"
  rm -rf "$tmp"
fi

(cd "$action" && "$bun" install --frozen-lockfile --production --silent)

bin="${RUNNER_TEMP:?}/outrun-bin"
mkdir -p "$bin"
cat >"$bin/outrun" <<EOF
#!/bin/sh
exec "$bun" "$action/src/main.ts" "\$@"
EOF
chmod +x "$bin/outrun"
echo "$bin" >>"${GITHUB_PATH:?}"
echo "outrun $("$bin/outrun" --version | sed 's/^outrun //') on Bun $("$bun" --version), from $action"
