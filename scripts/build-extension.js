// Bundles the browser extension (extension/dist/*.js) and, for tests, the in-page engine.
//
//   node scripts/build-extension.js            -> extension/dist/content.js, background.js
//   const { buildExtension } = require('./build-extension')   (used by tests)
//
// The page-side traversal scripts are written as strings in the Node pipeline
// (they are passed to page.evaluate). Extensions can't eval, so they are turned
// into real functions here, at build time, through the `virtual:page-scripts` module.

const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');

/** Compile a TypeScript file for Node and return its exports. */
function loadTs(relativePath) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

/** Source of the `virtual:page-scripts` module. */
function pageScriptsSource() {
  const { getBrowserTraversalScript } = loadTs('src/traverser/shadowDomTraverser.ts');
  const { getAncestorProbeScript } = loadTs('src/discoverer/ancestorProbe.ts');

  // The probe embeds its node index as a literal; swap in the parameter instead
  const SENTINEL = '2147483000';
  const probe = getAncestorProbeScript(Number(SENTINEL)).split(SENTINEL).join('nodeIndex');

  return [
    'export function traverse(document, window) {',
    `  return (${getBrowserTraversalScript().trim()});`,
    '}',
    'export function ancestorProbe(document, window, nodeIndex) {',
    `  return (${probe.trim()});`,
    '}',
  ].join('\n');
}

const pageScriptsPlugin = {
  name: 'page-scripts',
  setup(build) {
    build.onResolve({ filter: /^virtual:page-scripts$/ }, () => ({ path: 'page-scripts', namespace: 'page-scripts' }));
    build.onLoad({ filter: /.*/, namespace: 'page-scripts' }, () => ({ contents: pageScriptsSource(), loader: 'js' }));
  },
};

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  plugins: [pageScriptsPlugin],
  logLevel: 'warning',
};

/**
 * Build the extension bundles.
 * @param {{ outdir?: string, engineOut?: string }} options
 *   engineOut: when set, also writes the in-page engine as an IIFE exposing
 *   `window.LocatorAgentEngine` (used by tests to run it in a real page).
 */
async function buildExtension(options = {}) {
  const outdir = options.outdir || path.join(root, 'extension', 'dist');

  if (options.engineOut) {
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, 'extension/src/engine/index.ts')],
      format: 'iife',
      globalName: 'LocatorAgentEngine',
      outfile: options.engineOut,
    });
    return;
  }

  await esbuild.build({
    ...common,
    entryPoints: {
      content: path.join(root, 'extension/src/content/index.ts'),
      background: path.join(root, 'extension/src/background.ts'),
    },
    format: 'iife',
    outdir,
  });
}

module.exports = { buildExtension };

if (require.main === module) {
  buildExtension()
    .then(() => console.log('Extension built: extension/dist'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
