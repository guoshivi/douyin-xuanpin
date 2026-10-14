// 面板公共显示规则；仅格式化，不改变内部计时精度。
const secondsFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  roundingMode: 'halfExpand',
  useGrouping: false,
});

export function formatSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return `${secondsFormatter.format(value)} 秒`;
}

const messages = {
  VIDEO_SAVE_ROOT_INVALID: '请填写完整的绝对目录路径，支持本机或已挂载的网络共享；不能留空或包含相对路径段',
  FOLDER_PICKER_UNAVAILABLE: '当前系统不支持文件夹选择器，请直接填写完整路径',
  FOLDER_PICKER_BUSY: '文件夹选择器已打开，请先完成选择或取消',
  FOLDER_PICKER_FAILED: '无法完成文件夹选择，请直接填写完整路径或重试',
  INVALID_NUMBER: '请输入有效的非负数字',
  INVALID_INTEGER: '请输入有效的整数',
  INVALID_DATE: '请选择有效日期',
  INVALID_BOOLEAN: '请选择有效的勾选状态',
  INVALID_TEXT: '文本格式不正确或内容过长',
  INVALID_IDS: '请选择有效类目',
  INVALID_ID: '类目标识格式不正确',
  REQUIRED: '此项必须填写',
  CATEGORY_NOT_AVAILABLE: '类目选项未加载或类目标识不存在',
  REVISION_CONFLICT: '配置已被另一页面修改，请重新读取',
  BAD_HOST: '本机地址校验失败，请重新打开设置面板',
  BAD_ORIGIN: '页面来源校验失败，请重新打开设置面板',
  BAD_CSRF: '本次页面校验已失效，请刷新设置面板',
  BAD_CONTENT_TYPE: '请求格式不正确',
  BODY_TOO_LARGE: '提交内容过大，请缩短补充说明',
  INVALID_JSON: '提交内容格式不正确',
  INTERNAL_ERROR: '本机服务暂时无法处理请求，请重新读取或重开面板',
};

export function localizeError(value) {
  const text = String(value?.message ?? value ?? '');
  for (const [code, message] of Object.entries(messages)) {
    if (text.includes(code)) return message;
  }
  if (/failed to fetch|fetch failed|networkerror|load failed/i.test(text)) {
    return '无法连接本机设置服务，请检查服务是否仍在运行';
  }
  if (/[\u3400-\u9fff]/u.test(text)) return text.replace(/\bID\b/g, '标识').replace(/\bSKU\b/g, '款式');
  return '操作未完成，请检查填写内容或重新打开设置面板';
}

// 请求期间同步冻结控件，防止迟到响应覆盖后来输入。
export function createFormLock(form) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(callback) {
      if (busy) return;
      busy = true;
      const controls = [...form.querySelectorAll('input,select,textarea,button')];
      const original = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      try { return await callback(); }
      finally {
        controls.forEach((control, index) => { control.disabled = original[index]; });
        busy = false;
      }
    },
  };
}

