export function validateCode(output: string): { passed: boolean; message: string } {
  const text = output.trim();

  // Empty output from tsc --noEmit = success (tsc prints nothing on a clean build)
  if (text.length === 0) {
    return { passed: true, message: 'Clean build (no output)' };
  }

  const tsError = text.match(/error TS\d+[^\n]*/i)?.[0];
  if (tsError) {
    return { passed: false, message: `TypeScript error: ${tsError.slice(0, 120)}` };
  }

  if (/\d+\s+(?:test\s+)?fail(?:ed|ure)/i.test(text) || /\bFAIL\b/.test(text)) {
    return { passed: false, message: 'Test failures detected in output' };
  }

  return { passed: true, message: 'Code output clean (no errors found)' };
}
