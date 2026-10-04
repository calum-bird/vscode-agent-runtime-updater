import Module from 'node:module';
import type { TestContext } from 'node:test';

interface ModuleLoader {
  _load(request: string, parent: NodeModule | null | undefined, isMain?: boolean): unknown;
}

const moduleLoader = Module as unknown as ModuleLoader;

// The compiled tests exercise CommonJS loading just as the extension host does.
export function loadWithMocks<T>(
  t: TestContext,
  modulePath: string,
  mock: (request: string, parent: NodeModule | null | undefined) => unknown
): T {
  const previous = require.cache[modulePath];
  const load = moduleLoader._load;
  const loader = t.mock.method(
    moduleLoader,
    '_load',
    (name: string, parent: NodeModule | null | undefined, isMain?: boolean) => {
      const replacement = mock(name, parent);
      return replacement === undefined ? load.call(Module, name, parent, isMain) : replacement;
    }
  );
  delete require.cache[modulePath];
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  try {
    return require(modulePath) as T;
  } finally {
    loader.mock.restore();
  }
}
