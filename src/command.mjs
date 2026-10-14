import {spawn} from 'node:child_process';
import {failure} from './verifier.mjs';
export function runCommand(command,args,{input='',cwd,signal,timeoutMs=90000,maxBytes=1024*1024,onLine}={}) {
 if(signal?.aborted)return Promise.reject(failure('TASK_PAUSED'));
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(maxBytes)||maxBytes<1)return Promise.reject(failure('COMMAND_OPTIONS_INVALID'));
 return new Promise((resolve,reject)=>{
  let child,stopped=null,timer,killTimer,settled=false,closing=false;
  const parts={stdout:[],stderr:[]},buffers={stdout:'',stderr:''},sizes={stdout:0,stderr:0};
  // detached creates an exclusive owned session/group, never the caller/Ego group.
  const kill=sig=>{if(!Number.isSafeInteger(child?.pid))return;try{process.kill(process.platform==='win32'?child.pid:-child.pid,sig);}catch(e){if(e.code!=='ESRCH')stopped??=failure('COMMAND_CLEANUP_UNCONFIRMED');}};
  const abort=()=>stop('TASK_PAUSED');
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();if(stopped)reject(stopped);else resolve({stdout:Buffer.concat(parts.stdout).toString('utf8'),stderr:Buffer.concat(parts.stderr).toString('utf8')});};
  const cleanup=()=>{if(closing)return;closing=true;kill('SIGTERM');killTimer=setTimeout(()=>{kill('SIGKILL');finish();},150);};
  const stop=code=>{stopped??=failure(code);cleanup();};
  try{child=spawn(command,args,{cwd,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});}catch{reject(failure('SPAWN_FAILED'));return;}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();timer=setTimeout(()=>stop('COMMAND_TIMEOUT'),timeoutMs);
  for(const name of ['stdout','stderr'])child[name].on('data',d=>{if(closing)return;sizes[name]+=d.length;if(sizes[name]>maxBytes){stop('COMMAND_OUTPUT_LIMIT');return;}parts[name].push(d);if(onLine){buffers[name]+=d.toString('utf8');let i;while((i=buffers[name].indexOf('\n'))>=0){const line=buffers[name].slice(0,i);buffers[name]=buffers[name].slice(i+1);try{onLine(line,name);}catch{stop('PROTOCOL_INVALID');return;}}}});
  child.on('error',()=>stop('SPAWN_FAILED'));child.stdin.on('error',()=>stop('STDIN_FAILED'));
  child.on('close',code=>{if(settled)return;clearTimeout(timer);if(onLine&&!closing)for(const name of ['stdout','stderr'])if(buffers[name].trim())try{onLine(buffers[name],name);}catch{stopped??=failure('PROTOCOL_INVALID');}if(code!==0&&!stopped)stopped=failure('COMMAND_FAILED');cleanup();});
  child.stdin.end(input);
 });
}
