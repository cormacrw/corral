import type { Project, PullRequestFile, RunEvent, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { demoSha, type Seeder } from './harness.ts'

// The demo's story: two projects over about two weeks, told in order. Each
// step goes through the server the way the human, the agents and GitHub
// would, so the states at the end are real ones. When adding to it, keep at
// most one task runnable at a time: every schedule() hands all runnable work
// to the fake runner, and a run nobody finishes is left holding a lease.

const ASSETS = join(import.meta.dirname, 'assets')
const asset = (name: string) => readFileSync(join(ASSETS, name))

export async function seedDemo(t: Seeder): Promise<void> {
  await t.request('PATCH', '/api/me', { name: 'Sam Rivera' })
  const shop = await t.project({ name: 'Storefront', prefix: 'SHOP', repository: 'acme/storefront' })
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'], thumbnailColor: '#f97316' }).where(eq(schema.projects.id, shop.id))
  const notes = await t.project({ name: 'Field Notes', prefix: 'NOTE', repository: 'acme/field-notes', humanReviewDefault: true })
  await t.db.update(schema.projects).set({ thumbnailColor: '#16a34a' }).where(eq(schema.projects.id, notes.id))
  await t.advance('2h')

  await storefrontFoundations(t, shop)
  await fieldNotesFoundations(t, notes)
  await wishlistParent(t, shop)
  await notesDesign(t, notes)
  await storefrontFixes(t, shop)
  await offlineSpike(t, notes)
  await storefrontStuck(t, shop)
  await releaseNotes(t, shop)
  await planConversations(t, notes)
  await inFlight(t, shop, notes)
  await backlogs(t, shop, notes)
  // Released without a schedule: the work held back in inFlight waits for
  // runners the demo doesn't have
  await t.db.update(schema.agents).set({ paused: false }).where(eq(schema.agents.role, 'developer'))
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, notes.id))

  const active = await t.db.select({ id: schema.runs.id, role: schema.runs.role, taskId: schema.runs.taskId, state: schema.runs.state, runnerId: schema.runs.runnerId, lease: schema.runs.leaseExpiresAt }).from(schema.runs)
  // A queued run no runner has taken is fine: it waits for one
  const live = active.filter(r => ['queued', 'starting', 'running', 'waiting_for_input', 'stopping'].includes(r.state) && (r.runnerId || r.lease))
  if (live.length > 0) throw new Error(`The story left runs in flight, which would hold leases: ${JSON.stringify(live)}`)
}

// ---- Flows ----

interface DevelopInput {
  head: string
  summary: string
  note: string
  files?: PullRequestFile[]
  outcome?: 'pr_opened' | 'pr_updated'
  // Evidence per criterion, by position; a note by default
  evidence?: (t: Seeder, job: RunJob, task: Task) => Promise<void>
  checks?: 'success' | 'pending' | 'failure'
  minutes?: number
  // Runs just before the developer reports
  beforeReport?: () => Promise<void>
}

async function develop(t: Seeder, project: Project, task: Task, input: DevelopInput): Promise<RunJob> {
  const job = await t.jobFor(task, 'developer')
  await t.started(job)
  await t.transcript(job, developerTranscript(task, input))
  await t.advance(`${input.minutes ?? 30}m`)
  const sha = await t.pushed(project, job, `${task.ref}-${input.head}`, {
    files: input.files ?? [],
    checks: [{ name: 'ci', conclusion: input.checks ?? 'success', url: `https://github.com/${project.repository}/actions/runs/${parseInt(demoSha(input.head).slice(0, 6), 16)}` }]
  })
  if (input.evidence) await input.evidence(t, job, task)
  else for (const c of task.acceptanceCriteria.filter(c => !c.checkedByHuman)) await t.evidenceNote(job, c.id, `Covered by a test: ${c.text.toLowerCase()}.`)
  await input.beforeReport?.()
  await t.reportDeveloper(job, { outcome: input.outcome ?? 'pr_opened', summary: input.summary, note: input.note, headSha: sha })
  return job
}

async function review(t: Seeder, task: Task, outcome: 'approved' | 'changes_requested', summary: string, notes: (string | { met: boolean, note: string })[], minutes = 8): Promise<void> {
  const job = await t.jobFor(task, 'reviewer')
  await t.started(job)
  await t.transcript(job, [
    { type: 'thinking', text: `Reviewing ${task.ref} against its ${task.acceptanceCriteria.length} criteria. Start with the diff, then the evidence.` },
    { type: 'tool_call', id: 'r1', tool: 'Bash', input: { command: 'git diff origin/main...HEAD --stat' } },
    { type: 'tool_result', id: 'r1', output: ' 4 files changed, 132 insertions(+), 18 deletions(-)', isError: false },
    { type: 'tool_call', id: 'r2', tool: 'mcp__corral__get_evidence', input: {} },
    { type: 'tool_result', id: 'r2', output: 'Evidence for every criterion', isError: false },
    { type: 'message', text: summary }
  ], { inputTokens: 21_000, cacheReadTokens: 96_000, outputTokens: 1_800 })
  await t.advance(`${minutes}m`)
  await t.reportReviewer(job, task, outcome, summary, notes)
}

// Developer, reviewer and merge, the whole way
async function ship(t: Seeder, project: Project, task: Task, input: DevelopInput & { review: string, notes?: string[] }): Promise<void> {
  await develop(t, project, task, input)
  await t.advance('6m')
  await review(t, task, 'approved', input.review, input.notes ?? [])
  await t.advance('3m')
  await t.mergePass()
}

function developerTranscript(task: Task, input: DevelopInput): RunEvent[] {
  const files = input.files ?? []
  const events: RunEvent[] = [
    { type: 'system', text: `Worktree ready on corral/${task.ref.toLowerCase()}` },
    { type: 'thinking', text: `${task.title}. ${task.acceptanceCriteria.length} criteria to cover. Read the code it touches first.` }
  ]
  files.forEach((file, i) => {
    events.push({ type: 'tool_call', id: `read-${i}`, tool: 'Read', input: { file_path: file.path } })
    events.push({ type: 'tool_result', id: `read-${i}`, output: `${file.additions + 40} lines`, isError: false })
  })
  files.forEach((file, i) => {
    events.push({ type: 'tool_call', id: `edit-${i}`, tool: file.status === 'added' ? 'Write' : 'Edit', input: { file_path: file.path } })
    events.push({ type: 'tool_result', id: `edit-${i}`, output: 'ok', isError: false })
  })
  events.push(
    { type: 'tool_call', id: 'test', tool: 'Bash', input: { command: 'pnpm test --run' } },
    { type: 'tool_result', id: 'test', output: ' Test Files  38 passed (38)\n      Tests  412 passed (412)\n   Duration  9.84s', isError: false },
    { type: 'message', text: input.summary }
  )
  return events
}

