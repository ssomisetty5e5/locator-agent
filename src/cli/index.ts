#!/usr/bin/env node
// ============================================================
// LocatorAgent CLI
// Analyze live URLs or HTML snapshots from the command line.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { LocatorAgent } from '../agent';
import { AgentInput, ElementAnalysis, PageAnalysis } from '../types';
import { formatWithFrames } from '../util/frames';
import { findWeakElements } from './ciGate';
import type { PageObjectLanguage } from '../pageobject';

/** Version from package.json, so `--version` can't drift from the published one */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('locator-agent')
  .description('Smart web locator generator with Shadow DOM support')
  .version(packageVersion());

program
  .command('analyze')
  .description('Analyze a web page and generate locators')
  .option('-u, --url <url>', 'URL of the page to analyze')
  .option('-f, --file <path>', 'Path to an HTML snapshot file')
  .option('--html <html>', 'Raw HTML string to analyze')
  .option('-a, --all', 'Include non-interactive elements', false)
  .option('-m, --max <number>', 'Maximum elements to return', '50')
  .option('-t, --timeout <ms>', 'Page load timeout in ms', '30000')
  .option('-s, --storage-state <path>', 'Playwright storageState JSON to reuse a logged-in session')
  .option('-j, --json', 'Output as JSON', false)
  .option('--top <n>', 'Show top N locators per element', '3')
  .option('--fail-below <score>', 'CI gate: exit with code 2 if any element\'s best locator scores below this or is not unique')
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
      storageState: opts.storageState,
    };

    const agent = new LocatorAgent();

    try {
      console.log(chalk.cyan('\n🔍 LocatorAgent - Analyzing page...\n'));

      const result = await agent.analyze(input);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printResults(result, parseInt(opts.top, 10));
      }

      if (opts.failBelow !== undefined) {
        const threshold = parseInt(opts.failBelow, 10);
        const weak = findWeakElements(result, threshold);
        if (weak.length > 0) {
          console.error(chalk.red(`\n${weak.length} element(s) failed the locator quality gate (--fail-below ${threshold}):`));
          for (const w of weak) {
            console.error(`  #${w.index} <${w.tag}>${w.text ? ` "${w.text}"` : ''}  ${w.locator}  (${w.reason})`);
          }
          // exitCode, not exit(): the finally block must still close the browser
          process.exitCode = 2;
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
      process.exit(1);
    } finally {
      await agent.shutdown();
    }
  });

program
  .command('page-object')
  .description('Generate a Playwright page object (TypeScript, Python or Java) for a page')
  .option('-u, --url <url>', 'URL of the page')
  .option('-f, --file <path>', 'Path to an HTML snapshot file')
  .option('--html <html>', 'Raw HTML string')
  .option('-n, --class-name <name>', 'Class name (default: derived from the page title)')
  .option('-o, --out <path>', 'Write the class to this file instead of stdout')
  .option('-m, --max <number>', 'Maximum elements to analyze', '100')
  .option('-t, --timeout <ms>', 'Page load timeout in ms', '30000')
  .option('-s, --storage-state <path>', 'Playwright storageState JSON to reuse a logged-in session')
  .option('--min-score <n>', 'Skip elements whose best locator scores below this', '0')
  .option('-l, --language <lang>', 'Output language: typescript, python or java', 'typescript')
  .option('--package <name>', 'Java only: package declaration for the generated class')
  .option('--import-from <module>', 'TypeScript only: module to import Page/Locator types from', '@playwright/test')
  .option('--no-goto', 'Do not generate a goto() method')
  .option('-j, --json', 'Output the full result (class, code, elements) as JSON', false)
  .action(async (opts) => {
    if (!opts.url && !opts.file && !opts.html) {
      console.error(chalk.red('Error: Provide --url, --file, or --html'));
      process.exit(1);
    }

    const agent = new LocatorAgent();
    try {
      // Progress goes to stderr so stdout stays clean for piping the generated code
      console.error(chalk.cyan('Analyzing page...'));
      const result = await agent.generatePageObject(
        {
          url: opts.url,
          filePath: opts.file,
          html: opts.html,
          maxElements: parseInt(opts.max, 10),
          timeout: parseInt(opts.timeout, 10),
          storageState: opts.storageState,
        },
        {
          className: opts.className,
          language: String(opts.language).toLowerCase() as PageObjectLanguage,
          javaPackage: opts.package,
          importFrom: opts.importFrom,
          minScore: parseInt(opts.minScore, 10),
          noGoto: opts.goto === false,
        },
      );

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (opts.out) {
        fs.writeFileSync(opts.out, result.code, 'utf-8');
        const unverified = result.elements.filter((e) => !e.verified).length;
        console.error(chalk.green(`Wrote ${result.className} with ${result.elements.length} elements to ${opts.out}`));
        if (result.skipped > 0) console.error(chalk.gray(`  ${result.skipped} element(s) skipped`));
        if (unverified > 0) console.error(chalk.yellow(`  ${unverified} locator(s) could not be verified unique (marked TODO)`));
      } else {
        process.stdout.write(result.code);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
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
  console.log(`  ${chalk.bold('Frames:')}       ${result.framesAnalyzed ?? 1}`);
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

    if (el.framePath && el.framePath.length > 0) {
      console.log(`  ${chalk.magenta(`Inside iframe: ${el.framePath.join(' → ')}`)}`);
    }

    // Recommended
    const rec = analysis.recommended;
    console.log(`  ${chalk.green.bold('★ Recommended:')} [${rec.strategy}/${rec.framework}] ${chalk.white(formatWithFrames(rec))} ${chalk.gray(`(score: ${rec.score})`)}`);

    // Top N alternatives
    const alternatives = analysis.locators
      .filter((l) => l.value !== rec.value)
      .slice(0, topN - 1);

    if (alternatives.length > 0) {
      console.log(`  ${chalk.yellow('  Alternatives:')}`);
      alternatives.forEach((loc) => {
        console.log(`    ${chalk.gray(`[${loc.strategy}/${loc.framework}]`)} ${formatWithFrames(loc)} ${chalk.gray(`(score: ${loc.score})`)}`);
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
