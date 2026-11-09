import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm,chmod,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {request,paths} from '../src/runtime.js';

const project=new URL('../',import.meta.url);
// Exercise the real npm scripts and control CLI, but ONLY against a temporary
// project with a synthetic main.js. Never copy the operational .env or secrets.
test('macOS launcher uses dedicated Node; npm start/status/logs/restart/stop recover a killed fixture',
 {skip:process.platform!=='darwin',timeout:60000},async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'tpa-manual-')));
 const run=(...args)=>new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'tpa'),args,{cwd:os.tmpdir(),env:{...process.env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error('fixture launcher failed: '+code+' '+output)));
 });
 try{
  await mkdir(path.join(root,'src'));
  for(const file of ['config.js','runtime.js','control.js'])await copyFile(new URL('src/'+file,project),path.join(root,'src',file));
  await copyFile(new URL('package.json',project),path.join(root,'package.json'));
  await copyFile(new URL('tpa',project),path.join(root,'tpa'));await chmod(path.join(root,'tpa'),0o755);
  await writeFile(path.join(root,'src','main.js'),`import {createRuntime} from './runtime.js';import {root} from './config.js';import {writeFile} from 'node:fs/promises';import net from 'node:net';let rt;rt=await createRuntime(root,()=>setTimeout(()=>rt.close(),25));await writeFile(root+'/node-used.json',JSON.stringify({executable:process.execPath,attemptTimeout:net.getDefaultAutoSelectFamilyAttemptTimeout()}));console.log('synthetic fixture ready');rt.ready();`);
  await run('start');const first=await request(root);assert.equal(first.phase,'running');
  const nodeUsed=JSON.parse(await readFile(path.join(root,'node-used.json'),'utf8'));
  assert.equal(nodeUsed.executable,'/Users/ibksystem/.local/share/tpa-tools/node-v22.23.4-darwin-x64/bin/node');
  assert.equal(nodeUsed.attemptTimeout,1500);
  assert.match(await run('npm','run','bot:status'),/실행 중/);
  assert.match(await run('logs'),/synthetic fixture ready/);
  const reader=spawn(path.join(root,'tpa'),['follow'],{stdio:['ignore','pipe','ignore']});
  try{await new Promise((ok,no)=>{reader.once('error',no);reader.stdout.once('data',b=>{try{assert.match(b.toString(),/synthetic fixture ready/);ok();}catch(e){no(e);}});});}
  finally{const done=new Promise(r=>reader.once('close',r));reader.kill('SIGINT');await done;}
  assert.equal((await request(root)).instance,first.instance); // Stopping tail leaves daemon alive.
  await Promise.all([run('start'),run('start')]);assert.equal((await request(root)).instance,first.instance);
  await run('restart');const second=await request(root);assert.notEqual(second.instance,first.instance);
  process.kill(second.pid,'SIGKILL');
  for(let i=0;i<100&&await request(root);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(await request(root),null);assert.ok((await readFile(paths(root).state,'utf8')).length);
  await run('start');assert.notEqual((await request(root)).instance,second.instance);
  await run('stop');assert.equal(await request(root),null);
  assert.match(await run('status'),/중지 상태/);
 }finally{
  if(await request(root))await run('stop').catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});