function patch(path: string, lines: string[], status: PullRequestFile['status'] = 'modified'): PullRequestFile {
  const added = lines.filter(l => l.startsWith('+')).length
  const removed = lines.filter(l => l.startsWith('-')).length
  return { path, status, additions: added, deletions: removed, patch: `@@ -1,${removed + 3} +1,${added + 3} @@\n${lines.join('\n')}` }
}

const testOutput = (lines: string) => ({ kind: 'test_output' as const, fileName: 'vitest.txt', contentType: 'text/plain', data: lines, note: 'Test run' })

// ---- Storefront ----

async function storefrontFoundations(t: Seeder, shop: Project): Promise<void> {
  const images = await t.task(shop, {
    title: 'Lazy-load product images below the fold',
    description: 'The category pages download every product image up front. Load the ones below the fold as they scroll into view.',
    implementationPlan: '- `src/components/ProductImage.vue`: add `loading` and `decoding="async"`, and set `width` and `height` from the product data so nothing shifts.\n- `src/components/ProductGrid.vue`: pass `eager` to the first row only (`i < columns`).\n- Edge case: the column count changes at breakpoints, so read it from the grid, not a constant.\n- Test: a component test that only the first row is eager; check CLS in Lighthouse on /new.',
    acceptanceCriteria: ['Images below the fold load only when they come within 300 px of the viewport', 'The first row still loads eagerly, with no layout shift'],
    priority: 'high'
  })
  await t.approve(shop, images)
  await t.advance('40m')
  await ship(t, shop, images, {
    head: 'v1',
    summary: 'Product images below the fold now use loading="lazy" with explicit sizes; the first row stays eager. Largest contentful paint on /new drops from 3.1 s to 1.7 s on the throttled profile.',
    note: 'Lazy-loaded product images below the fold',
    files: [
      patch('src/components/ProductImage.vue', ['-<img :src="src" :alt="alt">', '+<img :src="src" :alt="alt" :width="width" :height="height"', '+  :loading="eager ? \'eager\' : \'lazy\'" decoding="async">']),
      patch('src/components/ProductGrid.vue', ['-<ProductCard v-for="p in products" :product="p" />', '+<ProductCard v-for="(p, i) in products" :product="p" :eager="i < columns" />'])
    ],
    evidence: async (t, job, task) => {
      await t.evidenceFile(job, task.acceptanceCriteria[0]!.id, testOutput('✓ ProductGrid > lazy-loads images after the first row (4 ms)\n✓ ProductImage > sets width and height to reserve space (2 ms)\n\nTest Files  2 passed (2)\n     Tests  2 passed (2)'))
      await t.evidenceNote(job, task.acceptanceCriteria[1]!.id, 'Lighthouse on /new: CLS 0.00 before and after, LCP 3.1 s → 1.7 s. The first row has loading="eager".')
    },
    review: 'Clean change. Sizes are set from the product data, so there is no layout shift, and the first row is eager.',
    notes: ['loading="lazy" below the first row; browser threshold is about 300 px', 'CLS stays 0 in the Lighthouse run']
  })
  await t.advance('5h')

  const reviews = await t.task(shop, {
    title: 'Show a review summary on the product page',
    description: 'Under the price: the average star rating and how many reviews, linking down to the reviews section.',
    implementationPlan: 'Add `ReviewSummary.vue` beside `ProductPrice` in `src/pages/products/[slug].vue`, reading `product.rating` and `product.reviewCount`. Render nothing at zero reviews. Link to `#reviews`, which `ReviewList` already sets.',
    acceptanceCriteria: ['Shows the average rating to one decimal place and the review count', 'Hidden when a product has no reviews', 'Clicking it scrolls to the reviews section']
  })
  await t.approve(shop, reviews)
  await t.advance('25m')
  await ship(t, shop, reviews, {
    head: 'v1',
    summary: 'Added ReviewSummary under the price with the average (one decimal) and count, hidden at zero reviews, linking to #reviews.',
    note: 'Added the review summary to the product page',
    files: [
      patch('src/components/ReviewSummary.vue', ['+<template>', '+  <a v-if="count > 0" href="#reviews" class="review-summary">', '+    <StarRating :value="average" /> {{ average.toFixed(1) }} · {{ count }} reviews', '+  </a>', '+</template>'], 'added'),
      patch('src/pages/products/[slug].vue', ['   <ProductPrice :product="product" />', '+  <ReviewSummary :average="product.rating" :count="product.reviewCount" />'])
    ],
    review: 'All three criteria are covered by component tests, and the anchor matches the reviews section id.'
  })
  await t.advance('1d')
}

async function fieldNotesFoundations(t: Seeder, notes: Project): Promise<void> {
  const setup = await t.task(notes, {
    title: 'Set up the Expo app with TypeScript and CI',
    description: 'A fresh Expo app, strict TypeScript, ESLint and a GitHub Actions workflow that runs typecheck, lint and tests.',
    acceptanceCriteria: ['`pnpm ios` and `pnpm android` start the app', 'CI runs typecheck, lint and tests on every PR'],
    humanReview: false
  })
  await t.approve(notes, setup)
  await t.advance('20m')
  await ship(t, notes, setup, {
    head: 'v1',
    minutes: 45,
    summary: 'Created the Expo SDK 54 app with strict TypeScript, ESLint flat config and a CI workflow running typecheck, lint and Jest.',
    note: 'Set up Expo, TypeScript and CI',
    files: [
      patch('app.json', ['+{ "expo": { "name": "Field Notes", "slug": "field-notes" } }'], 'added'),
      patch('.github/workflows/ci.yml', ['+name: ci', '+on: [pull_request]', '+jobs:', '+  check:', '+    runs-on: ubuntu-latest'], 'added'),
      patch('tsconfig.json', ['+{ "extends": "expo/tsconfig.base", "compilerOptions": { "strict": true } }'], 'added')
    ],
    review: 'The app starts on both simulators per the evidence, and the workflow has all three steps.'
  })
  await t.advance('3h')

  const search = await t.task(notes, {
    title: 'Search notes by title and text',
    description: 'A search field above the list that filters notes as you type, matching the title and body, ignoring case and accents.',
    acceptanceCriteria: ['Typing filters the list within 100 ms for 1,000 notes', 'Matches ignore case and accents ("cafe" finds "Café")'],
    humanReview: false
  })
  await t.approve(notes, search)
  await t.advance('30m')
  await ship(t, notes, search, {
    head: 'v1',
    summary: 'Search normalizes with NFD and strips diacritics, then filters in memory; 1,000 notes filter in about 12 ms on a mid-range Android.',
    note: 'Added accent-insensitive note search',
    files: [patch('src/notes/search.ts', ['+export function matches(note: Note, query: string) {', '+  const q = fold(query)', '+  return fold(note.title).includes(q) || fold(note.body).includes(q)', '+}'], 'added')],
    review: 'Folding is right and the benchmark in the evidence is well under budget.'
  })
  await t.advance('1d')
}

