import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultPolicy, policyToDraft, draftToPolicy, validatePolicy } from './settings-model.mjs';
import { setCategoryCatalog } from './policy.mjs';
import { getVideoRoot, validateVideoRoot, chooseVideoDirectory } from './storage-settings.mjs';
import { createTaskManager } from './task-manager.mjs';
import { safeCode, failure } from './verifier.mjs';
import { resolveLanInterface, validateSettingsPort, checkSettingsNetwork, LanAccessError } from './lan-access.mjs';

const MAX_BODY = 32 * 1024;
const STATIC = { '/settings.css': ['settings.css','text/css; charset=utf-8'], '/settings.mjs': ['settings.mjs','text/javascript; charset=utf-8'], '/display.mjs': ['display.mjs','text/javascript; charset=utf-8'], '/form-lock.mjs': ['form-lock.mjs','text/javascript; charset=utf-8'] };
const here = path.dirname(fileURLToPath(import.meta.url));

function json(res, status, body) { const data=JSON.stringify(body); res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(data)}); res.end(data); }
function text(res,status,data,type) { res.writeHead(status, {'content-type':type,'cache-control':'no-store','content-length':Buffer.byteLength(data)}); res.end(data); }
function safeError(res,status,message,errors) { json(res,status,{error:message, ...(errors?{errors}: {})}); }
function openFolder(dir){ return new Promise((resolve,reject)=>{ execFile('open',[dir],{timeout:5000},err=>{ if(err)reject(err); else resolve(); }); }); }
async function readPolicySnapshot(file) {
  const bytes=await fs.readFile(file); const p=JSON.parse(bytes.toString('utf8'));
  const result=validatePolicy(p, []); if(!result.valid){const e=new Error('INVALID_POLICY');e.errors=result.errors;throw e;}
  return {p,r:crypto.createHash('sha256').update(bytes).digest('hex')};
}
async function readCatalog(root) {
  try {
    const parsed=JSON.parse(await fs.readFile(path.join(root,'config','site-map.local.json'),'utf8'));
    if (!Array.isArray(parsed.categories)) return [];
    return parsed.categories.filter(c=>c&&typeof c==='object'&&typeof c.id==='string').map(c=>({id:c.id,...(typeof c.name==='string'?{name:c.name}:{})}));
  } catch { return []; }
}
async function ensurePolicy(root) {
  const dir=path.join(root,'config'), file=path.join(dir,'selection.json');
  await fs.mkdir(dir,{recursive:true});
  try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify(defaultPolicy(),null,2)+'\n',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;}); }
  return file;
}

