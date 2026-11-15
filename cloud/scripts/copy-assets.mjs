// tsc only compiles TypeScript; the SQL migrations have to travel with the build.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/src/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/src/db/migrations', { recursive: true });
console.log('migrations copied to dist/src/db/migrations');
