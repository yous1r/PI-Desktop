/**
 * V3 command-center presentation for the desktop renderer.
 *
 * Public seam for the parent integration: mount `CommandCenterSurface` in the
 * app route (or compose `CommandCenterToolbar` with the individual pages), pass
 * the C1 workspace/monitor/receipt data and explicit ports, and register the
 * `commandCenter` i18n namespace from `locales/en.json` and
 * `locales/zh-CN.json`. Nothing here registers IPC channels, RACP operations or
 * capabilities.
 */
export { CommandCenterSurface, type CommandCenterDraftSubmissionInput } from "./CommandCenterSurface";
export { CommandCenterToolbar, type CommandCenterToolbarDestination } from "./CommandCenterToolbar";
export { CommandCenterOverview } from "./CommandCenterOverview";
export { CommandCenterWorkspacePage } from "./CommandCenterWorkspacePage";
export { CommandCenterHistoryPage } from "./CommandCenterHistoryPage";
export { CommandCenterReceipts } from "./CommandCenterReceipts";
export { CommandCenterTaskList } from "./CommandCenterTaskList";
export { CommandCenterWorkspaceEntryList, CommandCenterWorkspaceTabStrip } from "./CommandCenterWorkspaceEntries";
export { COMMAND_CENTER_I18N_NAMESPACE } from "./strings";
export { useCommandCenterView } from "./view/use-command-center-view";
export * from "./view/command-center-view";
