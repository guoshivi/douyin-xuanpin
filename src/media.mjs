import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {runCommand} from './command.mjs';
import {failure,assertNumericId} from './verifier.mjs';
export function validateMediaUrl(value){let u;try{u=new URL(value);}catch{throw failure('MEDIA_HOST_REJECTED');}const exact=['aweme.snssdk.com','www.iesdouyin.com','www.douyin.com'];if(u.protocol!=='https:'||u.username||u.password||u.port||!(exact.includes(u.hostname)||['douyinvod.com','ecombdimg.com','byteimg.com','douyinpic.com'].some(h=>u.hostname.endsWith('.'+h))))throw failure('MEDIA_HOST_REJECTED');return u.href;}
export async function downloadBytes(value,{fetchImpl=fetch,signal,checkpoint=()=>{},maxBytes=150*1024*1024}={}){
 let url=validateMediaUrl(value);for(let redirects=0;redirects<5;redirects++){
  checkpoint();let response;try{response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(25000)]),headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.douyin.com/'}});}catch{throw failure('MEDIA_TEMPORARY_NETWORK');}
  if([401,403].includes(response.status))throw failure('HTTP_'+response.status+'_PERMISSION_DENIED');if(response.status===404)throw failure('HTTP_404');
  if([301,302,303,307,308].includes(response.status)){url=validateMediaUrl(new URL(response.headers.get('location'),url).href);continue;}
  if(response.status!==200)throw failure('MEDIA_HTTP_FAILED');const length=Number(response.headers.get('content-length'));if(length>maxBytes)throw failure('MEDIA_SIZE_LIMIT');let size=0;const chunks=[];
  try{for await(const chunk of response.body){checkpoint();size+=chunk.length;if(size>maxBytes)throw failure('MEDIA_SIZE_LIMIT');chunks.push(Buffer.from(chunk));}}catch(e){if(typeof e?.code==='string'&&e.code)throw e;throw failure('MEDIA_TEMPORARY_NETWORK');}
  if(size===0||(length>0&&size!==length))throw failure('MEDIA_CONTENT_LENGTH');return Buffer.concat(chunks);
 }throw failure('MEDIA_REDIRECT_LIMIT');
}
export function videoSources(meta,row){assertNumericId(row.aweme_id);if(meta?.filter_reason||meta?.error||meta?.status_self_see!=null&&meta.status_self_see!==false&&meta.status_self_see!==0)return {unavailable:true,reason:'METADATA_RESTRICTED'};
 if(meta?.aweme_id!==row.aweme_id||meta?.desc!==row.title)return {unavailable:true,reason:'METADATA_IDENTITY_MISMATCH'};
 if(!Number.isFinite(meta.duration_ms)||meta.duration_ms<=0)throw failure('METADATA_DURATION_MISSING');
 if(typeof meta.uri!=='string'||!meta.uri||!Array.isArray(meta.play))throw failure('METADATA_SOURCES_MISSING');
 return {sources:[{quality:'original',url:`https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(meta.uri)}&ratio=default&line=0`},...meta.play.slice(0,2).map(url=>({quality:'web_best_available',url:validateMediaUrl(url)}))]};
}
export async function obtainVideo(meta,row,options){const spec=videoSources(meta,row);if(spec.unavailable)return spec;for(const [i,source] of spec.sources.entries()){try{return {bytes:await downloadBytes(source.url,options),quality:source.quality,attempts:i+1,duration_ms:meta.duration_ms,author:meta.author??null};}catch(e){if(/^HTTP_(401|403)_/.test(e.code))return {unavailable:true,reason:e.code};if(['HTTP_404','MEDIA_TEMPORARY_NETWORK','MEDIA_SIZE_LIMIT','MEDIA_HOST_REJECTED'].includes(e.code)&&i<spec.sources.length-1)continue;throw e;}}throw failure('MEDIA_SOURCES_EXHAUSTED');}
export async function probeMedia(bytes,{kind='video',durationMs,privateRoot,command='/opt/homebrew/bin/ffprobe',signal}={}) {
 if(!privateRoot)throw failure('PRIVATE_ROOT_REQUIRED');await fs.mkdir(privateRoot,{recursive:true,mode:0o700});const file=path.join(privateRoot,'probe-'+crypto.randomUUID()+'.'+(kind==='video'?'mp4':'img'));await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
 let p;try{const {stdout}=await runCommand(command,['-v','error','-show_format','-show_streams','-of','json',file],{timeoutMs:30000,maxBytes:256*1024,signal});p=JSON.parse(stdout);}catch{throw failure('MEDIA_PROBE_FAILED');}
 const stream=p.streams?.find(x=>x.codec_type==='video');if(!stream||stream.width<=0||stream.height<=0)throw failure('MEDIA_STREAM_MISSING');
 if(kind==='image'){const extension={mjpeg:'jpg',png:'png',webp:'webp'}[stream.codec_name];if(!extension)throw failure('IMAGE_FORMAT_INVALID');return {extension,width:stream.width,height:stream.height};}
 const duration=Number(p.format?.duration);if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(durationMs)||Math.abs(duration*1000-durationMs)>200+1e-7)throw failure('FULL_DURATION_MISMATCH');return {duration_seconds:duration,duration_display:duration.toFixed(1),width:stream.width,height:stream.height,has_audio:p.streams.some(x=>x.codec_type==='audio')};
}
