export interface InjectionFlag {
  pattern: string;
  severity: 'low' | 'medium' | 'high';
  match: string;
}

export interface ScanResult {
  safe: boolean;
  flags: InjectionFlag[];
  score: number;
}

interface PatternDef {
  pattern: string;
  regex: RegExp;
  severity: 'low' | 'medium' | 'high';
}

const SEVERITY_WEIGHT: Record<'low' | 'medium' | 'high', number> = {
  low: 0.1,
  medium: 0.3,
  high: 0.6,
};

const PATTERNS: PatternDef[] = [
  // ─── EN — High: direct instruction override attempts ───
  { pattern: 'ignore_previous_instructions', regex: /ignore\s+(all\s+)?previous\s+instructions?/i, severity: 'high' },
  { pattern: 'ignore_all_instructions', regex: /ignore\s+all\s+(your\s+)?instructions?/i, severity: 'high' },
  { pattern: 'forget_instructions', regex: /forget\s+(your\s+)?(previous\s+)?instructions?/i, severity: 'high' },
  { pattern: 'override_instructions', regex: /override\s+(your\s+)?instructions?/i, severity: 'high' },
  { pattern: 'disregard_instructions', regex: /disregard\s+(all\s+)?(your\s+)?instructions?/i, severity: 'high' },
  { pattern: 'dan_jailbreak', regex: /you\s+are\s+now\s+DAN\b/i, severity: 'high' },
  { pattern: 'do_anything_now', regex: /do\s+anything\s+now\b/i, severity: 'high' },
  { pattern: 'your_real_instructions', regex: /your\s+real\s+instructions?\b/i, severity: 'high' },
  { pattern: 'new_instructions', regex: /new\s+instructions?\s*:/i, severity: 'high' },
  { pattern: 'system_prompt_leak', regex: /repeat\s+(the\s+)?(above|your|system)\s+prompt/i, severity: 'high' },

  // ─── EN — Medium: role overrides and jailbreak signals ───
  { pattern: 'jailbreak', regex: /\bjailbreak\b/i, severity: 'medium' },
  { pattern: 'bypass_filters', regex: /bypass\s+(your\s+)?(safety\s+)?(filters?|restrictions?|rules?)/i, severity: 'medium' },
  { pattern: 'system_prompt_reference', regex: /\bsystem\s+prompt\b/i, severity: 'medium' },
  { pattern: 'role_override', regex: /you\s+are\s+now\s+(a|an)\s+\w+/i, severity: 'medium' },
  { pattern: 'pretend_no_restrictions', regex: /pretend\s+(you\s+have\s+no|there\s+are\s+no)\s+(restrictions?|rules?|guidelines?)/i, severity: 'medium' },
  { pattern: 'developer_mode', regex: /\bdeveloper\s+mode\b/i, severity: 'medium' },

  // ─── EN — Low: mild manipulation signals ───
  { pattern: 'act_as', regex: /\bact\s+as\s+(a|an)\s+\w+/i, severity: 'low' },
  { pattern: 'pretend_you_are', regex: /\bpretend\s+(you\s+are|to\s+be)\b/i, severity: 'low' },
  { pattern: 'hypothetically', regex: /\bhypothetically\b.*\bignore\b/i, severity: 'low' },
  { pattern: 'translate_instructions', regex: /translate\s+the\s+(above|following)\s+instructions?/i, severity: 'low' },

  // ─── PT — Bloco 3.4 (mitigação inicial — operador é falante de português) ───
  { pattern: 'ignore_instrucoes_pt', regex: /ignor[ae]\s+(as\s+)?(instruções|comandos|regras)\s+(anteriores|prévi[ao]s|acima|do\s+sistema)/i, severity: 'high' },
  { pattern: 'esqueca_instrucoes_pt', regex: /esqueç[ao]\s+(as\s+)?(instruções|comandos|regras)/i, severity: 'high' },
  { pattern: 'desconsidere_pt', regex: /desconsidere\s+(as\s+)?(instruções|regras|restrições|orientações)/i, severity: 'high' },
  { pattern: 'sobrescreva_pt', regex: /sobrescrev[ae]?r?\s+(as\s+)?(instruções|regras)/i, severity: 'high' },
  { pattern: 'novas_instrucoes_pt', regex: /novas\s+instruções\s*[:\-]/i, severity: 'high' },
  { pattern: 'prompt_sistema_pt', regex: /\bprompt\s+(do\s+)?sistema\b/i, severity: 'medium' },
  { pattern: 'modo_desenvolvedor_pt', regex: /modo\s+(desenvolvedor|debug|admin)/i, severity: 'medium' },
  { pattern: 'finja_que_pt', regex: /finja\s+(ser|que\s+(é|você)\s+(um|uma))/i, severity: 'medium' },
  { pattern: 'aja_como_pt', regex: /\baja\s+como\s+(um|uma)\b/i, severity: 'low' },
  { pattern: 'pretenda_pt', regex: /\bpretenda\s+(ser|que)\b/i, severity: 'low' },
];

export function scanForInjection(text: string): ScanResult {
  const flags: InjectionFlag[] = [];

  for (const def of PATTERNS) {
    const m = def.regex.exec(text);
    if (m) {
      flags.push({ pattern: def.pattern, severity: def.severity, match: m[0] });
    }
  }

  // Weighted sum capped at 1.
  const score = Math.min(
    flags.reduce((acc, f) => acc + SEVERITY_WEIGHT[f.severity], 0),
    1,
  );

  return { safe: score < 0.5, flags, score };
}
