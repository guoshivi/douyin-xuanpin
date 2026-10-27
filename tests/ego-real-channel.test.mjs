import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

// TEST ONLY: every executable, request and evidence file is isolated; no real CLI/network.
const workspace=process.env.XUANPIN_ROOT??process.cwd();
const root=path.resolve(process.env.SOURCE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
assert.ok(root===workspace||root.startsWith(workspace+'/data/acceptance/phase2/implementation-'));
const acceptance=path.join(root,'data/acceptance/phase2/real-channel-fix');
const runRoot=process.env.TEST_CHANNEL_RUN_ROOT;
assert.ok(path.isAbsolute(runRoot??'')&&runRoot.startsWith(acceptance+path.sep));
assert.equal((await fs.lstat(runRoot)).isDirectory(),true);
await fs.writeFile(path.join(runRoot,'TEST-worker.json'),JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
const modulePath=process.env.TEST_PROTOCOL_MODULE_ABS??path.join(root,'src/browser/protocol.mjs');
assert.ok([path.join(root,'src/browser/protocol.mjs'),path.join(root,'data/acceptance/phase2/implementation-v4-three/src/browser/protocol.mjs')].includes(modulePath));
const {runBrowserRound}=await import(pathToFileURL(modulePath).href);
const url='https://buyin.jinritemai.com/TEST-real-channel';
const landed=url+'?observed=TEST';
const spaceId='TEST-991',commodity='7687626523348053681';
const sentinel='TEST_SECRET_DIAGNOSTIC_SENTINEL';
const limit=1024*1024;

const runtime=String.raw`// TEST ONLY fake CLI: no network, no real browser.
(async()=>{
  const fs=await import('node:fs/promises');
  const {setTimeout:delay}=await import('node:timers/promises');
  const spec=JSON.parse(process.env.TEST_SPEC);
  await fs.writeFile(process.env.TEST_PID,JSON.stringify({pid:process.pid,argv:process.argv.slice(2)}),{flag:'wx',mode:0o600});
  let input='';for await(const c of process.stdin)input+=c;
  await fs.writeFile(process.env.TEST_STDIN,input,{flag:'wx',mode:0o600});
  const native={stdout:process.stdout.write.bind(process.stdout),stderr:process.stderr.write.bind(process.stderr)};
  const rows=[],calls=[];
  process.stdout.write=(chunk,encoding,callback)=>{
    rows.push(JSON.parse(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk)));
    if(typeof encoding==='function')encoding();else if(typeof callback==='function')callback();
    return true;
  };
  globalThis.taskSpace=async id=>{
    calls.push(['space',id]);
    return {spaceId:'TEST-991',ownership:'agent',page:label=>{
      const page={goto:async u=>calls.push(['goto',u]),url:async()=>spec.landed,title:async()=> 'TEST 中文 title',snapshot:async()=> 'TEST 私密完整证据'};
      if(!spec.omitLabel)page.label=spec.label??label;
      if(!spec.omitSpace)page.spaceId=spec.pageSpace??'TEST-991';
      return page;
    },finish:async keep=>calls.push(['finish',keep]),handOff:async()=>calls.push(['handoff'])};
  };
  try{
    if(spec.preexisting)await fs.writeFile(spec.file,'TEST-existing-preserved',{flag:'wx',mode:0o600});
    if(spec.execute!==false)await import('data:text/javascript;base64,'+Buffer.from(input).toString('base64'));
    if(spec.evidence){
      const ev=JSON.parse(await fs.readFile(spec.file,'utf8'));
      Object.assign(ev,spec.evidence.patch??{});
      for(const k of spec.evidence.omit??[])delete ev[k];
      await fs.writeFile(spec.file,spec.evidence.raw??JSON.stringify(ev),{mode:0o600});
      if(spec.evidence.mode)await fs.chmod(spec.file,spec.evidence.mode);
      if(spec.evidence.size){const h=await fs.open(spec.file,'r+');try{await h.truncate(spec.evidence.size);}finally{await h.close();}}
    }
  }finally{
    process.stdout.write=native.stdout;
    await fs.writeFile(process.env.TEST_CALLS,JSON.stringify(calls),{flag:'wx',mode:0o600});
  }
  const events=spec.events??rows.map((row,i)=>({row,stream:spec.channel==='mixed-stderr-space'?(i===0?'stderr':'stdout'):spec.channel==='mixed-stdout-space'?(i===0?'stdout':'stderr'):(spec.channel??'stderr'),waitBefore:i?25:0}));
  for(const event of events){
    if(event.waitBefore)await delay(event.waitBefore);
    let text;
    if(event.raw!=null)text=event.raw;
    else if(event.fill!=null)text='x'.repeat(event.fill);
    else{
      const row={...(event.row??rows.find(r=>r.type===event.record)),...(event.patch??{})};
      for(const k of event.omit??[])delete row[k];
      text=JSON.stringify(row)+(event.eof?'':'\n');
    }
    const bytes=Buffer.from(text),stream=event.stream??'stderr';
    const write=async b=>{await new Promise(resolve=>native[stream](b,resolve));};
    if(event.chunk){for(let i=0;i<bytes.length;i+=event.chunk){await write(bytes.subarray(i,i+event.chunk));await delay(1);}}
    else await write(bytes);
  }
  if(spec.hang){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
  else if(spec.exit!=null)process.exitCode=spec.exit;
})().catch(()=>{process.exitCode=91;});
`;

function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
async function fixture(spec={},requestPatch={},legacy=false){
  const d=await fs.mkdtemp(path.join(runRoot,'TEST-case-'));
  await fs.chmod(d,0o700);
  const file=path.join(d,'TEST-evidence.json'),command=path.join(d,legacy?'TEST-adapter.mjs':'ego-browser');
  const pidfile=path.join(d,'TEST-pid.json'),stdinfile=path.join(d,'TEST-stdin.txt'),callsfile=path.join(d,'TEST-calls.json');
  await fs.writeFile(command,legacy?`// TEST ONLY non-Ego adapter; no network.\nimport fs from 'node:fs/promises';\nawait fs.writeFile(process.env.TEST_PID,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});\nlet input='';for await(const c of process.stdin)input+=c;JSON.parse(input);\nfor(const ev of JSON.parse(process.env.TEST_SPEC).events)process[ev.stream].write(JSON.stringify(ev.row)+'\\n');\n`:`#!${process.execPath}\n${runtime}`,{flag:'wx',mode:0o700});
  const req={action:'inspect',space_id:spaceId,page_label:'p1',commodity_id:commodity,url,output_file:file,...requestPatch};
  const space={type:'space',space_id:spaceId,page_label:'p1'};
  const obs={type:'observation',status:'ok',space_id:spaceId,page_label:'p1',commodity_id:commodity,observed_url:landed,evidence_path:file,observed_count:1};
  const config={file,landed,...spec};
  if(typeof config.events==='function')config.events=config.events({space,obs,file});
  const run=async()=>{
    try{return await runBrowserRound(req,{root,command,timeoutMs:spec.hang?500:3500,env:{TEST_SPEC:JSON.stringify(config),TEST_PID:pidfile,TEST_STDIN:stdinfile,TEST_CALLS:callsfile}});}
    finally{
      let pid=null;try{pid=JSON.parse(await fs.readFile(pidfile,'utf8')).pid;}catch(e){if(e.code!=='ENOENT')throw e;}
      const before=pid==null||!alive(pid);
      if(!before){process.kill(pid,'SIGKILL');for(let n=0;n<100&&alive(pid);n++)await delay(20);}
      const dead=pid==null||!alive(pid);
      await fs.appendFile(path.join(runRoot,'TEST-process-exits.jsonl'),JSON.stringify({case:path.basename(d),pid,exitedBeforeCleanup:before,exited:dead})+'\n',{mode:0o600});
      assert.equal(dead,true,'own TEST child must be dead');
      assert.equal(before,true,'protocol promise must wait for child close');
    }
  };
  return {d,file,req,space,obs,run,stdinfile,callsfile,pidfile};
}
function safeError(e){
  assert.ok(!String(e.stack).includes(sentinel));
  assert.equal(Object.hasOwn(e,'stdout'),false);assert.equal(Object.hasOwn(e,'stderr'),false);
  assert.equal(Object.hasOwn(e,'snapshot'),false);return true;
}
async function rejected(f,code){await assert.rejects(f.run,e=>{assert.equal(e.code,code);safeError(e);return true;});}
async function verified(f){
  const r=await f.run();
  assert.equal(r.verified,true);assert.equal(r.space_id,spaceId);assert.equal(r.page_label,'p1');
  assert.equal(Object.hasOwn(r,'stderr'),false);assert.equal(Object.hasOwn(r,'stdout'),false);assert.equal(Object.hasOwn(r,'snapshot'),false);
  const input=await fs.readFile(f.stdinfile,'utf8');
  assert.ok(input.includes('requirePageIdentity:true'),'production stdin must explicitly require identity');
  const pid=JSON.parse(await fs.readFile(f.pidfile,'utf8'));
  assert.deepEqual(pid.argv,['nodejs']);
  if(f.req.action==='inspect'){
    assert.equal(r.observed_count,1);assert.equal(r.evidence_path,f.file);
    const st=await fs.stat(f.file),ev=JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.equal(st.mode&0o777,0o600);assert.equal((await fs.stat(f.d)).mode&0o777,0o700);
    assert.deepEqual(Object.keys(ev).sort(),['space_id','page_label','commodity_id','captured_at','requested_url','landed_url','title','snapshot'].sort());
    assert.equal(ev.space_id,spaceId);assert.equal(ev.page_label,'p1');assert.equal(ev.commodity_id,commodity);
    assert.equal(ev.requested_url,url);assert.equal(ev.landed_url,landed);assert.equal(ev.snapshot,'TEST 私密完整证据');
    assert.ok(Number.isFinite(Date.parse(ev.captured_at)));assert.equal(ev.title,'TEST 中文 title');
    assert.ok(!JSON.stringify(r).includes('TEST 私密完整证据'));
  }
  return r;
}

for(const channel of ['stderr','stdout','mixed-stderr-space','mixed-stdout-space'])test('positive '+channel+' executes strict stdin and wx/0600 evidence',async()=>{await verified(await fixture({channel}));});
for(const channel of ['stderr','stdout'])test('positive '+channel+' EOF observation without newline',async()=>{await verified(await fixture({events:[{record:'space',stream:channel},{record:'observation',stream:channel,eof:true,waitBefore:25}]}));});
test('positive mixed EOF tails bind ownership regardless of stream flush order',async()=>{await verified(await fixture({events:[{record:'space',stream:'stderr',eof:true},{record:'observation',stream:'stdout',eof:true,waitBefore:25}]}));});
test('positive separate chunk buffers and split UTF8 diagnostics',async()=>{await verified(await fixture({events:[{record:'space',stream:'stderr',chunk:7},{raw:`TEST 中文 ${sentinel}\n`,stream:'stdout',chunk:1},{record:'observation',stream:'stdout',chunk:31,waitBefore:25}]}));});
test('positive cross-stream completed observation waits for partial space identity',async()=>{await verified(await fixture({events:[{record:'space',stream:'stderr',eof:true},{record:'observation',stream:'stdout',waitBefore:25}]}));});
test('positive plain diagnostics do not become observations or leak',async()=>{await verified(await fixture({events:[{raw:`TEST ${sentinel} not JSON\n`,stream:'stderr'},{record:'space'},{raw:'{malformed TEST diagnostic\n',stream:'stderr'},{record:'observation',waitBefore:25}]}));});
test('positive independent streams may total over 1MiB',async()=>{await verified(await fixture({events:[{fill:600000,stream:'stdout'},{raw:'\n',stream:'stdout'},{fill:600000,stream:'stderr'},{raw:'\n',stream:'stderr'},{record:'space'},{record:'observation',waitBefore:25}]}));});
for(const stream of ['stdout','stderr'])test('positive exact 1MiB '+stream+' limit',async()=>{
  const f=await fixture({execute:false,events:({space,obs})=>{
    const records=JSON.stringify(space)+'\n'+JSON.stringify(obs)+'\n';
    return [{row:space,stream},{row:obs,stream,waitBefore:25},{fill:limit-Buffer.byteLength(records)-1,stream},{raw:'\n',stream}];
  }});
  await fs.writeFile(f.file,JSON.stringify({space_id:spaceId,page_label:'p1',commodity_id:commodity,captured_at:'2026-10-09T00:00:00.000Z',requested_url:url,landed_url:landed,title:'TEST 中文 title',snapshot:'TEST 私密完整证据'}),{flag:'wx',mode:0o600});
  await verified(f);
});
for(const action of ['finish','handoff'])test('positive stderr '+action,async()=>{
  const f=await fixture({channel:'stderr'},{action,...(action==='finish'?{keep:[]}:{})});
  const r=await verified(f);assert.equal(r.status,action==='handoff'?'handoff':'ok');
  const calls=JSON.parse(await fs.readFile(f.callsfile,'utf8'));
  assert.deepEqual(calls[1],action==='finish'?['finish',{keep:[]}]:['handoff']);
});

const errorRow={type:'result',status:'error',space_id:spaceId,page_label:'p1',error_code:'TEST_RUNTIME_ERROR',may_have_late_effects:true};
for(const [name,spec,code] of [
  ['stderr sensitive notice',{events:[{record:'space',stream:'stdout'},{row:{type:'notice',token:sentinel},stream:'stderr',waitBefore:25},{record:'observation',stream:'stdout'}]},'PROTOCOL_SENSITIVE_FIELD'],
  ['late stderr sensitive record',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{row:{type:'notice',snapshot:{nested:sentinel}},stream:'stderr',waitBefore:50}]},'PROTOCOL_SENSITIVE_FIELD'],
  ['late EOF stderr sensitive record',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{row:{type:'notice',authorization:sentinel},stream:'stderr',eof:true,waitBefore:50}]},'PROTOCOL_SENSITIVE_FIELD'],
  ['stderr runtime error',{events:[{record:'space',stream:'stdout'},{row:errorRow,stream:'stderr',waitBefore:25}]},'TEST_RUNTIME_ERROR'],
  ['stderr EOF runtime error',{events:[{record:'space',stream:'stdout'},{row:errorRow,stream:'stderr',eof:true,waitBefore:25}]},'TEST_RUNTIME_ERROR'],
  ['late stderr error after success',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{row:errorRow,stream:'stderr',waitBefore:50}]},'PROTOCOL_MULTIPLE_RESULTS'],
  ['late EOF stderr error after success',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{row:errorRow,stream:'stderr',eof:true,waitBefore:50}]},'PROTOCOL_MULTIPLE_RESULTS'],
  ['duplicate same space across streams',{events:[{record:'space',stream:'stdout'},{record:'space',stream:'stderr',waitBefore:25},{record:'observation',stream:'stdout'}]},'PROTOCOL_SPACE_DUPLICATE'],
  ['conflicting space across streams',{events:[{record:'space',stream:'stdout'},{record:'space',patch:{space_id:'TEST-992'},stream:'stderr',waitBefore:25},{record:'observation',stream:'stdout'}]},'PROTOCOL_SPACE_DUPLICATE'],
  ['duplicate observations across streams',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{record:'observation',stream:'stderr',waitBefore:25}]},'PROTOCOL_MULTIPLE_RESULTS'],
  ['late different-page space',{events:[{record:'space',stream:'stdout'},{record:'observation',stream:'stdout'},{record:'space',patch:{page_label:'p2'},stream:'stderr',waitBefore:25}]},'PROTOCOL_SPACE_DUPLICATE'],
  ['stderr different observation space',{events:[{record:'space',stream:'stdout'},{record:'observation',patch:{space_id:'TEST-992'},stream:'stderr',waitBefore:25}]},'SPACE_PAGE_MISMATCH'],
  ['stderr different observation page',{events:[{record:'space',stream:'stdout'},{record:'observation',patch:{page_label:'p2'},stream:'stderr',waitBefore:25}]},'SPACE_PAGE_MISMATCH'],
  ['EOF cross-stream different ownership',{events:[{record:'space',stream:'stderr',eof:true},{record:'observation',patch:{space_id:'TEST-992'},stream:'stdout',eof:true,waitBefore:25}]},'SPACE_PAGE_MISMATCH'],
  ['nonzero exit after stderr success',{channel:'stderr',exit:7},'ROUND_FAILED'],
  ['nonzero exit after stdout success',{channel:'stdout',exit:7},'ROUND_FAILED'],
  ['stderr invalid type',{events:[{record:'space',stream:'stdout'},{row:{type:'other',space_id:spaceId,page_label:'p1'},stream:'stderr',waitBefore:25}]},'PROTOCOL_TYPE_INVALID'],
  ['stderr extra field',{events:[{record:'space',stream:'stdout'},{record:'observation',patch:{extra:'TEST'},stream:'stderr',waitBefore:25}]},'PROTOCOL_FIELD_NOT_ALLOWED'],
  ['stderr wrong commodity',{events:[{record:'space'},{record:'observation',patch:{commodity_id:'TEST-other'},waitBefore:25}]},'COMMODITY_MISMATCH'],
  ['stderr wrong count',{events:[{record:'space'},{record:'observation',patch:{observed_count:0},waitBefore:25}]},'OBSERVATION_EVIDENCE_REQUIRED'],
  ['stderr invalid count type',{events:[{record:'space'},{record:'observation',patch:{observed_count:'1'},waitBefore:25}]},'OBSERVED_COUNT_INVALID'],
  ['stderr wrong status',{events:[{record:'space'},{record:'observation',patch:{status:'handoff'},waitBefore:25}]},'ACTION_RESULT_MISMATCH'],
  ['stderr missing evidence path',{events:[{record:'space'},{record:'observation',omit:['evidence_path'],waitBefore:25}]},'OBSERVATION_EVIDENCE_REQUIRED'],
  ['stderr no space',{events:[{record:'observation'}]},'PROTOCOL_SPACE_MISSING'],
  ['diagnostic-only stderr',{events:[{raw:`TEST ${sentinel}\n`,stream:'stderr'}]},'PROTOCOL_SPACE_MISSING'],
  ['stderr space only',{events:[{record:'space'}]},'PROTOCOL_RESULT_MISSING'],
  ['strict label missing',{omitLabel:true},'PAGE_SPACE_MISMATCH'],
  ['strict space missing',{omitSpace:true},'PAGE_SPACE_MISMATCH'],
  ['strict both identity fields missing',{omitLabel:true,omitSpace:true},'PAGE_SPACE_MISMATCH'],
  ['strict page wrong',{label:'p2'},'PAGE_SPACE_MISMATCH'],
  ['strict space wrong',{pageSpace:'TEST-992'},'PAGE_SPACE_MISMATCH'],
  ['evidence permissions',{evidence:{mode:0o644}},'PROTOCOL_INVALID'],
  ['evidence malformed content',{evidence:{raw:'TEST-not-json'}},'EVIDENCE_CONTENT_INVALID'],
  ['evidence incomplete',{evidence:{omit:['snapshot']}},'EVIDENCE_CONTENT_INCOMPLETE'],
  ['evidence oversized',{evidence:{size:8*1024*1024+1}},'EVIDENCE_FILE_INVALID'],
  ['evidence different commodity',{evidence:{patch:{commodity_id:'TEST-other'}}},'EVIDENCE_OWNERSHIP_MISMATCH'],
  ['evidence different page',{evidence:{patch:{page_label:'p2'}}},'EVIDENCE_OWNERSHIP_MISMATCH'],
  ['evidence different space',{evidence:{patch:{space_id:'TEST-992'}}},'EVIDENCE_OWNERSHIP_MISMATCH'],
  ['evidence wrong requested URL',{evidence:{patch:{requested_url:url+'?wrong=TEST'}}},'EVIDENCE_URL_MISMATCH'],
  ['evidence wrong landed URL',{evidence:{patch:{landed_url:landed+'&wrong=TEST'}}},'EVIDENCE_URL_MISMATCH'],
  ['evidence invalid time',{evidence:{patch:{captured_at:'TEST-not-time'}}},'EVIDENCE_TIME_INVALID'],
])test('negative '+name,async()=>{await rejected(await fixture(spec),code);});

