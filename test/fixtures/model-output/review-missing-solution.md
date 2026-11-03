### Analysis: One blocking problem in the migration.

#### Findings / Actions
- **🔴 Critical `db/migrate.ts:88`**: the migration runs without a transaction, so a failure leaves the schema half-applied.
