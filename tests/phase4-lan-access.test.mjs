// Isolated TEST only. Real local HTTP sockets are distinguished from injected metadata.
// No cross-device, public-network, production-config, NAS or Feishu operation is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSettingsServer } from '../src/settings-server.mjs';
import { defaultPolicy } from '../src/settings-model.mjs';
import { resolveLanInterface, checkSettingsNetwork, parseSettingsOptions, isPrivateIPv4 } from '../src/lan-access.mjs';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const work=process.env.PHASE4_LAN_WORK_ROOT;
assert.ok(work&&path.isAbsolute(work)&&work.includes('/phase4-web-integration-20261010T1442/lan-implementation-v1/'),'TEST output must be in the authorized, fresh LAN acceptance directory');
await fs.mkdir(work,{recursive:true});
const live=resolveLanInterface(process.env.PHASE4_LAN_ADDRESS);
const interfaces={TEST:[{address:'192.168.40.10',netmask:'255.255.255.0',family:'IPv4',internal:false}]};
const synthetic=resolveLanInterface('192.168.40.10',interfaces);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
console.log(`# TEST_LAN_BINDING ${JSON.stringify({sourceRoot,interface:live.name,address:live.address,netmask:live.netmask,realCrossDevice:false})}`);

function req(base,endpoint,options={}) {
  return new Promise((resolve,reject)=>{
    const request=http.request(new URL(endpoint,base),{method:options.method||'GET',headers:options.headers,agent:false},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,headers:response.headers,text,json:()=>JSON.parse(text)});});
    });
    request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('TEST_HTTP_TIMEOUT')));request.end(options.body);
  });
}
const post=(service,base,endpoint,body,headers={})=>req(base,endpoint,{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':service.csrf,...headers},body:typeof body==='string'?body:JSON.stringify(body)});
async function fixture() {
  const root=await fs.mkdtemp(path.join(work,'TEST-'));
  await fs.mkdir(path.join(root,'config'));await fs.mkdir(path.join(root,'ui'));
  const policy=defaultPolicy();policy.storage.video_root=path.join(root,'TEST-video-root');
  await fs.writeFile(path.join(root,'config/selection.json'),JSON.stringify(policy),{flag:'wx'});
  await fs.writeFile(path.join(root,'config/site-map.local.json'),JSON.stringify({categories:[{id:'TEST-A',name:'测试甲'},{id:'TEST-B',name:'测试乙'}]}),{flag:'wx'});
  for(const name of ['settings.html','settings.css','settings.mjs','display.mjs','form-lock.mjs'])await fs.copyFile(path.join(sourceRoot,'ui',name),path.join(root,'ui',name));
  return root;
}
async function closed(port) {
  await assert.rejects(new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve();});socket.setTimeout(2000,()=>socket.destroy(new Error('TEST_CLOSE_TIMEOUT')));}),undefined,'the exact TEST listener must be gone');
}
async function withService(options,callback) {
  const root=await fixture();let service;
  try {service=await createSettingsServer({projectRoot:root,...options});await callback(service,root);}
  finally {if(service){await service.close();assert.equal(service.server.listening,false);await closed(service.port);await assert.rejects(fs.access(path.join(root,'.selection.lock')));}}
}
async function tree(root) {
  const names=[];
  async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full);else names.push(path.relative(root,full));}}
  await walk(root);return names.sort();
}
async function injectedRequest(service,{localAddress,remoteAddress,host,extraHeaders={},method='GET',url='/api/tasks',body=''}={}) {
  // Explicit unit injection into the same real request handler; NOT a real remote socket.
  const request={socket:{localAddress,remoteAddress},headers:{host,...extraHeaders},method,url,async *[Symbol.asyncIterator](){if(body)yield Buffer.from(body);}};
  let status,headers,text='';
  const response={headersSent:false,writeHead(code,values){status=code;headers=values;this.headersSent=true;},end(value){text+=value||'';}};
  await service.server.listeners('request')[0](request,response);
  return {status,headers,text,json:()=>JSON.parse(text)};
}

