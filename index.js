/**
 * 极简网页代理（零依赖，Node 18+）
 * 用法：部署后打开站点，输入网址即可浏览
 * 路由：
 *   GET  /                 首页（输入框）
 *   GET  /p?url=<目标>      抓取并改写页面
 *   GET  /raw?url=<目标>    原样返回（图片/JS/CSS）
 *   GET  /health           健康检查
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 10000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const HOME = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>网页代理</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.box{width:min(680px,92vw)}h1{font-size:22px;margin:0 0 6px}p{color:#8b93a1;margin:0 0 18px;font-size:13px}
form{display:flex;gap:8px}input{flex:1;padding:12px 14px;border-radius:8px;border:1px solid #2a2f3a;
background:#151922;color:#e6e6e6;font-size:15px;outline:none}input:focus{border-color:#4c7dff}
button{padding:12px 20px;border:0;border-radius:8px;background:#4c7dff;color:#fff;font-size:15px;cursor:pointer}
button:hover{background:#3d68e0}.tip{margin-top:14px;color:#5c6472;font-size:12px}
</style></head><body><div class="box">
<h1>网页代理</h1><p>输入网址，服务器代你抓取（出口在美国）</p>
<form action="/p" method="get"><input name="url" placeholder="https://example.com" autofocus>
<button type="submit">打开</button></form>
<div class="tip">支持 http / https。需要登录的站点不可用。</div>
</div></body></html>`;

function abs(base, rel) {
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

function rewriteHtml(html, target) {
  const base = target;
  const prox = (u) => '/p?url=' + encodeURIComponent(abs(base, u));
  const proxRaw = (u) => '/raw?url=' + encodeURIComponent(abs(base, u));

  // 去掉会拦住代理的头部声明
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/<base[^>]*>/gi, '');

  html = html.replace(/(href|src|poster)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
    if (!val || /^(#|data:|javascript:|mailto:|tel:)/i.test(val)) return m;
    const fn = attr.toLowerCase() === 'href' ? prox : proxRaw;
    return `${attr}=${q}${fn(val)}${q}`;
  });

  // 资源完整性/跨域属性会让改写后的地址校验失败，直接去掉
  html = html.replace(/\sintegrity\s*=\s*(["']).*?\1/gi, '');
  html = html.replace(/\scrossorigin(\s*=\s*(["']).*?\2)?/gi, '');

  // srcset
  html = html.replace(/srcset\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
    const parts = val.split(',').map((s) => {
      const [u, d] = s.trim().split(/\s+/);
      return proxRaw(u) + (d ? ' ' + d : '');
    });
    return `srcset=${q}${parts.join(',')}${q}`;
  });

  // form 提交也走代理：把 action 换成 /p?url=<目标>，浏览器追加的参数由 /p 处理时合并
  html = html.replace(/<form([^>]*)>/gi, (m, attrs) => {
    const am = /action\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    const act = am ? abs(target, am[2]) : target;
    const cleaned = attrs.replace(/action\s*=\s*(["']).*?\1/gi, '').replace(/method\s*=\s*(["']).*?\1/gi, '');
    return `<form${cleaned} action="/p?url=${encodeURIComponent(act)}" method="get">`;
  });

  // 给页面加一个返回条
  const bar = `<div style="position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#0f1115;
   border-bottom:1px solid #2a2f3a;padding:6px 10px;font:12px/1.4 sans-serif;color:#8b93a1;display:flex;gap:8px">
   <a href="/" style="color:#4c7dff;text-decoration:none">← 回首页</a>
   <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${target}</span></div>
   <div style="height:28px"></div>`;
  return html.replace(/<body([^>]*)>/i, `<body$1>${bar}`);
}

function fetchTarget(target, res, isRaw) {
  target = String(target || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    res.writeHead(400); return res.end('only http/https');
  }

  const client = u.protocol === 'https:' ? https : http;
  const req = client.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: 'GET', timeout: 25000,
    headers: {
      'User-Agent': UA,
      'Accept': isRaw ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': u.origin + '/',
    },
  }, (r) => {
    const enc = (r.headers['content-encoding'] || '').toLowerCase();
    let stream = r;
    if (enc === 'gzip') stream = r.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = r.pipe(zlib.createInflate());
    else if (enc === 'br') stream = r.pipe(zlib.createBrotliDecompress());

    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      const loc = abs(u.toString(), r.headers.location);
      res.writeHead(302, { Location: (isRaw ? '/raw?url=' : '/p?url=') + encodeURIComponent(loc) });
      r.resume(); return res.end();
    }

    const ct = r.headers['content-type'] || '';
    const headers = { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-store' };

    if (!isRaw && /text\/html|application\/xhtml/i.test(ct)) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const out = rewriteHtml(html, u.toString());
        headers['Content-Type'] = 'text/html; charset=utf-8';
        res.writeHead(200, headers); res.end(out);
      });
      stream.on('error', () => { res.writeHead(502); res.end('decode error'); });
      return;
    }

    res.writeHead(r.statusCode || 200, headers);
    stream.pipe(res);
  });

  req.on('timeout', () => { req.destroy(); try { res.writeHead(504); res.end('timeout'); } catch {} });
  req.on('error', (e) => { try { res.writeHead(502); res.end('upstream error: ' + e.message); } catch {} });
  req.end();
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }
  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HOME);
  }
  if (url.pathname === '/p' || url.pathname === '/raw') {
    let target = url.searchParams.get('url');
    if (!target) { res.writeHead(400); return res.end('missing url'); }
    // 把表单额外参数合并到目标地址
    const extra = new URLSearchParams(url.searchParams);
    extra.delete('url');
    const qs = extra.toString();
    if (qs) target += (target.includes('?') ? '&' : '?') + qs;
    return fetchTarget(target, res, url.pathname === '/raw');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
}).listen(PORT, '0.0.0.0', () => console.log('proxy listening on ' + PORT));
