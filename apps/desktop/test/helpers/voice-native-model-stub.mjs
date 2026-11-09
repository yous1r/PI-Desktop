export const behavior = {};
export const models = [];
export class TranscribeModel {
  static async load(path) {
    const model = new TranscribeModel(path);
    models.push(model);
    return behavior.load ? behavior.load(model) : model;
  }
  constructor(path) { this.path = path; this.transcriptions = []; this.disposeCalls = 0; }
  async transcribe(pcm, options) {
    this.transcriptions.push({ pcm: [...pcm], options });
    return behavior.transcribe ? behavior.transcribe(this, pcm, options) : { text: " fixture transcript " };
  }
  dispose() { this.disposeCalls++; behavior.dispose?.(this); }
}
export function resetModels() {
  models.length = 0;
  for (const key of Object.keys(behavior)) delete behavior[key];
}