test('CLI parse preserves default/no-open behavior and adds explicit LAN/address/port',()=>{
  assert.deepEqual(parseSettingsOptions([]),{noOpen:false,lan:false,port:0});
  assert.deepEqual(parseSettingsOptions(['--no-open','--no-open']),{noOpen:true,lan:false,port:0});
  assert.deepEqual(parseSettingsOptions(['--lan','--lan-address','192.168.40.10','--port','6000','--no-open']),{noOpen:true,lan:true,port:6000,lanAddress:'192.168.40.10'});
});
for(const args of [['--lan-address','192.168.40.10'],['--lan-address'],['--port'],['--port','0'],['--port','-1'],['--port','1.5'],['--port','01'],['--port','65536'],['--port','Infinity'],['--port','80junk'],['--host','0.0.0.0'],['--lan','--lan']]) {
  test(`CLI rejects invalid options ${JSON.stringify(args)}`,()=>assert.throws(()=>parseSettingsOptions(args),error=>/[\u3400-\u9fff]/u.test(error.message)));
}
for(const address of ['0.0.0.0','127.0.0.1','8.8.8.8','169.254.1.2','localhost','192.168.040.10','192.168.40.10:80','::1','::ffff:192.168.40.10','192.168.40.10 ','172.15.1.1','172.32.1.1',null,{}]) {
  test(`discovery rejects malformed/non-private input ${JSON.stringify(address)}`,()=>assert.throws(()=>resolveLanInterface(address,interfaces),error=>error.code==='LAN_ADDRESS_INVALID'));
}
test('discovery uses a real interface, validates RFC1918 families, and does not hardcode the site IP',()=>{
  assert.equal(resolveLanInterface(undefined,interfaces).address,'192.168.40.10');
  assert.equal(live.address,os.networkInterfaces()[live.name].find(entry=>entry.address===live.address).address);
  for(const address of ['10.1.2.3','172.16.0.1','172.31.255.254','192.168.0.1'])assert.equal(isPrivateIPv4(address),true);
  for(const netmask of ['255.255.255.254','255.255.255.255'])assert.equal(resolveLanInterface(undefined,{TEST:[{...interfaces.TEST[0],netmask}]}).address,'192.168.40.10');
  assert.throws(()=>resolveLanInterface('192.168.40.11',interfaces),error=>error.code==='LAN_INTERFACE_NOT_FOUND');
});
test('discovery fails closed for no match, invalid/broad mask, internal interface, and ambiguity',()=>{
  for(const entries of [[],[{...interfaces.TEST[0],internal:true}],[{...interfaces.TEST[0],netmask:'255.0.255.0'}],[{...interfaces.TEST[0],netmask:'255.0.0.0'}]])assert.throws(()=>resolveLanInterface(undefined,{TEST:entries}));
  const multiple={...interfaces,SECOND:[{...interfaces.TEST[0],address:'10.20.30.40'}]};
  assert.throws(()=>resolveLanInterface(undefined,multiple),error=>error.code==='LAN_INTERFACE_AMBIGUOUS');
  assert.equal(resolveLanInterface('192.168.40.10',multiple).name,'TEST');
  assert.throws(()=>resolveLanInterface('192.168.40.10',{...interfaces,DUPLICATE:interfaces.TEST}),error=>error.code==='LAN_INTERFACE_AMBIGUOUS');
});

