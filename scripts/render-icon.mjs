import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const svg = fs.readFileSync('assets/icon.svg', 'utf8');
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset='utf-8'>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 256px; height: 256px; overflow: hidden; background: transparent; }
svg { width: 256px; height: 256px; display: block; }
</style>
</head>
<body>
${svg}
</body>
</html>`;

const tmpHtml = path.resolve('assets/temp_icon.html');
fs.writeFileSync(tmpHtml, html, 'utf8');

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outPng = path.resolve('assets/icon.png');
const fileUrl = 'file:///' + tmpHtml.replace(/\\/g, '/');

const args = [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=256,256',
  '--default-background-color=00000000',
  `--screenshot=${outPng}`,
  fileUrl
];

console.log('Rendering icon.svg to icon.png via Edge...');
execFileSync(edge, args);
fs.unlinkSync(tmpHtml);

const outBuf = fs.readFileSync(outPng);
console.log('Generated icon.png size:', outBuf.length);
const width = outBuf.readUInt32BE(16);
const height = outBuf.readUInt32BE(20);
console.log(`Dimensions: ${width}x${height}`);
