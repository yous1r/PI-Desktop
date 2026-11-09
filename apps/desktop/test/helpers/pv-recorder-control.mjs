export const loading = Promise.withResolvers();
export const importEntered = Promise.withResolvers();
export const recorders = [];
export const behavior = {};

export class Recorder {
  static getAvailableDevices() { return behavior.devices?.() ?? ["Fixture microphone"]; }
  constructor(frameLength, deviceIndex) {
    this.frameLength = frameLength;
    this.deviceIndex = deviceIndex;
    this.sampleRate = behavior.sampleRate ?? 16000;
    this.isRecording = false;
    this.stopCalls = 0;
    this.releaseCalls = 0;
    this.reads = [];
    this.nextRead = Promise.withResolvers();
    recorders.push(this);
    behavior.construct?.(this);
  }
  start() {
    this.isRecording = true;
    behavior.start?.(this);
  }
  read() {
    const read = Promise.withResolvers();
    this.reads.push(read);
    this.nextRead.resolve(read);
    this.nextRead = Promise.withResolvers();
    return read.promise;
  }
  stop() {
    this.stopCalls++;
    this.isRecording = false;
    behavior.stop?.(this);
  }
  release() {
    this.releaseCalls++;
    behavior.release?.(this);
  }
}

export function reset() {
  for (const key of Object.keys(behavior)) delete behavior[key];
  recorders.length = 0;
}

export function settleReads() {
  for (const recorder of recorders) {
    recorder.isRecording = false;
    for (const read of recorder.reads) read.resolve(new Int16Array(0));
  }
}
