import path from 'node:path';
import { resolveAgentDeckHome } from '../lib/paths';

export function getStoreRoot(home = resolveAgentDeckHome()): string {
  return home;
}

export function storePaths(home = resolveAgentDeckHome()) {
  const root = getStoreRoot(home);
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    playbooksDir: path.join(root, 'playbooks'),
    servicesDir: path.join(root, 'services'),
    decksDir: path.join(root, 'decks'),
    credentialsDir: path.join(root, 'credentials'),
  };
}
