import * as fs from 'fs';
import * as path from 'path';
import { callOmnirouteWithUsage } from '../../utils/omniroute-call.js';

export interface CompactionSettings {
  autoCompactEnabled: boolean;
  autoCompactThreshold: number; // chars, default 100_000
  summarizationModel?: string;
}

export interface CompactionStats {
  charsBefore: number;
  charsAfter: number;
  reductionPct: number;
  stage: 'none' | 'stage1' | 'stage2';
  archivePath?: string;
}

export interface MaybeCompactResult {
  contextText: string;
  historyMessages: string[];
  archivePath?: string;
  compactStats: CompactionStats;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  autoCompactEnabled: true,
  autoCompactThreshold: 100_000,
  summarizationModel: 'anthropic/claude-haiku-4-5-20251001',
};

/**
 * smartTruncate keeps head+tail with a [...N chars omitted...] marker.
 * Breaks on paragraph/sentence boundaries where possible.
 */
export function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const headRatio = 0.6;
  const tailRatio = 0.3;
  const headTarget = Math.floor(maxChars * headRatio);
  const tailTarget = Math.floor(maxChars * tailRatio);

  // Break head at paragraph or sentence boundary
  let headEnd = headTarget;
  const headSlice = text.slice(0, headTarget + 200);
  const headParaBreak = headSlice.lastIndexOf('\n\n', headTarget + 200);
  const headSentBreak = headSlice.search(/[.!?]\s+[A-Z]/);
  if (headParaBreak > headTarget * 0.7) {
    headEnd = headParaBreak + 2;
  } else if (headSentBreak > headTarget * 0.7) {
    headEnd = headSentBreak + 2;
  }
  headEnd = Math.min(headEnd, text.length);

  // Break tail at paragraph or sentence boundary
  const tailStart = text.length - tailTarget;
  const tailSlice = text.slice(Math.max(0, tailStart - 200));
  const tailParaBreak = tailSlice.indexOf('\n\n');
  const adjustedTailStart =
    tailParaBreak !== -1 && tailParaBreak < 200
      ? Math.max(0, tailStart - 200) + tailParaBreak + 2
      : tailStart;

  const head = text.slice(0, headEnd);
  const tail = text.slice(adjustedTailStart);
  const omitted = text.length - head.length - tail.length;

  return `${head}\n\n[...${omitted} chars omitted...]\n\n${tail}`;
}

function logCompactionEvent(
  sessionId: string,
  stats: CompactionStats,
  runId?: string,
): void {
  const entry = {
    ts: new Date().toISOString(),
    event: 'compaction',
    sessionId,
    runId,
    chars_before: stats.charsBefore,
    chars_after: stats.charsAfter,
    reduction_pct: stats.reductionPct.toFixed(1),
    stage: stats.stage,
    archive_path: stats.archivePath,
  };
  // Structured log to stderr to avoid polluting stdout
  process.stderr.write('[compaction] ' + JSON.stringify(entry) + '\n');
}

async function archiveToVault(
  text: string,
  sessionId: string,
): Promise<string> {
  const vaultDir = path.join('data', 'vault', 'compaction_archives');
  fs.mkdirSync(vaultDir, { recursive: true });
  const timestamp = Date.now();
  const archivePath = path.join(vaultDir, `${sessionId}_${timestamp}.txt`);
  fs.writeFileSync(archivePath, text, 'utf8');
  return archivePath;
}

/**
 * Two-stage compaction:
 * Stage 1 — cheap trim: drop oldest chars until under threshold; accept if savings >= 20%.
 * Stage 2 — LLM summarize: calls Omniroute for dense summary; archives original.
 */
export async function maybeCompact(
  currentContextText: string,
  recentHistoryMessages: string[],
  settings: CompactionSettings,
  currentModel: string,
  sessionId: string,
  runId?: string,
): Promise<MaybeCompactResult> {
  const threshold = settings.autoCompactThreshold ?? 100_000;
  const charsBefore = currentContextText.length;

  const noopResult: MaybeCompactResult = {
    contextText: currentContextText,
    historyMessages: recentHistoryMessages,
    compactStats: {
      charsBefore,
      charsAfter: charsBefore,
      reductionPct: 0,
      stage: 'none',
    },
  };

  if (!settings.autoCompactEnabled || charsBefore <= threshold) {
    return noopResult;
  }

  // --- Stage 1: cheap trim ---
  const trimmed = smartTruncate(currentContextText, threshold);
  const stage1Savings = (charsBefore - trimmed.length) / charsBefore;

  if (stage1Savings >= 0.2) {
    const stats: CompactionStats = {
      charsBefore,
      charsAfter: trimmed.length,
      reductionPct: stage1Savings * 100,
      stage: 'stage1',
    };
    logCompactionEvent(sessionId, stats, runId);
    return {
      contextText: trimmed,
      historyMessages: recentHistoryMessages,
      compactStats: stats,
    };
  }

  // --- Stage 2: LLM summarize ---
  const archivePath = await archiveToVault(currentContextText, sessionId);

  const summarizationModel =
    settings.summarizationModel ??
    DEFAULT_COMPACTION_SETTINGS.summarizationModel!;

  let summarized = trimmed; // fallback
  try {
    const result = await callOmnirouteWithUsage({
      systemPrompt:
        'You are a context compactor. Produce a dense, factual summary that preserves all key decisions, artifacts, errors, and conclusions. Target ~30% of the input length. No filler.',
      userPrompt: `Summarize the following context:\n\n${currentContextText}`,
      model: summarizationModel,
      temperature: 0,
    });
    summarized = result.content;
  } catch (err) {
    // Graceful fallback: keep the stage1 trim, but surface the degradation on
    // the same stderr channel as logCompactionEvent so the operator knows
    // stage 2 fell back to the cheap trim.
    process.stderr.write(
      '[compaction] stage2 LLM summarization failed, falling back to stage1 trim: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
  }

  const stats: CompactionStats = {
    charsBefore,
    charsAfter: summarized.length,
    reductionPct: ((charsBefore - summarized.length) / charsBefore) * 100,
    stage: 'stage2',
    archivePath,
  };
  logCompactionEvent(sessionId, stats, runId);

  return {
    contextText: summarized,
    historyMessages: recentHistoryMessages,
    archivePath,
    compactStats: stats,
  };
}
