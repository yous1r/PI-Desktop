/** Public, credential-free metadata for a Host-owned plugin connection. */
export type PluginConnection = {
  id: string;
  pluginId: string;
  label: string;
  baseUrl: string;
  revision: number;
  hasCredential: boolean;
  caConfigured: boolean;
  allowHttp: boolean;
  routes: Array<{ path: string; methods: Array<"GET" | "POST"> }>;
};

/** Requests cannot override authentication or select another origin. */
export type PluginConnectionRequest = {
  connectionId: string;
  expectedRevision: number;
  requestId: string;
  path: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type PluginConnectionResponse = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  connectionRevision: number;
};

export type PluginConnectionsApi = {
  getCapabilities(): Promise<{ version: 1 }>;
  list(): Promise<PluginConnection[]>;
  request(input: PluginConnectionRequest): Promise<PluginConnectionResponse>;
  cancel(requestId: string): Promise<void>;
};

/** Native settings input. Never expose this operation on the plugin API. */
export type PluginConnectionInput = {
  pluginId: string;
  id?: string;
  expectedRevision?: number;
  label: string;
  baseUrl: string;
  token?: string;
  caPem?: string;
  allowHttp: boolean;
  routes: PluginConnection["routes"];
};
