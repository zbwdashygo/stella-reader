'use strict';
/** 开发用启动器：清理 Electron 相关环境变量后启动应用 */
const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const appDir = path.join(__dirname, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.ELECTRON_ENABLE_LOGGING;

const child = spawn(electronPath, [appDir], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});
