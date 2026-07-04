#!/usr/bin/env node

/**
 * Provider Discovery CLI
 * Command-line interface for provider discovery system
 */

import { DiscoveryOrchestrator } from '../src/provider-discovery/DiscoveryOrchestrator.js';
import { StatusClassifier } from '../src/provider-discovery/StatusClassifier.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const command = process.argv[2];

switch (command) {
  case 'discover':
    await runDiscovery();
    break;
  case 'quick':
    await runQuickDiscovery();
    break;
  case 'status':
    await showStatus();
    break;
  default:
    showUsage();
}

async function runDiscovery() {
  console.log('🚀 Starting Provider Discovery System\n');
  console.log('=' .repeat(60));
  
  try {
    const orchestrator = new DiscoveryOrchestrator();
    const report = await orchestrator.discoverAllProviders();
    
    // Classificar resultados
    const classifier = new StatusClassifier();
    const availabilityReport = classifier.classifyResults(report.all_results);
    
    // Exibir relatório
    printAvailabilityReport(availabilityReport);
    
    // Salvar para análise posterior
    const outputPath = path.join(process.cwd(), 'reports/provider-discovery', `discovery-${Date.now()}.json`);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify({
      discovery_report: report,
      availability_report: availabilityReport
    }, null, 2));
    
    console.log(`\n💾 Full report saved to: ${outputPath}`);
    
    // Salvar também como latest para fácil acesso
    const latestPath = path.join(process.cwd(), 'reports/provider-discovery', 'latest.json');
    await fs.promises.writeFile(latestPath, JSON.stringify({
      discovery_report: report,
      availability_report: availabilityReport
    }, null, 2));
    
    console.log(`📁 Latest report saved to: ${latestPath}`);
    
  } catch (error) {
    console.error('❌ Discovery failed:', error);
    process.exit(1);
  }
}

async function runQuickDiscovery() {
  console.log('⚡ Starting Quick Provider Discovery (Phase 1 only)\n');
  console.log('=' .repeat(60));
  
  try {
    const orchestrator = new DiscoveryOrchestrator();
    
    // Buscar modelos e agrupar por provider
    const allModels = await orchestrator.fetchAllModels();
    console.log(`📊 Found ${allModels.length} total models`);
    
    const byProvider = orchestrator.groupByProvider(allModels);
    console.log(`🗂️  Grouped into ${Object.keys(byProvider).length} providers`);
    
    // Executar apenas Phase 1
    console.log('\n🚀 Phase 1: Testing 1 model per provider...');
    const phase1Results = await orchestrator.testProviderRepresentatives(byProvider);
    
    const available = phase1Results.filter(r => r.status === 'available');
    const unavailable = phase1Results.filter(r => r.status !== 'available');
    const total = phase1Results.length;
    
    console.log(`\n✅ Phase 1 Complete: ${available.length}/${total} providers available`);
    console.log(`❌ Unavailable: ${unavailable.length}/${total} providers`);
    
    // Mostrar detalhes dos disponíveis
    if (available.length > 0) {
      console.log('\n✅ Available Providers:');
      for (const result of available) {
        console.log(`  ${result.provider.padEnd(20)} - ${result.model} (${result.latency_ms}ms)`);
      }
    }
    
    // Mostrar detalhes dos indisponíveis
    if (unavailable.length > 0) {
      console.log('\n❌ Unavailable Providers:');
      for (const result of unavailable) {
        const errorShort = result.error_message ? result.error_message.substring(0, 60) : result.error_code;
        console.log(`  ${result.provider.padEnd(20)} - ${errorShort}`);
      }
    }
    
    // Salvar resultado rápido
    const quickReport = {
      timestamp: Date.now(),
      phase1_only: true,
      total_providers: total,
      available_providers: available.length,
      unavailable_providers: unavailable.length,
      available_details: available,
      unavailable_details: unavailable
    };
    
    const quickPath = path.join(process.cwd(), 'reports/provider-discovery', 'quick-report.json');
    await fs.promises.mkdir(path.dirname(quickPath), { recursive: true });
    await fs.promises.writeFile(quickPath, JSON.stringify(quickReport, null, 2));
    console.log(`\n💾 Quick report saved to: ${quickPath}`);
    
  } catch (error) {
    console.error('❌ Quick discovery failed:', error);
    process.exit(1);
  }
}

