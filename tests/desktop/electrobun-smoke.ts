// Tests packaged runtime/resources. WKWebView and native panels are verified via native UI QA.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const bundle = resolve(
  process.argv[2] ?? "build/stable-macos-arm64/ResearchBunny.app",
);
const root = await mkdtemp(join(tmpdir(), "researchbunny-packaged-"));
try {
  const code = `
    import assert from "node:assert/strict";
    import { fork } from "node:child_process";
    import { readFileSync } from "node:fs";
    const child = fork(process.argv[1], [process.argv[2], process.argv[3]], { execPath: process.execPath, stdio: ["ignore","ignore","inherit","ipc"], serialization:"json" });
    let id = 0;
    const pending = new Map();
    const request = (command,args={}) => new Promise((resolve,reject)=> { const key=++id; pending.set(key,{resolve,reject}); child.send({id:key,command,args}); });
    child.on("message", m=> { if(m.result) { const p=pending.get(m.id); pending.delete(m.id); if(m.result.ok) p?.resolve(m.result.data); else p?.reject(new Error(m.result.error.message)); } });
    const ready = new Promise(resolve=>child.on("message",m=> {if(m.ready) resolve();}));
    const deadline=setTimeout(()=>{ child.kill(); process.exit(1); },30000);
    try {
      await ready;
      await request("init",{});
      const snapshot=await request("snapshot");
      const projectId=snapshot.projects[0].id;
      const run=await request("pdfImport",{projectId,paths:[process.argv[4]],options:{mode:"managed"}});
      let final;
      for(let n=0;n<200;n++) { const s=await request("snapshot",{projectId}); final=s.runs.find(r=>r.id===run.id); if(final?.status==="completed")break; await Bun.sleep(50); }
      assert.equal(final.status,"completed"); assert.equal(final.count,1);
      const items=await request("importItems",{runId:run.id});
      assert(items[0].message.includes("extracted"),JSON.stringify(items));
      const workId=items[0].workId;
      await request("mutateWorks",{projectId,ids:[workId],patch:{screening:"included",note:"packaged"}});
      const preview=await request("pdfDownloadPreview",{projectId,scope:"selected",ids:[workId]});
      assert.deepEqual(preview,{total:1,existing:1,books:0,eligible:0});
      const download=await request("downloadPdfs",{projectId,scope:"selected",ids:[workId]});
      let downloaded;
      for(let i=0;i<100;i++){const s=await request("snapshot",{projectId});downloaded=s.runs.find(r=>r.id===download.id);if(downloaded?.status==="completed")break;await Bun.sleep(50);}
      assert.equal(downloaded.status,"completed");assert.equal(downloaded.download.items[0].status,"existing");
      assert.equal((await request("inspect",{projectId,workId})).state.note,"packaged");
      const output=await request("performExport",{projectId,scope:"selected",ids:[workId],path:process.argv[5]+"/out.bib"});
      assert.equal(output.count,1); assert(readFileSync(process.argv[5]+"/out.bib","utf8").includes("@"));
      const backup=await request("backup",{path:process.argv[5]+"/backup",includeAttachments:true,includeLinked:false});
      const restored=await request("restore",{path:backup.path,destination:process.argv[5]+"/restored"});
      assert.equal(restored.missing.length,0);
      await assert.rejects(request("deleteTrashedWorks",{projectId,target:{kind:"selected",ids:[workId]}}));
      await request("mutateWorks",{projectId,ids:[workId],patch:{screening:"trash"}});
      const deleted=await request("deleteTrashedWorks",{projectId,target:{kind:"selected",ids:[workId]}});
      assert.deepEqual(deleted.ids,[workId]);
      assert.equal((await request("snapshot",{projectId})).counts.trash,0);
      await assert.rejects(request("inspect",{projectId,workId}));
      await request("shutdown");
      console.log("PASS packaged PDF extraction, archive, export, backup, restore and permanent deletion with restricted PATH");
    } finally { clearTimeout(deadline); child.kill(); }
  `;
  const resources = join(bundle, "Contents/Resources/app/runtime");
  const child = Bun.spawn(
    [
      join(bundle, "Contents/MacOS/bun"),
      "-e",
      code,
      join(resources, "service.js"),
      join(root, "library"),
      join(resources, "pdf-worker.cjs"),
      resolve("tests/fixtures/synthetic-local.pdf"),
      root,
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  assert.equal(await child.exited, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}
