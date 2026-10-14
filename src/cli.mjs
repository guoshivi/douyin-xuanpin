#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createSettingsServer } from './settings-server.mjs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createTaskManager, publicTask } from './task-manager.mjs';
import { safeCode, failure } from './verifier.mjs';
import { parseSettingsOptions, LanAccessError } from './lan-access.mjs';

export function parseSelectionOptions(args){const [action='status',...tokens]=args;if(!['start','resume','pause','status'].includes(action))throw failure('CLI_OPTION_INVALID');const options={action};for(const token of tokens){if(token==='--core-only'){if(!['start','resume'].includes(action)||options.coreOnly)throw failure('CLI_OPTION_INVALID');options.coreOnly=true;}else if(typeof token!=='string'||token.startsWith('--')||!['resume','pause'].includes(action)||options.runId)throw failure('CLI_OPTION_INVALID');else options.runId=token;}if(['resume','pause'].includes(action)&&!options.runId)throw failure('CLI_OPTION_INVALID');return options;}
export async function runSelection({projectRoot=process.cwd(),action='start',runId,expectedRevision,adapter,testMode=false,coreOnly=false,output=body=>process.stdout.write(JSON.stringify(body)+'\n')}={}) {
  const manager=createTaskManager({projectRoot,coreOnly}); let activeId; const stop=()=>activeId?manager.pause(activeId):Promise.resolve();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    if(action==='status'){const tasks=manager.list().map(publicTask);output({tasks});return {tasks};}
    if(action==='pause'){const task=await manager.pause(runId);output({task});return {task};}
    let started;
    if(action==='resume')started=await manager.resume(runId,{adapter,testMode});
    else if(action==='start') {const bytes=await fs.readFile(path.join(projectRoot,'config/selection.json'));const revision=crypto.createHash('sha256').update(bytes).digest('hex');if(expectedRevision&&expectedRevision!==revision)throw failure('REVISION_CONFLICT');started=await manager.start({policy:JSON.parse(bytes),revision,adapter,testMode});}
    else throw failure('CLI_ACTION_INVALID');
    activeId=started.run_id;output({task:started.task});const completed=await started.done;const task=publicTask(completed);output({task});return {task};
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await manager.close();}
}

export async function runSettings({projectRoot=process.cwd(), noOpen=false, lan=false, lanAddress, port=0, coreOnly=false}={}) {
  const service=await createSettingsServer({projectRoot,lan,lanAddress,port,coreOnly});
  const url=service.url;
  process.stdout.write(`SETTINGS_READY ${url}\n`);
  process.stdout.write(`SETTINGS_MODE ${coreOnly?'core_only 核心流程模式 · 飞书同步未启用':'integrated 集成模式 · 飞书同步已启用'}\n`);
  if(service.lanUrl)process.stdout.write(`SETTINGS_LAN_READY ${service.lanUrl}\n局域网仅信任本机获准子网内设备，没有账号登录或公网认证；地址变化后需重启。任务与目录选择窗口均在服务端 Mac 执行。\n`);
  if (!noOpen) {
    const child=spawn('open',[url],{stdio:'ignore',detached:true});
    child.on('error',()=>{}); child.unref();
  }
  let stopping=false;
  const stop=async()=>{if(stopping)return; stopping=true; try{await service.close();process.exitCode=0;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  return {service, stop};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command,...args]=process.argv.slice(2);
  if(command==='selection') {
    try{runSelection(parseSelectionOptions(args)).then(({task})=>{if(task&&task.state!=='completed'&&task.state!=='paused')process.exitCode=1;}).catch(e=>{console.error(`SELECTION_ERROR ${safeCode(e)}`);process.exitCode=1;});}
    catch{console.error('用法：node src/cli.mjs selection start [--core-only] 或 selection resume <run_id> [--core-only] 或 selection status|pause <run_id>');process.exitCode=2;}
  } else if (command !== 'settings') { console.error('用法：node src/cli.mjs settings [--core-only] [--lan [--lan-address <本机私网IPv4>]] [--port <正整数>] [--no-open] 或 selection start|status|resume|pause'); process.exitCode=2; }
  else {
    try {runSettings(parseSettingsOptions(args)).catch(error=>{console.error(error instanceof LanAccessError?`SETTINGS_ERROR ${error.code} ${error.message}`:'SETTINGS_ERROR OPERATION_FAILED');process.exitCode=1;});}
    catch(error){console.error(error instanceof LanAccessError?error.message:'启动选项无效');process.exitCode=2;}
  }
}
