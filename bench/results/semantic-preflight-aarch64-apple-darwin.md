# Semantic runtime preflight receipt

- Result: **PASS**
- Generated: 2026-08-24T02:11:18.027Z
- Target: `aarch64-apple-darwin` (darwin/arm64)
- Embedding dimension: 384
- Manifest: `manifest.json` · `3c31b4a1841eae2097a75c78fa0ac92396345e459f7f2f0e64597873bdf88110` · verified

## Verified assets

| Asset | File | SHA-256 | Version / commit |
| --- | --- | --- | --- |
| SQLite | `libsqlite3.3.53.3.dylib` | `b64abb706584a8952e67a3efd872e3fe6e6852c6a2a0d09adec2e94c4ab08ca5` | `system` |
| vec0 | `vec0.dylib` | `b098417690d57c5bf8a0f1bcb999b811f0b2511a693f8349eba8337804258727` | `0.1.8` |
| lembed0 | `lembed0.dylib` | `af84d62dd1ca9ea9f935cbeac04f315c85fd0cc7df40f6a0e92b5286ff03d969` | `0.0.1-alpha.8` |
| all-MiniLM-L6-v2 | `all-MiniLM-L6-v2.e4ce9877.q8_0.gguf` | `71f1d177171468fb5f186c07019e303015aea17af275a67767760bba7be8d2e6` | `7a7bac37782986fe1d4f213de771a8a3d9170b35` |

## Compiled smoke

- compiled-against-bundled-sqlite
- loaded-vec0-and-lembed0
- queried-nonempty-extension-versions
- registered-pinned-minilm-model
- executed-vec0-knn

## Source-tree binding

- Git revision: `264fcc804588cfa5b2703ea68773e153b566ad59`
- Input digest: `6ff63bacb2c14d94811ca08fdeca82459558c6696b97b2e249aa665faec4706d`
- `scripts/prepare-semantic-assets.ts` · `c4691d200c75a2d61f524a8efb3b70efd6c12354c5389b823019491d6121eea4`
- `packages/core/package.json` · `8a3880f24187ca6d581c4de9257be10dee19f292296b9732e87e9cecf8f45eeb`
- `package.json` · `12aa7a0eea22055963542a86f38710762636d090202496880fb438a60c236f02`
- `bun.lock` · `bcccbe6eca82c2b38bac6914ba96669d5a33acb08546f5ff270255a941615e8c`

## Not claimed

- No evidence is claimed for any target other than aarch64-apple-darwin.
- The smoke proves artifact loading and one vector query, not semantic retrieval quality.
- The receipt does not attest the identity of the machine or builder.

Receipt digest: `ad4163f9b015bc091954d0bc7cb5bd7a55dba0d53f5f5c7f0242b02929d6cd44`
