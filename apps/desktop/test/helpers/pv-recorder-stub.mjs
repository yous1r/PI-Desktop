import { importEntered, loading } from "./pv-recorder-control.mjs";
importEntered.resolve();
await loading.promise;
export { Recorder as PvRecorder } from "./pv-recorder-control.mjs";
