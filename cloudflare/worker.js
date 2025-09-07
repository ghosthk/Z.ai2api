/**
 * Z.ai → OpenAI-Compatible 代理 (Function Call + UTF-8 + SSE)
 * Cloudflare Workers 版本
 * - /v1/chat/completions 与 /v1/models
 * - 严格兼容 OpenAI 工具调用：有 tool_calls 时 content=null、finish_reason=tool_calls
 * - SSE 流式：携带 tools 时全程缓冲，结束后统一输出（避免客户端崩溃/乱码）
 * - 明确 UTF-8：所有响应带 charset=utf-8；SSE 手动按 UTF-8 解码
 */

// ==============================
// 配置（硬编码）
// ==============================
const CONFIG = {
  API_BASE: 'https://chat.z.ai',
  DEFAULT_MODEL: 'GLM-4.5',
  DEBUG_MODE: false,
  THINK_TAGS_MODE: 'reasoning',  // 支持多种模式：reasoning, think, strip, details
  FUNCTION_CALL_ENABLED: true,
  ANON_TOKEN_ENABLED: true,
  UPSTREAM_TOKEN: '',
  HTTP_CONNECT_TIMEOUT: 10,
  HTTP_READ_TIMEOUT: 60,
  TOKEN_TIMEOUT: 8,
  RETRY_COUNT: 2,
  RETRY_BACKOFF: 0.6,
  MAX_JSON_SCAN: 200000,
  SSE_HEARTBEAT_SECONDS: 15,
};

// 模型思考能力配置（基于 models.json）
const MODEL_CAPABILITIES = {
  // 支持思考的模型
  '0727-360B-API': { hasThinking: true, name: 'GLM-4.5' },
  '0727-106B-API': { hasThinking: true, name: 'GLM-4.5-Air' },
  'glm-4.5v': { hasThinking: true, name: 'GLM-4.5V' },
  'GLM-4.1V-Thinking-FlashX': { hasThinking: true, name: 'GLM-4.1V-9B-Thinking' },
  // 不支持思考的模型
  'main_chat': { hasThinking: false, name: 'GLM-4-32B' },
  'deep-research': { hasThinking: false, name: 'Z1-Rumination' },
  'zero': { hasThinking: false, name: 'Z1-32B' },
  'glm-4-flash': { hasThinking: false, name: '任务专用' },
};

// 浏览器请求头
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/139.0.0.0',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'X-FE-Version': 'prod-fe-1.0.76',
  'sec-ch-ua': '"Not;A=Brand";v="99", "Edge":v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Origin': CONFIG.API_BASE,
};

// 请求记录存储
let requestLogs = [];
const MAX_LOGS = 20;

// 添加请求记录
function addRequestLog(path, method, status, userAgent, ip) {
  // 只记录核心 API 接口的请求
  const apiPaths = ['/healthz', '/v1/models', '/v1/chat/completions'];
  if (!apiPaths.includes(path)) {
    return;
  }
  
  const log = {
    timestamp: new Date().toISOString(),
    path,
    method,
    status,
    userAgent: userAgent || 'Unknown',
    ip: ip || 'Unknown',
  };
  
  requestLogs.unshift(log);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs = requestLogs.slice(0, MAX_LOGS);
  }
}

