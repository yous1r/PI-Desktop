import { normalizeProjectPath, type McpServerRecord } from "@pi-desktop/shared";

function identity(path: string): string {
  const normalized = normalizeProjectPath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Exact logical identity only: a binding never implies another repository or a filesystem mount. */
export function centralProjectForSession(record: McpServerRecord, projectPath?: string | null): string | undefined {
  if (!projectPath) return undefined;
  const target = identity(projectPath);
  return Object.entries(record.memoryProjectBindings ?? {}).find(([path]) => identity(path) === target)?.[1];
}

export function memoryToolDescription(record: McpServerRecord, toolName: string, description: string, projectPath?: string | null): string {
  const project = centralProjectForSession(record, projectPath);
  if (!project || !toolName.startsWith("sc_memory_")) return description;
  return `${description} This session is explicitly bound to central-memory project ${JSON.stringify(project)}. Code paths are relative to this session's actual workspace, including a remote workspace; verify the revision before reading files.`;
}

/** Fill an explicit configured binding; never silently overwrite a different requested project. */
export function boundMemoryArguments(record: McpServerRecord, toolName: string, args: unknown, projectPath?: string | null): unknown {
  const project = centralProjectForSession(record, projectPath);
  if (!project || !toolName.startsWith("sc_memory_") || toolName === "sc_memory_projects" || toolName === "sc_memory_test_connection") return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const input = args as Record<string, unknown>;
  const mismatch = () => Object.assign(new Error("The requested central project differs from this session's configured binding. Review the MCP project binding before continuing."), { errorCode: "MCP_PROJECT_BINDING_MISMATCH" });
  if (toolName === "sc_memory_search") {
    if (input.projects !== undefined && (!Array.isArray(input.projects) || input.projects.length !== 1 || input.projects[0] !== project)) throw mismatch();
    return { ...input, projects: [project] };
  }
  if (!["sc_memory_status", "sc_memory_get", "sc_memory_put", "sc_memory_ingest", "sc_memory_trace", "sc_memory_forget"].includes(toolName)) return args;
  if (input.project !== undefined && input.project !== project) throw mismatch();
  return { ...input, project };
}
