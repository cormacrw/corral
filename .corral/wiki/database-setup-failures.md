# Database setup failures

`packages/db/src/failures.ts` holds the failure handling for opening a database
and for test databases. `attemptAll` runs every step even after one fails.
`operationError` wraps the first failure as `cause`, with the operation in the
message; when cleanup also failed it returns an `AggregateError` holding both.

It also scrubs the password in the URL it is given from the message, stack and
string fields of the error, its causes and nested errors. It changes the original
errors in place, so they keep their class and Postgres code. Pass the URL for any
operation that touches a connection string.

`createTestDatabase` drops only the database it generated, and only after the
create succeeded. Its `close` attempts both closing and dropping.
