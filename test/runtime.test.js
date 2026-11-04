import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {start,stop} from '../src/control.js';
import {paths,request,readState,withControl} from '../src/runtime.js';
const runtimeUrl=new URL('../src/runtime.js',import.meta.url).href;
const controlUrl=new URL('../src/control.js',import.meta.url).href;
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'tobi-runtime-test-')),entry=path.join(root,'fixture.mjs');
 await writeFile(entry,`import {createRuntime} from ${JSON.stringify(runtimeUrl)};let rt;rt=await createRuntime(${JSON.stringify(root)},()=>{setTimeout(()=>rt.close(),50);});console.log('token 123456789:abcdefghijklmnopqrstuvw secret sk-testingsecret');rt.ready();`);
 return {root,entry,async close(){await stop(root,{timeout:5000}).catch(()=>{});await rm(root,{recursive:true,force:true});}};
}
async function parent(root,entry){
 const runner=path.join(root,'parent.mjs');await writeFile(runner,`import {start} from ${JSON.stringify(controlUrl)};await start(${JSON.stringify(root)},{entry:${JSON.stringify(entry)},timeout:5000});`);
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[runner],{stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('parent failed')));});
}
test('background survives parent exit; duplicate start returns same instance; stop confirms exit',async()=>{
 const f=await fixture();try{await parent(f.root,f.entry);const first=await request(f.root);assert.equal(first.phase,'running');const again=await start(f.root,{entry:f.entry,timeout:5000});assert.equal(again.instance,first.instance);await stop(f.root,{timeout:5000});assert.equal(await request(f.root),null);assert.equal(await readState(f.root),null);}finally{await f.close();}
});
test('forged or reused PID never authorizes stop of another process',async()=>{
 const f=await fixture();let real;try{await start(f.root,{entry:f.entry,timeout:5000});real=await readState(f.root);await writeFile(paths(f.root).state,JSON.stringify({...real,pid:process.pid}));assert.equal(await request(f.root),null);await stop(f.root,{timeout:1000});assert.doesNotThrow(()=>process.kill(real.pid,0));await writeFile(paths(f.root).state,JSON.stringify(real));assert.equal((await request(f.root)).phase,'running');}finally{if(real)await writeFile(paths(f.root).state,JSON.stringify(real));await f.close();}
});
test('simultaneous start commands serialize and yield one instance',async()=>{
 const f=await fixture();try{const states=await Promise.all([withControl(f.root,()=>start(f.root,{entry:f.entry,timeout:5000})),withControl(f.root,()=>start(f.root,{entry:f.entry,timeout:5000}))]);assert.equal(states[0].instance,states[1].instance);}finally{await f.close();}
});
test('unauthenticated local stop request rejected; logs redact credentials',async()=>{
 const f=await fixture();try{await start(f.root,{entry:f.entry,timeout:5000});await new Promise(resolve=>{const s=net.createConnection(paths(f.root).pipe);s.on('connect',()=>s.write(JSON.stringify({token:'bad',command:'stop'})+'\n'));s.on('close',resolve);s.on('error',resolve);});assert.equal((await request(f.root)).phase,'running');const text=await readFile(paths(f.root).log,'utf8');assert.ok(!text.includes('123456789:abcdefghijklmnopqrstuvw'));assert.ok(!text.includes('sk-testingsecret'));assert.ok(text.includes('숨김'));}finally{await f.close();}
});
test('large logs rotate with bounded retention and restart creates new identity',async()=>{
 const f=await fixture();try{await start(f.root,{entry:f.entry,timeout:5000});const a=await request(f.root);await stop(f.root,{timeout:5000});await writeFile(paths(f.root).log,'x'.repeat(2*1024*1024+10));await start(f.root,{entry:f.entry,timeout:5000});assert.notEqual((await request(f.root)).instance,a.instance);assert.ok((await stat(paths(f.root).log)).size<5000);assert.ok((await stat(paths(f.root).log+'.1')).size>2*1024*1024);}finally{await f.close();}
});
