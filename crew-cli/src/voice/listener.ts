import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRouter } from '../agent/router.js';

const execFileAsync = promisify(execFile);

export interface RecorderPlan {
  command: string;
  args: string[];
}

export type RecorderKind = 'sox' | 'ffmpeg-mac' | 'ffmpeg-linux' | 'ffmpeg-windows';

export interface RecordOptions {
  durationSec?: number;
  outputPath?: string;
}

export interface TranscribeOptions {
  provider?: 'auto' | 'openai' | 'whisper-cli';
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

export function selectRecorderPlan(
  platform: NodeJS.Platform,
  hasSox: boolean,
  hasFfmpeg: boolean,
  outputPath: string,
  durationSec: number
): RecorderPlan | null {
  if (hasSox) {
    return {
      command: 'sox',
      args: ['-d', '-c', '1', '-r', '16000', outputPath, 'trim', '0', String(durationSec)]
    };
  }

  if (hasFfmpeg) {
    if (platform === 'darwin') {
      return {
        command: 'ffmpeg',
        args: ['-y', '-f', 'avfoundation', '-i', ':0', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
      };
    }
    if (platform === 'linux') {
      return {
        command: 'ffmpeg',
        args: ['-y', '-f', 'alsa', '-i', 'default', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
      };
    }
    return {
      command: 'ffmpeg',
      args: ['-y', '-f', 'dshow', '-i', 'audio=default', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
    };
  }

  return null;
}

export function selectRecorderStrategy(
  available: { sox: boolean; ffmpeg: boolean },
  platform: NodeJS.Platform = process.platform
): RecorderKind | null {
  if (available.sox) return 'sox';
  if (!available.ffmpeg) return null;
  if (platform === 'darwin') return 'ffmpeg-mac';
  if (platform === 'linux') return 'ffmpeg-linux';
  return 'ffmpeg-windows';
}

export function buildRecorderStrategy(kind: RecorderKind, outputPath: string, durationSec: number): RecorderPlan {
  if (kind === 'sox') {
    return {
      command: 'sox',
      args: ['-d', '-c', '1', '-r', '16000', outputPath, 'trim', '0', String(durationSec)]
    };
  }
  if (kind === 'ffmpeg-mac') {
    return {
      command: 'ffmpeg',
      args: ['-y', '-f', 'avfoundation', '-i', ':0', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
    };
  }
  if (kind === 'ffmpeg-linux') {
    return {
      command: 'ffmpeg',
      args: ['-y', '-f', 'alsa', '-i', 'default', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
    };
  }
  return {
    command: 'ffmpeg',
    args: ['-y', '-f', 'dshow', '-i', 'audio=default', '-t', String(durationSec), '-ac', '1', '-ar', '16000', outputPath]
  };
}

export async function recordAudio(options: RecordOptions = {}): Promise<string> {
  const durationSec = Math.max(1, options.durationSec || 6);
  const outputPath = options.outputPath || join(tmpdir(), `crew-listen-${Date.now()}.wav`);

  const hasSox = await commandExists('sox');
  const hasFfmpeg = await commandExists('ffmpeg');
  const plan = selectRecorderPlan(process.platform, hasSox, hasFfmpeg, outputPath, durationSec);

  if (!plan) {
    throw new Error('No audio recorder found. Install sox or ffmpeg, or use --text.');
  }

  await execFileAsync(plan.command, plan.args, { maxBuffer: 1024 * 1024 * 16 });
  return outputPath;
}

export async function transcribeWithOpenAi(audioPath: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is required for OpenAI Whisper transcription.');
  }

  const audioBuffer = await readFile(audioPath);
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', blob, 'audio.wav');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper API failed (${response.status}): ${body.slice(0, 400)}`);
  }
  const data = await response.json() as any;
  return String(data.text || '').trim();
}

export async function transcribeWithWhisperCli(audioPath: string): Promise<string> {
  if (!(await commandExists('whisper'))) {
    throw new Error('Local whisper CLI is not installed.');
  }

  const outDir = join(tmpdir(), `crew-whisper-${Date.now()}`);
  await execFileAsync('mkdir', ['-p', outDir]);
  await execFileAsync('whisper', [audioPath, '--model', 'base', '--output_format', 'txt', '--output_dir', outDir], {
    maxBuffer: 1024 * 1024 * 16
  });
  const baseName = audioPath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'audio';
  const txtPath = join(outDir, `${baseName}.txt`);
  const text = await readFile(txtPath, 'utf8');
  return text.trim();
}

export async function transcribeAudio(audioPath: string, options: TranscribeOptions = {}): Promise<string> {
  const provider = options.provider || 'auto';

  if (provider === 'openai') {
    return transcribeWithOpenAi(audioPath);
  }
  if (provider === 'whisper-cli') {
    return transcribeWithWhisperCli(audioPath);
  }

  // auto
  if (process.env.OPENAI_API_KEY) {
    try {
      return await transcribeWithOpenAi(audioPath);
    } catch {
      // fallback
    }
  }
  return transcribeWithWhisperCli(audioPath);
}

export async function speakWithSkill(router: AgentRouter, text: string, skill = 'elevenlabs.tts'): Promise<any> {
  return router.callSkill(skill, { text });
}

export async function speakText(router: AgentRouter, text: string, skill = 'elevenlabs.tts'): Promise<any> {
  return speakWithSkill(router, text, skill);
}

export async function appendVoiceTranscript(baseDir: string, role: 'user' | 'assistant', text: string) {
  const path = join(baseDir, '.crew', 'voice-transcript.log');
  await execFileAsync('mkdir', ['-p', join(baseDir, '.crew')]);
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    role,
    text
  });
  await writeFile(path, `${line}\n`, { encoding: 'utf8', flag: 'a' });
}
