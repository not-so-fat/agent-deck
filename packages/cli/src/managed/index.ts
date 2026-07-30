export {
  agentDeckHome,
  cliEntryInVersionDir,
  currentLinkPath,
  localBinDir,
  localBinLauncherPath,
  partialVersionDir,
  resolveCurrentVersionDir,
  updateStatePath,
  versionDir,
  versionsDir,
} from './paths';
export { detectInstallKind, type InstallKind } from './install-kind';
export { activateVersion, pruneOldVersions } from './activate';
export { writeLocalBinLauncher } from './launcher';
export { installCliVersionToPrefix, PACKAGE_NAME } from './npm-prefix-install';
export { compareSemver } from './semver';
export { readUpdateState, writeUpdateState, type UpdateState } from './update-state';
export {
  ensurePendingDownload,
  fetchLatestVersion,
  isAutoupdaterDisabled,
  maybeActivatePendingVersion,
  readCurrentManagedVersion,
  runManagedCliEntryHooks,
  scheduleBackgroundUpdateCheck,
} from './updater';
