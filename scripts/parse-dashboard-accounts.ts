#!/usr/bin/env tsx
/**
 * Parse Dashboard HTML for Account Information
 *
 * Fetches the dashboard HTML and attempts to extract account names
 * and connection details.
 */

const OMNIROUTE_URL = 'http://localhost:20228';

async function parseDashboardForAccounts() {
  console.log('🔍 Parsing Dashboard HTML for Account Information\n');

  try {
    const response = await fetch(`${OMNIROUTE_URL}/dashboard`);
    const html = await response.text();

    console.log(`📊 Dashboard HTML loaded: ${html.length} characters\n`);

    // Look for patterns that might contain account information
    const patterns = [
      { regex: /account[^>]*>([^<]+)</gi, desc: 'Account references' },
      { regex: /connected[^>]*>([^<]+)</gi, desc: 'Connected status' },
      { regex: /provider[^>]*>([^<]+)</gi, desc: 'Provider references' },
      { regex: /codex[^>]*>([^<]+)/gi, desc: 'Codex references' },
      { regex: /claude[^>]*>([^<]+)/gi, desc: 'Claude references' },
      { regex: /openai[^>]*>([^<]+)/gi, desc: 'OpenAI references' },
      { regex: /email[^>]*>([^<]+)</gi, desc: 'Email patterns' },
      { regex: /@[^>]*</gi, desc: 'Email-like patterns' },
      { regex: /"account":\s*"([^"]+)"/gi, desc: 'JSON account fields' },
      { regex: /"name":\s*"([^"]+)"/gi, desc: 'JSON name fields' },
      { regex: /"provider":\s*"([^"]+)"/gi, desc: 'JSON provider fields' },
    ];

    const found = new Map<string, Set<string>>();

    for (const { regex, desc } of patterns) {
      const matches = html.match(regex);
      if (matches && matches.length > 0) {
        const uniqueValues = new Set(matches.map(m => m.replace(/<[^>]+>/g, '').trim()));
        if (uniqueValues.size > 0 && uniqueValues.size < 50) { // Filter out too many matches
          found.set(desc, uniqueValues);
          console.log(`\n✅ ${desc}:`);
          uniqueValues.forEach(val => console.log(`   - ${val}`));
        }
      }
    }

    // Look for JSON data embedded in the HTML
    const jsonMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonMatches) {
      console.log(`\n📜 Found ${jsonMatches.length} script tags`);

      for (let i = 0; i < jsonMatches.length; i++) {
        const scriptContent = jsonMatches[i];
        try {
          // Try to find JSON-like structures
          const jsonObjects = scriptContent.match(/\{[^{}]*"[^"]*account[^"]*"[^{}]*\}/gi);
          if (jsonObjects) {
            console.log(`\n🔍 Script ${i + 1} - Found account-related JSON:`);
            jsonObjects.forEach(obj => {
              try {
                const parsed = JSON.parse(obj);
                console.log(`   ${JSON.stringify(parsed, null, 2).substring(0, 200)}...`);
              } catch (e) {
                // Not valid JSON, just show the string
                console.log(`   ${obj.substring(0, 150)}...`);
              }
            });
          }
        } catch (e) {
          // Skip parsing errors
        }
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ Dashboard parsing complete');

  } catch (error) {
    console.error('❌ Error parsing dashboard:', error);
  }
}

parseDashboardForAccounts().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});