export async function createSettingsServer({
projectRoot=process.cwd(), root: injectedRoot, port=0, lan=false, lanAddress, coreOnly=false, directoryPicker=chooseVideoDirectory, taskAdapter, testMode=false, taskDbPath}={}) {
  setCategoryCatalog(await readCatalog(projectRoot));
  if(typeof coreOnly!=='boolean')throw failure('TASK_OPTION_INVALID');
  validateSettingsPort(port);
  if(typeof lan!=='boolean'||(!lan&&lanAddress!==undefined))throw new LanAccessError('SETTINGS_OPTION_INVALID','局域网地址必须通过明确的 LAN 模式启用。');
  const lanInterface=lan?resolveLanInterface(lanAddress):null;
  const root=path.resolve(injectedRoot ?? projectRoot); const configFile=await ensurePolicy(root); const uiRoot=path.join(root,'ui');
  await current();
  const csrf=crypto.randomBytes(24).toString('base64url');
  let closePromise; let saveQueue=Promise.resolve();
  const sockets=new Set();
  let tasks; const manager=()=>tasks??=createTaskManager({projectRoot:root, coreOnly, ...(taskDbPath?{dbPath:taskDbPath}:{})});
  if(taskAdapter&&!testMode)throw new Error('TEST_ADAPTER_NOT_ALLOWED');
  let pickerBusy=false; const pickerAbort=new AbortController();
  const queue=fn=>{const next=saveQueue.then(fn,fn); saveQueue=next.catch(()=>{}); return next;};
  async function current() { return readPolicySnapshot(configFile); }
  async function writeAtomic(nextPolicy) {
    const dir=path.dirname(configFile); const tmp=path.join(dir,`.selection.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const handle=await fs.open(tmp,'wx');
    try {
      try { await handle.writeFile(JSON.stringify(nextPolicy,null,2)+'\n','utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(tmp,configFile);
    } catch(e) { await fs.unlink(tmp).catch(()=>{}); throw e; }
  }
  const server=http.createServer(async (req,res)=>{
    try {
      const host=req.headers.host;
      const denied=checkSettingsNetwork(req,server.address()?.port,lanInterface);
      if(denied)return safeError(res,403,denied);
      const url=new URL(req.url,`http://${host}`);
      if (req.method==='GET' && url.pathname==='/') {
        const file=path.join(uiRoot,'settings.html'); let html=await fs.readFile(file,'utf8'); html=html.replaceAll('__CSRF_TOKEN__',csrf); return text(res,200,html,'text/html; charset=utf-8');
      }
      if (req.method==='GET' && STATIC[url.pathname]) { const [name,type]=STATIC[url.pathname]; return text(res,200,await fs.readFile(path.join(uiRoot,name)),type); }
      if (req.method==='GET' && url.pathname==='/api/settings') {
        const {p,r}=await current(); const cats=await readCatalog(root); return json(res,200,{revision:r,policy:p,draft:policyToDraft(p),categories:cats,capabilities:{execution_mode:coreOnly?'core_only':'integrated',feishu_sync_enabled:!coreOnly},storage_layout:{root:getVideoRoot(p),example:'日期 / 商品编号 / 视频'}});
      }
      if(req.method==='GET'&&url.pathname==='/api/tasks'){return json(res,200,{tasks:manager().listPublic()});}
      if (req.method==='POST' && ['/api/settings','/api/close','/api/choose-video-directory','/api/tasks/start','/api/tasks/pause','/api/tasks/resume','/api/tasks/cancel','/api/open-folder'].includes(url.pathname)) {
        if (req.headers.origin !== `http://${host}`) return safeError(res,403,'BAD_ORIGIN');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return safeError(res,403,'BAD_CONTENT_TYPE');
        if (req.headers['x-csrf-token'] !== csrf) return safeError(res,403,'BAD_CSRF');
        const chunks=[]; let size=0; let oversized=false; for await (const chunk of req) { size+=chunk.length; if(size>MAX_BODY){oversized=true; continue;} chunks.push(chunk); }
        if (oversized) return safeError(res,413,'BODY_TOO_LARGE');
        let body; try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return safeError(res,400,'INVALID_JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return safeError(res,422,'INVALID_REQUEST');
        if(url.pathname.startsWith('/api/tasks/')){
          const start=url.pathname==='/api/tasks/start';const allowed=start?['expected_revision']:['run_id'];
          if(Object.keys(body).some(k=>!allowed.includes(k))||Object.keys(body).length!==1||typeof body[allowed[0]]!=='string')return safeError(res,422,'INVALID_REQUEST');
          const result=await queue(async()=>{try{
            if(pickerBusy)return {status:409,body:{error:'FOLDER_PICKER_BUSY'}};
            if(start){const saved=await current();if(body.expected_revision!==saved.r)return {status:409,body:{error:'REVISION_CONFLICT'}};const started=await manager().start({policy:saved.p,revision:saved.r,adapter:taskAdapter,testMode});return {status:202,body:{task:started.task}};}
            if(!/^run-[a-f0-9-]{36}$/.test(body.run_id))return {status:422,body:{error:'INVALID_REQUEST'}};
            const task=url.pathname==='/api/tasks/pause'?await manager().pause(body.run_id):url.pathname==='/api/tasks/cancel'?await manager().cancel(body.run_id):(await manager().resume(body.run_id,{adapter:taskAdapter,testMode})).task;return {status:200,body:{task}};
          }catch(e){return {status:409,body:{error:safeCode(e,'TASK_REJECTED')}};}});return json(res,result.status,result.body);
        }
        if (url.pathname==='/api/choose-video-directory') {
          if (Object.keys(body).length) return safeError(res,422,'INVALID_REQUEST');
          if (pickerBusy) return safeError(res,409,'FOLDER_PICKER_BUSY');
          pickerBusy=true;
          try {
            const chosen=await directoryPicker({signal:pickerAbort.signal});
            return json(res,200,chosen===null ? {cancelled:true} : {cancelled:false,path:validateVideoRoot(chosen)});
          } catch { return safeError(res,503,'FOLDER_PICKER_FAILED'); }
          finally { pickerBusy=false; }
        }
        if (url.pathname==='/api/open-folder') {
          const keys=Object.keys(body);
          if (keys.length!==1 || keys[0]!=='path' || typeof body.path!=='string' || body.path.length>600) return safeError(res,422,'INVALID_REQUEST');
          const normalized=path.normalize(body.path);
          const segs=normalized.split(path.sep);
          if (!path.isAbsolute(normalized) || !/^\d{4}-\d{2}-\d{2}$/.test(segs[segs.length-2]??'') || !/^\d{19}$/.test(segs[segs.length-1]??'')) return safeError(res,422,'INVALID_REQUEST');
          const {p}=await current();
          const videoRoot=path.normalize(getVideoRoot(p));
          if (!normalized.startsWith(videoRoot+path.sep)) return safeError(res,422,'INVALID_REQUEST');
          let realRoot,realTarget,stat;
          try { realRoot=await fs.realpath(videoRoot); realTarget=await fs.realpath(normalized); } catch { return safeError(res,404,'FOLDER_NOT_FOUND'); }
          if (!realTarget.startsWith(realRoot+path.sep)) return safeError(res,422,'INVALID_REQUEST');
          try { stat=await fs.stat(realTarget); } catch { return safeError(res,404,'FOLDER_NOT_FOUND'); }
          if (!stat.isDirectory()) return safeError(res,422,'INVALID_REQUEST');
          try { await openFolder(realTarget); return json(res,200,{opened:true,path:realTarget}); } catch { return safeError(res,503,'OPEN_FAILED'); }
        }
        if (url.pathname==='/api/close') {
          if (Object.keys(body).length) return safeError(res,422,'INVALID_REQUEST');
          json(res,200,{closed:true}); setImmediate(()=>close()); return;
        }
        if (Object.keys(body).some(key => !['expected_revision','draft'].includes(key)) || typeof body.expected_revision!=='string' || !body.draft || typeof body.draft!=='object' || Array.isArray(body.draft)) return safeError(res,422,'INVALID_REQUEST');
        const result=await queue(async()=>{
          const currentState=await current();
          if (body.expected_revision!==currentState.r) return {status:409,body:{error:'REVISION_CONFLICT',revision:currentState.r}};
          const cats=await readCatalog(root);
          let next; try { next=draftToPolicy(body.draft,currentState.p,cats); } catch(e) { return {status:422,body:{error:'VALIDATION_ERROR',errors:e.errors||{draft:'字段无效'}}}; }
          next.policy_version=`season-surge-v1-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; next.confirmed=true;
          const vp=validatePolicy(next,cats); if(!vp.valid)return {status:422,body:{error:'VALIDATION_ERROR',errors:vp.errors}};
          await writeAtomic(next); const readback=await current(); return {status:200,body:{revision:readback.r,policy:readback.p,draft:policyToDraft(readback.p)}};
        });
        return json(res,result.status,result.body);
      }
      return safeError(res,404,'NOT_FOUND');
    } catch (error) { if(!res.headersSent) safeError(res,500,'INTERNAL_ERROR'); }
  });
  server.on('connection',socket=>{ sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); });
  await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(port,lanInterface?'0.0.0.0':'127.0.0.1',resolve); });
  const actual=server.address().port; const origin=`http://127.0.0.1:${actual}`;
  function close(){
    if (!closePromise) {
      closePromise=(async()=>{try{await tasks?.close();}finally{return new Promise(resolve=>{
        const deadline=setTimeout(()=>{ for (const socket of sockets) socket.destroy(); },1500);
        // 让已接受连接的待处理数据进入请求处理，避免被 Node 当作空闲连接提前关闭。
        setTimeout(()=>server.close(()=>{ clearTimeout(deadline); resolve(); }),0);
      });}})();
      pickerAbort.abort();
    }
    return closePromise;
  }
  const lanOrigin=lanInterface?`http://${lanInterface.address}:${actual}`:null;
  return { server, port:actual, url:origin+'/', origin, csrf, close, lanUrl:lanOrigin?lanOrigin+'/':null, lanOrigin, lanInterface };
}

export { MAX_BODY };
export const startSettingsServer = createSettingsServer;
