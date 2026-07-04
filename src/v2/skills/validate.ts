/**
 * Validate a skill definition's raw markdown content.
 *
 * Checks:
 *  1. YAML frontmatter is present and parseable
 *  2. `name` field is a non-empty string
 *  3. `description` field is present
 *  4. No `<script` tags in the content (XSS / injection guard)
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const SCRIPT_TAG_RE = /<script[\s>]/i;

export interface ValidateSkillResult {
  valid: boolean;
  errors: string[];
}

export function validateSkillDefinition(content: string): ValidateSkillResult {
  const errors: string[] = [];

  if (SCRIPT_TAG_RE.test(content)) {
    errors.push('Skill content contains disallowed <script> tag');
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    errors.push('Missing YAML frontmatter (expected --- block at top of file)');
    return { valid: errors.length === 0, errors };
  }

  let raw: Record<string, unknown>;
  try {
    // Minimal inline YAML parse — only handles simple key: value pairs to
    // avoid pulling js-yaml at validation time (callers may not have it).
    // For full YAML support the registry uses js-yaml directly.
    raw = parseSimpleYaml(match[1]);
  } catch {
    errors.push('Frontmatter YAML is not parseable');
    return { valid: false, errors };
  }

  if (!raw['name'] || typeof raw['name'] !== 'string' || !raw['name'].trim()) {
    errors.push("Frontmatter missing required field 'name'");
  }

  if (!('description' in raw) || typeof raw['description'] !== 'string') {
    errors.push("Frontmatter missing required field 'description'");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Minimal YAML parser — handles simple `key: value` pairs only.
 * Sufficient for skill frontmatter validation without js-yaml dependency.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