// ==============================
// 图片上传功能
// ==============================
async function uploadImage(dataUrl, chatId) {
  try {
    // 检查是否为匿名模式或非data:格式
    if (!CONFIG.ANON_TOKEN_ENABLED && !CONFIG.UPSTREAM_TOKEN) {
      debug('图片上传需要token认证');
      return null;
    }
    
    if (!dataUrl.startsWith('data:')) {
      debug('非data:格式图片，跳过上传');
      return null;
    }

    // 解析data URL
    const [header, encoded] = dataUrl.split(',', 2);
    if (!encoded) {
      debug('图片数据格式错误');
      return null;
    }

    const mimeType = header.split(';')[0].split(':')[1] || 'image/jpeg';
    
    // Base64解码
    const imageData = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    debug(`上传图片文件: ${filename}`);
    
    // 构造FormData
    const formData = new FormData();
    formData.append('file', new Blob([imageData], { type: mimeType }), filename);
    
    const token = await getToken();
    const response = await fetch(`${CONFIG.API_BASE}/api/v1/files/`, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Authorization': `Bearer ${token}`,
        'Referer': `${CONFIG.API_BASE}/c/${chatId}`,
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
    
    if (response.ok) {
      const result = await response.json();
      const fileUrl = `${result.id}_${result.filename}`;
      debug(`图片上传成功: ${fileUrl}`);
      return fileUrl;
    } else {
      throw new Error(`Upload failed: ${response.status}`);
    }
  } catch (e) {
    debug(`图片上传失败: ${e.message}`);
    return null;
  }
}

// Token计数功能（简化版）
function countTokens(text) {
  if (!text) return 0;
  // 简单的token估算：中文字符=1.5token，英文单词=1token，其他字符=0.5token
  const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishCount = (text.match(/[a-zA-Z]+/g) || []).join(' ').split(' ').length;
  const otherCount = text.length - chineseCount - englishCount;
  return Math.ceil(chineseCount * 1.5 + englishCount + otherCount * 0.5);
}

// ==============================
// 工具函数
// ==============================
function debug(msg, ...args) {
  if (CONFIG.DEBUG_MODE) {
    console.log(`[DEBUG] ${msg}`, ...args);
  }
}

function setCORS(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return response;
}

function nowNsId(prefix = 'msg') {
  return `${prefix}-${Date.now() * 1000000}`;
}

function safeLogJson(prefix, data) {
  try {
    const scrub = JSON.parse(JSON.stringify(data));
    ['Authorization', 'authorization'].forEach(k => {
      if (scrub[k]) scrub[k] = '***';
    });
    debug(`${prefix} ${JSON.stringify(scrub).substring(0, 2000)}`);
  } catch (e) {
    debug(`${prefix} <unserializable>`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatToolsForPrompt(tools) {
  if (!tools || !tools.length) return '';
  
  const lines = [];
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    
    const fdef = tool.function || {};
    const name = fdef.name || 'unknown';
    const desc = fdef.description || '';
    const params = fdef.parameters || {};
    
    const toolDesc = [`- ${name}: ${desc}`];
    const props = params.properties || {};
    const required = new Set(params.required || []);
    
    for (const [pname, pinfo] of Object.entries(props)) {
      const ptype = pinfo.type || 'any';
      const pdesc = pinfo.description || '';
      const req = required.has(pname) ? ' (required)' : ' (optional)';
      toolDesc.push(`  - ${pname} (${ptype})${req}: ${pdesc}`);
    }
    lines.push(toolDesc.join('\n'));
  }
  
  if (!lines.length) return '';
  
  return (
    '\n\n可用的工具函数:\n' + lines.join('\n') +
    '\n\n如果需要调用工具，请仅用以下 JSON 结构回复（不要包含多余文本）:\n' +
    '```json\n' +
    '{\n' +
    '  "tool_calls": [\n' +
    '    {\n' +
    '      "id": "call_xxx",\n' +
    '      "type": "function",\n' +
    '      "function": {\n' +
    '        "name": "function_name",\n' +
    '        "arguments": "{\\"param1\\": \\"value1\\"}"\n' +
    '      }\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    '```\n'
  );
}

function contentToStr(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string') {
        parts.push(p);
      } else if (p.type === 'text') {
        parts.push(p.text || '');
      }
    }
    return parts.join(' ');
  }
  return '';
}

function appendTextToContent(orig, extra) {
  if (typeof orig === 'string') {
    return orig + extra;
  }
  if (Array.isArray(orig)) {
    const newc = [...orig];
    if (newc.length > 0 && newc[newc.length - 1].type === 'text') {
      newc[newc.length - 1].text = (newc[newc.length - 1].text || '') + extra;
    } else {
      newc.push({ type: 'text', text: extra });
    }
    return newc;
  }
  return extra;
}

function processMessagesWithTools(messages, tools, toolChoice) {
  const processed = [];
  
  if (tools && CONFIG.FUNCTION_CALL_ENABLED && toolChoice !== 'none') {
    const toolsPrompt = formatToolsForPrompt(tools);
    const hasSystem = messages.some(m => m.role === 'system');
    
    if (hasSystem) {
      for (const m of messages) {
        if (m.role === 'system') {
          processed.push({
            ...m,
            content: appendTextToContent(m.content, toolsPrompt)
          });
        } else {
          processed.push(m);
        }
      }
    } else {
      processed.push({ role: 'system', content: '你是一个有用的助手。' + toolsPrompt });
      processed.push(...messages);
    }
    
    if (toolChoice === 'required' || toolChoice === 'auto') {
      const lastUser = processed[processed.length - 1];
      if (lastUser && lastUser.role === 'user') {
        lastUser.content = appendTextToContent(lastUser.content, '\n\n请根据需要使用提供的工具函数。');
      }
    } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
      const fname = toolChoice.function?.name;
      if (fname) {
        const lastUser = processed[processed.length - 1];
        if (lastUser && lastUser.role === 'user') {
          lastUser.content = appendTextToContent(lastUser.content, `\n\n请使用 ${fname} 函数来处理这个请求。`);
        }
      }
    }
  } else {
    processed.push(...messages);
  }
  
  const finalMsgs = [];
  for (const m of processed) {
    const role = m.role;
    if (role === 'tool' || role === 'function') {
      const toolName = m.name || 'unknown';
      const toolContent = contentToStr(m.content || '');
      finalMsgs.push({
        role: 'assistant',
        content: `工具 ${toolName} 返回结果:\n\`\`\`json\n${toolContent}\n\`\`\``,
      });
    } else {
      const mm = { ...m };
      if (Array.isArray(mm.content)) {
        mm.content = contentToStr(mm.content);
      }
      finalMsgs.push(mm);
    }
  }
  
  return finalMsgs;
}

