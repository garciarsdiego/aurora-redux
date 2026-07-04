#!/usr/bin/env node

/**
 * Omniforge Quick Test Suite - Versão Melhorada
 * Executa testes representativos com retry logic, validação estruturada e métricas avançadas
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  executeWithRetry,
  parseOmniforgeOutput,
  validateStructuredOutput,
  MetricsCollector,
  AsyncTestExecutor,
  truncateOutput,
  getAdaptiveTimeout,
  saveResults,
  generateTimestamp
} from './test-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESULTS_DIR = path.join(__dirname, '../test-results');
const OMNIFORGE_BIN = path.join(__dirname, '../bin/omniforge');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const testCases = [
  // NÍVEL 1 - BÁSICO (5 testes)
  {
    id: 'L1-001',
    level: 'Nível 1 - Básico',
    objective: 'Explique o que é machine learning em 2 parágrafos',
    expected_type: 'single_llm_call',
    complexity: 'baixa'
  },
  {
    id: 'L1-002', 
    level: 'Nível 1 - Básico',
    objective: 'Crie uma lista de 5 benefícios do TypeScript',
    expected_type: 'single_llm_call',
    complexity: 'baixa'
  },
  {
    id: 'L1-003',
    level: 'Nível 1 - Básico',
    objective: 'Resuma a história da computação em 3 linhas',
    expected_type: 'single_llm_call',
    complexity: 'baixa'
  },
  {
    id: 'L1-004',
    level: 'Nível 1 - Básico',
    objective: 'Escreva um poema de 4 linhas sobre inteligência artificial',
    expected_type: 'single_llm_call',
    complexity: 'baixa'
  },
  {
    id: 'L1-005',
    level: 'Nível 1 - Básico',
    objective: 'Defina o que é uma API REST',
    expected_type: 'single_llm_call',
    complexity: 'baixa'
  },
  
  // NÍVEL 2 - INTERMEDIÁRIO (5 testes)
  {
    id: 'L2-001',
    level: 'Nível 2 - Intermediário',
    objective: 'Compare PostgreSQL vs MongoDB e recomende para e-commerce',
    expected_type: 'multi_step_decomposition',
    complexity: 'media'
  },
  {
    id: 'L2-002',
    level: 'Nível 2 - Intermediário',
    objective: 'Liste 3 frameworks de JavaScript e compare suas características principais',
    expected_type: 'multi_step_decomposition',
    complexity: 'media'
  },
  {
    id: 'L2-003',
    level: 'Nível 2 - Intermediário',
    objective: 'Explique as diferenças entre monolito e microserviços com exemplos',
    expected_type: 'multi_step_decomposition',
    complexity: 'media'
  },
  {
    id: 'L2-004',
    level: 'Nível 2 - Intermediário',
    objective: 'Descreva 5 melhores práticas de segurança web e como implementar',
    expected_type: 'multi_step_decomposition',
    complexity: 'media'
  },
  {
    id: 'L2-005',
    level: 'Nível 2 - Intermediário',
    objective: 'Analise prós e contras de 3 bancos de dados diferentes para projeto específico',
    expected_type: 'multi_step_decomposition',
    complexity: 'media'
  },
  
  // NÍVEL 3 - AVANÇADO (3 testes)
  {
    id: 'L3-001',
    level: 'Nível 3 - Avançado',
    objective: 'Crie um plano de migração de sistema legado para cloud com riscos e mitigação',
    expected_type: 'complex_decomposition',
    complexity: 'alta'
  },
  {
    id: 'L3-002',
    level: 'Nível 3 - Avançado',
    objective: 'Projete arquitetura de sistema escalável com milhões de usuários',
    expected_type: 'complex_decomposition',
    complexity: 'alta'
  },
  {
    id: 'L3-003',
    level: 'Nível 3 - Avançado',
    objective: 'Desenvolva estratégia de monitoramento e alertas para sistema distribuído',
    expected_type: 'complex_decomposition',
    complexity: 'alta'
  },
  
  // NÍVEL 4 - ESPECIALISTA (2 testes)
  {
    id: 'L4-001',
    level: 'Nível 4 - Especialista',
    objective: 'Analise performance de algoritmos de ordenação e recomende para diferentes cenários',
    expected_type: 'parallel_analysis',
    complexity: 'muito_alta'
  },
  {
    id: 'L4-002',
    level: 'Nível 4 - Especialista',
    objective: 'Compare 5 abordagens de arquitetura para sistema de alta disponibilidade',
    expected_type: 'parallel_analysis',
    complexity: 'muito_alta'
  },
  
  // NÍVEL 5 - EXTREMO (2 testes)
  {
    id: 'L5-001',
    level: 'Nível 5 - Extremo',
    objective: 'Crie análise técnica completa com múltiplas perspectivas sobre arquitetura de sistemas',
    expected_type: 'stress_test',
    complexity: 'extrema'
  },
  {
    id: 'L5-002',
    level: 'Nível 5 - Extremo',
    objective: 'Desenvolva plano completo de disaster recovery com RTO, RPO e procedimentos detalhados',
    expected_type: 'stress_test',
    complexity: 'extrema'
  }
];

// Initialize metrics collector
const metricsCollector = new MetricsCollector();
const asyncExecutor = new AsyncTestExecutor();

const results = {
  started_at: new Date().toISOString(),
  total_tests: testCases.length,
  executed: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
  timing_data: [],
  errors: [],
  advanced_metrics: null
};

async function runTestWithRetry(test) {
  const timeout = getAdaptiveTimeout(test.complexity);
  const command = `node "${OMNIFORGE_BIN}" run "${test.objective}" --workspace internal --auto-approve`;
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TESTE: ${test.id} | ${test.level}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Objetivo: ${test.objective}`);
  console.log(`Tipo esperado: ${test.expected_type}`);
  console.log(`Complexidade: ${test.complexity}`);
  console.log(`Timeout: ${(timeout / 1000 / 60).toFixed(1)} min`);
  
  const startTime = Date.now();
  let result = {
    ...test,
    started_at: new Date().toISOString(),
    status: 'running',
    duration_ms: null,
    workflow_id: null,
    tasks_executed: null,
    output: null,
    parsed_output: null,
    validation: null,
    error: null,
    timeout_ms: timeout,
    retry_count: 0
  };

  try {
    const execResult = await executeWithRetry(command, {
      timeout,
      cwd: path.join(__dirname, '..')
    });
    
    result.duration_ms = execResult.duration;
    result.output = truncateOutput(execResult.stdout, 1500);
    result.retry_count = execResult.retryCount || 0;
    
    // Parse structured output
    result.parsed_output = parseOmniforgeOutput(execResult.stdout);
    
    // Validate structured output
    result.validation = validateStructuredOutput(result.parsed_output, {
      requireWorkflowId: true,
      requireTasksExecuted: false,
      requireDuration: false
    });
    
    // Merge parsed data into result
    if (result.parsed_output.workflow_id) {
      result.workflow_id = result.parsed_output.workflow_id;
    }
    if (result.parsed_output.tasks_executed !== null) {
      result.tasks_executed = result.parsed_output.tasks_executed;
    }
    if (result.parsed_output.duration_ms !== null) {
      result.duration_ms = result.parsed_output.duration_ms;
    }
    
    // Check validation
    if (!result.validation.valid) {
      result.status = 'warning';
      console.log(`⚠️ PASSOU com avisos de validação`);
    } else {
      result.status = 'passed';
    }
    
    results.executed++;
    results.passed++;
    
    // Record metrics
    metricsCollector.recordTestExecution(test, result);
    
    console.log(`✅ ${result.status.toUpperCase()} - ${result.duration_ms}ms | Tasks: ${result.tasks_executed}`);
    console.log(`   Workflow ID: ${result.workflow_id}`);
    if (result.validation.warnings.length > 0) {
      console.log(`   Warnings: ${result.validation.warnings.join(', ')}`);
    }

  } catch (error) {
    result.duration_ms = Date.now() - startTime;
    result.status = 'failed';
    result.error = {
      message: error.message,
      output: truncateOutput(error.stdout || error.stderr || '', 800)
    };
    
    // Try to parse error output
    if (error.stdout) {
      result.parsed_output = parseOmniforgeOutput(error.stdout);
    }

    results.executed++;
    results.failed++;
    results.errors.push({
      test_id: test.id,
      error: result.error
    });
    
    // Record metrics even for failures
    metricsCollector.recordTestExecution(test, result);

    console.log(`❌ FALHOU - ${result.duration_ms}ms`);
    console.log(`   Erro: ${error.message.substring(0, 100)}`);
  }

  results.tests.push(result);
  results.timing_data.push({
    test_id: test.id,
    level: test.level,
    duration_ms: result.duration_ms,
    status: result.status,
    tasks_executed: result.tasks_executed,
    retry_count: result.retry_count
  });

  // Salvar incremental
  saveIncrementalResults();
}

function saveIncrementalResults() {
  const timestamp = generateTimestamp();
  const filename = `quick-test-results-${timestamp}.json`;
  saveResults(results, RESULTS_DIR, filename);
}

async function generateReport() {
  results.ended_at = new Date().toISOString();
  results.total_duration_ms = new Date(results.ended_at) - new Date(results.started_at);
  
  // Calculate time percentiles
  const durations = results.tests
    .filter(t => t.duration_ms !== null)
    .map(t => t.duration_ms);
  metricsCollector.calculateTimePercentiles(durations);
  
  // Get advanced metrics
  results.advanced_metrics = metricsCollector.getSummary();

  const reportPath = path.join(RESULTS_DIR, `quick-test-report-${Date.now()}.md`);
  
  let report = `# Omniforge Quick Test Suite - Relatório Melhorado\n\n`;
  report += `**Data:** ${new Date().toLocaleString('pt-BR')}\n`;
  report += `**Duração:** ${(results.total_duration_ms/1000/60).toFixed(2)} minutos\n`;
  report += `**Versão:** 2.0 (com métricas avançadas)\n\n`;

  // Resumo
  report += `## 📊 Resumo Executivo\n\n`;
  report += `| Métrica | Valor |\n`;
  report += `|---------|-------|\n`;
  report += `| Total de Testes | ${results.total_tests} |\n`;
  report += `| Executados | ${results.executed} |\n`;
  report += `| Passaram | ${results.passed} (${((results.passed/results.executed)*100).toFixed(1)}%) |\n`;
  report += `| Falharam | ${results.failed} (${((results.failed/results.executed)*100).toFixed(1)}%) |\n`;
  report += `| Pulados | ${results.skipped} |\n\n`;

  // Resultados por nível
  const levelGroups = {};
  results.tests.forEach(test => {
    if (!levelGroups[test.level]) {
      levelGroups[test.level] = { total: 0, passed: 0, failed: 0, warnings: 0, tests: [] };
    }
    levelGroups[test.level].total++;
    levelGroups[test.level].tests.push(test);
    if (test.status === 'passed') levelGroups[test.level].passed++;
    else if (test.status === 'warning') levelGroups[test.level].warnings++;
    else levelGroups[test.level].failed++;
  });

  report += `## 🎯 Resultados por Nível\n\n`;
  for (const [level, data] of Object.entries(levelGroups)) {
    const passRate = ((data.passed/data.total)*100).toFixed(1);
    report += `### ${level}\n`;
    report += `- **Total:** ${data.total}\n`;
    report += `- **Passaram:** ${data.passed} (${passRate}%)\n`;
    report += `- **Avisos:** ${data.warnings}\n`;
    report += `- **Falharam:** ${data.failed}\n\n`;
  }

  // Detalhes dos testes
  report += `## 📋 Detalhes dos Testes\n\n`;
  report += `| ID | Nível | Status | Duração | Tasks | Retries |\n`;
  report += `|----|-------|--------|---------|-------|---------|\n`;
  
  for (const test of results.tests) {
    let statusIcon = '✅';
    if (test.status === 'failed') statusIcon = '❌';
    else if (test.status === 'warning') statusIcon = '⚠️';
    
    const duration = test.duration_ms ? `${(test.duration_ms/1000).toFixed(1)}s` : 'N/A';
    const tasks = test.tasks_executed || 'N/A';
    const retries = test.retry_count || 0;
    report += `| ${test.id} | ${test.level} | ${statusIcon} | ${duration} | ${tasks} | ${retries} |\n`;
  }

  // Análise de performance avançada
  report += `\n## ⏱️ Análise de Performance Avançada\n\n`;
  const successfulTests = results.tests.filter(t => t.status === 'passed' || t.status === 'warning');
  if (successfulTests.length > 0) {
    const avgDuration = successfulTests.reduce((sum, t) => sum + t.duration_ms, 0) / successfulTests.length;
    const maxDuration = Math.max(...successfulTests.map(t => t.duration_ms));
    const minDuration = Math.min(...successfulTests.map(t => t.duration_ms));
    
    report += `### Estatísticas Gerais\n`;
    report += `- **Tempo médio:** ${(avgDuration/1000).toFixed(1)}s\n`;
    report += `- **Tempo mínimo:** ${(minDuration/1000).toFixed(1)}s\n`;
    report += `- **Tempo máximo:** ${(maxDuration/1000).toFixed(1)}s\n\n`;
    
    // Percentiles
    const dist = results.advanced_metrics.execution_time_distribution;
    if (dist.p50 !== null) {
      report += `### Distribuição de Tempos (Percentis)\n`;
      report += `- **P50 (mediana):** ${(dist.p50/1000).toFixed(1)}s\n`;
      report += `- **P75:** ${(dist.p75/1000).toFixed(1)}s\n`;
      report += `- **P90:** ${(dist.p90/1000).toFixed(1)}s\n`;
      report += `- **P95:** ${(dist.p95/1000).toFixed(1)}s\n`;
      report += `- **P99:** ${(dist.p99/1000).toFixed(1)}s\n\n`;
    }
  }

  // Performance por tipo de tarefa
  report += `## 🎯 Performance por Tipo de Tarefa\n\n`;
  report += `| Tipo | Total | Passaram | Falharam | Tempo Médio |\n`;
  report += `|------|-------|----------|----------|-------------|\n`;
  
  for (const [taskType, metrics] of Object.entries(results.advanced_metrics.performance_by_task_type)) {
    const successRate = ((metrics.success_count / metrics.total_tests) * 100).toFixed(1);
    report += `| ${taskType} | ${metrics.total_tests} | ${metrics.success_count} (${successRate}%) | ${metrics.failure_count} | ${(metrics.avg_duration_ms/1000).toFixed(1)}s |\n`;
  }

  // Análise de custos
  if (Object.keys(results.advanced_metrics.cost_analysis).length > 0) {
    report += `\n## 💰 Análise de Custos\n\n`;
    report += `| Tipo de Tarefa | Custo Total | Custo Médio | Testes |\n`;
    report += `|----------------|-------------|-------------|--------|\n`;
    
    for (const [taskType, cost] of Object.entries(results.advanced_metrics.cost_analysis)) {
      report += `| ${taskType} | $${cost.total_cost_usd.toFixed(4)} | $${cost.avg_cost_usd.toFixed(4)} | ${cost.test_count} |\n`;
    }
  }

  // Taxa de sucesso por modelo
  if (Object.keys(results.advanced_metrics.success_rate_by_model).length > 0) {
    report += `\n## 🤖 Taxa de Sucesso por Modelo\n\n`;
    report += `| Modelo | Total | Sucesso | Falha | Taxa Sucesso |\n`;
    report += `|--------|-------|---------|-------|-------------|\n`;
    
    const sortedModels = Object.entries(results.advanced_metrics.success_rate_by_model)
      .sort((a, b) => b[1].total - a[1].total);
    
    for (const [model, metrics] of sortedModels.slice(0, 10)) {
      report += `| ${model} | ${metrics.total} | ${metrics.success} | ${metrics.failure} | ${metrics.success_rate.toFixed(1)}% |\n`;
    }
  }

  // Taxa de sucesso por provider
  if (Object.keys(results.advanced_metrics.success_rate_by_provider).length > 0) {
    report += `\n## 🏢 Taxa de Sucesso por Provider\n\n`;
    report += `| Provider | Total | Sucesso | Falha | Taxa Sucesso |\n`;
    report += `|----------|-------|---------|-------|-------------|\n`;
    
    const sortedProviders = Object.entries(results.advanced_metrics.success_rate_by_provider)
      .sort((a, b) => b[1].total - a[1].total);
    
    for (const [provider, metrics] of sortedProviders) {
      report += `| ${provider} | ${metrics.total} | ${metrics.success} | ${metrics.failure} | ${metrics.success_rate.toFixed(1)}% |\n`;
    }
  }

  // Estatísticas de retry
  const retryStats = results.advanced_metrics.retry_statistics;
  if (retryStats.total_retries > 0) {
    report += `## 🔄 Estatísticas de Retry\n\n`;
    report += `- **Total de retries:** ${retryStats.total_retries}\n`;
    report += `- **Retries bem-sucedidos:** ${retryStats.successful_retries}\n`;
    report += `- **Retries falhados:** ${retryStats.failed_retries}\n`;
    report += `- **Taxa de sucesso de retries:** ${((retryStats.successful_retries / retryStats.total_retries) * 100).toFixed(1)}%\n\n`;
  }

  // Validação de saída estruturada
  report += `## 🔍 Validação de Saída Estruturada\n\n`;
  const validationPassed = results.tests.filter(t => t.validation && t.validation.valid).length;
  const validationWarnings = results.tests.filter(t => t.validation && t.validation.warnings.length > 0).length;
  report += `- **Testes com validação completa:** ${validationPassed}/${results.executed}\n`;
  report += `- **Testes com avisos de validação:** ${validationWarnings}\n\n`;

  // Erros
  if (results.errors.length > 0) {
    report += `## ❌ Erros Encontrados\n\n`;
    for (const error of results.errors) {
      report += `### ${error.test_id}\n`;
      report += `**Erro:** ${error.error.message}\n`;
      if (error.error.output) {
        report += `**Output:** ${error.error.output}\n`;
      }
      report += `\n`;
    }
  }

  // Conclusões
  report += `## 💡 Conclusões e Recomendações\n\n`;
  const successRate = (results.passed / results.executed) * 100;
  
  if (successRate > 90) {
    report += `✅ **Excelente estabilidade** do sistema com taxa de sucesso de ${successRate.toFixed(1)}%\n`;
  } else if (successRate > 70) {
    report += `⚠️ **Estabilidade aceitável** com taxa de sucesso de ${successRate.toFixed(1)}%, mas há espaço para melhorias\n`;
  } else {
    report += `🚨 **Estabilidade crítica** com taxa de sucesso de apenas ${successRate.toFixed(1)}%, requer atenção imediata\n`;
  }
  
  // Recomendações baseadas em métricas
  report += `\n### Recomendações:\n\n`;
  
  if (retryStats.total_retries > 0) {
    const retryRate = (retryStats.total_retries / results.executed) * 100;
    if (retryRate > 20) {
      report += `- ⚠️ Alta taxa de retry (${retryRate.toFixed(1)}%). Considerar investigar timeouts ou instabilidades.\n`;
    }
  }
  
  if (validationWarnings > 0) {
    report += `- ⚠️ ${validationWarnings} testes apresentaram avisos de validação. Revisar parsing de output.\n`;
  }

  report += `\n---\n`;
  report += `*Relatório gerado automaticamente por Omniforge Quick Test Suite v2.0*\n`;

  fs.writeFileSync(reportPath, report);
  console.log(`\n📄 Relatório salvo: ${reportPath}`);
  
  return reportPath;
}

// Executar testes
async function main() {
  console.log('🚀 Iniciando Omniforge Quick Test Suite v2.0\n');
  console.log(`📋 Total de testes: ${testCases.length}`);
  console.log(`📁 Resultados: ${RESULTS_DIR}`);
  console.log(`🔄 Retry logic: Ativado (3 retries com backoff exponencial)`);
  console.log(`🔍 Validação estruturada: Ativada`);
  console.log(`📊 Métricas avançadas: Ativadas\n`);

  for (const test of testCases) {
    await runTestWithRetry(test);
    // Pequena pausa entre testes para evitar rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 TESTES CONCLUÍDOS');
  console.log(`${'='.repeat(70)}`);
  console.log(`✅ Passaram: ${results.passed}/${results.executed}`);
  console.log(`❌ Falharam: ${results.failed}/${results.executed}`);
  console.log(`⏱️  Duração total: ${(results.total_duration_ms/1000/60).toFixed(2)} minutos`);

  const reportPath = await generateReport();
  
  // Salvar resultados finais
  const finalResultsPath = path.join(RESULTS_DIR, `quick-test-results-final-${generateTimestamp()}.json`);
  saveResults(results, RESULTS_DIR, `quick-test-results-final-${generateTimestamp()}.json`);
  console.log(`📁 Resultados finais: ${finalResultsPath}`);
}

main().catch(console.error);