async function wishlistParent(t: Seeder, shop: Project): Promise<void> {
  const { session, job } = await t.planSession({ projectId: shop.id, text: 'Shoppers keep asking for a way to save products for later. Can you plan a wishlist? It should work without an account and keep items after a reload.' })
  await t.started(job)
  await t.call(job, 'propose_plan', {
    title: 'Wishlist',
    summary: 'Save products from any product card, see them on a wishlist page, and keep them across reloads without an account. Built as one parent so the three parts ship together in one PR.',
    parents: [{ key: 'wishlist', title: 'Wishlist', summary: 'Save products for later, without an account', reviewMode: 'parent' }],
    tasks: [
      { key: 'store', parent: 'wishlist', title: 'Wishlist store that survives reloads', description: 'Shoppers can save products for later, and they are still there after a reload.', implementationPlan: '- New `src/stores/wishlist.ts` Pinia store keyed by product id, with `add`, `remove` and `toggle`.\n- Persist with `useLocalStorage` under `wishlist:v1`; ignore and reset an unreadable value.\n- Edge case: a saved product that no longer exists is dropped when the page loads it.', type: 'task', priority: 'high', acceptanceCriteria: ['Items survive a page reload', 'Toggling a product twice leaves it out of the wishlist'] },
      { key: 'button', parent: 'wishlist', title: 'Heart button on product cards', description: 'A heart on every product card saves or unsaves the product, so shoppers can collect things as they browse.', implementationPlan: 'Add `WishlistButton.vue` to the corner of `ProductCard.vue`, calling `toggle` on the store and showing a toast. Put the saved count in `AppHeader.vue`. Stop the click reaching the card link.', type: 'task', dependsOn: ['store'], acceptanceCriteria: ['Every product card has a heart button that toggles the product', 'The header shows how many products are saved'] },
      { key: 'page', parent: 'wishlist', title: 'Wishlist page', description: 'A /wishlist page listing saved products with Remove and Add to bag.', type: 'task', dependsOn: ['store'], acceptanceCriteria: ['Lists every saved product with its price and stock', 'Remove takes a product off the list straight away'] }
    ]
  })
  await t.pmReply(job, 'Here is a plan for the wishlist: one parent with three sub-tasks. The store comes first; the heart button and the wishlist page can then go in parallel. You review the whole thing once, as the parent\'s PR, rather than three times.')
  await t.advance('15m')
  const [plan] = (await t.session(session.id)).plans
  await t.request('POST', `/api/plan/plans/${plan!.id}/approve`, { to: 'ready' })
  await t.advance('10m')

  const parentTasks = await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, shop.id))
  const byTitle = async (title: string) => t.get(shop, parentTasks.find(row => row.title === title) as unknown as Task)

  const store = await byTitle('Wishlist store that survives reloads')
  await ship(t, shop, store, {
    head: 'v1',
    summary: 'Added useWishlist, a Pinia store persisted to localStorage under acme.wishlist, with add, remove, toggle and has.',
    note: 'Added the persisted wishlist store',
    files: [patch('src/stores/wishlist.ts', ['+export const useWishlist = defineStore(\'wishlist\', () => {', '+  const ids = useLocalStorage<string[]>(\'acme.wishlist\', [])', '+  const toggle = (id: string) => has(id) ? remove(id) : add(id)', '+  return { ids, add, remove, toggle, has }', '+})'], 'added')],
    review: 'Store is small and tested; persistence goes through useLocalStorage so SSR is safe.'
  })
  await t.advance('2h')

  const button = await byTitle('Heart button on product cards')
  await ship(t, shop, button, {
    head: 'v1',
    minutes: 50,
    summary: 'Added WishlistButton to ProductCard and a saved count in the header. The toast names the product.',
    note: 'Added the heart button and header count',
    files: [
      patch('src/components/WishlistButton.vue', ['+<button class="heart" :aria-pressed="saved" @click="wishlist.toggle(product.id)">', '+  <HeartIcon :filled="saved" />', '+</button>'], 'added'),
      patch('src/components/ProductCard.vue', ['   <ProductImage :product="product" />', '+  <WishlistButton :product="product" />']),
      patch('src/components/SiteHeader.vue', ['+<NuxtLink to="/wishlist" class="pill">♥ {{ wishlist.ids.length }}</NuxtLink>'])
    ],
    evidence: async (t, job, task) => {
      await t.evidenceFile(job, task.acceptanceCriteria[0]!.id, { kind: 'screenshot', fileName: 'wishlist-grid.png', contentType: 'image/png', data: asset('wishlist-grid.png'), note: 'Three products saved from the grid; the toast confirms the last one' })
      await t.evidenceFile(job, task.acceptanceCriteria[1]!.id, { kind: 'screenshot', fileName: 'wishlist-grid.png', contentType: 'image/png', data: asset('wishlist-grid.png'), note: 'The header pill shows ♥ 3' })
    },
    review: 'Screenshot matches the criteria and the button has aria-pressed.'
  })
  await t.advance('1h')

  const page = await byTitle('Wishlist page')
  await ship(t, shop, page, {
    head: 'v1',
    summary: 'Added /wishlist with a row per saved product, Remove and Add to bag.',
    note: 'Added the wishlist page',
    files: [patch('src/pages/wishlist.vue', ['+<template>', '+  <h1>Your wishlist</h1>', '+  <WishlistRow v-for="p in products" :key="p.id" :product="p" @remove="wishlist.remove(p.id)" />', '+</template>'], 'added')],
    evidence: async (t, job, task) => {
      await t.evidenceFile(job, task.acceptanceCriteria[0]!.id, { kind: 'screenshot', fileName: 'wishlist-page.png', contentType: 'image/png', data: asset('wishlist-page.png'), note: 'The three saved products with price and stock' })
      await t.evidenceNote(job, task.acceptanceCriteria[1]!.id, 'Component test: clicking Remove drops the row without a reload.')
    },
    review: 'Both criteria shown. Remove is optimistic, which is fine for local data.'
  })
  await t.advance('20m')

  // All three are in: the parent's PR opens and its reviewer checks them together
  const parent = await t.db.select().from(schema.epics).where(eq(schema.epics.projectId, shop.id))
  const epicId = parent[0]!.id
  const integration = await t.job(job => job.epicId === epicId && job.role === 'reviewer')
  for (const pr of t.github.pulls.values()) {
    if (pr.head === integration.branch) {
      t.github.pullFiles.set(pr.number, [
        patch('src/stores/wishlist.ts', ['+export const useWishlist = defineStore(\'wishlist\', () => {'], 'added'),
        patch('src/components/WishlistButton.vue', ['+<button class="heart" :aria-pressed="saved">'], 'added'),
        patch('src/pages/wishlist.vue', ['+<h1>Your wishlist</h1>'], 'added'),
        patch('src/components/ProductCard.vue', ['+  <WishlistButton :product="product" />'])
      ])
      t.github.setChecks(pr.headSha, [{ name: 'ci', conclusion: 'success', url: null }])
    }
  }
  await t.started(integration)
  await t.advance('12m')
  await t.call(integration, 'report_outcome', { outcome: 'approved', summary: 'The three parts fit: the button and page both read the same store, the header count updates from either, and the full suite passes without the cache.', headSha: integration.headSha })
  await t.ended(integration, integration.headSha ?? null)
  await t.advance('1d')
}

