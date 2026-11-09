export const behavior = {};
export const models = [];
export class TranscribeModel {
  static async load(path) {
    const model = new TranscribeModel(path);
    models.push(model);
    return behavior.load ? behavior.load(model) : model;
  }
  constructor(path) { this.path = path; this.transcriptions = []; this.disposeCalls = 0; this.sessions = []; }
  async transcribe(pcm, options) {
    this.transcriptions.push({ pcm: [...pcm], options });
    return behavior.transcribe ? behavior.transcribe(this, pcm, options) : { text: " fixture transcript " };
  }
  createSession() {
    if (!behavior.streaming) throw new Error("Fixture streaming disabled");
    const session = new Session(this);
    this.sessions.push(session);
    behavior.createSession?.(session);
    return session;
  }
  dispose() { this.disposeCalls++; behavior.dispose?.(this); }
}
class Session {
  constructor(model) { this.model = model; this.disposeCalls = 0; }
  async stream(options) {
    this.options = options;
    await behavior.stream?.(this);
    this.value = new Stream(this);
    return this.value;
  }
  dispose() { this.disposeCalls++; behavior.sessionDispose?.(this); }
}
class Stream {
  constructor(session) { this.session = session; this.frames = []; this.events = []; this.resetCalls = 0; this.computing = false; }
  async feed(pcm) {
    if (this.computing) throw new Error("Fixture overlapping compute");
    this.computing = true; this.events.push("feed-start");
    try { await behavior.feed?.(this, pcm); this.frames.push([...pcm]); return { revision: this.frames.length }; }
    finally { this.computing = false; this.events.push("feed-end"); }
  }
  async finalize() {
    if (this.computing) throw new Error("Fixture overlapping compute");
    this.computing = true; this.events.push("finalize");
    try { await behavior.finalize?.(this); return { revision: this.frames.length + 1 }; }
    finally { this.computing = false; }
  }
  get text() {
    if (this.computing) throw new Error("Fixture text read during compute");
    return { full: behavior.text ?? " fixture stream transcript ", committed: "", tentative: "" };
  }
  reset() { this.resetCalls++; this.events.push("reset"); behavior.reset?.(this); }
}
export function resetModels() {
  models.length = 0;
  for (const key of Object.keys(behavior)) delete behavior[key];
}
