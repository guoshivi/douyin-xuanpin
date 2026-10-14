import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runBrowserRound} from '../src/browser/protocol.mjs';
import {handleRound} from '../src/browser/round.mjs';
const root=process.cwd(),base=path.join(root,'data/acceptance/phase2/repair2');
const url='https://buyin.jinritemai.com/TEST-observer',landed=url+'?observed=TEST';
async function dir(){await fs.mkdir(base,{recursive:true,mode:0o700});return fs.mkdtemp(path.join(base,'TEST-release-'));}
async function fixture(){
  const d=await dir(),file=path.join(d,'evidence.json'),command=path.join(d,'TEST-stdin.mjs');
  await fs.writeFile(command,`// TEST ONLY JSON stdin protocol fixture; no browser or network.
let input='';for await(const c of process.stdin)input+=c;JSON.parse(input);
for(const row of JSON.parse(process.env.TEST_ROWS))process.stdout.write(JSON.stringify(row)+'\\n');
process.exitCode=Number(process.env.TEST_EXIT||0);`,{mode:0o600});
  const req={action:'inspect',space_id:'991',page_label:'p1',commodity_id:'1111111111111111111',url,output_file:file};
  const space={type:'space',space_id:'991',page_label:'p1'};
  const obs={type:'observation',status:'ok',space_id:'991',page_label:'p1',commodity_id:req.commodity_id,observed_url:landed,evidence_path:file,observed_count:1};
  const evidence={space_id:'991',page_label:'p1',commodity_id:req.commodity_id,captured_at:'2026-10-09T00:00:00.000Z',requested_url:url,landed_url:landed,title:'TEST title',snapshot:'TEST private snapshot'};
  await fs.writeFile(file,JSON.stringify(evidence),{mode:0o600});
  const run=(r=req,rows=[space,obs],exit=0)=>runBrowserRound(r,{root,command,timeoutMs:2000,env:{TEST_ROWS:JSON.stringify(rows),TEST_EXIT:String(exit)}});
  return {d,file,command,req,space,obs,evidence,run};
}
test('release positive: full private file content is verified',async()=>{const f=await fixture(),r=await f.run();assert.equal(r.verified,true);assert.equal(r.observed_count,1);assert.equal(Object.hasOwn(r,'snapshot'),false);});
test('release child spawn failure is sanitized and settled',async()=>{const d=await dir();await assert.rejects(()=>runBrowserRound({action:'inspect'},{root,command:path.join(d,'TEST-missing-executable'),timeoutMs:500}),e=>e.code==='SPAWN_FAILED'&&!Object.hasOwn(e,'stderr'));});
test('release navigation exception retains actual space but not runtime secrets',async()=>{const d=await dir();await assert.rejects(()=>handleRound({action:'inspect',url,output_file:path.join(d,'evidence.json')},{root,taskSpace:async()=>({spaceId:991,ownership:'agent',page:()=>({label:'p1',spaceId:991,goto:async()=>{throw new Error('TEST_SECRET_RUNTIME_EXCEPTION');}})})}),e=>{assert.equal(e.space_id,'991');assert.equal(e.page_label,'p1');assert.equal(e.code,'NAVIGATION_TIMEOUT');assert.equal(e.may_have_late_effects,true);assert.equal(e.stack.includes('TEST_SECRET_RUNTIME_EXCEPTION'),false);return true;});});
test('release full evidence rejects insecure permissions and final symlink',async()=>{const f=await fixture();await fs.chmod(f.file,0o644);await assert.rejects(()=>f.run());await fs.chmod(f.file,0o600);const link=path.join(f.d,'TEST-linked-evidence.json');await fs.symlink(f.file,link);await assert.rejects(()=>f.run({...f.req,output_file:link},[f.space,{...f.obs,evidence_path:link}]));});
for(const [name,change] of [
  ['inspect rejects result/ok',f=>({...f.obs,type:'result',observed_url:undefined,evidence_path:undefined,observed_count:undefined})],
  ['finish rejects observation',f=>({...f.obs})],
  ['handoff rejects result/ok',f=>({type:'result',status:'ok',space_id:'991',page_label:'p1'})],
  ['space mismatch',f=>({...f.obs,space_id:'992'})],
  ['page mismatch',f=>({...f.obs,page_label:'p2'})],
  ['commodity missing',f=>({...f.obs,commodity_id:undefined})],
  ['commodity different',f=>({...f.obs,commodity_id:'2'})],
  ['HTTP observed URL',f=>({...f.obs,observed_url:'http://buyin.jinritemai.com/TEST'})],
  ['javascript observed URL',f=>({...f.obs,observed_url:'javascript://buyin.jinritemai.com/TEST'})],
  ['signed observed URL',f=>({...f.obs,observed_url:url+'?token=TEST_SENTINEL'})],
])test('release '+name,async()=>{const f=await fixture();const req=name.startsWith('finish')?{action:'finish',space_id:'991',keep:[]}:name.startsWith('handoff')?{action:'handoff',space_id:'991'}:f.req;await assert.rejects(()=>f.run(req,[f.space,change(f)]));});
for(const field of ['space_id','page_label','commodity_id','requested_url','landed_url','captured_at'])test('release evidence binds '+field,async()=>{const f=await fixture();f.evidence[field]=field.endsWith('url')?'https://buyin.jinritemai.com/TEST-wrong':'TEST-WRONG';await fs.writeFile(f.file,JSON.stringify(f.evidence),{mode:0o600});await assert.rejects(()=>f.run());});
test('release evidence cannot substitute another file',async()=>{const f=await fixture(),other=path.join(f.d,'other.json');await fs.writeFile(other,JSON.stringify(f.evidence),{mode:0o600});await assert.rejects(()=>f.run(f.req,[f.space,{...f.obs,evidence_path:other}]));});
test('release evidence missing snapshot and oversized file fail',async()=>{const f=await fixture();delete f.evidence.snapshot;await fs.writeFile(f.file,JSON.stringify(f.evidence));await assert.rejects(()=>f.run());await fs.writeFile(f.file,' '.repeat(8*1024*1024+1));await assert.rejects(()=>f.run());});
test('release conflicting results and nonzero successful exit fail',async()=>{const f=await fixture();await assert.rejects(()=>f.run(f.req,[f.space,f.obs,f.obs]));await assert.rejects(()=>f.run(f.req,[f.space,f.obs],7));});
test('release sensitive JSON and null fail safely preserving actual space',async()=>{const f=await fixture();for(const row of [{type:'notice',token:'TEST_SECRET_SENTINEL'},null]){await assert.rejects(()=>f.run(f.req,[f.space,row,f.obs]),e=>{assert.equal(e.space_id,'991');assert.equal(e.page_label,'p1');assert.equal(String(e.stack).includes('TEST_SECRET_SENTINEL'),false);assert.equal(Object.hasOwn(e,'stderr'),false);return true;});}});
test('release error rejects with code, space, page and late effects',async()=>{const f=await fixture();await assert.rejects(()=>f.run(f.req,[f.space,{type:'result',status:'error',space_id:'991',page_label:'p1',error_code:'TEST_FAILURE',may_have_late_effects:true}]),e=>e.code==='TEST_FAILURE'&&e.space_id==='991'&&e.page_label==='p1'&&e.may_have_late_effects);});
test('release old zero-observation is unverified; echoed output is rejected',async()=>{const f=await fixture(),old={...f.obs,evidence_path:null,observed_url:undefined,observed_count:0};const r=await f.run({action:'inspect',space_id:'991',commodity_id:f.req.commodity_id},[f.space,old]);assert.equal(r.verified,false);assert.equal(r.missing_reason,'NO_OBSERVATIONS');await assert.rejects(()=>f.run(f.req,[f.space,{...old,evidence_path:f.file}]));});
test('release timeout retains streamed ownership, kills SIGTERM-resistant child before rejection',async()=>{const d=await dir(),command=path.join(d,'TEST-resistant.mjs'),pidfile=path.join(d,'TEST-pid.json');await fs.writeFile(command,`import fs from 'node:fs';fs.writeFileSync(process.env.TEST_PID,JSON.stringify(process.pid),{mode:0o600});process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'space',space_id:'991',page_label:'p1'}));setInterval(()=>{},1000);`);await assert.rejects(()=>runBrowserRound({action:'inspect',space_id:'991'},{root,command,timeoutMs:350,env:{TEST_PID:pidfile}}),e=>e.code==='TIMEOUT'&&e.space_id==='991'&&e.page_label==='p1'&&e.may_have_late_effects);const pid=JSON.parse(await fs.readFile(pidfile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});});
test('release stdout and stderr caps fail without leaking buffers',async()=>{for(const stream of ['stdout','stderr']){const d=await dir(),command=path.join(d,'TEST-limit.mjs');await fs.writeFile(command,`console.log(JSON.stringify({type:'space',space_id:'991',page_label:'p1'}));process.${stream}.write('TEST_SECRET_SENTINEL'.repeat(70000));setInterval(()=>{},1000);`);await assert.rejects(()=>runBrowserRound({action:'inspect',space_id:'991'},{root,command,timeoutMs:2000}),e=>{assert.equal(e.code,stream==='stdout'?'OUTPUT_LIMIT':'STDERR_LIMIT');assert.equal(e.message.includes('TEST_SECRET_SENTINEL'),false);return true;});}});
test('release explicit Ego stdin branch executes inspect, finish and handoff',async()=>{
  const d=await dir(),command=path.join(d,'ego-browser'),capture=path.join(d,'TEST-calls.json');
  await fs.writeFile(command,`#!/usr/bin/env node
// TEST ONLY ESM stdin runtime, never real Ego.
import fs from 'node:fs/promises';let code='';for await(const c of process.stdin)code+=c;
const calls=[];globalThis.taskSpace=async id=>{calls.push(['space',id]);return {spaceId:991,ownership:'agent',page:label=>({label,spaceId:991,goto:async u=>calls.push(['goto',u]),url:async()=>${JSON.stringify(landed)},title:async()=> 'TEST title',snapshot:async()=> 'TEST private snapshot'}),finish:async x=>calls.push(['finish',x]),handOff:async()=>calls.push(['handoff'])};};
try{await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}finally{await fs.writeFile(process.env.TEST_CAPTURE,JSON.stringify(calls),{mode:0o600});}`,{mode:0o700});
  for(const action of ['inspect','finish','handoff']){const file=path.join(d,action+'-evidence.json'),req={action,space_id:'991',...(action==='inspect'?{url,output_file:file,commodity_id:'1'}:action==='finish'?{keep:[]}:{})};const r=await runBrowserRound(req,{root,command,timeoutMs:2000,env:{TEST_CAPTURE:capture}});assert.equal(r.verified,true);const calls=JSON.parse(await fs.readFile(capture,'utf8'));assert.deepEqual(calls[0],['space',991]);assert.deepEqual(calls[1],action==='inspect'?['goto',url]:action==='finish'?['finish',{keep:[]}]:['handoff']);if(action==='inspect'){const ev=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(ev.space_id,'991');assert.equal(ev.snapshot,'TEST private snapshot');assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);}}
});
test('release navigation rejects bad URL and unknown ownership before effects',async()=>{
  let effects=0;const d=await dir(),file=path.join(d,'evidence.json');
  const factory=async()=>({spaceId:991,ownership:'agent',page:()=>({goto:async()=>effects++})});
  for(const bad of ['http://buyin.jinritemai.com/TEST','javascript://buyin.jinritemai.com/TEST','https://TEST_USER:TEST_PASSWORD@example.invalid/TEST',url+'?token=TEST'])await assert.rejects(()=>handleRound({action:'inspect',url:bad,output_file:file},{root,taskSpace:factory}));
  for(const ownership of ['unknown','unassigned','user','inactive',undefined])await assert.rejects(()=>handleRound({action:'inspect',url,output_file:file},{root,taskSpace:async()=>({spaceId:991,ownership,page:()=>{effects++;}})}));
  assert.equal(effects,0);
});
test('release finish/handoff require existing space; page identity mismatch blocks navigation',async()=>{let effects=0;for(const action of ['finish','handoff'])await assert.rejects(()=>handleRound({action,keep:[]},{root,taskSpace:async()=>{effects++;}}));const d=await dir();await assert.rejects(()=>handleRound({action:'inspect',url,output_file:path.join(d,'evidence.json')},{root,taskSpace:async()=>({spaceId:991,ownership:'agent',page:()=>({label:'p2',spaceId:992,goto:async()=>effects++})})}));assert.equal(effects,0);});
test('release output symlink and existing evidence fail before navigation',async()=>{const d=await dir(),target=path.join(d,'target'),link=path.join(d,'link');await fs.mkdir(target);await fs.symlink(target,link);let effects=0;const factory=async()=>({spaceId:991,ownership:'agent',page:()=>{effects++;}});await assert.rejects(()=>handleRound({action:'inspect',url,output_file:path.join(link,'evidence.json')},{root,taskSpace:factory}));const file=path.join(d,'preserved.json');await fs.writeFile(file,'TEST-preserved',{mode:0o600});await assert.rejects(()=>handleRound({action:'inspect',url,output_file:file},{root,taskSpace:factory}));assert.equal(await fs.readFile(file,'utf8'),'TEST-preserved');assert.equal(effects,0);});