async function storefrontFixes(t: Seeder, shop: Project): Promise<void> {
  // Two review rounds: the first misses a criterion
  const currency = await t.task(shop, {
    title: 'Order confirmation email shows the wrong currency',
    type: 'bug',
    description: 'Customers in the UK get confirmation emails with prices in dollars. The email should use the currency the order was paid in.',
    acceptanceCriteria: ['The email formats prices in the order\'s currency', 'Totals match the receipt to the penny for GBP and EUR orders'],
    priority: 'high'
  })
  await t.approve(shop, currency)
  await t.advance('15m')
  await develop(t, shop, currency, {
    head: 'v1',
    summary: 'The email template now formats with the order\'s currency instead of the store default.',
    note: 'Used the order currency in the confirmation email',
    files: [patch('server/emails/order-confirmation.ts', ['-const money = (cents: number) => formatMoney(cents, store.currency)', '+const money = (cents: number) => formatMoney(cents, order.currency)'])]
  })
  await t.advance('6m')
  await review(t, currency, 'changes_requested', 'The currency is right now, but the totals are rounded per line before summing, so a three-item EUR order is a cent off the receipt.', [{ met: true, note: 'Uses order.currency' }, { met: false, note: 'Per-line rounding: €48.33 in the email vs €48.34 on the receipt' }])
  await t.advance('25m')
  await develop(t, shop, currency, {
    head: 'v2',
    outcome: 'pr_updated',
    summary: 'Totals now sum the unrounded line amounts and round once, the same way the receipt does. Added GBP and EUR fixtures that compare the two.',
    note: 'Addressed review: round once, after summing',
    files: [
      patch('server/emails/order-confirmation.ts', ['-const money = (cents: number) => formatMoney(cents, store.currency)', '+const money = (cents: number) => formatMoney(cents, order.currency)', '-const total = lines.reduce((sum, l) => sum + round(l.amount), 0)', '+const total = round(lines.reduce((sum, l) => sum + l.amount, 0))']),
      patch('server/emails/order-confirmation.test.ts', ['+it.each([\'GBP\', \'EUR\'])(\'matches the receipt for %s\', async (currency) => {'], 'added')
    ],
    evidence: async (t, job, task) => {
      await t.evidenceNote(job, task.acceptanceCriteria[0]!.id, 'Snapshot test renders £ and € for GBP and EUR orders.')
      await t.evidenceFile(job, task.acceptanceCriteria[1]!.id, testOutput('✓ order confirmation > matches the receipt for GBP (6 ms)\n✓ order confirmation > matches the receipt for EUR (5 ms)\n\nTest Files  1 passed (1)\n     Tests  2 passed (2)'))
    }
  })
  await t.advance('5m')
  await review(t, currency, 'approved', 'Rounding now matches the receipt, and the new fixtures prove it for both currencies.', ['£ and € in the snapshots', 'Fixtures compare email and receipt totals'])
  await t.advance('2m')
  await t.mergePass()
  await t.advance('4h')

  // Human review: a bug with a check only a person can do
  const promo = await t.task(shop, {
    title: 'Expired promo codes block checkout',
    type: 'bug',
    description: 'Entering an expired code shows a spinner forever and the Pay button never comes back. It should explain that the code expired and let the shopper remove it.',
    acceptanceCriteria: ['An expired code shows "This code expired on <date>" under the field', 'Pay stays enabled once the code is removed', { text: 'Feels right on a real phone with the keyboard open', checkedByHuman: true }],
    humanReview: true,
    priority: 'urgent'
  })
  await t.approve(shop, promo)
  await t.advance('10m')
  // Two rounds of evidence: the second replaces the first round's and attaches
  // nothing to the phone check, so that criterion keeps round 1's screenshot
  await develop(t, shop, promo, {
    head: 'v1',
    minutes: 30,
    summary: 'The client only handled 400 from the promo endpoint, so an expired code (410) never settled. It now handles 410 and stops the spinner.',
    note: 'Stopped the spinner on expired promo codes',
    files: [patch('src/composables/usePromoCode.ts', ['-  if (res.status === 400) error.value = res.data.message', '+  if (res.status === 400 || res.status === 410) error.value = res.data.message', '+  pending.value = false'])],
    evidence: async (t, job, task) => {
      await t.evidenceFile(job, task.acceptanceCriteria[0]!.id, { kind: 'screenshot', fileName: 'checkout-promo-v1.png', contentType: 'image/png', data: asset('checkout-promo.png'), note: 'The spinner is gone and the field says the code is invalid' })
      await t.evidenceNote(job, task.acceptanceCriteria[0]!.id, 'The message is the generic one: the endpoint sends no expiry date yet.')
      await t.evidenceNote(job, task.acceptanceCriteria[1]!.id, 'Playwright: apply an expired code, remove it, Pay is enabled.')
      await t.evidenceFile(job, task.acceptanceCriteria[2]!.id, { kind: 'screenshot', fileName: 'checkout-promo-phone.png', contentType: 'image/png', data: asset('checkout-promo.png'), note: 'iPhone 15 simulator, keyboard open: the message sits above it' })
      await t.evidenceFile(job, null, testOutput('✓ usePromoCode > settles on 410 (3 ms)\n\nTest Files  1 passed (1)\n     Tests  1 passed (1)'))
    }
  })
  await t.advance('6m')
  await review(t, promo, 'changes_requested', 'The spinner is fixed, but the message doesn\'t say when the code expired, which the first criterion asks for.', [{ met: false, note: 'Generic "invalid code" message, no date' }, { met: true, note: 'Covered by the Playwright test' }])
  await t.advance('20m')
  await develop(t, shop, promo, {
    head: 'v2',
    outcome: 'pr_updated',
    minutes: 15,
    summary: 'The promo endpoint returned 410 for expired codes and the client only handled 400, so the request never settled. The client now handles 410 with the expiry date, and the Pay button no longer waits on the promo request.',
    note: 'Addressed review: the message names the expiry date',
    files: [
      patch('src/composables/usePromoCode.ts', ['-  if (res.status === 400) error.value = res.data.message', '+  if (res.status === 400 || res.status === 410) error.value = res.data.message', '+  pending.value = false']),
      patch('server/api/promo.post.ts', ['-  throw createError({ statusCode: 410 })', '+  throw createError({ statusCode: 410, message: `This code expired on ${formatDate(code.expiresAt)}` })'])
    ],
    evidence: async (t, job, task) => {
      await t.evidenceFile(job, task.acceptanceCriteria[0]!.id, { kind: 'screenshot', fileName: 'checkout-promo.png', contentType: 'image/png', data: asset('checkout-promo.png'), note: 'AUTUMN-20 expired on 31 October' })
      await t.evidenceNote(job, task.acceptanceCriteria[1]!.id, 'Playwright: apply an expired code, remove it, Pay is enabled and the order goes through.')
      await t.evidenceFile(job, null, testOutput('✓ usePromoCode > settles on 410 (3 ms)\n✓ promo.post > names the expiry date (4 ms)\n\nTest Files  2 passed (2)\n     Tests  2 passed (2)'))
    }
  })
  await t.advance('7m')
  await review(t, promo, 'approved', 'Root cause found and fixed on both sides; the screenshot shows the message and the e2e test covers removing the code. The phone check is yours.', ['Message and date in the screenshot', 'Covered by the Playwright test'])
  await t.advance('2h')
}

