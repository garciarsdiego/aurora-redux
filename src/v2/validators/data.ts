export function validateData(output: string): { passed: boolean; message: string } {
  const text = output.trim();

  if (text.length === 0) {
    return { passed: false, message: 'Data output is empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { passed: false, message: 'Data output is not valid JSON' };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { passed: false, message: 'Data array is empty (0 rows)' };
    }
    return { passed: true, message: `Data valid: array with ${parsed.length} row(s)` };
  }

  if (parsed !== null && typeof parsed === 'object') {
    const keys = Object.keys(parsed as object);
    if (keys.length === 0) {
      return { passed: false, message: 'Data object has no fields' };
    }
    return { passed: true, message: `Data valid: object with ${keys.length} field(s)` };
  }

  return { passed: false, message: `Data output is a primitive (${typeof parsed}), expected object or array` };
}