// ==============================
// 思考链清洗 
// ==============================
// 全局变量跟踪阶段状态，用于处理thinking截断问题
let phaseBak = "thinking";

function extractContentFromSSE(data, modelId) {
  const d = data.data || {};
  const phase = d.phase;
  const delta = d.delta_content || '';
  const edit = d.edit_content || '';
  const content = delta || edit;
  
  // 如果没有内容，直接返回
  if (!content) {
    return null;
  }
  
  // 获取模型的思考能力
  const modelInfo = MODEL_CAPABILITIES[modelId] || { hasThinking: false };
  
  // 如果模型不支持思考，直接返回内容
  if (!modelInfo.hasThinking) {
    return { role: 'assistant', content: content };
  }
  
  // 对支持思考的模型进行处理
  let processed = content;
  const contentBak = content;
  
  // 根据phase和内容进行特殊处理
  if (phase === 'thinking' || (phase === 'answer' && content.includes('summary>'))) {
    // 移除 <details> 标签及其内容（针对思考链）
    processed = processed.replace(/<details[^>]*>[\s\S]*?<\/details>/g, '');
    
    // 清理残留自定义标签
    processed = processed.replace(/<\/thinking>/g, '');
    processed = processed.replace(/<Full>/g, '');
    processed = processed.replace(/<\/Full>/g, '');
    
    if (phase === 'thinking') {
      // 清理 summary 标签
      processed = processed.replace(/\n*<summary>[\s\S]*?<\/summary>\n*/g, '\n\n');
    }
    
    // 以 <reasoning> 为基底
    processed = processed.replace(/<details[^>]*>\n*/g, '<reasoning>\n\n');
    processed = processed.replace(/\n*<\/details>/g, '\n\n</reasoning>');
    
    if (phase === 'answer') {
      // 判断 </reasoning> 后是否有内容
      const match = processed.match(/^(.*?<\/reasoning>)(.*)$/s);
      if (match) {
        const [, before, after] = match;
        if (after.trim()) {
          // </reasoning> 后有内容
          if (phaseBak === 'thinking') {
            // 思考休止 → 结束思考，加上回答
            processed = `\n\n</reasoning>\n\n${after.replace(/^\n+/, '')}`;
          } else if (phaseBak === 'answer') {
            // 回答休止 → 清除所有
            processed = '';
          }
        } else {
          // 思考休止 → </reasoning> 后无内容
          processed = '\n\n</reasoning>';
        }
      }
    }
  }
  
  // 处理行前缀 "> "（仅在thinking阶段）
  if (phase === 'thinking') {
    processed = processed.replace(/^>\s*/gm, '');
    processed = processed.replace(/\n>/g, '\n');
  }
  
  // 根据 THINK_TAGS_MODE 和 phase 处理
  if (CONFIG.THINK_TAGS_MODE === 'reasoning') {
    // reasoning 模式：thinking阶段返回reasoning_content
    if (phase === 'thinking') processed = processed.replace(/\n>\s?/g, '\n');
    processed = processed.replace(/\n*<summary>[\s\S]*?<\/summary>\n*/g, '');
    processed = processed.replace(/<reasoning>\n*/g, '');
    processed = processed.replace(/\n*<\/reasoning>/g, '');
    
    // 更新阶段状态
    phaseBak = phase;
    
    if (phase === 'thinking') {
      return { role: 'assistant', reasoning_content: processed };
    } else {
      return { role: 'assistant', content: processed };
    }
  } else if (CONFIG.THINK_TAGS_MODE === 'think') {
    // think 模式：thinking阶段返回reasoning_content
    if (phase === 'thinking') processed = processed.replace(/\n>\s?/g, '\n');
    processed = processed.replace(/\n*<summary>[\s\S]*?<\/summary>\n*/g, '');
    processed = processed.replace(/<reasoning>/g, '<think>');
    processed = processed.replace(/<\/reasoning>/g, '</think>');
    
    // 更新阶段状态
    phaseBak = phase;
    
    if (phase === 'thinking') {
      return { role: 'assistant', reasoning_content: processed };
    } else {
      return { role: 'assistant', content: processed };
    }
  } else if (CONFIG.THINK_TAGS_MODE === 'strip') {
    // strip 模式：去除所有thinking相关内容，只返回content
    processed = processed.replace(/\n*<summary>[\s\S]*?<\/summary>\n*/g, '');
    processed = processed.replace(/<reasoning>\n*/g, '');
    processed = processed.replace(/<\/reasoning>/g, '');
    
    // 更新阶段状态
    phaseBak = phase;
    
    if (phase === 'thinking') {
      return null; // 跳过thinking内容
    } else {
      return { role: 'assistant', content: processed };
    }
  } else if (CONFIG.THINK_TAGS_MODE === 'details') {
    // details 模式：转换为details标签
    if (phase === 'thinking') processed = processed.replace(/\n>\s?/g, '\n');
    processed = processed.replace(/<reasoning>/g, '<details type="reasoning" open><div>');
    let thoughts = '';
    if (phase === 'answer') {
      // 判断是否有 <summary> 内容
      const summaryMatch = processed.match(/<summary>[\s\S]*?<\/summary>/);
      const durationMatch = processed.match(/duration="(\d+)"/);
      if (summaryMatch) {
        // 有内容 → 直接照搬
        thoughts = `\n\n${summaryMatch[0]}`;
      } else if (durationMatch) {
        // 有内容 → 通过 duration 生成 <summary>
        thoughts = `\n\n<summary>Thought for ${durationMatch[1]} seconds</summary>`;
      }
    }
    processed = processed.replace(/<\/reasoning>/g, `</div>${thoughts}</details>`);
    
    // 更新阶段状态
    phaseBak = phase;
    
    return { role: 'assistant', content: processed };
  } else {
    // 默认模式
    processed = processed.replace(/<\/reasoning>/g, '</reasoning>\n\n');
    
    // 更新阶段状态
    phaseBak = phase;
    
    if (phase === 'thinking') {
      return { role: 'assistant', reasoning_content: processed };
    } else {
      return { role: 'assistant', content: processed };
    }
  }
}

