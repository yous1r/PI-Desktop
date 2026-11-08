import { describe, expect, it } from "vitest";

import { EventHub, EventStream } from "./event-log.js";
import { RacpError } from "./errors.js";
import type { Clock, IdSource } from "./ports.js";

class FixedClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
}

class SeqIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}

function stream(retention = { maxEvents: 100, maxAgeMs: 60_000 }, clock = new FixedClock()) {
  return new EventStream("ep_1", retention, clock, new SeqIds());
}

const draft = (kind: "item.completed" | "item.delta", sessionId = "s1") => ({
  scope: "session" as const,
  sessionId,
  revision: 1,
  kind,
  payload: {},
});

describe("EventStream", () => {
  it("sequences durable events and tags ephemeral ones with afterSequence", () => {
    const log = stream();
    const first = log.append(draft("item.completed"));
    const delta = log.append(draft("item.delta"));
    const second = log.append(draft("item.completed"));
    expect(first.sequence).toBe(1);
    expect(first.afterSequence).toBeUndefined();
    expect(delta.sequence).toBeUndefined();
    expect(delta.afterSequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.cursor()).toEqual({ epoch: "ep_1", sequence: 2 });
    expect(delta.epoch).toBe("ep_1");
  });

  it("replays retained durable events after a cursor and never a delta", () => {
    const log = stream();
    log.append(draft("item.completed"));
    log.append(draft("item.delta"));
    log.append(draft("item.completed"));
    log.append(draft("item.completed"));
    const decision = log.replay({ epoch: "ep_1", sequence: 1 });
    expect(decision.status).toBe("replay");
    if (decision.status !== "replay") throw new Error("unreachable");
    expect(decision.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(log.replay({ epoch: "ep_1", sequence: 3 })).toEqual({ status: "replay", events: [] });
  });

  it("resynchronizes on epoch change, eviction, and a cursor ahead of the host", () => {
    const log = stream({ maxEvents: 2, maxAgeMs: 60_000 });
    for (let index = 0; index < 4; index += 1) log.append(draft("item.completed"));
    expect(log.replay({ epoch: "ep_old", sequence: 1 })).toEqual({ status: "resync", reason: "epoch" });
    expect(log.replay({ epoch: "ep_1", sequence: 9 })).toEqual({ status: "resync", reason: "ahead" });
    expect(log.replay({ epoch: "ep_1", sequence: 1 })).toEqual({ status: "resync", reason: "evicted" });
    expect(log.replay({ epoch: "ep_1", sequence: 2 }).status).toBe("replay");
    expect(log.replay(undefined)).toEqual({ status: "live" });
  });

  it("evicts by age", () => {
    const clock = new FixedClock();
    const log = stream({ maxEvents: 100, maxAgeMs: 1_000 }, clock);
    log.append(draft("item.completed"));
    clock.current += 5_000;
    log.append(draft("item.completed"));
    expect(log.oldestRetained).toBe(2);
  });
});

describe("EventHub", () => {
  function hub() {
    return new EventHub({ clock: new FixedClock(), ids: new SeqIds() });
  }

  it("fans out per session and replays from a cursor on subscribe", () => {
    const events = hub();
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s2"));
    const received: number[] = [];
    const result = events.subscribe(
      { scope: "session", sessionId: "s1", after: { epoch: events.stream("s1").epoch, sequence: 1 } },
      { deliver: (envelope) => received.push(envelope.sequence!), close: () => {} },
    );
    expect(result.replayComplete).toBe(true);
    expect(result.starting.sequence).toBe(3);
    expect(received).toEqual([2]);
    events.publish(draft("item.completed", "s2"));
    events.publish(draft("item.completed", "s1"));
    expect(received).toEqual([2, 3]);
  });

  it("reports a resync instead of inventing events", () => {
    const events = hub();
    events.publish(draft("item.completed", "s1"));
    const result = events.subscribe(
      { scope: "session", sessionId: "s1", after: { epoch: "stale", sequence: 1 } },
      { deliver: () => {}, close: () => {} },
    );
    expect(result.replayComplete).toBe(false);
    expect(result.resyncReason).toBe("epoch");
  });

  it("drops ephemeral events first and closes a slow subscriber with a resumable cursor", () => {
    const events = hub();
    const delivered: string[] = [];
    let closed: { error: RacpError; sequence: number } | undefined;
    events.subscribe(
      { scope: "session", sessionId: "s1", maxOutstanding: 2 },
      {
        deliver: (envelope) => delivered.push(envelope.kind + ":" + (envelope.sequence ?? "e")),
        close: (error, cursor) => {
          closed = { error, sequence: cursor.sequence };
        },
      },
    );
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.delta", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.delta", "s1"));
    events.publish(draft("item.completed", "s1"));
    expect(delivered).toEqual(["item.completed:1", "item.completed:2"]);
    expect(closed?.error.code).toBe("CLIENT_TOO_SLOW");
    expect(closed?.sequence).toBe(2);
    expect(events.subscriptionCount()).toBe(0);
  });

  it("lets an acknowledging subscriber keep receiving", () => {
    const events = hub();
    const delivered: number[] = [];
    const { subscriptionId } = events.subscribe(
      { scope: "session", sessionId: "s1", maxOutstanding: 2 },
      { deliver: (envelope) => delivered.push(envelope.sequence!), close: () => {} },
    );
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.ack(subscriptionId, 2);
    events.publish(draft("item.completed", "s1"));
    expect(delivered).toEqual([1, 2, 3]);
  });

  it("keeps a separate host-scope stream", () => {
    const events = hub();
    const received: string[] = [];
    events.subscribe({ scope: "host" }, { deliver: (envelope) => received.push(envelope.kind), close: () => {} });
    events.publish({ scope: "host", revision: 0, kind: "session.created", payload: {} });
    events.publish(draft("item.completed", "s1"));
    expect(received).toEqual(["session.created"]);
    expect(events.hostStream().lastSequence).toBe(1);
  });
});

