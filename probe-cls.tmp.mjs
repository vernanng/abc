import { classify } from './dist/classify.js';
for (const p of ['.env.example', 'config/.env.example', '.env', '.env.local', 'docs/.env.sample']) {
  const r = classify([{ path: p, status: 'M' }], '+x\n');
  console.log(p, '=>', r.level, r.labels.join(','));
}
