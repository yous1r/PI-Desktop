"use strict";

// Desktop owns local attachments; native project operations run beside their files.
const engine = require("./main.js");
module.exports = {
  onLoad: engine.onLoad,
  onUnload: engine.onUnload,
  async onPanelInvoke(channel, payload) {
    let context;
    try { context = await pi.workspace.getContext?.(); }
    catch (error) { if (error?.code !== "UNSUPPORTED") throw error; }
    if (!context || typeof pi.workspace.invoke !== "function") return engine.onPanelInvoke(channel,payload);
    if (context.authority?.kind === "remote" && typeof pi.workspace.isAvailable === "function" && !await pi.workspace.isAvailable()) return engine.onPanelInvoke(channel,payload);
    if (payload?.external === true) return engine.onLocalFileInvoke(channel,payload);
    return pi.workspace.invoke(channel,payload);
  },
};