async function showStatus() {
  const latestPath = path.join(process.cwd(), 'reports/provider-discovery', 'latest.json');
  
  try {
    const data = await fs.promises.readFile(latestPath, 'utf8');
    const report = JSON.parse(data);
    
    console.log('📊 Latest Provider Discovery Status');
    console.log('=' .repeat(60));
    console.log(`Timestamp: ${new Date(report.availability_report.timestamp).toISOString()}`);
    printAvailabilityReport(report.availability_report);
    
  } catch (error) {
    console.error('❌ No previous discovery report found. Run "discover" first.');
    process.exit(1);
  }
}

function printAvailabilityReport(report) {
  console.log('\n📊 PROVIDER AVAILABILITY REPORT');
  console.log('=' .repeat(60));
  console.log(`Total Providers: ${report.total_providers}`);
  console.log(`Total Models: ${report.total_models}`);
  console.log('');
  
  console.log('✅ AVAILABLE:');
  console.log(`  Providers: ${report.available.providers}`);
  console.log(`  Models: ${report.available.models}`);
  console.log(`  Rate: ${((report.available.models / report.total_models) * 100).toFixed(1)}%`);
  console.log('');
  
  console.log('❌ UNAVAILABLE:');
  console.log(`  No Credits: ${report.unavailable.no_credits.models} models (${report.unavailable.no_credits.providers} providers)`);
  console.log(`  No Credentials: ${report.unavailable.no_credentials.models} models (${report.unavailable.no_credentials.providers} providers)`);
  console.log(`  Errors: ${report.unavailable.error.models} models (${report.unavailable.error.providers} providers)`);
  console.log(`  Timeouts: ${report.unavailable.timeout.models} models (${report.unavailable.timeout.providers} providers)`);
  console.log('');
  
  console.log('📈 BY PROVIDER:');
  console.log('-'.repeat(60));
  
  // Ordenar por disponibilidade
  const sortedProviders = Object.entries(report.by_provider)
    .sort((a, b) => b[1].availability_rate - a[1].availability_rate);
  
  for (const [provider, stats] of sortedProviders) {
    const statusEmoji = stats.status === 'fully_available' ? '✅' : 
                       stats.status === 'partially_available' ? '⚠️' : '❌';
    const rate = (stats.availability_rate * 100).toFixed(1);
    const latency = stats.avg_latency_ms > 0 ? `${stats.avg_latency_ms}ms` : 'N/A';
    
    console.log(`  ${statusEmoji} ${provider.padEnd(20)} ${stats.available_models}/${stats.total_models} (${rate}%) ${latency}`);
    
    if (stats.recommended_models.length > 0 && stats.status !== 'unavailable') {
      console.log(`      → ${stats.recommended_models.slice(0, 2).join(', ')}`);
    }
  }
  
  console.log('');
  console.log('📋 SUMMARY:');
  console.log(`  Overall Availability: ${(report.summary.overall_availability_rate * 100).toFixed(1)}%`);
  console.log(`  Recommended Providers: ${report.summary.recommended_providers.join(', ') || 'None'}`);
  console.log(`  Providers to Avoid: ${report.summary.providers_to_avoid.join(', ') || 'None'}`);
}

function showUsage() {
  console.log('Provider Discovery CLI');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/provider-discovery.mjs discover    - Run full discovery (all models)');
  console.log('  node scripts/provider-discovery.mjs quick      - Run quick discovery (Phase 1 only)');
  console.log('  node scripts/provider-discovery.mjs status     - Show last discovery status');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/provider-discovery.mjs discover');
  console.log('  node scripts/provider-discovery.mjs quick');
  console.log('  node scripts/provider-discovery.mjs status');
}