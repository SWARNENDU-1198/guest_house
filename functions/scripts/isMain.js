import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// True when the module at metaUrl is the script Node was started with.
// Comparing against `file://${argv[1]}` breaks on Windows (backslashes, drive letter).
export const isMain = (metaUrl) => Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === metaUrl;
