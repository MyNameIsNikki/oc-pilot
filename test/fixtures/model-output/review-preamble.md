Sure! Here is the review you asked for.

### Analysis: One problem found in the lookup path.

#### Findings / Actions
- **Critical** `src/db/users.ts:88`: the query is built by string concatenation, so user input reaches SQL.

#### Solution
```ts
const rows = await db.query("select * from users where id = $1", [id]);
```
