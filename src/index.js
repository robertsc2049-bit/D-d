import path from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? path.resolve('data', 'campaigns.json');
const apiKey = process.env.API_KEY;
const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');

if (!apiKey) {
  console.warn('WARNING: API_KEY is not set. Anyone who finds this server can read and change your campaigns.');
}

const store = new Store(dataFile);
const app = createApp({ store, apiKey, publicUrl, log: (line) => console.log(line) });

app.listen(port, () => {
  console.log(`Solo Adventure Engine listening on port ${port}`);
  console.log(`Campaign data: ${dataFile}`);
  console.log(`OpenAPI spec:  ${publicUrl ?? `http://localhost:${port}`}/openapi.json`);
});
