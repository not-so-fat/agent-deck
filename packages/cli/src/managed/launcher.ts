import fs from 'node:fs';

import { localBinDir, localBinLauncherPath } from './paths';

const LAUNCHER_BODY = `#!/usr/bin/env bash
set -euo pipefail
HOME_DIR="\${AGENT_DECK_HOME:-$HOME/.agent-deck}"
CURRENT="$HOME_DIR/current"
BIN="$CURRENT/node_modules/@agent-deck/cli/dist/bin.js"
if [ ! -f "$BIN" ]; then
  echo "agent-deck: managed install broken (missing $BIN). Re-run: agent-deck install" >&2
  exit 1
fi
exec node "$BIN" "$@"
`;

export function writeLocalBinLauncher(): void {
  const dir = localBinDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = localBinLauncherPath();
  fs.writeFileSync(target, LAUNCHER_BODY, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}
