import { test } from "bun:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { FulltextEngine } from "../../src/service/fulltext/engine";
import { LocalDownloads, matchesDownloadedPdf } from "../../src/service/fulltext/local-downloads";
import { ChromeDownloads, type ChromeControl } from "../../src/service/fulltext/chrome";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";
import { hashFile } from "../../src/service/interchange/pdf";

const worker = resolve("dist/runtime/pdf-worker.cjs"), fixture = resolve("tests/fixtures/synthetic-local.pdf");
const title = "Packaged PDF extraction fixture";
async function finish(jobs: PdfDownloads) { for (let i=0; i<2000 && jobs.active.size; i++) await Bun.sleep(5); assert.equal(jobs.active.size,0); }
async function downloaded(root: string, name: string) {
  const path = join(root,name); await copyFile(fixture,path); const date = new Date(Date.now()-5000); await utimes(path,date,date); return path;
}
test("an existing publisher-named PDF is attached before opening Chrome, with its original bytes and archive state preserved", async () => {
  const root = await mkdtemp(join(tmpdir(),"rb-recovery-existing-")), db = new Library(join(root,"library"));
  const projectId = db.projects()[0].id, work = db.upsert(blankWork({title})).work;
  db.mutate(projectId,[work.id],{screening:"included",note:"keep",reading:"reading",tags:["retain"]});
  const source = await downloaded(root,"publisher.pdf"), before = db.state(projectId,work.id);
  let calls=0;
  const jobs = new PdfDownloads(db,worker,()=>{},new FulltextEngine(async()=>{calls++;throw Error("network must not be used");}),{async retrieve(){calls++;throw Error("Chrome must not be used");}});
  try {
    const run=jobs.start({projectId,scope:"archive",useBrowser:true,downloadDirectory:root});await finish(jobs);
    assert.equal(calls,0); assert.equal(db.run(run.id).download!.items[0].status,"completed");
    assert(db.run(run.id).download!.items[0].message.includes("자동 복구"));
    const attachment=db.attachments(work.id)[0];assert.equal(attachment.mode,"managed");
    assert.equal(await hashFile(attachment.path),await hashFile(source));assert.deepEqual(db.state(projectId,work.id),before);
    assert.equal((await jobs.preview({projectId,scope:"archive"})).downloadDirectory,root);
  } finally {jobs.stopRecoveryMonitor();db.close();await rm(root,{recursive:true,force:true});}
});
test("a PDF arriving after a completed failure is automatically recovered, survives restart and is never duplicated", async () => {
  const root=await mkdtemp(join(tmpdir(),"rb-recovery-late-")), db=new Library(join(root,"library"));
  const projectId=db.projects()[0].id, work=db.upsert(blankWork({title,url:"https://papers.example.org/paper"})).work;
  db.mutate(projectId,[work.id],{screening:"included",note:"keep"});
  const jobs=new PdfDownloads(db,worker,()=>{},new FulltextEngine(async()=>new Response("missing",{status:404}),async()=>{}),{async retrieve(){throw new AppError("CHROME_CONTROL","lost tab");}});
  let closed = false;
  try {
    const run=jobs.start({projectId,scope:"archive",useBrowser:true,downloadDirectory:root});await finish(jobs);
    assert.equal(db.run(run.id).download!.items[0].status,"failed");
    const source=await downloaded(root,"late-publisher.pdf");await downloaded(root,"duplicate-uuid.pdf");
    jobs.startRecoveryMonitor(()=>jobs.active.size>0,25);
    for(let i=0;i<2000 && !db.attachments(work.id).length;i++)await Bun.sleep(5);
    jobs.stopRecoveryMonitor();await finish(jobs);
    assert.equal(db.run(run.id).download!.items[0].status,"completed");assert.equal(db.attachments(work.id).length,1);
    assert.equal(await hashFile(db.attachments(work.id)[0].path),await hashFile(source));assert.equal(db.state(projectId,work.id).note,"keep");
    await jobs.recoverCompleted();assert.equal(db.attachments(work.id).length,1);
    db.close();closed = true;const reopened=new Library(join(root,"library"));
    try {const restored=new PdfDownloads(reopened,worker,()=>{});assert.equal(reopened.pref("pdfDownloadDirectory"),root);await restored.recoverCompleted();assert.equal(reopened.attachments(work.id).length,1);}finally{reopened.close();}
  }finally{jobs.stopRecoveryMonitor();if(!closed)db.close();await rm(root,{recursive:true,force:true});}
});
test("supplements, corrections, a DOI present only in a reference, and ambiguous titles cannot become a main PDF", async () => {
  const work=blankWork({title:"A specific study of brain stimulation",doi:"10.1234/main"});
  const document={title:work.title,text:work.title,dois:[work.doi!],pages:8,authors:"",status:"extracted"};
  assert(matchesDownloadedPdf(document,work));
  assert(!matchesDownloadedPdf({...document,title:"SUPPLEMENTARY INFORMATION " + work.title},work));
  assert(!matchesDownloadedPdf({...document,title:"Correction to another author",text:"Correction to another author. "+work.title},work));
  assert(!matchesDownloadedPdf({...document,title:"Unrelated clinical study",text:"References: "+work.title},work));
  const root=await mkdtemp(join(tmpdir(),"rb-recovery-ambiguous-"));
  try {await downloaded(root,"same-title.pdf");const index=new LocalDownloads(worker);await index.scan([root],new AbortController().signal);
    const a=blankWork({title}), b=blankWork({title});assert.equal(await index.copyFor(a,[a,b],join(root,"save.part"),new AbortController().signal),null);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("automatic recovery never reattaches a file to an item removed from the archive", async () => {
  const root=await mkdtemp(join(tmpdir(),"rb-recovery-removed-")),db=new Library(join(root,"library"));
  const projectId=db.projects()[0].id,work=db.upsert(blankWork({title})).work;db.mutate(projectId,[work.id],{screening:"included"});
  const jobs=new PdfDownloads(db,worker,()=>{},new FulltextEngine(async()=>new Response("missing",{status:404}),async()=>{}),{async retrieve(){throw new AppError("CHROME_CONTROL","lost tab");}});
  try{jobs.start({projectId,scope:"archive",useBrowser:true,downloadDirectory:root});await finish(jobs);db.mutate(projectId,[work.id],{screening:"trash"});await downloaded(root,"late.pdf");await jobs.recoverCompleted();assert.equal(db.attachments(work.id).length,0);assert.equal(db.state(projectId,work.id).screening,"trash");}
  finally{db.close();await rm(root,{recursive:true,force:true});}
});
test("a folder detection permission error is actionable and cannot silently watch a different directory", async () => {
  let opened=false;const chrome:ChromeControl={async open(){opened=true;return {windowId:"1",tabId:"2"};},async probe(){throw Error("unused");},async navigate(){},async download(){},async close(){}};
  const driver=new ChromeDownloads(chrome,async()=>{throw new AppError("CHROME_DIRECTORY","choose actual folder");});
  await assert.rejects(driver.retrieve(blankWork({url:"https://papers.example.org/paper"}),"/unused",new AbortController().signal,()=>{},async()=>{}),error=>error instanceof AppError && error.code==="CHROME_DIRECTORY");
  assert.equal(opened,false);
  assert.equal((await readFile(fixture)).subarray(0,5).toString(),"%PDF-");
});