const networkCases=[
  ['public source','192.168.40.10','8.8.8.8','192.168.40.10:6000','BAD_NETWORK'],
  ['other private subnet','192.168.40.10','192.168.41.10','192.168.40.10:6000','BAD_NETWORK'],
  ['other RFC1918 block','192.168.40.10','10.1.2.3','192.168.40.10:6000','BAD_NETWORK'],
  ['unapproved local interface','192.168.41.10','192.168.40.11','192.168.40.10:6000','BAD_NETWORK'],
  ['wildcard local address','0.0.0.0','192.168.40.11','192.168.40.10:6000','BAD_NETWORK'],
  ['subnet network source','192.168.40.10','192.168.40.0','192.168.40.10:6000','BAD_NETWORK'],
  ['subnet broadcast source','192.168.40.10','192.168.40.255','192.168.40.10:6000','BAD_NETWORK'],
  ['IPv6 source','192.168.40.10','::1','192.168.40.10:6000','BAD_NETWORK'],
  ['mapped source','192.168.40.10','::ffff:192.168.40.11','192.168.40.10:6000','BAD_NETWORK'],
  ['wrong Host name','192.168.40.10','192.168.40.11','localhost:6000','BAD_HOST'],
  ['wrong Host port','192.168.40.10','192.168.40.11','192.168.40.10:6001','BAD_HOST'],
  ['Host prefix attack','192.168.40.10','192.168.40.11','192.168.40.10.evil:6000','BAD_HOST'],
  ['Host userinfo attack','192.168.40.10','192.168.40.11','evil@192.168.40.10:6000','BAD_HOST'],
];
for(const [name,localAddress,remoteAddress,host,expected] of networkCases) {
  test(`socket metadata ${name} rejected despite forged forwarding headers`,()=>{
    const request={socket:{localAddress,remoteAddress},headers:{host,'x-forwarded-for':'192.168.40.11',forwarded:'for=192.168.40.11;host=192.168.40.10:6000'}};
    assert.equal(checkSettingsNetwork(request,6000,synthetic),expected);
  });
}
test('real socket policy allows only loopback and selected private subnet; untrusted XFF cannot create or revoke access',()=>{
  for(const [localAddress,remoteAddress,host] of [['127.0.0.1','127.0.0.1','127.0.0.1:6000'],['192.168.40.10','192.168.40.11','192.168.40.10:6000']])assert.equal(checkSettingsNetwork({socket:{localAddress,remoteAddress},headers:{host,'x-forwarded-for':'8.8.8.8'}},6000,synthetic),null);
  assert.equal(checkSettingsNetwork({socket:{localAddress:'127.0.0.1',remoteAddress:'192.168.40.11'},headers:{host:'127.0.0.1:6000'}},6000), 'BAD_NETWORK');
});

for(const options of [{lan:true,lanAddress:'8.8.8.8'},{lan:true,lanAddress:'localhost'},{lan:true,lanAddress:'0.0.0.0'},{lan:true,lanAddress:'10.254.254.254'},{lanAddress:live.address},{lan:'true'},{port:-1},{port:65536},{port:'5000'}]) {
  test(`server invalid configuration rejects before config I/O and bind ${JSON.stringify(options)}`,async()=>{
    const parent=await fs.mkdtemp(path.join(work,'TEST-preflight-')),root=path.join(parent,'must-not-be-created');
    let binds=0;const listen=http.Server.prototype.listen;
    http.Server.prototype.listen=function(...args){binds++;return listen.apply(this,args);};
    let unexpectedService;
    try {await assert.rejects(createSettingsServer({projectRoot:root,...options}).then(service=>{unexpectedService=service;return service;}),error=>/[\u3400-\u9fff]/u.test(error.message));assert.equal(binds,0);await assert.rejects(fs.access(root));}
    finally {http.Server.prototype.listen=listen;if(unexpectedService){await unexpectedService.close();await closed(unexpectedService.port);}}
  });
}

test('default server remains exact IPv4 loopback, with original URL/Origin and no LAN access',()=>withService({},async service=>{
  assert.equal(service.server.address().address,'127.0.0.1');assert.equal(service.url,`http://127.0.0.1:${service.port}/`);assert.equal(service.lanUrl,null);
  assert.equal((await req(service.url,'/api/settings')).status,200);
  assert.equal((await req(service.url,'/api/settings',{headers:{host:`${live.address}:${service.port}`}})).status,403);
}));

test('actual local LAN-interface socket and loopback serve the same settings/HTML without CORS or private static routes',()=>withService({lan:true,lanAddress:live.address},async(service,root)=>{
  assert.equal(service.server.address().address,'0.0.0.0');assert.equal(service.lanUrl,`http://${live.address}:${service.port}/`);
  const records=[];service.server.on('request',request=>records.push({local:request.socket.localAddress,remote:request.socket.remoteAddress}));
  const loop=await req(service.url,'/api/settings'),lan=await req(service.lanUrl,'/api/settings');
  assert.equal(loop.status,200);assert.equal(lan.status,200);assert.deepEqual(lan.json(),loop.json());
  assert.deepEqual(records.slice(0,2),[{local:'127.0.0.1',remote:'127.0.0.1'},{local:live.address,remote:live.address}]);
  assert.equal(lan.headers['access-control-allow-origin'],undefined);
  const html=await req(service.lanUrl,'/');assert.equal(html.status,200);assert.match(html.text,/服务端 Mac 或其已挂载 NAS/);assert.match(html.text,/窗口在服务端 Mac 打开/);assert.match(html.text,/关闭客户端页面不会终止任务/);assert.doesNotMatch(html.text,/__CSRF_TOKEN__/);
  for(const endpoint of ['/config/selection.json','/data/state.sqlite','/private/test','/signed-media.mp4','/src/lan-access.mjs'])assert.equal((await req(service.lanUrl,endpoint)).status,404,endpoint);
  assert.deepEqual((await tree(root)).filter(name=>name.startsWith('data/')),[],'read settings alone must not create task DB');
}));

