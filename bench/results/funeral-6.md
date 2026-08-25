# Laptop Funeral — PASS

Schema: `pylos.bench.laptop-funeral.v3` · source and restore both passed full chain verification.

## Archive and transport

- Source episodes: **1,000,000**; restored episodes: **1,000,000**; import reported **1,000,000** episodes.
- Source and restore head: `602ce624efd20b1bb9d2354a552351ec062e1e4b87de558468dd0890429c27da` (identical).
- Full verify: source through #1,000,000; restore through #1,000,000.
- Bundle: **434,722,285 bytes (414.583 MiB)**.
- Bundle SHA-256: `ade96e8277537f8639f67fba87534d4e7c15465a9c3ff01cb4cdaa4bed626ec0`.
- Source manifest: `beab4c111198f508b4caa6be985c2ae8f7d4e51b579f0dd7471882293af5f306`; restore manifest: `beab4c111198f508b4caa6be985c2ae8f7d4e51b579f0dd7471882293af5f306` (identical).
- Timing: export **13.178s** · import **72.705s** · total **151.723s**.
- Staging telemetry: export max staged **434,712,708 bytes (414.574 MiB)**, import max staged **434,722,285 bytes (414.583 MiB)**, max rows **1,000,000**.
- Transport buffer: declared bound **35,848,320 bytes (34.188 MiB)**; export peak **35,848,320 bytes (34.188 MiB)**, import peak **35,848,320 bytes (34.188 MiB)**; both stayed within the declared bound.

## Transported tables

| Table | Source count | Restore count |
| --- | ---: | ---: |
| episodes | 1,000,000 | 1,000,000 |
| atoms | 0 | 0 |
| capsules | 0 | 0 |
| capsuleLedgerEntries | 0 | 0 |
| loss | 0 | 0 |
| packets | 0 | 0 |
| tombstones | 0 | 0 |
| addressRoutes | 0 | 0 |
| addressAliases | 0 | 0 |
| atomizationReceipts | 0 | 0 |

## Exact page

- Requested page: turn **#730,000**.
- Source and restore page digests equal: **yes**; byte-exact page: **yes**.
- Page digest: `fd2b26077046628b0807012cfa780df4d89fbec0bc751015657e05e1c3332904`.

## Receipt boundary

| Namespace | Source count | Restore count |
| --- | ---: | ---: |
| packet | 0 | 0 |
| request-round | 0 | 0 |
| reachability | 0 | 0 |
| coverage | 0 | 0 |
| evidence | 0 | 0 |
| answer | 0 | 0 |
| semantic | 0 | 0 |
| address-route | 0 | 0 |
| address-alias | 0 | 0 |
| atomization | 0 | 0 |
| capsule-ledger | 0 | 0 |
| tombstone | 0 | 0 |
| attachment-manifest | 0 | 0 |

- Exercised namespaces: none.
- Unexercised namespaces: `packet`, `request-round`, `reachability`, `coverage`, `evidence`, `answer`, `semantic`, `address-route`, `address-alias`, `atomization`, `capsule-ledger`, `tombstone`, `attachment-manifest`.

**Important limitation:** any namespace listed as unexercised has only a matching empty-set transport digest. This artifact does **not** license nonempty Phase 2/4 receipt survival for those namespaces.

## Memory observations

- RSS snapshot before export: **1,127,890,944 bytes (1075.641 MiB)**.
- RSS snapshot after export: **1,168,621,568 bytes (1114.484 MiB)**.
- RSS snapshot after import: **1,132,920,832 bytes (1080.438 MiB)**.
- RSS snapshot after verify: **1,134,247,936 bytes (1081.703 MiB)**.
- Maximum sampled RSS: **1,168,621,568 bytes (1114.484 MiB)**. RSS snapshots are observations, not an absolute process-memory bound; the transport bound above is the kernel progress contract.

Result duration measured by the harness: **151.723s**.