// ==============================
// 工具调用提取
// ==============================
const JSON_FENCE = /```json\s*(\{[\s\S]*?\})\s*```/g;
const JSON_INLINE = /(\{[^{}]{0,10000}\"tool_calls\"[\s\S]*?\})/g;
const FUNC_LINE = /调用函数\s*[：:]\s*([\w\-\.]+)\s*(?:参数|arguments)[：:]\s*(\{[\s\S]*?\})/g;

function tryExtractToolCalls(text) {
  if (!text) return null;
  
  const sample = text.substring(0, CONFIG.MAX_JSON_SCAN);
  
  // 尝试从代码块中提取
  const fences = [...sample.matchAll(JSON_FENCE)];
  for (const match of fences) {
    try {
      const data = JSON.parse(match[1]);
      if (data.tool_calls && Array.isArray(data.tool_calls)) {
        return data.tool_calls;
      }
    } catch (e) {
      continue;
    }
  }
  
  // 尝试从内联 JSON 中提取
  const inlineMatch = sample.match(JSON_INLINE);
  if (inlineMatch) {
    try {
      const data = JSON.parse(inlineMatch[1]);
      if (data.tool_calls && Array.isArray(data.tool_calls)) {
        return data.tool_calls;
      }
    } catch (e) {
      // 忽略错误
    }
  }
  
  // 尝试从函数调用格式中提取
  const funcMatch = sample.match(FUNC_LINE);
  if (funcMatch) {
    const fname = funcMatch[1].trim();
    const args = funcMatch[2].trim();
    try {
      JSON.parse(args);
      return [{
        id: nowNsId('call'),
        type: 'function',
        function: { name: fname, arguments: args },
      }];
    } catch (e) {
      return null;
    }
  }
  
  return null;
}

function stripToolJsonFromText(text) {
  let new_text = text.replace(JSON_FENCE, (match, block) => {
    try {
      const data = JSON.parse(block);
      return data.tool_calls ? '' : match;
    } catch (e) {
      return match;
    }
  });
  
  new_text = new_text.replace(JSON_INLINE, '');
  return new_text.trim();
}

// ==============================
// HTTP 请求处理
// ==============================
async function getToken() {
  if (!CONFIG.ANON_TOKEN_ENABLED) {
    return CONFIG.UPSTREAM_TOKEN;
  }
  
  const url = `${CONFIG.API_BASE}/api/v1/auths/`;
  
  for (let i = 0; i <= CONFIG.RETRY_COUNT; i++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(CONFIG.TOKEN_TIMEOUT * 1000),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      const token = data.token;
      if (token) {
        debug(`匿名 token 获取成功 (前10位): ${token.substring(0, 10)}...`);
        return token;
      }
    } catch (e) {
      debug(`匿名 token 获取失败[${i + 1}/${CONFIG.RETRY_COUNT + 1}]: ${e.message}`);
      if (i < CONFIG.RETRY_COUNT) {
        await sleep(CONFIG.RETRY_BACKOFF * 1000 * (i + 1));
      }
    }
  }
  
  return CONFIG.UPSTREAM_TOKEN;
}

async function callUpstreamChat(data, chatId) {
  const token = await getToken();
  const headers = {
    ...BROWSER_HEADERS,
    'Authorization': `Bearer ${token}`,
    'Referer': `${CONFIG.API_BASE}/c/${chatId}`,
    'Content-Type': 'application/json',
  };
  
  safeLogJson('上游请求体:', data);
  const url = `${CONFIG.API_BASE}/api/chat/completions`;
  
  for (let i = 0; i <= CONFIG.RETRY_COUNT; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(CONFIG.HTTP_READ_TIMEOUT * 1000),
      });
      
      if (response.status >= 200 && response.status < 300) {
        return response;
      } else {
        throw new Error(`Upstream HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (e) {
      debug(`上游调用失败[${i + 1}/${CONFIG.RETRY_COUNT + 1}]: ${e.message}`);
      if (i < CONFIG.RETRY_COUNT) {
        await sleep(CONFIG.RETRY_BACKOFF * 1000 * (i + 1));
      } else {
        throw e;
      }
    }
  }
  
  throw new Error('上游调用失败（重试耗尽）');
}

async function* parseUpstreamSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line || !line.startsWith('data: ')) continue;
      
      try {
        const data = JSON.parse(line.substring(6));
        yield data;
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
  
  // 处理剩余的缓冲区
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.substring(6));
        yield data;
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}

// ==============================
// 路由处理
// ==============================
async function handleHome() {
  try {
    // 获取模型列表
    const modelsResponse = await handleModels();
    const modelsData = await modelsResponse.json();
    
    // 统计请求记录
    const totalRequests = requestLogs.length;
    const successRequests = requestLogs.filter(log => log.status >= 200 && log.status < 300).length;
    const errorRequests = requestLogs.filter(log => log.status >= 400).length;
    
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Z.ai API 代理状态</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 30px;
        }
        h1 {
            color: #2c3e50;
            margin-bottom: 30px;
            text-align: center;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .status-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 6px;
            border-left: 4px solid #007bff;
        }
        .status-card h3 {
            margin: 0 0 10px 0;
            color: #495057;
        }
        .status-card .value {
            font-size: 24px;
            font-weight: bold;
            color: #007bff;
        }
        .section {
            margin-bottom: 30px;
        }
        .section h2 {
            color: #2c3e50;
            border-bottom: 2px solid #007bff;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .models-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
        }
        .model-card {
            background: #fff;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            padding: 15px;
            transition: transform 0.2s;
        }
        .model-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        }
        .model-name {
            font-weight: bold;
            color: #495057;
            margin-bottom: 5px;
        }
        .model-id {
            font-family: monospace;
            color: #6c757d;
            font-size: 0.9em;
        }
        .logs-table {
            width: 100%;
            border-collapse: collapse;
            background: white;
        }
        .logs-table th,
        .logs-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #dee2e6;
        }
        .logs-table th {
            background-color: #f8f9fa;
            font-weight: 600;
            color: #495057;
        }
        .status-success {
            color: #28a745;
        }
        .status-error {
            color: #dc3545;
        }
        .status-info {
            color: #17a2b8;
        }
        .timestamp {
            font-family: monospace;
            font-size: 0.9em;
            color: #6c757d;
        }
        .api-endpoints {
            background: #e9ecef;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        .api-endpoints code {
            background: #fff;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Z.ai API 代理状态面板</h1>
        
        <div class="status-grid">
            <div class="status-card">
                <h3>总请求数</h3>
                <div class="value">${totalRequests}</div>
            </div>
            <div class="status-card">
                <h3>成功请求</h3>
                <div class="value status-success">${successRequests}</div>
            </div>
            <div class="status-card">
                <h3>错误请求</h3>
                <div class="value status-error">${errorRequests}</div>
            </div>
            <div class="status-card">
                <h3>可用模型</h3>
                <div class="value">${modelsData.data ? modelsData.data.length : 0}</div>
            </div>
        </div>

        <div class="section">
            <h2>API 端点</h2>
            <div class="api-endpoints">
                <p><strong>健康检查:</strong> <code>GET /healthz</code></p>
                <p><strong>模型列表:</strong> <code>GET /v1/models</code></p>
                <p><strong>聊天完成:</strong> <code>POST /v1/chat/completions</code></p>
            </div>
        </div>

        <div class="section">
            <h2>支持的模型 (${modelsData.data ? modelsData.data.length : 0})</h2>
            <div class="models-grid">
                ${modelsData.data ? modelsData.data.map(model => `
                    <div class="model-card">
                        <div class="model-name">${model.name}</div>
                        <div class="model-id">${model.id}</div>
                    </div>
                `).join('') : '<p>无法获取模型列表</p>'}
            </div>
        </div>

        <div class="section">
            <h2>最近请求记录 (最近${Math.min(requestLogs.length, MAX_LOGS)}条)</h2>
            <table class="logs-table">
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>接口</th>
                        <th>方法</th>
                        <th>状态</th>
                        <th>用户代理</th>
                    </tr>
                </thead>
                <tbody>
                    ${requestLogs.map(log => {
                      const apiNames = {
                        '/healthz': '健康检查',
                        '/v1/models': '模型列表',
                        '/v1/chat/completions': '聊天完成'
                      };
                      const apiName = apiNames[log.path] || log.path;
                      
                      return `
                        <tr>
                            <td class="timestamp">${new Date(log.timestamp).toLocaleString('zh-CN')}</td>
                            <td><code>${apiName}</code></td>
                            <td>${log.method}</td>
                            <td class="${log.status >= 200 && log.status < 300 ? 'status-success' : log.status >= 400 ? 'status-error' : 'status-info'}">${log.status}</td>
                            <td>${log.userAgent.substring(0, 50)}${log.userAgent.length > 50 ? '...' : ''}</td>
                        </tr>
                      `;
                    }).join('') || '<tr><td colspan="5">暂无 API 请求记录</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
    
    const response = new Response(html, { status: 200 });
    response.headers.set('Content-Type', 'text/html; charset=utf-8');
    return setCORS(response);
  } catch (e) {
    debug('状态页面生成失败: %s', e.message);
    const errorHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>Z.ai API 代理状态 - 错误</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .error { color: #dc3545; background: #f8d7da; padding: 20px; border-radius: 6px; }
    </style>
</head>
<body>
    <div class="error">
        <h1>状态页面生成失败</h1>
        <p>错误信息: ${e.message}</p>
    </div>
</body>
</html>`;
    
    const response = new Response(errorHtml, { status: 500 });
    response.headers.set('Content-Type', 'text/html; charset=utf-8');
    return setCORS(response);
  }
}

async function handleHealthz() {
  const response = new Response('ok', { status: 200 });
  response.headers.set('Content-Type', 'text/plain; charset=utf-8');
  return setCORS(response);
}

async function handleModels() {
  // 模型名称格式化函数 (与app.py一致)
  function formatModelName(name) {
    if (!name) return '';
    const parts = name.split('-');
    if (parts.length === 1) {
      return parts[0].toUpperCase();
    }
    const formatted = [parts[0].toUpperCase()];
    for (const p of parts.slice(1)) {
      if (!p) {
        formatted.push('');
      } else if (/^\d+$/.test(p)) {
        formatted.push(p);
      } else if (/[a-zA-Z]/.test(p)) {
        formatted.push(p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
      } else {
        formatted.push(p);
      }
    }
    return formatted.join('-');
  }

  function isEnglishLetter(ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
  }

  // 动态获取模型列表 (与app.py完全一致)
  try {
    const token = await getToken();
    const headers = {
      ...BROWSER_HEADERS,
      'Authorization': `Bearer ${token}`,
    };
    
    const response = await fetch(`${CONFIG.API_BASE}/api/models`, {
      method: 'GET',
      headers: headers,
      signal: AbortSignal.timeout(CONFIG.TOKEN_TIMEOUT * 1000),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const modelsOut = [];
    
    // 处理模型列表 (与app.py逻辑完全一致)
    for (const model of data.data || []) {
      if (model.info?.is_active === false) continue;
      
      const modelId = model.id;
      let modelName = model.name;
      
      // 使用app.py的模型名称处理逻辑
      if (modelId.startsWith('GLM') || modelId.startsWith('Z')) {
        modelName = modelId;
      }
      if (!modelName || !isEnglishLetter(modelName[0])) {
        modelName = formatModelName(modelId);
      }
      
      modelsOut.push({
        id: modelId,
        object: 'model',
        name: modelName,
        created: model.info?.created_at || Math.floor(Date.now() / 1000),
        owned_by: 'z.ai'
      });
    }
    
    const result = {
      object: 'list',
      data: modelsOut,
    };
    
    const resp = new Response(JSON.stringify(result), { status: 200 });
    resp.headers.set('Content-Type', 'application/json; charset=utf-8');
    return setCORS(resp);
  } catch (e) {
    debug('获取模型列表失败: %s', e.message);
    // 返回静态模型列表作为后备 (使用MODEL_CAPABILITIES)
    const fallbackModels = Object.entries(MODEL_CAPABILITIES).map(([id, info]) => ({
      id,
      object: 'model',
      name: info.name,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'z.ai'
    }));
    
    const result = {
      object: 'list',
      data: fallbackModels,
    };
    
    const resp = new Response(JSON.stringify(result), { status: 200 });
    resp.headers.set('Content-Type', 'application/json; charset=utf-8');
    return setCORS(resp);
  }
}

async function handleChat(request) {
  const req = await request.json();
  const chatId = nowNsId('chat');
  const msgId = nowNsId('msg');
  const model = req.model || CONFIG.DEFAULT_MODEL;
  
  const tools = req.tools || [];
  const toolChoice = req.tool_choice;
  const messages = req.messages || [];
  const stream = req.stream || false;
  const includeUsage = stream && req.stream_options?.include_usage;
  
  // 处理图片上传
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const contentItem of message.content) {
        if (contentItem.type === 'image_url') {
          const url = contentItem.image_url?.url || '';
          if (url.startsWith('data:')) {
            const fileUrl = await uploadImage(url, chatId);
            if (fileUrl) {
              contentItem.image_url.url = fileUrl;
            }
          }
        }
      }
    }
  }
  
  const processedMessages = processMessagesWithTools(messages, tools, toolChoice);
  
  // 检查模型是否支持思考
  const modelInfo = MODEL_CAPABILITIES[model] || { hasThinking: false };
  
  const upstreamData = {
    stream: true, // 总是使用流式
    chat_id: chatId,
    id: msgId,
    model: model,
    messages: processedMessages,
    features: { enable_thinking: modelInfo.hasThinking },
    ...Object.fromEntries(
      ['temperature', 'top_p', 'max_tokens']
        .filter(key => key in req)
        .map(key => [key, req[key]])
    ),
  };
  const createdTs = Math.floor(Date.now() / 1000);
  
  // 流式响应
  if (req.stream) {
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const upstream = await callUpstreamChat(upstreamData, chatId);
          let lastPing = Date.now();
          let accContent = '';
          let toolCalls = null;
          const bufferingOnly = CONFIG.FUNCTION_CALL_ENABLED && tools.length > 0;
          
          // 首块：role
          const firstChunk = {
            id: nowNsId('chatcmpl'),
            object: 'chat.completion.chunk',
            created: createdTs,
            model: model,
            choices: [{ index: 0, delta: { role: 'assistant' } }],
          };
          
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
          
          // 计算prompt tokens
          let promptTokens = 0;
          for (const msg of messages) {
            if (typeof msg.content === 'string') {
              promptTokens += countTokens(msg.content);
            } else if (Array.isArray(msg.content)) {
              for (const item of msg.content) {
                if (item.type === 'text') {
                  promptTokens += countTokens(item.text || '');
                }
              }
            }
          }
          
          let completionStr = '';
          let reasoningStr = '';
          
          for await (const data of parseUpstreamSSE(upstream)) {
            if (Date.now() - lastPing >= CONFIG.SSE_HEARTBEAT_SECONDS * 1000) {
              controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
              lastPing = Date.now();
            }
            
            if (data.data?.done) {
              let finish = 'stop';
              
              if (bufferingOnly) {
                toolCalls = tryExtractToolCalls(accContent);
                if (toolCalls) {
                  const out = {
                    id: nowNsId('chatcmpl'),
                    object: 'chat.completion.chunk',
                    created: createdTs,
                    model: model,
                    choices: [{ index: 0, delta: { tool_calls: [] } }],
                  };
                  
                  for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    out.choices[0].delta.tool_calls.push({
                      index: i,
                      id: tc.id,
                      type: tc.type || 'function',
                      function: tc.function || {},
                    });
                  }
                  
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(out)}\n\n`));
                  finish = 'tool_calls';
                } else {
                  const trimmed = stripToolJsonFromText(accContent);
                  if (trimmed) {
                    const chunk = {
                      id: nowNsId('chatcmpl'),
                      object: 'chat.completion.chunk',
                      created: createdTs,
                      model: model,
                      choices: [{ index: 0, delta: { content: trimmed } }],
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                  finish = 'stop';
                }
              } else {
                finish = 'stop';
              }
              
              const tail = {
                id: nowNsId('chatcmpl'),
                object: 'chat.completion.chunk',
                created: createdTs,
                model: model,
                choices: [{ index: 0, delta: {}, finish_reason: finish }],
              };
              
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tail)}\n\n`));
              
              // 如果需要usage统计
              if (includeUsage) {
                const completionTokens = countTokens(completionStr + reasoningStr);
                const usageChunk = {
                  id: nowNsId('chatcmpl'),
                  object: 'chat.completion.chunk',
                  created: createdTs,
                  model: model,
                  choices: [],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens
                  }
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
              }
              
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            
            const deltaObj = extractContentFromSSE(data, model);
            if (!deltaObj) continue;
            
            if (bufferingOnly) {
              if (deltaObj.content) {
                accContent += deltaObj.content;
              }
              if (deltaObj.reasoning_content) {
                accContent += deltaObj.reasoning_content;
              }
            } else {
              const chunk = {
                id: nowNsId('chatcmpl'),
                object: 'chat.completion.chunk',
                created: createdTs,
                model: model,
                choices: [{ index: 0, delta: deltaObj }],
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
              
              // 累计内容用于token计算
              if (deltaObj.content) {
                completionStr += deltaObj.content;
              }
              if (deltaObj.reasoning_content) {
                reasoningStr += deltaObj.reasoning_content;
              }
            }
          }
        } catch (e) {
          debug('流式响应错误: %s', e.message);
          controller.error(e);
        }
      },
    });
    
    const response = new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
    
    return setCORS(response);
  }
  
  // 非流式响应
  const upstream = await callUpstreamChat(upstreamData, chatId);
  const contents = {
    content: [],
    reasoning_content: []
  };
  
  // 计算prompt tokens
  let promptTokens = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      promptTokens += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          promptTokens += countTokens(item.text || '');
        }
      }
    }
  }
  
  for await (const data of parseUpstreamSSE(upstream)) {
    if (data.data?.done) break;
    const deltaObj = extractContentFromSSE(data, model);
    if (deltaObj) {
      if (deltaObj.content) {
        contents.content.push(deltaObj.content);
      }
      if (deltaObj.reasoning_content) {
        contents.reasoning_content.push(deltaObj.reasoning_content);
      }
    }
  }
  
  // 构建最终消息内容
  const finalMessage = { role: 'assistant' };
  let completionStr = '';
  
  if (contents.reasoning_content.length > 0) {
    finalMessage.reasoning_content = contents.reasoning_content.join('');
    completionStr += finalMessage.reasoning_content;
  }
  if (contents.content.length > 0) {
    finalMessage.content = contents.content.join('');
    completionStr += finalMessage.content;
  }
  
  let toolCalls = null;
  let finishReason = 'stop';
  
  if (CONFIG.FUNCTION_CALL_ENABLED && tools.length > 0) {
    toolCalls = tryExtractToolCalls(completionStr);
    if (toolCalls) {
      finalMessage.content = stripToolJsonFromText(finalMessage.content || '');
      finishReason = 'tool_calls';
    }
  }
  
  if (toolCalls) {
    finalMessage.tool_calls = toolCalls;
    if (!finalMessage.content) {
      finalMessage.content = null;
    }
  }
  
  const completionTokens = countTokens(completionStr);
  
  const respBody = {
    id: nowNsId('chatcmpl'),
    object: 'chat.completion',
    created: createdTs,
    model: model,
    choices: [{ index: 0, message: finalMessage, finish_reason: finishReason }],
    usage: { 
      prompt_tokens: promptTokens, 
      completion_tokens: completionTokens, 
      total_tokens: promptTokens + completionTokens 
    },
  };
  
  const response = new Response(JSON.stringify(respBody), { status: 200 });
  response.headers.set('Content-Type', 'application/json; charset=utf-8');
  return setCORS(response);
}

