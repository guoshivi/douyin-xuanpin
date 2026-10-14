import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const SENSITIVE=/(cookie|authorization|password|passwd|secret|token|credential|private|snapshot|signed.?url|auth(?!or))/iu;
const LOCAL_FIELD=/(?:^|_)(?:local_path|evidence_path|file_path|absolute_path)$/iu;
const HOSTS=new Set(['buyin.jinritemai.com','jinritemai.com','haohuo.jinritemai.com','douyin.com','www.douyin.com']);
function ancestors(p){const out=[];let x=path.resolve(p);while(true){out.push(x);const y=path.dirname(x);if(y===x)break;x=y;}return out.reverse();}
function noLinks(target){for(const p of ancestors(target)){try{if(fs.lstatSync(p).isSymbolicLink())throw new Error('LOCAL_PATH_SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}}}
export function safeEvidencePath(root,file,{mustExist=false}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('EVIDENCE_ROOT_INVALID');
  if(typeof file!=='string'||!path.isAbsolute(file)||/[\u0000-\u001f\u007f]/u.test(file))throw new Error('EVIDENCE_PATH_INVALID');
  const data=path.resolve(root,'data'),target=path.resolve(file);
  if(target===data||!target.startsWith(`${data}${path.sep}`))throw new Error('EVIDENCE_PATH_OUTSIDE_DATA');
  noLinks(target);
  if(mustExist){const st=fs.statSync(target);if(!st.isFile()||(st.mode&0o777)!==0o600)throw new Error('EVIDENCE_FILE_INVALID');}
  return target;
}
export function acquireLock(root,runId){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('LOCK_ROOT_INVALID');if(typeof runId!=='string'||!runId)throw new Error('RUN_ID_REQUIRED');
  noLinks(root);fs.mkdirSync(root,{recursive:true});const lockPath=path.join(root,'.selection.lock'),nonce=crypto.randomBytes(16).toString('hex');
  const payload=JSON.stringify({pid:process.pid,run_id:runId,owner_nonce:nonce,created_at:new Date().toISOString()});let fd;
  try{fd=fs.openSync(lockPath,'wx',0o600);fs.writeFileSync(fd,payload);fs.closeSync(fd);fd=undefined;}catch(e){if(fd!=null)try{fs.closeSync(fd);}catch{}if(e.code==='EEXIST')throw new Error('LOCK_HELD:已有锁存在，无法确认归属时默认阻塞，不自动删除');throw e;}
  let released=false;const release=()=>{if(released)return;const current=fs.readFileSync(lockPath,'utf8');let parsed;try{parsed=JSON.parse(current);}catch{throw new Error('LOCK_CHANGED');}if(parsed.owner_nonce!==nonce||parsed.pid!==process.pid){released=true;throw new Error('LOCK_OWNERSHIP_CHANGED');}fs.unlinkSync(lockPath);released=true;};
  return {path:lockPath,pid:process.pid,run_id:runId,owner_nonce:nonce,release,close:release};
}
function idOk(id){if(typeof id!=='string'||!id||path.isAbsolute(id)||id==='.'||id==='..'||id.includes('/')||id.includes('\\')||id.includes('..')||/[\u0000-\u001f\u007f]/u.test(id))throw new Error('ASSET_ID_INVALID');}
export function safeAssetPath(root,id,ext='bin'){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('ASSET_ROOT_INVALID');idOk(id);if(typeof ext!=='string'||!/^\.?[A-Za-z0-9]{1,12}$/.test(ext))throw new Error('ASSET_EXT_INVALID');
  noLinks(root);const suffix=ext.startsWith('.')?ext:`.${ext}`,target=path.join(path.resolve(root),id+suffix);noLinks(target);return target;
}
function inspect(v,key=''){
  if(SENSITIVE.test(key)||LOCAL_FIELD.test(key))throw new Error('PUBLIC_SENSITIVE_FIELD');
  if(typeof v==='string'){
    if(/(?:^|[\r\n])(?:Cookie|Authorization):/iu.test(v))throw new Error('PUBLIC_HEADER_SECRET');
    if(key==='relative_path'&&(path.isAbsolute(v)||v.split(/[\\/]/u).includes('..')))throw new Error('PUBLIC_LOCAL_PATH');
    const isUrlKey=/(?:^|_)(?:url|uri)s?$/iu.test(key);
    if(isUrlKey||/^[a-z][a-z0-9+.-]*:\/\//iu.test(v)){
      let u;try{u=new URL(v);}catch{throw new Error('PUBLIC_URL_INVALID');}
      if(u.protocol!=='https:')throw new Error('PUBLIC_URL_HTTPS_REQUIRED');if(u.username||u.password)throw new Error('PUBLIC_URL_USERINFO');
      if(![...HOSTS].some(h=>u.hostname===h||u.hostname.endsWith(`.${h}`)))throw new Error('PUBLIC_URL_HOST_NOT_ALLOWED');
      for(const k of u.searchParams.keys())if(/token|sign|signature|auth|credential|cookie|expires|x-oss/iu.test(k))throw new Error('PUBLIC_SIGNED_URL');
      if(/token|signature|authorization|password/iu.test(u.hash))throw new Error('PUBLIC_SIGNED_URL');
    }
  }else if(Array.isArray(v))v.forEach((x,i)=>inspect(x,`${key}[${i}]`));else if(v&&typeof v==='object')Object.entries(v).forEach(([k,x])=>inspect(x,k));
}
export function assertPublicSafe(payload){inspect(payload);return true;}
export function buildPublicRecord(kind,source={}){
  const fields={product:['commodity_id','product_id','title','category_ids','price','commission_rate','sales','conversion_rate','source_url','captured_at'],observation:['commodity_id','stage','state','source_url','captured_at','missing_reason'],asset:['commodity_id','aweme_id','kind','archive_date','relative_path','verified_at']}[kind];
  if(!fields)throw new Error('PUBLIC_KIND_INVALID');const out={};for(const k of fields)if(Object.hasOwn(source,k))out[k]=source[k];assertPublicSafe(out);return out;
}
