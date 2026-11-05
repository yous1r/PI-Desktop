export type PluginProcessInput = {command:string;args:string[];cwd?:string;env?:Record<string,string>;timeoutMs?:number};
export type PluginProcessChunk = {stream:"stdout"|"stderr";text:string;sequence:number};
export type PluginProcessExit = {code:number|null;signal:string|null;reason?:"cancelled"|"timeout"|"output-limit"|"spawn-error"};
export type PluginProcessRead = {chunks:PluginProcessChunk[];more:boolean;exit?:PluginProcessExit};
export type PluginExecInput = PluginProcessInput & {stdin?:string;signal?:AbortSignal;onOutput?:(chunk:PluginProcessChunk)=>void};
export type PluginExecResult = PluginProcessExit & {stdout:string;stderr:string};
/** Host-owned handles. Every operation stays on the originating workspace. */
export type PluginWorkspaceExecutionApi = {
  /** Call this plugin's declared workspace entry. Desktop UI and main remain local. */
  invoke(channel:string,payload?:unknown):Promise<unknown>;
  /** Whether invoke can reach a declared backend now, without prompting or starting it. */
  isAvailable():Promise<boolean>;
  exec(input:PluginExecInput):Promise<PluginExecResult>;
  /** Open a workspace loopback HTTP service on Desktop. Requires workspace.exec and browser.cdp. */
  openPort(input:{port:number;path?:string}):Promise<{url:string}>;
  process:{
    start(input:PluginProcessInput):Promise<{processId:string}>;
    read(processId:string,afterSequence?:number,waitMs?:number):Promise<PluginProcessRead>;
    write(processId:string,data:string):Promise<{ok:true}>;
    end(processId:string):Promise<{ok:true}>;
    cancel(processId:string):Promise<{ok:true}>;
    close(processId:string):Promise<{ok:true}>;
  };
  terminal:{
    list(refresh?:boolean):Promise<{shells:Array<{id:string;label:string;family:string;isDefault:boolean}>}>;
    create(input:{shellId:string;cols:number;rows:number;cwd?:string}):Promise<{terminalId:string;shellId:string;cols:number;rows:number}>;
    write(terminalId:string,data:string):Promise<{ok:true}>;
    resize(terminalId:string,cols:number,rows:number):Promise<{ok:true}>;
    /** Base64 UTF-8 replay plus the latest sequence. Never replays input. */
    replay(terminalId:string,maxBytes?:number):Promise<{data:string|null;sequence?:number}>;
    buffer(terminalId:string,maxBytes?:number):Promise<{text:string}>;
    close(terminalId:string):Promise<{ok:true}>;
  };
};
