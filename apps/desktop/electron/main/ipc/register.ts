import { join } from "node:path";
import { dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { ErrorCodes, IPC, type LifecycleDialogChoice } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { BackendRouter } from "../remote/backend-router";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { runAgentExtensionCommand } from "../agent-extension-command";
import { readNpmPath, writeNpmPath } from "../npm-preferences";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerWorkspaceTerminals } from "../bootstrap/workspace-terminals";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import type { McpOAuthManager } from "../mcp-oauth";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerWorkspacePluginConsentIpc } from "./workspace-plugin-consent-ipc";
import type { WorkspacePluginConsent } from "../services/workspace-plugin-consent";
import { registerJevIpc } from "./jev-ipc";
import { registerModesIpc } from "./modes-ipc";
import type { ModeServices } from "../runtime/mode-services";
import { registerProviderIpc } from "./provider-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerStorageIpc } from "../storage/ipc";
import { registerConfigSyncIpc } from "./config-sync-ipc";
import { registerBackgroundTasksIpc } from "./background-tasks-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAgentImportIpc } from "./agent-import-ipc";
import { registerRemoteHostIpc } from "./remote-host-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { registerWorktreeIpc } from "./worktree-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerVoiceIpc } from "./voice-ipc";
import { registerLiveVoiceIpc } from "./live-voice-ipc";
import type { LiveCallService } from "../live-voice/call-service";
import type { ComposerSuggestionAnswer } from "../services/composer-suggestion";
import type { LiveVoiceWidget } from "../live-voice/widget-window";
import type { IpcRegistrar } from "./types";
import type { PersonalTodosRuntime } from "../personal-todos/runtime";
import type { createTraySessions } from "../tray-sessions";
import type { createTaskbarUnreadBadge } from "../taskbar-unread-badge";
import { createIpcInvocationRouter } from "./invocation-router";
import type { DesktopHandoffAdmission } from "../runtime/handoff-admission";

export type RegisterIpcDependencies = {
  isQuitting: () => boolean;
  ipcMain: IpcMain;
  handoffAdmission: DesktopHandoffAdmission;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  traySessions: ReturnType<typeof createTraySessions>;
  taskbarUnreadBadge: ReturnType<typeof createTaskbarUnreadBadge>;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  /**
   * Resolves the remote backend router once it exists. Renderer IPC calls whose
   * session is owned by a paired remote host are forwarded through it; every
   * other call — including all internal invokes — runs the local handler
   * unchanged. Null until the router is wired (and in tests).
   */
  getBackendRouter?: () => BackendRouter | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  /** The session on screen, as the shell reported it (plugin `session:activated`). */
  setActivePluginSession: (
    next: { sessionId: string; projectPath: string | null } | null,
  ) => void;
  /** The shell's answer to a composer suggestion it was offered (ADR 0333). */
  settleComposerSuggestion: (answer: ComposerSuggestionAnswer) => boolean;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  disabledBuiltinSubagents: () => Promise<string[]>;
  disabledBuiltinSkills: () => Promise<string[]>;
  /** Host activation plus the inline-visualization switch, for runtime consumers. */
  runtimeDisabledBuiltinSkills: () => Promise<string[]>;
  completionNoticeTurns: Set<string>;
  /** Mode definition catalog and staged run coordination (ADR mode-definitions). */
  modeServices: ModeServices;
  liveCallService?: LiveCallService;
  liveVoiceWidget?: LiveVoiceWidget;
  personalTodos?: PersonalTodosRuntime;
  restartForStorage: () => void;
  mcpOAuth?: McpOAuthManager;
  workspaceConsent: WorkspacePluginConsent;
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  [name: string]: any;
};


export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    getAgentHostBridge,
    getBackendRouter,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    setActivePluginSession,
    settleComposerSuggestion,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    recordTurnStart,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    resolveEffectiveCommandShell,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    traySessions,
    taskbarUnreadBadge,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    mcpOAuth,
    refreshUserMcp,
    describeError,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
    voiceService,
    liveCallService,
    liveVoiceWidget,
  } = dependencies;


  const { handle, handleWithEvent, invoke } = createIpcInvocationRouter({
    ipcMain,
    admission: dependencies.handoffAdmission,
    getBackendRouter,
    observeInvoke: (channel) => {
      traySessions.observeInvoke(channel);
      taskbarUnreadBadge.observeInvoke(channel);
    },
  });
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };

  dependencies.personalTodos?.register(registrar);
  registerWorkspaceTerminals({ registrar, getMainWindow, getHost, currentWorkspacePath });
  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerStorageIpc({ registrar, getMainWindow, restart: dependencies.restartForStorage });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerSessionIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    stripWinLongPrefix,
    modeCatalog: dependencies.modeServices.catalog,
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    applyUpdatePreference: (preference) => updater.setPreference(preference),
    resolveEffectiveCommandShell,
    liveCallService,
  });
  registerConfigSyncIpc({
    registrar,
    getHost,
    sendToRenderer,
  });
  registerBackgroundTasksIpc({
    registrar,
    getHost,
  });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    onProviderInvalidated: (providerId) => liveCallService?.invalidateProvider(providerId),
  });
  registerJevIpc({ registrar, logger });
  registerModesIpc({ registrar, catalog: dependencies.modeServices.catalog, runs: dependencies.modeServices.runs });
  registerWorktreeIpc({
    registrar,
    getHost,
    logger,
    openPath: (path) => shell.openPath(path),
    stripWinLongPrefix,
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    userMcp,
    refreshUserMcp,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    disabledBuiltinSkills: runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
  });
  registerWindowIpc({
    setTraySessionPreferences: traySessions.setPreferences,
    registrar,
    getMainWindow,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    executeNativeMenuAction,
  });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
    isQuitting: dependencies.isQuitting,
    admission: dependencies.handoffAdmission,
    invoke,
  });
  registerWorkspaceIpc({
    registrar,
    getMainWindow,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    dialogs: dialog,
    getLocale: getUpdaterLocale,
    getNpmPath: () => readNpmPath(dataDir),
    setNpmPath: (path) => writeNpmPath(dataDir, path),
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: (input) => runAgentExtensionCommand(input, {
      getHost,
      getSidecar,
      acquireSessionOperation,
      resolveAgentRuntimeLaunch,
    }),
  });
  registerAgentIpc({
    registrar,
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => {
      plugins.cancelSessionTools(sessionId, reason);
      userMcp.cancelSessionCalls(sessionId);
    },
    logger,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    recordTurnStart,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
    modeRuns: dependencies.modeServices.runs,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    refreshUserMcp,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    oauth: mcpOAuth,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    plugins,
    pluginActiveInProject,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerAgentImportIpc({
    registrar,
    getHost,
    sendToRenderer,
    refreshUserMcp,
    currentWorkspacePath,
  });

  registerWorkspacePluginConsentIpc(registrar, dependencies.workspaceConsent);
  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
    setActivePluginSession,
    settleComposerSuggestion,
  });
  registerSpeechIpc({ registrar, speech });

  if (voiceService) {
    registerVoiceIpc({ registrar, voiceService });
  }
  if (liveCallService && liveVoiceWidget) {
    registerLiveVoiceIpc({ registrar, service: liveCallService, getMainWindow, widget: liveVoiceWidget });
  }

  registerRemoteHostIpc({ registrar });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    refreshUserMcp,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });


  return invoke;
}
