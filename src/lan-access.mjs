import os from 'node:os';
import { isIPv4 } from 'node:net';

export class LanAccessError extends Error {
  constructor(code, message) { super(message); this.code=code; }
}
const reject=(code,message)=>{throw new LanAccessError(code,message);};
const ipv4Number=address=>address.split('.').reduce((value,part)=>(value*256+Number(part))>>>0,0);
export function isPrivateIPv4(address) {
  if(typeof address!=='string'||!isIPv4(address))return false;
  const n=ipv4Number(address);
  return (n>>>24)===10||(n>>>20)===(ipv4Number('172.16.0.0')>>>20)||(n>>>16)===(ipv4Number('192.168.0.0')>>>16);
}
function subnet(entry) {
  if(!isPrivateIPv4(entry.address)||typeof entry.netmask!=='string'||!isIPv4(entry.netmask))return null;
  const mask=ipv4Number(entry.netmask), inverse=(~mask)>>>0;
  if(((inverse+1)&inverse)!==0)return null;
  const prefix=32-Math.log2(inverse+1), minimum=entry.address.startsWith('10.')?8:entry.address.startsWith('172.')?12:16;
  if(prefix<minimum)return null;
  const address=ipv4Number(entry.address), network=(address&mask)>>>0, broadcast=(network|inverse)>>>0;
  if(prefix<=30&&(address===network||address===broadcast))return null;
  return {mask,network,broadcast,prefix};
}
// Validate an exact local RFC1918 interface before any configuration I/O or bind.
export function resolveLanInterface(address, interfaces=os.networkInterfaces()) {
  if(address!==undefined&&(typeof address!=='string'||!isPrivateIPv4(address)))reject('LAN_ADDRESS_INVALID','局域网地址必须是本机的 RFC1918 私网 IPv4，不能填写域名、公网或通配地址。');
  const candidates=[];
  for(const [name,entries] of Object.entries(interfaces))for(const entry of entries??[]) {
    if(entry.internal||(entry.family!=='IPv4'&&entry.family!==4))continue;
    const range=subnet(entry);
    if(range)candidates.push({name,address:entry.address,netmask:entry.netmask,...range});
  }
  const matches=address===undefined?candidates:candidates.filter(entry=>entry.address===address);
  if(matches.length===0)reject('LAN_INTERFACE_NOT_FOUND','未找到对应的本机私网 IPv4 接口或有效子网，请先核对网络地址。');
  if(matches.length!==1)reject('LAN_INTERFACE_AMBIGUOUS','存在多个私网接口，无法唯一确定局域网；请明确 --lan-address 并核对本机接口。');
  return Object.freeze(matches[0]);
}
export function validateSettingsPort(port) {
  if(!Number.isInteger(port)||port<0||port>65535)reject('SETTINGS_PORT_INVALID','端口必须是 1 到 65535 的整数；程序内部可用 0 自动分配。');
  return port;
}
// Header claims, Forwarded and X-Forwarded-For never determine the network source.
export function checkSettingsNetwork(req, port, lanInterface=null) {
  const local=req.socket?.localAddress, remote=req.socket?.remoteAddress;
  const localAllowed=local==='127.0.0.1'||Boolean(lanInterface&&local===lanInterface.address);
  let remoteAllowed=remote==='127.0.0.1';
  if(lanInterface&&isPrivateIPv4(remote)) {
    const n=ipv4Number(remote);
    remoteAllowed=((n&lanInterface.mask)>>>0)===lanInterface.network&&(lanInterface.prefix>30||(n!==lanInterface.network&&n!==lanInterface.broadcast));
  }
  if(!localAllowed||!remoteAllowed)return 'BAD_NETWORK';
  const hosts=[`127.0.0.1:${port}`,...(lanInterface?[`${lanInterface.address}:${port}`]:[])];
  if(!hosts.includes(req.headers.host))return 'BAD_HOST';
  return null;
}
export function parseSettingsOptions(args) {
  const options={noOpen:false,lan:false,port:0};
  const seen=new Set();
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(flag==='--no-open'){options.noOpen=true;continue;}
    if(seen.has(flag))reject('SETTINGS_OPTION_INVALID','启动选项不能重复。');
    seen.add(flag);
    if(flag==='--core-only'){options.coreOnly=true;continue;}
    if(flag==='--lan'){options.lan=true;continue;}
    if(flag==='--lan-address'||flag==='--port') {
      const value=args[++i];
      if(typeof value!=='string'||value.startsWith('--'))reject('SETTINGS_OPTION_INVALID',`${flag} 后必须填写一个值。`);
      if(flag==='--lan-address')options.lanAddress=value;
      else {
        if(!/^[1-9]\d*$/.test(value)||Number(value)>65535)reject('SETTINGS_PORT_INVALID','--port 必须填写 1 到 65535 的正整数。');
        options.port=Number(value);
      }
      continue;
    }
    reject('SETTINGS_OPTION_INVALID','用法：settings [--core-only] [--lan [--lan-address <本机私网IPv4>]] [--port <正整数>] [--no-open]');
  }
  if(options.lanAddress!==undefined&&!options.lan)reject('SETTINGS_OPTION_INVALID','--lan-address 必须与 --lan 同时使用。');
  return options;
}