test('positive interleaved stream fragments are never concatenated',async()=>{
  await verified(await fixture({events:({space,obs})=>{
    const text=JSON.stringify(space),middle=Math.floor(text.length/2);
    return [{raw:text.slice(0,middle),stream:'stderr'},{raw:'TEST interleaved diagnostic\n',stream:'stdout',waitBefore:25},{raw:text.slice(middle)+'\n',stream:'stderr',waitBefore:25},{row:obs,stream:'stdout',waitBefore:25}];
  }}));
});
test('negative stderr JSON primitive is not a diagnostic',async()=>{await rejected(await fixture({events:[{record:'space',stream:'stdout'},{raw:'null\n',stream:'stderr',waitBefore:25}]}),'PROTOCOL_MESSAGE_INVALID');});
test('negative stdout sensitive fields retain old strict validation',async()=>{await rejected(await fixture({events:[{record:'space',stream:'stdout'},{row:{type:'notice',cookie:sentinel},stream:'stdout'}]}),'PROTOCOL_SENSITIVE_FIELD');});
test('negative evidence response cannot substitute another path',async()=>{
  await rejected(await fixture({events:({space,obs,file})=>[{row:space,stream:'stdout'},{row:{...obs,evidence_path:file+'.other'},stream:'stderr',waitBefore:25}]}),'EVIDENCE_REQUEST_MISMATCH');
});
test('positive stderr error preserves late effect flag and bound identity',async()=>{
  const f=await fixture({events:[{record:'space',stream:'stderr'},{row:errorRow,stream:'stderr',waitBefore:25}]});
  await assert.rejects(f.run,e=>{assert.equal(e.code,'TEST_RUNTIME_ERROR');assert.equal(e.space_id,spaceId);assert.equal(e.page_label,'p1');assert.equal(e.may_have_late_effects,true);return safeError(e);});
});
for(const bad of ['http://buyin.jinritemai.com/TEST','https://example.invalid/TEST',url+'?token=TEST'])test('negative stderr observed URL '+bad,async()=>{await rejected(await fixture({events:[{record:'space',stream:'stdout'},{record:'observation',patch:{observed_url:bad},stream:'stderr',waitBefore:25}]}),'URL_NOT_ALLOWED');});
for(const stream of ['stdout','stderr'])test('negative '+stream+' byte limit and closed child',async()=>{await rejected(await fixture({events:[{record:'space',stream},{fill:limit+1,stream}],hang:true}),stream==='stdout'?'OUTPUT_LIMIT':'STDERR_LIMIT');});
test('negative missing evidence file cannot validate echoed path',async()=>{
  const f=await fixture({execute:false,events:({space,obs})=>[{row:space,stream:'stderr'},{row:obs,stream:'stderr',waitBefore:25}]});
  await rejected(f,'ENOENT');
});
test('negative stdout missing file retains existing ENOENT public contract',async()=>{
  const f=await fixture({execute:false,events:({space,obs})=>[{row:space,stream:'stdout'},{row:obs,stream:'stdout',waitBefore:25}]});
  await rejected(f,'ENOENT');
});
test('negative existing evidence stays wx preserved before navigation',async()=>{
  const f=await fixture({preexisting:true});await rejected(f,'EVIDENCE_EXISTS');
  assert.equal(await fs.readFile(f.file,'utf8'),'TEST-existing-preserved');
  assert.deepEqual(JSON.parse(await fs.readFile(f.callsfile,'utf8')),[['space',spaceId]]);
});
test('negative request identity override cannot disable production requirement',async()=>{await rejected(await fixture({omitLabel:true,omitSpace:true},{requirePageIdentity:false}),'PAGE_SPACE_MISMATCH');});
test('negative timeout preserves stderr ownership and waits for SIGKILL close',async()=>{
  const f=await fixture({events:[{record:'space',stream:'stderr'}],hang:true});
  await assert.rejects(f.run,e=>{assert.equal(e.code,'TIMEOUT');assert.equal(e.space_id,spaceId);assert.equal(e.page_label,'p1');assert.equal(e.may_have_late_effects,true);return safeError(e);});
});
test('negative non-Ego stderr pseudo-observation is never accepted',async()=>{
  await rejected(await fixture({events:({space,obs})=>[{row:space,stream:'stderr'},{row:obs,stream:'stderr'}]},{},true),'PROTOCOL_SPACE_MISSING');
});
test('positive non-Ego legacy stdout semantics ignore stderr pseudo-observation',async()=>{
  const f=await fixture({events:({space,obs})=>[{row:space,stream:'stdout'},{row:{...obs,observed_count:0,observed_url:undefined,evidence_path:null},stream:'stdout'},{row:obs,stream:'stderr'}]},{url:undefined,output_file:undefined},true);
  const r=await f.run();assert.equal(r.verified,false);assert.equal(r.evidence_path,null);assert.equal(r.missing_reason,'NO_OBSERVATIONS');
});
