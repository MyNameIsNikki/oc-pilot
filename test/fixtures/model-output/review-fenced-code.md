### Analysis: The timeout change removes the safety margin.

#### Findings / Actions
- **🔴 Critical `src/config.ts:7`**: the request timeout is now zero, so every call aborts immediately.

```ts
// the broken shape, shown for context:
- critical: timeout = 0
- warning: retries = -1
```

#### Solution
```ts
export const requestTimeoutMs = 30_000;
```
