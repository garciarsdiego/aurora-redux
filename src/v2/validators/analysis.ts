const MIN_LENGTH = 200;
const CONCLUSION_RE = /\b(conclusion|conclusions|therefore|thus|in summary|portanto|em suma|hence|consequently)\b/i;

export function validateAnalysis(output: string): { passed: boolean; message: string } {
  const text = output.trim();

  if (text.length === 0) {
    return { passed: false, message: 'Analysis output is empty' };
  }

  if (text.length < MIN_LENGTH) {
    return {
      passed: false,
      message: `Analysis too short: ${text.length} chars (minimum ${MIN_LENGTH})`,
    };
  }

  if (!CONCLUSION_RE.test(text)) {
    return {
      passed: false,
      message: 'Analysis lacks a conclusion marker (conclusion/therefore/portanto/in summary)',
    };
  }

  return { passed: true, message: `Analysis valid (${text.length} chars, conclusion present)` };
}
