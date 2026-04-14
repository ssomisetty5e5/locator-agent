#!/usr/bin/env node
// ============================================================
// LocatorAgent CLI
// Analyze live URLs or HTML snapshots from the command line.
// ============================================================

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { LocatorAgent } from '../agent';
import { AgentInput, ElementAnalysis, PageAnalysis } from '../types';

const program = new Command();

program
  .name('locator-agent')
  .description('Smart web locator generator with Shadow DOM support')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze a web page and generate locators')
  .option('-u, --url <url>', 'URL of the page to analyze')
  .option('-f, --file <path>', 'Path to an HTML snapshot file')
  .option('--html <html>', 'Raw HTML string to analyze')
  .option('-a, --all', 'Include non-interactive elements', false)
  .option('-m, --max <number>', 'Maximum elements to return', '50')
  .option('-t, --timeout <ms>', 'Page load timeout in ms', '30000')
  .option('-j, --json', 'Output as JSON', false)
  .option('--top <n>', 'Show top N locators per element', '3')
  .action(async (opts) => {
    if (!opts.url && !opts.file && !opts.html) {
      console.error(chalk.red('Error: Provide --url, --file, or --html'));
      process.exit(1);
    }

    const input: AgentInput = {
      url: opts.url,
      filePath: opts.file,
      html: opts.html,
      includeNonInteractive: opts.all,
      maxElements: parseInt(opts.max, 10),
      timeout: parseInt(opts.timeout, 10),
    };

    const agent = new LocatorAgent();

    try {
      console.log(chalk.cyan('\n🔍 LocatorAgent - Analyzing page...\n'));

      const result = await agent.analyze(input);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printResults(result, parseInt(opts.top, 10));
    } catch (err: any) {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
      process.exit(1);
    } finally {
      await agent.shutdown();
    }
  });

function printResults(result: PageAnalysis, topN: number): void {
  // Summary header
  console.log(chalk.green.bold('✅ Analysis Complete\n'));
  console.log(`  ${chalk.bold('Source:')}       ${result.source}`);
  console.log(`  ${chalk.bold('Page Title:')}   ${result.pageTitle}`);
  console.log(`  ${chalk.bold('DOM Elements:')} ${result.totalDomElements}`);
  console.log(`  ${chalk.bold('Interactive:')}  ${result.interactiveElementsFound}`);
  console.log(`  ${chalk.bold('Shadow Roots:')} ${result.shadowRootsPierced}`);
  console.log('');

  if (result.elements.length === 0) {
    console.log(chalk.yellow('  No interactive elements found.'));
    return;
  }

  // Per-element output
  result.elements.forEach((analysis, index) => {
    const el = analysis.element;
    const label = el.text
      ? `<${el.tag}> "${el.text.substring(0, 40)}"`
      : `<${el.tag}>`;
    const attrs = Object.entries(el.attributes)
      .filter(([k]) => ['id', 'name', 'class', 'type', 'data-testid', 'aria-label', 'role', 'href', 'placeholder'].includes(k))
      .map(([k, v]) => `${k}="${v.substring(0, 30)}"`)
      .join(' ');

    console.log(chalk.cyan.bold(`  ─── Element ${index + 1}: ${label} ───`));
    if (attrs) {
      console.log(`  ${chalk.gray(attrs)}`);
    }
    if (el.shadowDepth > 0) {
      console.log(`  ${chalk.magenta(`Shadow DOM depth: ${el.shadowDepth} | hosts: ${el.shadowHostChain.join(' → ')}`)}`);
    }

    // Recommended
    const rec = analysis.recommended;
    console.log(`  ${chalk.green.bold('★ Recommended:')} [${rec.strategy}/${rec.framework}] ${chalk.white(rec.value)} ${chalk.gray(`(score: ${rec.score})`)}`);

    // Top N alternatives
    const alternatives = analysis.locators
      .filter((l) => l.value !== rec.value)
      .slice(0, topN - 1);

    if (alternatives.length > 0) {
      console.log(`  ${chalk.yellow('  Alternatives:')}`);
      alternatives.forEach((loc) => {
        console.log(`    ${chalk.gray(`[${loc.strategy}/${loc.framework}]`)} ${loc.value} ${chalk.gray(`(score: ${loc.score})`)}`);
      });
    }

    console.log('');
  });

  // Summary table
  const table = new Table({
    head: [
      chalk.white('Strategy'),
      chalk.white('Count'),
      chalk.white('Avg Score'),
    ],
    colWidths: [25, 10, 12],
  });

  const strategyStats = new Map<string, { count: number; totalScore: number }>();
  for (const analysis of result.elements) {
    for (const loc of analysis.locators) {
      const stats = strategyStats.get(loc.strategy) || { count: 0, totalScore: 0 };
      stats.count++;
      stats.totalScore += loc.score;
      strategyStats.set(loc.strategy, stats);
    }
  }

  for (const [strategy, stats] of strategyStats) {
    table.push([
      strategy,
      stats.count.toString(),
      (stats.totalScore / stats.count).toFixed(1),
    ]);
  }

  console.log(chalk.bold('  📊 Strategy Summary:'));
  console.log(table.toString());
  console.log('');
}

program.parse();
