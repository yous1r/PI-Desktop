import type { WorkspaceExecutionContext } from "@pi-desktop/shared";

/** Installation contributions and workspace processes have different lifetimes. */
export class WorkspacePluginInstances<T extends object> {
  private readonly pending = new Map<string, { owner: T; promise: Promise<T> }>();
  private readonly active = new Map<T, { owner: T; key: string; promise: Promise<T> }>();
  private creations = 0;
  private readonly create: (owner: T, context: WorkspaceExecutionContext) => Promise<T>;
  private readonly close: (instance: T) => Promise<void>;
  constructor(create: (owner: T, context: WorkspaceExecutionContext) => Promise<T>, close: (instance: T) => Promise<void>) {
    this.create = create; this.close = close;
  }
  async get(owner: T, pluginId: string, context: WorkspaceExecutionContext): Promise<T> {
    const key = JSON.stringify([pluginId,context.authority,context.workspaceId,context.generation]);
    const existing = this.pending.get(key);
    if (existing?.owner === owner) return existing.promise;
    if (this.active.size + this.creations >= 64) throw Object.assign(new Error("Workspace plugin instance limit reached"),{code:"LIMIT_EXCEEDED"});
    this.creations++;
    const promise = Promise.resolve().then(() => this.create(owner,context)).then(async instance => {
      if (this.pending.get(key)?.promise !== promise) { await this.close(instance); throw Object.assign(new Error("Plugin was unloaded while opening its workspace"),{code:"PLUGIN_UNLOADED"}); }
      this.active.set(instance,{owner,key,promise}); return instance;
    }).catch(error=>{if(this.pending.get(key)?.promise===promise)this.pending.delete(key);throw error;}).finally(() => { this.creations--; });
    this.pending.set(key,{owner,promise}); return promise;
  }
  values(): T[] { return [...this.active.keys()]; }
  has(instance: T): boolean { return this.active.has(instance); }
  owner(instance: T): T | undefined { return this.active.get(instance)?.owner; }
  remove(instance: T): void {
    const entry=this.active.get(instance);if(!entry)return;
    this.active.delete(instance);
    if (this.pending.get(entry.key)?.promise === entry.promise) this.pending.delete(entry.key);
  }
  async disposeOwner(owner: T): Promise<void> {
    const work: Promise<void>[]=[];
    for(const [key,entry] of this.pending)if(entry.owner===owner)this.pending.delete(key);
    for(const [instance,entry] of this.active)if(entry.owner===owner){this.active.delete(instance);work.push(this.close(instance));}
    await Promise.allSettled(work);
  }
}
