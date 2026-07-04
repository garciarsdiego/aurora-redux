export interface TriggerMatch {
  kind: 'image' | 'pdf' | 'code_block' | 'url';
  payload: string;
  specialist_persona_hint?: string;
}

const CODE_BLOCK_RE = /```\w+/g;
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;

export function detectTriggers(prompt: string, attachments?: any[]): TriggerMatch[] {
  const matches: TriggerMatch[] = [];

  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      const mime: string = att?.mime_type ?? att?.type ?? '';
      const name: string = att?.name ?? att?.filename ?? '';
      if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
        matches.push({ kind: 'image', payload: name || mime, specialist_persona_hint: 'worker.advisor_call' });
      } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
        matches.push({ kind: 'pdf', payload: name || mime });
      }
    }
  }

  const codeMatches = prompt.match(CODE_BLOCK_RE);
  if (codeMatches) {
    for (const m of codeMatches) {
      matches.push({ kind: 'code_block', payload: m });
    }
  }

  const urlMatches = prompt.match(URL_RE);
  if (urlMatches) {
    for (const u of urlMatches) {
      matches.push({ kind: 'url', payload: u });
    }
  }

  return matches;
}

export function suggestSpecialistAdvisor(triggers: TriggerMatch[]): string | null {
  for (const t of triggers) {
    if (t.kind === 'image') return 'analyze';
    if (t.kind === 'pdf') return 'apilookup';
    if (t.kind === 'code_block') return 'codereview';
    if (t.kind === 'url') return 'debug';
  }
  return null;
}
