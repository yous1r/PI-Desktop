/** Main-owned remote plugin approval. The renderer never supplies the grant binding. */
export type WorkspacePluginConsentRequest = {
  requestId: string;
  pluginName: string;
  hostKey: string;
};
