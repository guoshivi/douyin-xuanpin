import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateVideoRoot} from './storage-settings.mjs';
import {runCommand} from './command.mjs';
import {assertNumericId,failure} from './verifier.mjs';
export async function noLinks(file){let p=path.resolve(file);while(true){try{if((await fs.lstat(p)).isSymbolicLink())throw failure('STORAGE_SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}const up=path.dirname(p);if(up===p)break;p=up;}}
export function assetPath({root,archiveDate,commodityId,awemeId,kind='video',extension='mp4',imageIndex=1,dataName}){
 validateVideoRoot(root);assertNumericId(commodityId);if(!/^\d{4}-\d{2}-\d{2}$/.test(archiveDate)||Number.isNaN(Date.parse(archiveDate))||new Date(archiveDate).toISOString().slice(0,10)!==archiveDate)throw failure('ARCHIVE_DATE_INVALID');
 const base=path.join(root,archiveDate,commodityId);
 if(kind==='video'){assertNumericId(awemeId);if(extension!=='mp4')throw failure('ASSET_EXTENSION_INVALID');return path.join(base,awemeId+'.mp4');}
 if(kind==='image'){if(!['jpg','png','webp'].includes(extension)||!Number.isSafeInteger(imageIndex)||imageIndex<1)throw failure('ASSET_EXTENSION_INVALID');return path.join(base,'主图',String(imageIndex).padStart(2,'0')+'.'+extension);}
 if(kind==='data'&&/^[a-zA-Z0-9_-]+\.json$/.test(dataName??''))return path.join(base,'数据',dataName);
 throw failure('ASSET_KIND_INVALID');
}
export async function captureStorageIdentity(root,{projectRoot}={}) {
 validateVideoRoot(root);await noLinks(root);
 if(root.split(path.sep).some(x=>['private','.hermes','.codex','.ssh','.git','Library','Pictures','config'].includes(x)))throw failure('STORAGE_ROOT_FORBIDDEN');
 if(projectRoot&&['src','ui','tests','config','data'].some(x=>root===path.join(projectRoot,x)||root.startsWith(path.join(projectRoot,x)+path.sep)))throw failure('STORAGE_ROOT_FORBIDDEN');
 if(root.startsWith('/Volumes/')){
  const mount='/Volumes/'+root.split('/')[2];const {stdout}=await runCommand('/sbin/mount',[],{timeoutMs:5000,maxBytes:128*1024});
  const line=stdout.split('\n').find(x=>x.includes(' on '+mount+' (')&&/\((?:smbfs|nfs|afpfs)[,)]/.test(x));if(!line)throw failure('SHARE_NOT_MOUNTED');const st=await fs.stat(mount);return {root,mount,dev:st.dev,ino:st.ino,fingerprint:crypto.createHash('sha256').update(line).digest('hex')};
 }
 let existing=root;while(true){try{const st=await fs.stat(existing);if(!st.isDirectory())throw failure('STORAGE_NOT_DIRECTORY');return {root,existing,dev:st.dev,ino:st.ino};}catch(e){if(e.code!=='ENOENT')throw e;existing=path.dirname(existing);}}
}
export async function checkStorage(identity){await noLinks(identity.root);if(identity.mount){const fresh=await captureStorageIdentity(identity.root);if(fresh.fingerprint!==identity.fingerprint||fresh.dev!==identity.dev||fresh.ino!==identity.ino)throw failure('SHARE_IDENTITY_CHANGED');}else{const st=await fs.stat(identity.existing);if(st.dev!==identity.dev||st.ino!==identity.ino)throw failure('STORAGE_IDENTITY_CHANGED');}}
export async function hashFile(file){await noLinks(file);const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const hash=crypto.createHash('sha256');let bytes=0;for await(const chunk of handle.createReadStream({autoClose:false})){hash.update(chunk);bytes+=chunk.length;}return {sha256:hash.digest('hex'),bytes};}finally{await handle.close();}}
export async function writeVerifiedAsset(args){const target=assetPath(args),identity=args.identity??await captureStorageIdentity(args.root);const check=async()=>{args.checkpoint?.();await checkStorage(identity);await noLinks(target);};await check();await fs.mkdir(path.dirname(target),{recursive:true});await check();let h;
 try{h=await fs.open(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}catch(e){if(e.code==='EEXIST')throw failure('ASSET_CONFLICT');throw failure('ASSET_OPEN_FAILED');}
 try{const bytes=Buffer.isBuffer(args.bytes)?args.bytes:Buffer.from(args.bytes);for(let at=0;at<bytes.length;at+=1024*1024){await check();await h.writeFile(bytes.subarray(at,at+1024*1024));args.faults?.afterChunk?.();}await h.sync();}catch{throw failure('ARCHIVE_COPY_UNCERTAIN');}finally{await h.close();}
 await check();const actual=await hashFile(target);const expected=crypto.createHash('sha256').update(args.bytes).digest('hex');if(actual.sha256!==expected)throw failure('ARCHIVE_HASH_UNCERTAIN');return {path:target,...actual,kind:args.kind??'video'};
}
