// Where the headless checks find Chrome and the repo's Python venv, on Linux and on a Windows laptop.
// CHROME=<path> overrides the browser.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CHROME = process.env.CHROME ?? (WIN
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p))!
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
export const PYTHON = `${ROOT}.venv/${WIN ? 'Scripts/python.exe' : 'bin/python'}`;