test('injected invalid real-source metadata reaches rejection before any config/static read or task DB action',()=>withService({lan:true,lanAddress:live.address},async(service,root)=>{
  const before=await tree(root);const original=fs.readFile;let reads=0;
  fs.readFile=async function(file,...args){if(String(file).startsWith(root+path.sep))reads++;return original.call(this,file,...args);};
  try {
    for(const [localAddress,remoteAddress] of [[live.address,'8.8.8.8'],[live.address,'203.0.113.1'],['192.0.2.1',live.address],[live.address,'10.254.254.1']]) {
      const result=await injectedRequest(service,{localAddress,remoteAddress,host:`${live.address}:${service.port}`,extraHeaders:{'x-forwarded-for':live.address,forwarded:`for=${live.address}`}});
      assert.equal(result.status,403);assert.equal(result.json().error,'BAD_NETWORK');
    }
    assert.equal(reads,0);assert.deepEqual(await tree(root),before);
  } finally {fs.readFile=original;}
}));

test('LAN Host/Origin/CSRF/content-type/body/schema negatives preserve configuration and create no task DB',()=>withService({lan:true,lanAddress:live.address},async(service,root)=>{
  const file=path.join(root,'config/selection.json'),before=await fs.readFile(file),state=(await req(service.lanUrl,'/api/settings')).json();
  const payload={expected_revision:state.revision,draft:state.draft};
  const cases=[
    ['Host',{'host':`localhost:${service.port}`},payload,403],
    ['loop Origin on LAN Host',{origin:service.origin},payload,403],
    ['LAN Origin on loop Host',{host:`127.0.0.1:${service.port}`},payload,403],
    ['remote Origin',{origin:'http://evil.invalid'},payload,403],
    ['CSRF',{'x-csrf-token':'TEST-wrong'},payload,403],
    ['content type',{'content-type':'text/plain'},payload,403],
    ['oversized',{},'x'.repeat(32769),413],
    ['invalid JSON',{},'{',400],
    ['extra payload field',{}, {...payload,business_action:true},422],
    ['extra draft field',{}, {...payload,draft:{...state.draft,business_action:true}},422],
  ];
  for(const [name,headers,body,status] of cases){const result=await post(service,service.lanUrl,'/api/settings',body,headers);assert.equal(result.status,status,name);}
  for(const [body,status] of [[{expected_revision:state.revision,draft:state.draft},422],[{expected_revision:state.revision,business_action:true},422],[[],422],['x'.repeat(32769),413]])assert.equal((await post(service,service.lanUrl,'/api/tasks/start',body)).status,status);
  assert.equal(hash(await fs.readFile(file)),hash(before));assert.deepEqual((await tree(root)).filter(name=>name.startsWith('data/')),[]);
}));

test('two real local clients save/readback all 25 fields, explicit zero and categories; stale revision cannot overwrite; saving has zero tasks',()=>withService({lan:true,lanAddress:live.address},async(service,root)=>{
  const one=(await req(service.url,'/api/settings')).json(),two=(await req(service.lanUrl,'/api/settings')).json();assert.equal(one.revision,two.revision);
  const draft={...one.draft,seasonalNotes:'TEST-LAN-saved',priceMin:'0',priceBasis:'sku',includeCategories:['TEST-B','TEST-A'],videoSaveRoot:path.join(root,'TEST-NAS-path-not-created')};
  const requests=await Promise.all([post(service,service.url,'/api/settings',{expected_revision:one.revision,draft}),post(service,service.lanUrl,'/api/settings',{expected_revision:two.revision,draft})]);
  assert.deepEqual(requests.map(result=>result.status).sort(),[200,409]);
  const actual=(await req(service.lanUrl,'/api/settings')).json();assert.deepEqual(actual.draft,draft);assert.equal(Object.keys(actual.draft).length,25);
  const disk=JSON.parse(await fs.readFile(path.join(root,'config/selection.json'),'utf8'));assert.deepEqual(disk,actual.policy);assert.equal(disk.rules[0].min,0);assert.deepEqual(disk.categories.include,['TEST-B','TEST-A']);
  assert.deepEqual((await tree(root)).filter(name=>name.startsWith('data/')),[],'save creates zero task DB/actions');await assert.rejects(fs.access(draft.videoSaveRoot),'save does not create the video directory');
}));

