import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PipelineMetricsSummary {
  runs: number;
  qaApproved: number;
  qaRejected: number;
  qaRoundsTotal: number;
  contextChunksUsed: number;
  contextCharsSaved: number;
}

export async function loadPipelineMetricsSummary(baseDir: string): Promise<PipelineMetricsSummary> {
  const path = join(baseDir, '.crew', 'pipeline-metrics.jsonl');
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    let runs = 0;
    let qaApproved = 0;
    let qaRejected = 0;
    let qaRoundsTotal = 0;
    let contextChunksUsed = 0;
    let contextCharsSaved = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        runs += 1;
        if (rec.qaApproved === true) qaApproved += 1;
        if (rec.qaApproved === false) qaRejected += 1;
        qaRoundsTotal += Number(rec.qaRounds || 0);
        contextChunksUsed += Number(rec.contextChunksUsed || 0);
        contextCharsSaved += Number(rec.contextCharsSaved || 0);
      } catch {
        // Ignore malformed rows.
      }
    }
    return { runs, qaApproved, qaRejected, qaRoundsTotal, contextChunksUsed, contextCharsSaved };
  } catch {
    return { runs: 0, qaApproved: 0, qaRejected: 0, qaRoundsTotal: 0, contextChunksUsed: 0, contextCharsSaved: 0 };
  }
}
