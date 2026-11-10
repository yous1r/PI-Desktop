/**
 * Versioned command-center contracts shared by producers and consumers.
 *
 * Exporting schemas does not register RACP operations, IPC channels or runtime
 * capabilities. Those registrations land with the authoritative repositories,
 * adapters and their integration tests.
 */
export * from "./primitives.js";
export * from "./errors.js";
export * from "./identity.js";
export * from "./goal.js";
export * from "./intervention.js";
export * from "./receipt.js";
export * from "./summary.js";
export * from "./capabilities.js";
