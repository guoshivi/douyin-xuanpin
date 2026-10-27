import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const DEFAULT_VIDEO_ROOT = process.env.XUANPIN_VIDEO_ROOT ?? '/Volumes/选品素材';
const runFile = promisify(execFile);

// 配置阶段只验证格式，不创建目录、不移动文件、不接触 NAS 素材。
export function validateVideoRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) || /^\/+$/u.test(value) || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('VIDEO_SAVE_ROOT_INVALID');
  }
  return value;
}

export function getVideoRoot(policy) {
  return policy?.storage === undefined ? DEFAULT_VIDEO_ROOT : validateVideoRoot(policy.storage?.video_root);
}

export async function chooseVideoDirectory({signal} = {}) {
  if (process.platform !== 'darwin') throw new Error('FOLDER_PICKER_UNAVAILABLE');
  // 固定脚本；不拼接客户端传入路径，也不使用 shell。
  const script = `try
set chosenFolder to choose folder with prompt "选择视频保存目录（不会移动已有视频）"
return POSIX path of chosenFolder
on error number -128
return ""
end try`;
  try {
    const {stdout} = await runFile('/usr/bin/osascript', ['-e', script], {signal, timeout:120000, maxBuffer:16384});
    const value = stdout.replace(/\r?\n$/u, '');
    return value === '' ? null : validateVideoRoot(value);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('FOLDER_PICKER_FAILED', {cause:error});
  }
}
