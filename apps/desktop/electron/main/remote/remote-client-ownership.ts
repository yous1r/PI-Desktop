import type { ClientTransport, ClientTransportFactory } from "@pi-desktop/racp";
import { ExternalResourceActivity } from "../external-resource-activity.js";

type TransportRecord = {
  readonly transport: ClientTransport;
  readonly assertScope: () => void;
  retired: boolean;
  ended: boolean;
  closeRequested: boolean;
  closeError?: unknown;
  onClose?: (info: { code: number; reason: string }) => void;
};

export function remoteClientDisconnected(): Error {
  return Object.assign(new Error("Remote connection closed or replaced"), { code: "HOST_DISCONNECTED", errorCode: "HOST_DISCONNECTED" });
}

/** Local ownership only; a peer reply or transport close is not family closure. */
export class RemoteClientOwnership {
  private readonly activity: ExternalResourceActivity;
  private readonly records = new Set<TransportRecord>();
  private current?: TransportRecord;

  constructor(isAdmissionClosed: () => boolean, private readonly warn: (message: string) => void) {
    this.activity = new ExternalResourceActivity(isAdmissionClosed);
  }
  isAdmissionClosed(): boolean { return this.activity.isClosed(); }
  assertAdmission(): void {
    try { this.activity.assertOpen(); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "HOST_BUSY") throw Object.assign(error, { errorCode: "HOST_BUSY" });
      throw error;
    }
  }
  track<T>(operation: () => Promise<T>): Promise<T> { return this.activity.track(operation); }
  snapshot() { return this.activity.snapshot(this.records.size); }
  capture(requireAdmission: boolean): () => void {
    const record = this.current;
    const check = () => {
      if (!record || record.retired || record.ended || this.current !== record) throw remoteClientDisconnected();
      record.assertScope();
      if (requireAdmission) this.assertAdmission();
    };
    check();
    return check;
  }

  open(factory: ClientTransportFactory, assertScope: () => void): Promise<ClientTransport> {
    return this.track(async () => {
      assertScope(); this.assertAdmission();
      this.activity.nativeAttempt();
      const transport = await factory();
      const record: TransportRecord = { transport, assertScope, retired: false, ended: false, closeRequested: false };
      this.records.add(record);
      try {
        transport.onClose(info => {
          record.ended = true; record.retired = true;
          this.records.delete(record);
          if (this.current === record) this.current = undefined;
          record.onClose?.(info);
        });
        assertScope(); this.assertAdmission();
        if (record.ended) throw remoteClientDisconnected();
        this.current = record;
        const check = () => {
          if (record.retired || record.ended || this.current !== record) throw remoteClientDisconnected();
          assertScope();
        };
        return {
          send: frame => { check(); transport.send(frame); },
          close: (code, reason) => this.closeRecord(record, code, reason),
          onMessage: handler => transport.onMessage(frame => { if (!record.retired && this.current === record) handler(frame); }),
          onError: handler => transport.onError(error => { if (!record.retired && this.current === record) handler(error); }),
          onClose: handler => { record.onClose = handler; },
        };
      } catch (error) {
        this.closeRecord(record, 1000, "connection attempt retired");
        throw error;
      }
    });
  }

  closeAll(): void {
    const records = [...this.records];
    for (const record of records) this.closeRecord(record, 1000, "client closed");
    const failures = records.filter(record => record.closeError !== undefined).map(record => record.closeError);
    if (failures.length) throw new AggregateError(failures, "Remote transport cleanup could not be confirmed");
  }
  private closeRecord(record: TransportRecord, code?: number, reason?: string): void {
    if (record.closeRequested || record.ended) return;
    record.closeRequested = true; record.retired = true;
    if (this.current === record) this.current = undefined;
    try { record.transport.close(code, reason); }
    catch (error) {
      record.closeError = error;
      try { this.warn("Remote transport cleanup could not be confirmed; idle handoff remains unavailable"); }
      catch { console.error("Remote transport cleanup notification failed"); }
    }
  }
}
