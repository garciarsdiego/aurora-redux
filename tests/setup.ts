// Sprint 5.1 (D-H2.066): vitest setup file.
//
// Loads jest-dom matchers when the test environment provides `document`
// (i.e. JSDOM-enabled tests). Node-environment tests are unaffected.

if (typeof document !== 'undefined') {
  // Async import keeps this no-op cost for Node-env tests (no JSDOM).
  await import('@testing-library/jest-dom/vitest');

  // Auto-cleanup the DOM between tests so getByRole('button') etc. don't
  // pick up nodes from previous renders. React Testing Library v16 ships
  // an opt-in cleanup that we register globally here.
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });

  // JSDOM shims that dashboard-v2 components rely on. Centralized here so
  // tests work regardless of which setup file vitest loads.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (typeof window !== 'undefined') {
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
    }
    // useDrafts and similar gates the destructive path behind window.confirm.
    // Tests assume confirmation is granted; default to true here.
    window.confirm = () => true;
  }
}