async function storefrontStuck(t: Seeder, shop: Project): Promise<void> {
  // Blocked on a question for the human
  const stock = await t.task(shop, {
    title: 'Sync stock levels from the warehouse API',
    description: 'Every 10 minutes, read stock levels from the warehouse API and update products, so the site stops selling things that are out of stock.',
    acceptanceCriteria: ['Stock updates within 10 minutes of a change in the warehouse', 'A product at zero stock shows "Out of stock" and can\'t be added to the bag'],
    priority: 'high'
  })
  await t.approve(shop, stock)
  await t.advance('30m')
  const job = await t.jobFor(stock, 'developer')
  await t.started(job)
  await t.transcript(job, [
    { type: 'thinking', text: 'The warehouse API docs describe two ways to authenticate. Neither is configured in the repo.' },
    { type: 'tool_call', id: 'g1', tool: 'Grep', input: { pattern: 'WAREHOUSE_' } },
    { type: 'tool_result', id: 'g1', output: 'No matches', isError: false },
    { type: 'message', text: 'I need to know which credentials to use before I can build this.' }
  ])
  await t.advance('18m')
  await t.call(job, 'report_outcome', { outcome: 'stuck', summary: 'The warehouse API supports an API key or OAuth client credentials, and the repo has neither configured. Which should I use, and what is the env var called in production? With a key I can finish today; OAuth needs a token refresh job as well.', note: 'Stuck: need warehouse API credentials' })
  await t.ended(job)
  await t.advance('4m')
  await triage(t, stock, {
    question: 'Atlas is blocked on SHOP-' + stock.number + ' until it knows how to authenticate with the warehouse API. Which should it use?',
    recommendation: 'An API key from WAREHOUSE_API_KEY: it\'s what the warehouse team issues to other services, and it needs no token refresh job.',
    options: ['API key (WAREHOUSE_API_KEY)', 'OAuth client credentials', 'Wait until I\'ve asked the warehouse team'],
    retryOptions: ['API key (WAREHOUSE_API_KEY)', 'OAuth client credentials'],
    comment: 'The code side is clear: a scheduled Nitro task polling /v2/stock and upserting by SKU. The only open question is credentials, which I\'ve asked in the recovery conversation.',
    reply: 'This needs a decision only you can make: which credentials the warehouse API should use. Everything else about the task is clear.'
  })
  await t.advance('3h')

  // Failed: three runs that couldn't get past the same problem
  const applePay = await t.task(shop, {
    title: 'Offer Apple Pay at checkout',
    description: 'Show the Apple Pay button on Safari and iOS when the device supports it.',
    acceptanceCriteria: ['Apple Pay shows on supported devices only', 'A test payment completes in the Stripe test environment']
  })
  await t.approve(shop, applePay)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await t.advance('20m')
    const run = await t.jobFor(applePay, 'developer')
    await t.started(run)
    await t.transcript(run, [
      { type: 'tool_call', id: 'b1', tool: 'Bash', input: { command: 'pnpm stripe:verify-domain' } },
      { type: 'tool_result', id: 'b1', output: 'Error: domain verification file not found at /.well-known/apple-developer-merchantid-domain-association', isError: true }
    ])
    await t.advance('15m')
    await t.call(run, 'report_outcome', { outcome: 'failed', summary: 'Stripe can\'t verify the domain for Apple Pay: the merchant domain association file has to be downloaded from the Stripe dashboard, which I can\'t reach.', note: `Attempt ${attempt}: Apple Pay domain isn't verified` })
    await t.ended(run)
  }
  await t.advance('5m')
  await triage(t, applePay, {
    question: `SHOP-${applePay.number} failed three times on the same step: Stripe needs the Apple Pay domain association file, which only someone with Stripe dashboard access can download. Can you add it?`,
    recommendation: 'Download it from Stripe → Settings → Payment methods → Apple Pay, commit it to public/.well-known/, then retry.',
    options: ['I\'ve added the file, retry', 'Drop Apple Pay for now'],
    retryOptions: ['I\'ve added the file, retry'],
    comment: 'All three runs stopped at domain verification. The implementation itself (Payment Request button behind a capability check) was done in the first run and is on the branch.',
    reply: 'The work itself is done; it\'s blocked on a file only you can get from the Stripe dashboard.'
  })
  await t.advance('1d')
}

// The PM's one triage turn for a Blocked or Failed task: a comment on the
// task and a question for the human in its recovery conversation
async function triage(t: Seeder, task: Task, input: { question: string, recommendation: string, options: string[], retryOptions: string[], comment: string, reply: string }): Promise<void> {
  const job = await t.job(job => job.role === 'pm' && job.prompt.includes(`Automatic recovery for ${task.ref} `))
  await t.started(job)
  await t.call(job, 'add_comment', { taskRef: task.ref, body: input.comment })
  await t.call(job, 'ask_question', { question: input.question, recommendation: input.recommendation, options: input.options, retryOptions: input.retryOptions })
  await t.pmReply(job, input.reply)
}

