# Developer claim order

Developer claims sort by priority, then unleased In progress before Ready, then
creation time and id. Priority takes precedence over status. The same total order
is used for every PLACE_BATCH page; dependency filters and runner placement
continue to skip blocked candidates without leasing them.

Reviewer claims retain priority, creation time and id ordering.
Implementation: apps/server/src/claim.ts. Regression scenarios, including tied
timestamps and placement across a status boundary, are in claim.test.ts.
