const MIN_LENGTH = 100;

export function validateContent(output: string): { passed: boolean; message: string } {
  const text = output.trim();

  if (text.length === 0) {
    return { passed: false, message: 'Content is empty' };
  }

  if (text.length < MIN_LENGTH) {
    return {
      passed: false,
      message: `Content too short: ${text.length} chars (minimum ${MIN_LENGTH})`,
    };
  }

  return { passed: true, message: `Content valid (${text.length} chars)` };
}