test('LAN and loopback concurrent TEST starts still allow one writer; pause/resume/read progress preserve snapshot and zero external effects',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);let discovered=0,finished=0,external=0;
  const adapter={mode:'test',async discoverCandidates(){discovered++;if(discovered===1)await pending;return [];},async finish(){finished++;return {finished:true};}};
  for(const name of ['addToCart','readCart','readDecision','freezeVideos','downloadImage','syncFeishu','readFeishu'])adapter[name]=async()=>{external++;throw new Error('TEST_EXTERNAL_MUST_NOT_RUN');};
  try {await withService({lan:true,lanAddress:live.address,testMode:true,taskAdapter:adapter},async(service,root)=>{
    const settings=(await req(service.lanUrl,'/api/settings')).json(),payload={expected_revision:settings.revision};
    assert.equal((await post(service,service.lanUrl,'/api/tasks/start',{expected_revision:'TEST-stale'})).status,409);assert.equal(discovered,0);
    const results=await Promise.all([post(service,service.url,'/api/tasks/start',payload),post(service,service.lanUrl,'/api/tasks/start',payload)]);assert.deepEqual(results.map(result=>result.status).sort(),[202,409]);
    const started=results.find(result=>result.status===202).json().task;
    assert.equal((await post(service,service.lanUrl,'/api/tasks/pause',{run_id:started.run_id})).status,200);release();
    const paused=(await req(service.lanUrl,'/api/tasks')).json().tasks[0];assert.equal(paused.state,'paused');assert.deepEqual(paused.snapshot,started.snapshot);
    assert.equal((await post(service,service.url,'/api/tasks/resume',{run_id:started.run_id})).status,200);
    let final;
    for(let attempt=0;attempt<100;attempt++){final=(await req(service.lanUrl,'/api/tasks')).json().tasks[0];if(final.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(final.state,'completed',final.error_code);assert.deepEqual(final.snapshot,started.snapshot);assert.equal(external,0);assert.equal(finished,1);
  });} finally {release();}
});

test('real CLI LAN entry prints both URLs without CSRF, reads via actual interface, and SIGTERM closes exact PID/listener',async()=>{
  const root=await fixture(),cli=path.join(sourceRoot,'src/cli.mjs');let child,port,stdout='',stderr='',exit;
  try {
    child=spawn(process.execPath,[cli,'settings','--lan','--lan-address',live.address,'--no-open'],{cwd:root,stdio:['ignore','pipe','pipe']});
    exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('TEST_CLI_READY_TIMEOUT')),5000);
      const check=()=>{const match=stdout.match(/SETTINGS_LAN_READY (http:\/\/[^\s]+)/);if(match){clearTimeout(timer);child.stdout.removeListener('data',check);resolve(match[1]);}};
      child.stdout.on('data',check);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(`TEST_CLI_EARLY_EXIT ${stderr}`));});check();
    });
    port=Number(new URL(ready).port);assert.match(stdout,new RegExp(`SETTINGS_READY http://127\\.0\\.0\\.1:${port}/`));assert.match(stdout,/没有账号登录或公网认证/);
    const page=await req(ready,'/'),token=page.text.match(/name="csrf-token" content="([^"]+)"/)?.[1];assert.ok(token);assert.ok(!stdout.includes(token));
    assert.equal((await req(ready,'/api/settings')).status,200);child.kill('SIGTERM');await exit;assert.equal(child.exitCode,0);await closed(port);
    assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}}
    if(port)await closed(port);
  }
});