async function inFlight(t: Seeder, shop: Project, notes: Project): Promise<void> {
  // Ready to merge, waiting on CI
  const nuxt = await t.task(shop, {
    title: 'Upgrade to Nuxt 4.6',
    type: 'task',
    description: 'Move from Nuxt 4.4 to 4.6 for the faster dev server and the new image provider API.',
    acceptanceCriteria: ['The site builds and all tests pass on Nuxt 4.6', 'No deprecation warnings in the build output']
  })
  await t.approve(shop, nuxt)
  await t.advance('15m')
  await develop(t, shop, nuxt, {
    head: 'v1',
    checks: 'pending',
    summary: 'Bumped nuxt to 4.6.2 and moved the two image providers to the new defineProvider API. Build is clean.',
    note: 'Upgraded to Nuxt 4.6',
    files: [patch('package.json', ['-    "nuxt": "^4.4.1",', '+    "nuxt": "^4.6.2",']), patch('providers/cdn.ts', ['-export default <ProviderGetImage> function getImage(src, { modifiers }) {', '+export default defineProvider({ getImage(src, { modifiers }) {'])]
  })
  await t.advance('5m')
  await review(t, nuxt, 'approved', 'Straightforward upgrade; the provider migration matches the upgrade guide.', ['Build and tests pass locally', 'No warnings in the build log'])
  await t.mergePass()
  await t.advance('40m')

  // Agent review: submitted, with its review not started. Field Notes is
  // paused until the story ends, so the review isn't handed out.
  const pins = await t.task(notes, {
    title: 'Pin notes to the top of the list',
    description: 'Long-press a note to pin it. Pinned notes stay above the rest, with the green edge from the approved design.',
    acceptanceCriteria: ['Long-press toggles a note\'s pin', 'Pinned notes sort above the others, newest first'],
    humanReview: false
  })
  await t.approve(notes, pins)
  await t.advance('20m')
  await develop(t, notes, pins, {
    head: 'v1',
    summary: 'Added pinnedAt to notes, a long-press menu with Pin/Unpin, and sorting by pinnedAt then updatedAt. The pinned style follows design v2.',
    note: 'Added pinning with long-press',
    files: [
      patch('src/notes/NoteRow.tsx', ['+  onLongPress={() => togglePin(note.id)}', '+  style={[styles.row, note.pinnedAt && styles.pinned]}']),
      patch('src/notes/sort.ts', ['+export const byPinThenDate = (a: Note, b: Note) =>', '+  (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt'], 'added')
    ],
    beforeReport: async () => {
      await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, notes.id))
    }
  })
  await t.advance('30m')

  // In progress: the reviewer asked for changes and the developer hasn't
  // picked it up yet
  const sizes = await t.task(shop, {
    title: 'Size guide on product pages',
    description: 'A "Size guide" link next to the size picker that opens a modal with the chart for the product\'s category.',
    acceptanceCriteria: ['The link opens a modal with the right chart for the category', 'The modal closes on Escape and returns focus to the link']
  })
  await t.approve(shop, sizes)
  await t.advance('10m')
  await develop(t, shop, sizes, {
    head: 'v1',
    summary: 'Added SizeGuideModal with charts per category, opened from a link by the size picker.',
    note: 'Added the size guide modal',
    files: [patch('src/components/SizeGuideModal.vue', ['+<Dialog :open="open" @close="emit(\'close\')">', '+  <SizeChart :category="product.category" />', '+</Dialog>'], 'added')]
  })
  await t.advance('6m')
  // The developer's next round waits, unassigned, for a developer runner the
  // demo doesn't have. Paused until the story ends, so no later schedule hands
  // it to the seeding runner.
  await t.db.update(schema.agents).set({ paused: true }).where(eq(schema.agents.role, 'developer'))
  await review(t, sizes, 'changes_requested', 'The modal opens with the right chart, but focus stays inside the closed dialog after Escape, so keyboard users lose their place.', [{ met: true, note: 'Charts per category' }, { met: false, note: 'Focus isn\'t returned to the link' }])
  await t.advance('1h')
}

async function releaseNotes(t: Seeder, shop: Project): Promise<void> {
  const merged = await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, shop.id))
  // Only what reached main: the Wishlist sub-tasks are on the parent's branch
  const shipped = merged.filter(row => row.status === 'merged' && row.mergeCommitSha && !row.epicId)
    .sort((a, b) => a.mergedAt!.getTime() - b.mergedAt!.getTime())
  t.releaseNotes = () => [
    '## What changed',
    '',
    ...shipped.map(row => `- **SHOP-${row.number}** ${row.title}`),
    '',
    'Category pages load noticeably faster on mobile, product pages show their review summary, and UK and EU customers now get confirmation emails in their own currency.'
  ].join('\n')
  const fromSha = demoSha('deploy-previous')
  await t.request('POST', '/api/deployments', {
    repository: shop.repository,
    fromSha,
    toSha: shipped.at(-1)!.mergeCommitSha!,
    commits: shipped.toReversed().map(row => ({ sha: row.mergeCommitSha!, subject: `${row.title} (#${row.prNumber})` }))
  })
  // The notes come from a job on the runner
  for (let i = 0; i < 50; i++) {
    const [row] = await t.db.select({ status: schema.deployments.notesStatus }).from(schema.deployments)
    if (row?.status !== 'pending') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await t.advance('6h')
}

// ---- Field Notes ----

