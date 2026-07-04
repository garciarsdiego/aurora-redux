#!/usr/bin/env tsx
/**
 * Extract Account Names from Omniroute
 *
 * Attempts to extract detailed account information from Omniroute by
 * trying different API endpoints and parsing responses.
 */

const OMNIROUTE_URL = 'http://localhost:20228';

async function tryEndpoint(endpoint: string, description: string) {
  console.log(`🔍 Trying: ${description} (${endpoint})`);

  try {
    const response = await fetch(`${OMNIROUTE_URL}${endpoint}`);
    const contentType = response.headers.get('content-type');

    console.log(`   Status: ${response.status}`);
    console.log(`   Content-Type: ${contentType}`);

    if (contentType?.includes('application/json')) {
      const data = await response.json();
      console.log(`   Response preview: ${JSON.stringify(data).substring(0, 200)}...`);
      return data;
    } else {
      const text = await response.text();
      console.log(`   Response length: ${text.length} chars`);
      // Try to find account names in HTML
      const accountMatches = text.match(/account[^>]*>([^<]+)</gi) || [];
      if (accountMatches.length > 0) {
        console.log(`   Found ${accountMatches.length} account references in HTML`);
      }
      return null;
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error}`);
    return null;
  }
}

async function main() {
  console.log('🔍 Extracting Account Names from Omniroute\n');
  console.log('Omniroute URL:', OMNIROUTE_URL);
  console.log('='.repeat(50));

  // Try various endpoints that might contain account information
  const endpoints = [
    { path: '/api/providers', desc: 'Providers API' },
    { path: '/api/accounts', desc: 'Accounts API' },
    { path: '/api/connections', desc: 'Connections API' },
    { path: '/api/integrations', desc: 'Integrations API' },
    { path: '/api/config', desc: 'Config API' },
    { path: '/api/settings', desc: 'Settings API' },
    { path: '/api/user', desc: 'User API' },
    { path: '/dashboard', desc: 'Dashboard page' },
    { path: '/settings', desc: 'Settings page' },
    { path: '/integrations', desc: 'Integrations page' },
  ];

  for (const { path, desc } of endpoints) {
    console.log('\n' + '='.repeat(50));
    await tryEndpoint(path, desc);
  }

  console.log('\n' + '='.repeat(50));
  console.log('✅ Scan complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});