// ==============================
// Workers 入口
// ==============================
export default {
  async fetch(request, _env, _ctx) {
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'Unknown';
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      const response = new Response(null, { status: 204 });
      return setCORS(response);
    }
    
    let response;
    let status = 500;
    
    try {
      // 路由分发
      if (url.pathname === '/' || url.pathname === '') {
        response = await handleHome();
        status = 200;
      } else if (url.pathname === '/healthz') {
        response = await handleHealthz();
        status = 200;
      } else if (url.pathname === '/v1/models') {
        response = await handleModels();
        status = response.status;
      } else if (url.pathname === '/v1/chat/completions') {
        response = await handleChat(request);
        status = response.status;
      } else {
        response = new Response('Not Found', { status: 404 });
        status = 404;
      }
      
      // 记录请求（排除状态页面本身的请求）
      if (url.pathname !== '/' && url.pathname !== '') {
        addRequestLog(url.pathname, request.method, status, userAgent, clientIP);
      }
      
      return response;
    } catch (e) {
      debug('请求处理错误: %s', e.message);
      response = new Response(`Internal Server Error: ${e.message}`, { status: 500 });
      status = 500;
      
      // 记录错误请求
      if (url.pathname !== '/' && url.pathname !== '') {
        addRequestLog(url.pathname, request.method, status, userAgent, clientIP);
      }
      
      response.headers.set('Content-Type', 'text/plain; charset=utf-8');
      return setCORS(response);
    }
  },
};