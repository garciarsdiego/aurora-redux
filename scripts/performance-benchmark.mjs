#!/usr/bin/env node

/**
 * Performance Baseline Benchmark Script (Sprint 0)
 *
 * Measures and records performance baselines for the Omniforge Aurora system.
 * Results are saved to data/performance-baseline.json for trend analysis.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULTS_DIR = path.join(process.cwd(), 'data');
const RESULTS_FILE = path.join(RESULTS_DIR, 'performance-baseline.json');

/**
 * Performance benchmark results
 */
class PerformanceBenchmark {
  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      benchmarks: {},
      metadata: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: require('node:os').cpus().length,
        totalMemory: require('node:os').totalmem(),
      },
    };
  }

  /**
   * Measure build performance
   */
  async measureBuild() {
    console.log('📊 Measuring build performance...');
    
    const startTime = Date.now();
    try {
      execSync('pnpm build', { 
        stdio: 'pipe',
        cwd: process.cwd() 
      });
      const duration = Date.now() - startTime;
      
      this.results.benchmarks.build = {
        duration_ms: duration,
        status: 'success',
        timestamp: new Date().toISOString(),
      };
      
      console.log(`✅ Build completed in ${duration}ms`);
      return duration;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.benchmarks.build = {
        duration_ms: duration,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
      
      console.log(`❌ Build failed after ${duration}ms`);
      throw error;
    }
  }

  /**
   * Measure test performance
   */
  async measureTests() {
    console.log('📊 Measuring test performance...');
    
    const startTime = Date.now();
    try {
      execSync('pnpm test', { 
        stdio: 'pipe',
        cwd: process.cwd() 
      });
      const duration = Date.now() - startTime;
      
      this.results.benchmarks.tests = {
        duration_ms: duration,
        status: 'success',
        timestamp: new Date().toISOString(),
      };
      
      console.log(`✅ Tests completed in ${duration}ms`);
      return duration;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.benchmarks.tests = {
        duration_ms: duration,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
      
      console.log(`❌ Tests failed after ${duration}ms`);
      throw error;
    }
  }

  /**
   * Measure memory usage
   */
  measureMemory() {
    console.log('📊 Measuring memory usage...');
    
    const memoryUsage = process.memoryUsage();
    
    this.results.benchmarks.memory = {
      heap_used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rss_mb: Math.round(memoryUsage.rss / 1024 / 1024),
      external_mb: Math.round(memoryUsage.external / 1024 / 1024),
      timestamp: new Date().toISOString(),
    };
    
    console.log(`✅ Memory: heap=${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB, rss=${Math.round(memoryUsage.rss / 1024 / 1024)}MB`);
  }

  /**
   * Measure disk I/O performance
   */
  async measureDiskIO() {
    console.log('📊 Measuring disk I/O performance...');
    
    const testFile = path.join(RESULTS_DIR, 'io-test.tmp');
    const testData = 'x'.repeat(1024 * 1024); // 1MB
    
    try {
      // Write test
      const writeStart = Date.now();
      writeFileSync(testFile, testData);
      const writeDuration = Date.now() - writeStart;
      
      // Read test
      const readStart = Date.now();
      readFileSync(testFile);
      const readDuration = Date.now() - readStart;
      
      // Cleanup
      require('node:fs').unlinkSync(testFile);
      
      this.results.benchmarks.disk_io = {
        write_mb_per_sec: Math.round((1 / writeDuration) * 1000),
        read_mb_per_sec: Math.round((1 / readDuration) * 1000),
        write_latency_ms: writeDuration,
        read_latency_ms: readDuration,
        timestamp: new Date().toISOString(),
      };
      
      console.log(`✅ Disk I/O: write=${Math.round((1 / writeDuration) * 1000)}MB/s, read=${Math.round((1 / readDuration) * 1000)}MB/s`);
    } catch (error) {
      console.log(`❌ Disk I/O measurement failed: ${error.message}`);
      this.results.benchmarks.disk_io = {
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Compare with previous baseline
   */
  compareWithBaseline() {
    if (!existsSync(RESULTS_FILE)) {
      console.log('📝 No previous baseline found for comparison');
      return null;
    }
    
    try {
      const previous = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
      const comparison = {
        timestamp: previous.timestamp,
        deltas: {},
      };
      
      // Compare build time
      if (previous.benchmarks.build && this.results.benchmarks.build) {
        const buildDelta = this.results.benchmarks.build.duration_ms - previous.benchmarks.build.duration_ms;
        comparison.deltas.build_ms = buildDelta;
        comparison.deltas.build_pct = Math.round((buildDelta / previous.benchmarks.build.duration_ms) * 100);
      }
      
      // Compare test time
      if (previous.benchmarks.tests && this.results.benchmarks.tests) {
        const testDelta = this.results.benchmarks.tests.duration_ms - previous.benchmarks.tests.duration_ms;
        comparison.deltas.tests_ms = testDelta;
        comparison.deltas.tests_pct = Math.round((testDelta / previous.benchmarks.tests.duration_ms) * 100);
      }
      
      console.log('📈 Performance comparison with previous baseline:');
      if (comparison.deltas.build_ms !== undefined) {
        const trend = comparison.deltas.build_ms > 0 ? '🔴' : '🟢';
        console.log(`  ${trend} Build: ${comparison.deltas.build_ms > 0 ? '+' : ''}${comparison.deltas.build_ms}ms (${comparison.deltas.build_pct}%)`);
      }
      if (comparison.deltas.tests_ms !== undefined) {
        const trend = comparison.deltas.tests_ms > 0 ? '🔴' : '🟢';
        console.log(`  ${trend} Tests: ${comparison.deltas.tests_ms > 0 ? '+' : ''}${comparison.deltas.tests_ms}ms (${comparison.deltas.tests_pct}%)`);
      }
      
      return comparison;
    } catch (error) {
      console.log(`❌ Failed to compare with baseline: ${error.message}`);
      return null;
    }
  }

  /**
   * Save results to file
   */
  saveResults() {
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }
    
    writeFileSync(RESULTS_FILE, JSON.stringify(this.results, null, 2));
    console.log(`💾 Results saved to ${RESULTS_FILE}`);
  }

  /**
   * Print summary
   */
  printSummary() {
    console.log('\n📊 Performance Baseline Summary:');
    console.log(`  Timestamp: ${this.results.timestamp}`);
    console.log(`  Node.js: ${this.results.metadata.nodeVersion}`);
    console.log(`  Platform: ${this.results.metadata.platform} ${this.results.metadata.arch}`);
    console.log(`  CPUs: ${this.results.metadata.cpuCount}`);
    console.log(`  Memory: ${Math.round(this.results.metadata.totalMemory / 1024 / 1024 / 1024)}GB`);
    
    if (this.results.benchmarks.build) {
      console.log(`  Build: ${this.results.benchmarks.build.duration_ms}ms (${this.results.benchmarks.build.status})`);
    }
    if (this.results.benchmarks.tests) {
      console.log(`  Tests: ${this.results.benchmarks.tests.duration_ms}ms (${this.results.benchmarks.tests.status})`);
    }
    if (this.results.benchmarks.memory) {
      console.log(`  Memory: heap=${this.results.benchmarks.memory.heap_used_mb}MB, rss=${this.results.benchmarks.memory.rss_mb}MB`);
    }
    if (this.results.benchmarks.disk_io) {
      console.log(`  Disk I/O: write=${this.results.benchmarks.disk_io.write_mb_per_sec}MB/s, read=${this.results.benchmarks.disk_io.read_mb_per_sec}MB/s`);
    }
  }

  /**
   * Run all benchmarks
   */
  async runAll(skipBuild = false, skipTests = false) {
    console.log('🚀 Starting performance baseline benchmarks...\n');
    
    try {
      if (!skipBuild) {
        await this.measureBuild();
      } else {
        console.log('⏭️  Skipping build measurement');
      }
      
      if (!skipTests) {
        await this.measureTests();
      } else {
        console.log('⏭️  Skipping test measurement');
      }
      
      this.measureMemory();
      await this.measureDiskIO();
      
      this.compareWithBaseline();
      this.saveResults();
      this.printSummary();
      
      console.log('\n✅ Performance baseline completed successfully');
      return this.results;
    } catch (error) {
      console.error('\n❌ Performance baseline failed:', error.message);
      this.saveResults(); // Save partial results
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const skipTests = args.includes('--skip-tests');
  
  if (args.includes('--help')) {
    console.log(`
Usage: node performance-benchmark.mjs [options]

Options:
  --skip-build    Skip build performance measurement
  --skip-tests    Skip test performance measurement  
  --help          Show this help message

Examples:
  node performance-benchmark.mjs              # Run all benchmarks
  node performance-benchmark.mjs --skip-build  # Skip build measurement
  node performance-benchmark.mjs --skip-tests  # Skip test measurement
    `);
    process.exit(0);
  }
  
  const benchmark = new PerformanceBenchmark();
  await benchmark.runAll(skipBuild, skipTests);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});