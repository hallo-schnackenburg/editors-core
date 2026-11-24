# editors-core

What the editors of the Schnackenburg databases have in common: `archive-editor` and `contents-editor`.
It is TypeScript source that the editors bundle with their own code (Vite, Wrangler); there is no build step.

```
import { readField } from 'editors-core/yaml/read'
import { createAuth } from 'editors-core/worker/auth'
```

Every file below `src/` is reached by its path without `src/` and `.ts`.

- `src/yaml`: reading YAML and finding where an issue belongs in the text
- `src/worker`: what a Cloudflare Worker of an editor needs: the session cookie, signing in with GitHub, the GitHub client
  (`github.ts`), the hub that tells every open browser that something changed, and the webhook that feeds it
- `src/app`: what the browser side needs: the live connection

What differs between the editors (cookie names, the prefix of the branches) is handed in by the editor: `createAuth`,
`createHook`.

## Using it

While both editors and this repository lie next to each other (all below `code/`), they use it as `"editors-core": "file:../../editors-core"`.
The editors bundle its source from where it really lies, so `npm install` has to be run in this repository too (its
`node_modules` hold `yaml`). Once it is on GitHub: `"editors-core": "github:hallo-schnackenburg/editors-core#v0.1.0"` (a tag, so that an editor
changes only when it is moved on purpose; `npm install` locks the commit). Tested: Vitest, Vite, Wrangler and `tsx` (the check
in the data repositories) all take the TypeScript source from `node_modules`.

## Develop

```
npm install
npm test
npm run typecheck
```
