'use strict';

/**
 * Windows SAPI 文本转语音兜底实现（POST /api/tts）。
 *
 * 通过 PowerShell 调用 System.Speech.Synthesis.SpeechSynthesizer，
 * 优先选择中文语音（如 Microsoft Huihui Desktop），合成 wav 后回传。
 *
 * 说明：
 *  - 该接口是浏览器 speechSynthesis 无中文语音时的兜底，允许失败；
 *  - 文本超过 500 字截断，避免一次合成过久；
 *  - 非 Windows 平台 / 未安装语音时抛出中文错误，由路由层转成 500。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TEXT_LENGTH = 500;
const TIMEOUT_MS = 30000;
const TMP_DIR = path.join(os.tmpdir(), 'epub-player-tts');

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try {',
  "  $zh = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
  '  if ($env:EPUB_TTS_VOICE) { $synth.SelectVoice($env:EPUB_TTS_VOICE) } elseif ($zh) { try { $synth.SelectVoice($zh.VoiceInfo.Name) } catch {} }',
  '  $rate = 0',
  '  if ($env:EPUB_TTS_RATE) { try { $rate = [int]$env:EPUB_TTS_RATE } catch { $rate = 0 } }',
  '  if ($rate -lt -10) { $rate = -10 }',
  '  if ($rate -gt 10) { $rate = 10 }',
  '  $synth.Rate = $rate',
  '  $text = [System.IO.File]::ReadAllText($env:EPUB_TTS_TEXT_FILE, [System.Text.Encoding]::UTF8)',
  "  if ([string]::IsNullOrWhiteSpace($text)) { throw 'TTS text is empty' }",
  '  $synth.SetOutputToWaveFile($env:EPUB_TTS_WAV_FILE)',
  '  $synth.Speak($text)',
  '} finally {',
  '  try { $synth.Dispose() } catch {}',
  '}',
  ''
].join('\r\n');

function truncateText(text) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  if (chars.length <= MAX_TEXT_LENGTH) return chars.join('');
  return chars.slice(0, MAX_TEXT_LENGTH).join('');
}

/** speechSynthesis 的 rate（0.1~3，1 为正常）映射到 SAPI 的 -10~10。 */
function toSapiRate(rate) {
  const numeric = Number(rate);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = Math.min(Math.max(numeric, 0.1), 3);
  return Math.max(-10, Math.min(10, Math.round((normalized - 1) * 5)));
}

function writeScriptIfNeeded() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const scriptPath = path.join(TMP_DIR, 'sapi-tts.ps1');
  const existing = (() => {
    try {
      return fs.readFileSync(scriptPath, 'utf8');
    } catch {
      return null;
    }
  })();
  if (existing !== PS_SCRIPT) fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');
  return scriptPath;
}

function runPowerShell(scriptPath, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        env
      });
    } catch (error) {
      reject(new Error(`无法启动 PowerShell：${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      reject(new Error('语音合成超时（30 秒）'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new Error('未找到 PowerShell，无法使用系统语音合成'));
      else reject(new Error(`语音合成进程启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`语音合成失败（退出码 ${code}）：${(stderr || stdout).trim().slice(0, 500) || '未知错误'}`));
    });
  });
}

/**
 * 合成一段文本为 wav。
 * @param {string} text
 * @param {number|string} [rate]
 * @returns {Promise<Buffer>} wav 字节
 */
async function synthesize(text, rate, voiceName) {
  if (process.platform !== 'win32') {
    throw new Error('当前平台不支持系统语音合成（仅 Windows SAPI 可用）');
  }
  const safeText = truncateText(text);
  if (!safeText) throw new Error('朗读文本为空');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const scriptPath = writeScriptIfNeeded();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const textFile = path.join(TMP_DIR, `${token}.txt`);
  const wavFile = path.join(TMP_DIR, `${token}.wav`);
  fs.writeFileSync(textFile, safeText, 'utf8');
  try {
    const env = {
      ...process.env,
      EPUB_TTS_TEXT_FILE: textFile,
      EPUB_TTS_WAV_FILE: wavFile,
      EPUB_TTS_RATE: String(toSapiRate(rate)),
      EPUB_TTS_VOICE: typeof voiceName==='string' ? voiceName : ''
    };
    await runPowerShell(scriptPath, env, TIMEOUT_MS);
    let wav;
    try {
      wav = fs.readFileSync(wavFile);
    } catch {
      throw new Error('语音合成未生成音频文件（系统可能未安装可用语音）');
    }
    if (!wav || wav.length <= 44) {
      throw new Error('语音合成结果为空（系统可能未安装可用语音）');
    }
    return wav;
  } finally {
    for (const file of [textFile, wavFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 忽略 */
      }
    }
  }
}

let voiceCache=null,voiceCacheTime=0;
async function listVoices(){
  if(process.platform!=='win32')return [];
  if(voiceCache&&Date.now()-voiceCacheTime<60000)return voiceCache;
  fs.mkdirSync(TMP_DIR,{recursive:true});const script=path.join(TMP_DIR,'sapi-list.ps1');
  fs.writeFileSync(script,"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\nAdd-Type -AssemblyName System.Speech\r\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\r\ntry { $items = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [PSCustomObject]@{ voiceURI=('pc:'+$_.VoiceInfo.Name); name=('PC system - '+$_.VoiceInfo.Name+' (PC online)'); lang=$_.VoiceInfo.Culture.Name; source='desktop-linked' } }); ConvertTo-Json -InputObject $items -Compress } finally { $s.Dispose() }",'utf8');
  const result=await runPowerShell(script,{...process.env},15000);voiceCache=JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim()||'[]');if(!Array.isArray(voiceCache))voiceCache=[voiceCache];voiceCacheTime=Date.now();return voiceCache;
}
module.exports = { listVoices, synthesize, truncateText, toSapiRate, MAX_TEXT_LENGTH };
