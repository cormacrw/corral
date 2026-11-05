# Writing tests

A test should fail only when behaviour breaks. A November 2026 audit found the web suite passing 5/5 runs in a row, yet breaking on almost every UI change. It pinned copy, classes and demo data, so restyling a screen meant fixing dozens of tests. Those tests were cut or rewritten. Don't add them back.

## What to assert

- What was sent: the API call and its payload, the emitted event, the navigation.
- What a user can see change for given data: an item appears or goes, a button is disabled, an error and its Retry show.
- State that has to survive something: drafts, selection, cache through a live refresh.
- Branches in logic: which rule wins, `null` versus a value, which kind or variant comes back.

## What not to assert

- Exact copy, labels, colours, icon names or Tailwind classes. Check a key fact with `toContain` (a ref, a count, a name), not a whole sentence with `toBe`. Text joined from several elements, like `'Fix the loginLogin'`, pins markup.
- Layout: DOM order, which container holds the actions, element identity across renders, compiled CSS.
- Props passed to a stub, or a component's internals (`wrapper.vm.x()`, a stub's `$attrs.onSubmit`). Click the button and type into the input instead.
- Demo data. `~/prototype/fixtures` and the mock API are for `pnpm dev:demo`, not test input. Editing demo data must not break app tests, so build small inline data in the test.
- Prompt and instruction wording. Assert that injected data (refs, SHAs, feedback) and conditional sections are present or absent.

## Where a test goes

Test logic where it lives. Selection, gating and cache rules belong in composable or util tests with a fake `api` and `testQueryClient`. Mount a page only for behaviour that spans components, and keep a few of those per page. A helper that has to stub a dozen globals is a sign the test is aimed at the wrong level.

Find elements by role, label or `data-testid`, never by class.

## Determinism

- No real waits. Use fake timers for debounce, double tap and timeouts. Wait for a positive outcome with `expect.poll` (5s default in server and runner) or `vi.waitFor`, never a `sleep` before the assertion. A sleep before a "nothing happened" check proves little; prefer waiting for the event that would have come first.
- Reset everything a test changes, in `afterEach`, not at the end of the test body, so one failure can't break the next test: unmount wrappers, `vi.restoreAllMocks()`/`resetAllMocks()`, `vi.unstubAllGlobals()`, storage, module-level refs.
- Build dates that hold in any time zone, or compare in UTC.
- Sort rows before comparing unless the query has an `ORDER BY`.
- A check should be able to fail. If a selector matches nothing whatever the component does, the `exists()).toBe(false)` after it proves nothing.
