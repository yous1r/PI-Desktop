import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WorkspaceTerminalRouter } = await import("../electron/main/terminal/workspace-terminal-router.ts");
const { registerTerminalIpc } = await import("../electron/main/ipc/terminal-ipc.ts");
const { IPC, terminalWorkspaceId } = await import("@pi-desktop/shared");

for (const sessionId of ["session", undefined]) {
  test(`terminal IPC opens a real shell ${sessionId ? "with" : "without"} a session`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "terminal-user-path-"));
    const stored = root.replaceAll("\\", "/");
    let selected = root;
    const host = { call: async method => {
      if (method === "session.get") return {session:{projectPath:stored}};
      assert.equal(method,"project.groups.list");
      return {groups:[{id:"project",name:"Project",primaryPath:stored,roots:[{path:stored,name:"Project",position:0}]}]};
    } };
    const handlers = new Map();
    const sender = {};
    let terminalId;
    let output = "";
    const waiters = new Set();
    const router = new WorkspaceTerminalRouter({
      getHost: () => host, currentWorkspacePath: () => selected,
      remoteClient: () => { throw Error("Unexpected remote lookup"); },
      emit: event => {
        if ("data" in event) {
          const data = Buffer.from(event.data,"base64").toString("utf8");
          output += data;
          // ConPTY asks a terminal emulator for its cursor before starting cmd.
          if (data.includes("\x1b[6n") && terminalId) void call("terminalWrite",{terminalId,data:"\x1b[1;1R"});
        }
        for (const wake of waiters) wake();
      },
    });
    registerTerminalIpc({router:()=>router,registrar:{
      handleWithEvent:(channel,handler)=>handlers.set(channel,handler),
      assertMainWindowSender:event=>assert.equal(event,sender),
    }});
    const call = (name,input) => handlers.get(IPC.invoke[name])(sender,input);
    const text = () => stripVTControlCharacters(output).replaceAll("\r", "");
    const waitFor = predicate => new Promise((resolve,reject) => {
      const timer = setTimeout(() => { waiters.delete(wake);reject(Error("Terminal output deadline exceeded")); },10_000);
      const wake = () => { if(predicate()){clearTimeout(timer);waiters.delete(wake);resolve();} };
      waiters.add(wake);wake();
    });
    try {
      const target = {sessionId,workspaceId:terminalWorkspaceId({path:root}),tabId:"terminal-tab"};
      const {shells} = await call("terminalListShells",{target});
      const shell = shells.find(item=>item.id===(process.platform==="win32"?"cmd":"bash")) ?? shells[0];
      assert.ok(shell,"A local shell must be discoverable");
      ({terminalId} = await call("terminalCreate",{target,shellId:shell.id,cols:120,rows:30}));
      if (output.includes("\x1b[6n")) await call("terminalWrite",{terminalId,data:"\x1b[1;1R"});
      await call("terminalWrite",{terminalId,data:process.platform==="win32"?"set /a 734000+19\r":"echo $((734000+19))\r"});
      await waitFor(()=>text().includes("734019"));
      await call("terminalResize",{terminalId,cols:100,rows:28});
      const replay = await call("terminalReplay",{terminalId});
      assert.ok(Buffer.from(replay.data,"base64").toString("utf8").includes("734019"));
      selected = join(root,"other-project");
      await call("terminalWrite",{terminalId,data:process.platform==="win32"?"set /a 845000+23\r":"echo $((845000+23))\r"});
      await waitFor(()=>text().includes("845023"));
      await call("terminalClose",{terminalId});
      assert.deepEqual(await call("terminalReplay",{terminalId}),{data:null});
    } finally {
      await router.dispose();
      await rm(root,{recursive:true,force:true});
    }
  });
}
