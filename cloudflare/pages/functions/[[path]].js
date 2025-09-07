/**
 * Z.ai API Pages 代理 - 简化版本
 * 只处理 API 路径的代理请求
 */

const WORKER_URL = 'https://zai2api.ytxwz.workers.dev';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  console.log(`收到请求: ${request.method} ${pathname}`);
  
  // 只处理 API 路径，其他路径返回 404
  const isApiPath = pathname.startsWith('/v1/') || pathname === '/healthz';
  
  if (!isApiPath) {
    console.log(`非API路径，返回404: ${pathname}`);
    return new Response('Not Found - 只支持 /healthz 和 /v1/* API 路径', { 
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
  
  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    console.log('处理 CORS 预检请求');
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  try {
    // 构建目标 URL - 直接代理所有路径
    const targetUrl = WORKER_URL + pathname + url.search;
    console.log(`代理到: ${targetUrl}`);
    
    // 复制请求头，过滤掉 Cloudflare 特有的头
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      const lowerKey = key.toLowerCase();
      if (!['host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto'].includes(lowerKey)) {
        headers.set(key, value);
      }
    }
    
    // 确保有 User-Agent
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'Mozilla/5.0 (compatible; Z.ai-API-Proxy/1.0)');
    }
    
    console.log('请求头:', Object.fromEntries(headers));
    
    // 转发请求到 Workers
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
    });
    
    console.log(`收到响应: ${response.status} ${response.statusText}`);
    
    // 检查是否为流式响应（SSE）
    const contentType = response.headers.get('content-type') || '';
    const isSSE = contentType.includes('text/event-stream');
    
    // 复制响应头
    const responseHeaders = new Headers();
    for (const [key, value] of response.headers) {
      responseHeaders.set(key, value);
    }
    
    // 强制设置 CORS 头
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // 如果是SSE流式响应，保持流特性
    if (isSSE) {
      responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      responseHeaders.set('X-Accel-Buffering', 'no');
      console.log('检测到SSE流式响应，保持流特性');
    } else {
      // 确保内容类型正确
      if (!responseHeaders.has('Content-Type')) {
        responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
      }
    }
    
    console.log('响应头:', Object.fromEntries(responseHeaders));
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
    
  } catch (error) {
    console.error('代理请求失败:', error);
    return new Response(JSON.stringify({
      error: {
        message: '代理服务暂时不可用',
        details: error.message,
        worker_url: WORKER_URL,
        request_path: pathname
      }
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
}