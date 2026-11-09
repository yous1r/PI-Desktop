import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpOAuthActivity, McpOAuthOperation } from "./mcp-oauth-activity.ts";

/** A listener may finish binding after cancellation; close that original listener afterwards. */
export class McpOAuthLoopback {
  readonly server: Server;
  private binding?: Promise<AddressInfo>;
  private bindingPending = false;
  private bound = false;
  private closing?: Promise<void>;
  private readonly activity: McpOAuthActivity;
  private readonly operation: McpOAuthOperation;
  private readonly responses = new Set<ServerResponse>();
  constructor(activity: McpOAuthActivity, operation: McpOAuthOperation, factory: typeof createServer,
    callback: (request: IncomingMessage, response: ServerResponse) => Promise<void>, onError: (error: Error) => void) {
    this.activity = activity; this.operation = operation;
    operation.nativeAttempt();
    this.server = factory((request, response) => operation.track(async () => {
      this.observeResponse(response);
      await callback(request, response);
    }));
    activity.resources.add(this);
    const runtimeError = (error: Error) => { if (this.bound) onError(error); };
    this.server.on("error", runtimeError);
    this.removeError = () => this.server.off("error", runtimeError);
  }
  private readonly removeError: () => void;
  listen(preferredPort?: number): Promise<AddressInfo> {
    this.operation.assertCurrent();
    const completion = Promise.withResolvers<AddressInfo>();
    this.binding = completion.promise;
    this.bindingPending = true;
    void completion.promise.then(() => { this.bindingPending = false; }, () => { this.bindingPending = false; });
    const attempt = (port: number, fallback: boolean): void => {
      try { this.operation.assertCurrent(); }
      catch (error) { completion.reject(error); return; }
      const onError = (error: Error) => {
        this.server.off("error", onError);
        if (fallback && (error as NodeJS.ErrnoException).code === "EADDRINUSE") { attempt(0, false); return; }
        completion.reject(error);
      };
      this.server.once("error", onError);
      try {
        this.server.listen(port, "127.0.0.1", () => {
          this.bound = true;
          this.server.off("error", onError);
          const address = this.server.address();
          if (!address || typeof address === "string") completion.reject(new Error("OAuth loopback server has no address"));
          else completion.resolve(address);
        });
      } catch (error) { this.server.off("error", onError); completion.reject(error); }
    };
    attempt(preferredPort ?? 0, Boolean(preferredPort && preferredPort > 0));
    return completion.promise;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    const close = () => {
      try {
        for (const response of this.responses) if (!response.writableEnded) response.destroy();
        this.server.close(error => {
          this.removeError();
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            this.activity.uncertain(); this.activity.report("MCP OAuth listener cleanup could not be confirmed");
          } else this.activity.resources.delete(this);
          completion.resolve();
        });
        this.server.closeAllConnections();
      } catch {
        this.activity.uncertain(); this.activity.report("MCP OAuth listener cleanup could not be confirmed"); completion.resolve();
      }
    };
    // Keep the cleanup operation observable even when the original bind ignores cancellation.
    void this.operation.track(() => completion.promise);
    if (this.bindingPending && this.binding) void this.binding.then(close, close); else close();
    return completion.promise;
  }
  private observeResponse(response: ServerResponse): void {
    const completion = Promise.withResolvers<void>();
    this.responses.add(response);
    const done = () => {
      response.off("finish", done); response.off("close", done);
      this.responses.delete(response); completion.resolve();
    };
    response.once("finish", done); response.once("close", done);
    void this.operation.track(() => completion.promise);
    if (response.writableEnded || response.destroyed) done();
  }
}
