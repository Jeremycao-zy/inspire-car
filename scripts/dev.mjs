/**
 * scripts/dev.mjs — 一键起两个进程（Vite 前端 + Node API 服务）
 * 不引入 concurrently，少一个依赖就少一个装不上的风险。
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const procs = [];

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) console.log(prefix + l);
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    console.log(prefix + `进程退出，code=${code}`);
    shutdown(code ?? 0);
  });
  procs.push(p);
  return p;
}

function shutdown(code = 0) {
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const nodeBin = process.execPath;
const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// 前端端口用 WEB_PORT 覆盖（后端读的是 PORT，两者必须分开：
// 之前用 PORT 同时喂给两边，结果后端抢先占了端口，Vite 再启动就冲突退出）。
// 背景：5173 常被本机其它 Vite 项目（如 coal-workbench）长期占用，此时
// Vite 会静默 fallback 到 5174，导致"以为开的是 5173、其实看的是别的端口"，
// 排查起来非常浪费时间。显式指定端口可彻底避免这类歧义。
const WEB_PORT = process.env.WEB_PORT || '5173';
const API_PORT = process.env.PORT || '8787';

run('api', nodeBin, ['server/index.mjs'], '35');
run('web', npm, ['vite', '--host', '127.0.0.1', '--port', WEB_PORT, '--strictPort'], '36');

console.log(`\n  ▸ 前端  http://127.0.0.1:${WEB_PORT}`);
console.log(`  ▸ 接口  http://127.0.0.1:${API_PORT}/api/health\n`);
