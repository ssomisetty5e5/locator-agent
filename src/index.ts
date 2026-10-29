// ============================================================
// Library entry point: `import { LocatorAgent } from 'locator-agent'`
// (the CLI lives in ./cli and is exposed as the `locator-agent` binary)
// ============================================================

export { LocatorAgent } from './agent';
export { generatePageObject, LANGUAGES } from './pageobject';
export type { PageObjectOptions, GeneratedPageObject, GeneratedElement, PageObjectLanguage } from './pageobject';
export { findWeakElements } from './cli/ciGate';
export type { WeakElement } from './cli/ciGate';
export * from './types';