describe("replay byte retention", () => {
  it("evicts large UTF-8 events before the count limit and preserves live delivery", () => {
    const events = new EventHub({ clock: new FixedClock(), ids: new SeqIds(),
      replayBudget: { streamBytes: 1600, totalBytes: 3200 } });
    const received: unknown[] = [];
    events.subscribe({ scope: "session", sessionId: "s1" }, { deliver: e => received.push(e.payload), close: () => {} });
    const cursor = events.stream("s1").cursor();
    const payload = { text: "中".repeat(300) };
    events.publish({ ...draft("item.completed"), payload });
    events.publish({ ...draft("item.completed"), payload });
    expect(received).toEqual([payload, payload]);
    expect(events.stream("s1").replay(cursor)).toEqual({ status: "resync", reason: "evicted" });
    const retained = events.stream("s1").replay({ ...cursor, sequence: 1 });
    expect(retained.status).toBe("replay");
    if (retained.status === "replay") expect(retained.events).toHaveLength(1);
  });

  it("evicts the globally oldest event across sessions, including dormant streams", () => {
    const events = new EventHub({ clock: new FixedClock(), ids: new SeqIds(),
      replayBudget: { streamBytes: 4000, totalBytes: 1600 } });
    const cursor = events.stream("s1").cursor();
    events.publish({ ...draft("item.completed", "s1"), payload: { text: "x".repeat(900) } });
    events.publish({ ...draft("item.completed", "s2"), payload: { text: "y".repeat(900) } });
    expect(events.stream("s1").replay(cursor)).toEqual({ status: "resync", reason: "evicted" });
    expect(events.stream("s2").replay({ epoch: events.stream("s2").epoch, sequence: 0 }).status).toBe("replay");
  });

  it("delivers an oversized event live but never retains a replay gap", () => {
    const events = new EventHub({ clock: new FixedClock(), ids: new SeqIds(),
      replayBudget: { streamBytes: 900, totalBytes: 1800 } });
    const cursor = events.stream("s1").cursor();
    const delivered: number[] = [];
    events.subscribe({ scope: "session", sessionId: "s1" }, { deliver: e => delivered.push(e.sequence!), close: () => {} });
    events.publish(draft("item.completed"));
    events.publish({ ...draft("item.completed"), payload: { text: "x".repeat(2000) } });
    events.publish(draft("item.completed"));
    expect(delivered).toEqual([1, 2, 3]);
    expect(events.stream("s1").replay(cursor)).toEqual({ status: "resync", reason: "evicted" });
    const retained = events.stream("s1").replay({ ...cursor, sequence: 2 });
    expect(retained.status).toBe("replay");
    if (retained.status === "replay") expect(retained.events.map(e => e.sequence)).toEqual([3]);
  });

  it("expires dormant history on read and releases global capacity after count eviction", () => {
    const clock = new FixedClock();
    const events = new EventHub({ clock, ids: new SeqIds(), limits: { replayWindowEvents: 1, replayWindowMs: 1000 },
      replayBudget: { streamBytes: 4000, totalBytes: 2500 } });
    const cursor = events.stream("s1").cursor();
    for (let i = 0; i < 10; i++) events.publish({ ...draft("item.completed"), payload: { text: "x".repeat(900) } });
    events.publish({ ...draft("item.completed", "s2"), payload: { text: "y".repeat(900) } });
    expect(events.stream("s1").replay({ ...cursor, sequence: 9 }).status).toBe("replay");
    clock.current += 2000;
    expect(events.stream("s1").replay({ ...cursor, sequence: 9 })).toEqual({ status: "resync", reason: "evicted" });
  });
});
