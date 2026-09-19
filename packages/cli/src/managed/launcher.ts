import fs from 'node:fs';
import path from 'node:path';

import { LAUNCHER_GUARD_JS } from './launcher-guard';
import { launcherGuardPath, localBinDir, localBinLauncherPath } from './paths';

const LAUNCHER_BODY = `#!/usr/bin/env bash
set -euo pipefail
HOME_DIR="\${AGENT_DECK_HOME:-$HOME/.agent-deck}"
CURRENT="$HOME_DIR/current"
BIN="$CURRENT/node_modules/@agent-deck/cli/dist/bin.js"
GUARD="$HOME_DIR/bin/launcher-guard.js"
# A version is trusted once it carries .verified; otherwise check it (and fall back if it is broken).
if [ ! -f "$CURRENT/.verified" ] && [ -f "$GUARD" ]; then
  if ! DIR="$(node "$GUARD" "$HOME_DIR")"; then
    echo "agent-deck: no loadable managed install under $HOME_DIR/versions. Reinstall: npm install --prefix $HOME_DIR/versions/<version> @agent-deck/cli@<version>, then point $CURRENT at it" >&2
    exit 1
  fi
  BIN="$DIR/node_modules/@agent-deck/cli/dist/bin.js"
fi
if [ ! -f "$BIN" ]; then
  echo "agent-deck: managed install broken (missing $BIN). Re-run: agent-deck install" >&2
  exit 1
fi
exec node "$BIN" "$@"
`;

export function writeLocalBinLauncher(): void {
  const guard = launcherGuardPath();
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, LAUNCHER_GUARD_JS);

  const dir = localBinDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = localBinLauncherPath();
  fs.writeFileSync(target, LAUNCHER_BODY, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}