function tarball(dir: string): Buffer {
  const out = mkdtempSync(join(tmpdir(), 'corral-demo-bundle-'))
  try {
    execFileSync('tar', ['--format=ustar', '-cf', join(out, 'bundle.tar'), '-C', dir, 'index.html', 'styles.css'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return readFileSync(join(out, 'bundle.tar'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

async function notesDesign(t: Seeder, notes: Project): Promise<void> {
  const design = await t.task(notes, {
    title: 'Design the notes list and editor',
    type: 'design',
    description: 'The two screens people use most. They\'re used outdoors, often one-handed, so contrast and tap targets matter more than density.',
    acceptanceCriteria: ['Shows the notes list with pinned notes, search and tags', 'Shows the editor with the note\'s place and photos', 'Shows how an unsynced note looks']
  })
  await t.approve(notes, design)
  const bundle = tarball(join(ASSETS, 'design'))
  const spec = readFileSync(join(ASSETS, 'design', 'design.md'), 'utf8')
  const submitDesign = async (version: string, summary: string) => {
    const job = await t.jobFor(design, 'designer')
    await t.started(job)
    await t.transcript(job, [
      { type: 'thinking', text: 'Outdoor use: high contrast, 44 px targets, no FAB over the list.' },
      { type: 'tool_call', id: 'w1', tool: 'Write', input: { file_path: 'design/index.html' } },
      { type: 'tool_result', id: 'w1', output: 'ok', isError: false },
      { type: 'tool_call', id: 's1', tool: 'Bash', input: { command: 'agent-browser screenshot notes-desktop.png' } },
      { type: 'tool_result', id: 's1', output: '✓ Screenshot saved', isError: false },
      { type: 'message', text: summary }
    ])
    await t.advance('50m')
    const sha = demoSha(`${design.ref}-${version}`)
    t.github.setBranch(notes.repository, job.branch!, sha)
    await t.call(job, 'submit_design', {
      headSha: sha,
      spec,
      bundle: { dataBase64: bundle.toString('base64'), files: 2 },
      screenshots: [
        { fileName: 'notes-desktop.png', contentType: 'image/png', dataBase64: asset('notes-desktop.png').toString('base64') },
        { fileName: 'notes-mobile.png', contentType: 'image/png', dataBase64: asset('notes-mobile.png').toString('base64') }
      ]
    })
    const [first, second, third] = design.acceptanceCriteria
    await t.evidenceFile(job, first!.id, { kind: 'screenshot', fileName: 'notes-mobile.png', contentType: 'image/png', data: asset('notes-mobile.png'), note: 'notes-list at phone width' })
    await t.evidenceFile(job, second!.id, { kind: 'screenshot', fileName: 'notes-desktop.png', contentType: 'image/png', data: asset('notes-desktop.png'), note: 'note-editor, right' })
    await t.evidenceNote(job, third!.id, 'The last note in the list is unsynced: dashed border and "waiting to sync".')
    await t.call(job, 'report_outcome', { outcome: 'design_submitted', summary, note: `Submitted design ${version}`, headSha: sha })
    await t.ended(job, sha)
    await t.advance('10m')
    await review(t, design, 'approved', 'Both screens and the unsynced state are in the spec and screenshots; contrast passes AA.', ['notes-list in the screenshots', 'note-editor with place and photos', 'Dashed unsynced note'])
  }
  await submitDesign('v1', 'Notes list and editor, with a pin icon on pinned notes and a dashed border for unsynced ones.')
  await t.advance('3h')
  await t.inboxAction(design, { action: 'request_changes', text: 'The pin icon is too small to see in sunlight. Make pinned notes stand out some other way.' })
  await t.advance('1h')
  await submitDesign('v2', 'v2: pinned notes now get a 4 px green edge instead of the small pin icon, so they stand out in sunlight.')
  await t.advance('5h')
}

async function offlineSpike(t: Seeder, notes: Project): Promise<void> {
  const spike = await t.task(notes, {
    title: 'Can we sync offline edits with a CRDT?',
    type: 'spike',
    description: 'People edit notes with no signal and sync later, sometimes from two devices. Find out whether a CRDT library handles that well enough on React Native, and what it costs.',
    acceptanceCriteria: ['Says whether a CRDT handles concurrent edits from two offline devices', 'Gives the bundle size and sync payload cost', 'Recommends an approach with follow-up tasks']
  })
  await t.approve(notes, spike)
  await t.advance('20m')
  const job = await t.jobFor(spike, 'developer')
  await t.started(job)
  await t.transcript(job, [
    { type: 'thinking', text: 'Compare Yjs and Automerge on Hermes: merge correctness, bundle size, payload per edit.' },
    { type: 'tool_call', id: 'b1', tool: 'Bash', input: { command: 'node experiments/two-devices.mjs --lib yjs --edits 500' } },
    { type: 'tool_result', id: 'b1', output: 'yjs: 500 concurrent edits merged, 0 lost, 0 conflicts left\nupdate payload: 38 bytes median', isError: false },
    { type: 'tool_call', id: 'b2', tool: 'Bash', input: { command: 'node experiments/two-devices.mjs --lib automerge --edits 500' } },
    { type: 'tool_result', id: 'b2', output: 'automerge: 500 concurrent edits merged, 0 lost\nupdate payload: 112 bytes median\nwasm init on Hermes: 840 ms', isError: false }
  ], { inputTokens: 64_000, cacheReadTokens: 520_000, outputTokens: 9_400 })
  await t.advance('2h')
  const [a, b, c] = spike.acceptanceCriteria
  await t.evidenceFile(job, a!.id, testOutput('two-devices.mjs --lib yjs --edits 500\n  merged 500/500, lost 0\ntwo-devices.mjs --lib automerge --edits 500\n  merged 500/500, lost 0'))
  await t.evidenceFile(job, b!.id, { kind: 'text', fileName: 'sizes.txt', contentType: 'text/plain', data: 'yjs        69 kB min+gz   38 B/edit median\nautomerge 410 kB min+gz  112 B/edit median (wasm, 840 ms init on Hermes)', note: 'Bundle and payload sizes' })
  await t.evidenceNote(job, c!.id, 'Recommendation and follow-ups are in the findings.')
  await t.call(job, 'report_outcome', {
    outcome: 'findings_reported',
    note: 'Compared Yjs and Automerge for offline sync',
    summary: '**Answer:** Yes. Both Yjs and Automerge merged 500 concurrent edits from two offline devices with nothing lost.\n\n**Evidence:** two-devices.mjs runs and sizes.txt. Yjs is 69 kB and about 38 bytes per edit; Automerge is 410 kB with an 840 ms WASM start on Hermes.\n\n**Recommendation:** Use Yjs, one document per note, stored in SQLite and synced through a small relay on the existing API.\n\n**Suggested follow-up tasks:** Store notes as Yjs documents; Sync relay endpoint; Show sync state on each note.'
  })
  await t.ended(job)
  await t.advance('10m')
  await review(t, spike, 'approved', 'The experiment is sound and the numbers back the recommendation.', ['Two-device runs with no lost edits', 'Sizes for both libraries', 'Yjs, with three follow-ups'])
  await t.advance('1d')
}

async function planConversations(t: Seeder, notes: Project): Promise<void> {
  // A plan waiting for approval: its tasks show as Drafts
  const sync = await t.planSession({ projectId: notes.id, text: 'The spike says Yjs works. Plan offline sync from its follow-ups.' })
  await t.started(sync.job)
  await t.call(sync.job, 'propose_plan', {
    title: 'Offline sync',
    summary: 'Notes edited offline merge cleanly when the phone reconnects, on one device or several, using Yjs as the spike recommended.',
    tasks: [
      { key: 'docs', title: 'Store notes as Yjs documents', description: 'Keep each note as a Yjs document in SQLite, migrating existing notes on first launch.', type: 'task', priority: 'high', acceptanceCriteria: ['Existing notes migrate on first launch with nothing lost', 'Edits persist across an app restart'] },
      { key: 'relay', title: 'Sync relay endpoint', description: 'An API endpoint that stores and forwards Yjs updates per note.', type: 'task', dependsOn: ['docs'], acceptanceCriteria: ['Two devices editing offline converge after both reconnect', 'Updates are authorised per user'] },
      { key: 'state', title: 'Show sync state on each note', description: 'The dashed "waiting to sync" style from the approved design, cleared once the relay acknowledges.', type: 'task', dependsOn: ['relay'], acceptanceCriteria: ['Unsynced notes show "waiting to sync"', { text: 'Tested in airplane mode on a real phone', checkedByHuman: true }] }
    ]
  })
  await t.pmReply(sync.job, 'I\'ve turned the spike\'s follow-ups into three tasks in order: Yjs storage first, then the relay, then the sync state the design already shows. The last one has a check for you to do on a real phone. Approve it when it looks right and I\'ll put them on the board.', 'The spike recommends Yjs with a relay. Three follow-ups, strictly sequential since each builds on the last.')
  await t.advance('20m')
  // The human asks for a change, so the session has a v2 with its changes from v1
  const revise = await t.planMessage(sync.session.id, 'Two people can edit a shared note. Show who changed what after a merge.')
  await t.started(revise)
  await t.call(revise, 'propose_plan', {
    title: 'Offline sync',
    summary: 'Notes edited offline merge cleanly when the phone reconnects, on one device or several, using Yjs as the spike recommended, and a merged note shows who changed what.',
    tasks: [
      { key: 'docs', title: 'Store notes as Yjs documents', description: 'Keep each note as a Yjs document in SQLite, migrating existing notes on first launch.', type: 'task', priority: 'high', acceptanceCriteria: ['Existing notes migrate on first launch with nothing lost', 'Edits persist across an app restart'] },
      { key: 'relay', title: 'Sync relay endpoint', description: 'An API endpoint that stores and forwards Yjs updates per note, tagged with the author of each update.', type: 'task', dependsOn: ['docs'], acceptanceCriteria: ['Two devices editing offline converge after both reconnect', 'Updates are authorised per user', 'Each stored update records its author'] },
      { key: 'state', title: 'Show sync state on each note', description: 'The dashed "waiting to sync" style from the approved design, cleared once the relay acknowledges.', type: 'task', dependsOn: ['relay'], acceptanceCriteria: ['Unsynced notes show "waiting to sync"', { text: 'Tested in airplane mode on a real phone', checkedByHuman: true }] },
      { key: 'authors', title: 'Show who changed a merged note', description: 'After a merge, highlight each paragraph another person changed, with their name.', type: 'task', priority: 'low', dependsOn: ['relay'], acceptanceCriteria: ['Paragraphs changed by someone else are highlighted with their name', 'The highlight clears once the note is opened'] }
    ]
  })
  await t.pmReply(revise, 'v2 adds a task to show who changed a merged note, and the relay now records each update\'s author so that task has something to show. It can run alongside the sync state once the relay is in.', 'Authorship needs the relay to keep authors; the display is separate work after it.')
  await t.advance('2h')

  // A question the PM is waiting on
  const markdown = await t.planSession({ projectId: notes.id, text: 'People want formatting in notes. What should we support?' })
  await t.started(markdown.job)
  await t.call(markdown.job, 'ask_question', {
    question: 'Should notes store Markdown, or rich text the editor owns?',
    recommendation: 'Markdown: notes stay readable in exports and in the Yjs documents, and the editor only needs bold, lists and checkboxes.',
    options: ['Markdown', 'Rich text', 'Plain text for now']
  })
  await t.pmReply(markdown.job, 'Before I plan this, one decision shapes everything else.')
  await t.advance('1h')

  // A global conversation, across projects
  const status = await t.planSession({ text: 'What did the team get done this week?' })
  await t.pmReply(status.job, 'This week on **Storefront**: lazy-loaded product images (LCP 3.1 s → 1.7 s), the review summary, the email currency fix after a second review round, and the whole Wishlist parent, whose PR is waiting for you in the Inbox. Apple Pay failed three times on domain verification and needs someone with Stripe dashboard access, and the warehouse sync is blocked on which credentials to use.\n\nOn **Field Notes**: the Expo setup and search are merged, design v2 of the notes screens is ready for you, and the CRDT spike recommends Yjs. I\'ve drafted the offline sync plan from it.')
  await t.request('POST', `/api/plan/sessions/${status.session.id}/read`)
  await t.advance('30m')
}

async function backlogs(t: Seeder, shop: Project, notes: Project): Promise<void> {
  // Ready, waiting for the size guide it depends on
  const sizes = (await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, shop.id))).find(row => row.title === 'Size guide on product pages')!
  const fit = await t.task(shop, {
    title: 'Fit feedback on the size guide',
    description: 'Under the chart: "Runs small / true to size / runs large", from returns data.',
    acceptanceCriteria: ['Shows the fit for products with at least 20 returns', 'Hidden for products with fewer'],
    dependsOn: [sizes.number]
  })
  await t.approve(shop, fit)

  const backlog: [Project, { title: string, description: string, type?: 'task' | 'bug' | 'spike' | 'design', priority?: 'low' | 'medium' | 'high' | 'urgent', acceptanceCriteria: string[] }][] = [
    [shop, { title: 'Recently viewed products row', description: 'A row of the last eight products viewed, on product and cart pages.', acceptanceCriteria: ['Shows up to eight recently viewed products, newest first', 'Leaves out the product on the current page'] }],
    [shop, { title: 'Gift wrapping option at checkout', description: 'A $5 gift wrap option with a message, per order.', priority: 'low', acceptanceCriteria: ['Adds $5 to the order when selected', 'The message prints on the packing slip'] }],
    [shop, { title: 'Search suggests products as you type', description: 'Instant suggestions under the search box after two characters.', type: 'spike', acceptanceCriteria: ['Compares Algolia and Postgres full-text search on our catalogue', 'Recommends one with its cost'] }],
    [shop, { title: 'Cart badge doesn\'t update after removing the last item', description: 'The header still says Bag (1) after the bag is emptied, until a reload.', type: 'bug', priority: 'high', acceptanceCriteria: ['The badge shows Bag (0) as soon as the last item is removed'] }],
    [notes, { title: 'Export notes as Markdown', description: 'Share sheet export of one note or all notes as .md files.', acceptanceCriteria: ['Exports one note as a .md file through the share sheet', 'Exports all notes as a zip'] }],
    [notes, { title: 'Attach photos from the camera roll', description: 'Today only the camera works. Let people pick existing photos too.', acceptanceCriteria: ['Picks one or more photos from the library', 'Keeps the photo\'s location when it has one'] }],
    [notes, { title: 'Map of notes by place', description: 'A map tab with a pin per note that has coordinates.', type: 'design', acceptanceCriteria: ['Shows clustered pins at low zoom', 'Tapping a pin opens the note'] }]
  ]
  for (const [project, input] of backlog) {
    await t.task(project, input)
    await t.advance('17m')
  }
  const [cart] = (await t.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, shop.id))).filter(row => row.title.startsWith('Cart badge'))
  await t.comment(shop, cart as unknown as Task, 'Seen on iOS Safari and Chrome. Probably the cart store not being reset when the last line is deleted.')
}
