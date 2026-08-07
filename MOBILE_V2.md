# Scanified handset — v2

What the app is, what it may not do, and how work gets from a phone with no
signal into a ledger somebody can defend in a billing dispute.

## The two jobs

Everything on this app is one of two things, and the navigation says so.

**Delivery** happens on the road. It has a customer and an order number, and it
records SHIP or RETURN against them. It produces evidence.

**Warehouse** happens at the plant. It has a location and a fill state, and no
document at all. It produces inventory.

If a screen does not belong to one of those, it is a stack pushed on top of a
tab — never a sixth tab. The previous app was twenty-five stack routes reached
from a dashboard, which is why it needed training.

## Information architecture

```
login                          not signed in
└── (tabs)                     signed in
    ├── index        Home      scan-search, six actions, "are my scans safe"
    ├── delivery     Delivery  customer + order → scan
    ├── warehouse    Warehouse location + full/empty → scan
    ├── activity     Activity  waiting | sent, grouped by order
    └── more         More      profile, settings, help, sign out
scan                           FULL-SCREEN MODAL, outside the tabs
search                         stack, from Home
settings                       stack, from Home and More
history                        stack, from Home
analytics                      stack, from Home
asset/new                      stack, from Home
asset/edit/[barcode]           stack, from an asset
asset/[barcode]                stack, from anywhere
customer/[id]                  stack, from anywhere
```

### Home is a launcher, and that is a reversal

The first version of Home offered two buttons and argued that a grid of tiles
was the dashboard wall that made the old app need training. That is right for a
product nobody has used yet and wrong for this one: thirteen people use
Scanified daily and are being migrated onto this. The grid is not a wall they
have to learn, it is the map they already carry, and the six labels — Delivery,
Add, Edit, Locate, History, Analytics — are Scanified's own words in Scanified's
own order. Familiarity beats a cleaner taxonomy when the users are known,
existing, and mid-migration.

What is not copied from the old home: the notification bell (its badge sat at
four thousand unread, which is what a badge becomes when clearing it changes
nothing), and the palette. The camera moved into the search bar and became a
real scan-and-go — read a label, open whatever it turned out to be. `src/scan-route.ts`
owns that asset-then-customer-then-text decision so Home and Delivery cannot
drift apart on it.

Scanning is a modal rather than a tab on purpose. A scan session is a mode you
are in until you submit, and a tab bar mid-session invites someone to wander off
with forty unsent scans.

Nothing is registered that does not exist, and nothing that exists goes
unregistered. The first half stops a tile opening a blank screen; the second
stops a screen arriving with the default header — wrong tint, wrong weight,
wrong back affordance — which is what History and Analytics did for a while
because the files were on disk but not on the stack.

## Business rules

These are the rules the ledger depends on. Changing one is a product decision,
not a refactor.

### SHIP does not assign the customer

A SHIP scan writes a row to `asset_scans` and touches nothing else. It does not
set the asset's customer, and it does not open a rental.

SHIP is a *claim*: the driver says five went out. Until it is reconciled against
the document nobody knows which five, or whether five is even right. Assigning
here would make a phone in a yard the source of truth for billing, which is
exactly what verification exists to prevent.

### RETURN moves inventory immediately

A RETURN scan writes its row **and** sets the asset empty, clears the customer,
and puts it back in house.

RETURN is an *observation*: the thing is physically back. Nobody needs a document
to believe that, the yard needs it available to refill today, and a driver who
hands back a cylinder and still sees it "out" stops trusting the screen.

What RETURN does **not** do is close the rental. `assignedCustomerId` is where
the thing is; the rental is what it costs. Verification closes the rental, so
billing stays derived from the document.

### Unknown barcodes are held, never rejected

A barcode the server has never seen is stored with a null asset and surfaces at
verification. The server never rejects field work — a driver who loses a shift
to a validation error stops scanning, and then the whole ledger is worthless.

### Replaying a batch posts zero

Every scan is unique on `(organization, orderNumber, barcode, mode)`. A phone
that force-quits mid-upload and retries collides on that constraint and is
skipped. This is the guarantee the entire offline design rests on, and it is why
the Sync button can say "pressing this twice is safe" and mean it.

### Warehouse closes rentals, and says so

Putting an asset away in-house takes it off a customer's balance. If a rental was
open it is **closed**, because otherwise that customer keeps paying for something
sitting on your shelf. The count comes back and is shown: "twelve open rentals
closed — those customers stop being charged." Ending twelve rentals with one tap
is not something to discover in next month's invoice run.

Marking an asset full while it is still out at a customer warns first and
requires confirmation.

## The sync model

```
scan  ──▶  SQLite (immediately, always)
           │
           ├─ QUEUED      on the phone, not yet sent
           ├─ UPLOADING   in flight
           └─ SENT        the server has it
                    │
          submit ───┴──▶  POST /api/scans   idempotent
```

The outbox is a pure reducer (`src/outbox.ts`) with one queue and no second
source of truth. Nothing in the app writes a scan except through it.

A failed upload puts rows back in line rather than dropping them. If the server
*did* receive them, the retry posts zero, so the failure mode is a duplicate
attempt rather than lost work.

Warehouse is the one flow that requires signal, because it settles rentals rather
than recording evidence — and a rental closed optimistically on a phone that
never reconnects is a customer billed for nothing.

## The offline payload

`GET /api/mobile/bootstrap` is the cold-start download: every customer, every
asset, the locations in use, and the fleet counts. A driver leaves at 06:10 and
may not see signal until 17:40, so the detail screens read from this cache rather
than the network — they open instantly and always work.

It carries `v`. **Bump it whenever the shape changes.** The handset caches this
blob, so an upgraded app reads a cache written by the old one; a shape change
without a version bump produces a crash three screens away from its cause, on a
device with no debugger, in a yard. `hydrate()` discards any cache whose version
does not match and refetches.

Keys are one and two characters (`p`, `sn`, `f`, `c`). Across forty thousand rows
the key names are most of the bytes: ~700 KB for 7,600 assets, ~3.5 MB for
40,000.

## Accessibility floor

Not aspirational — these are met.

- Every control is at least 56pt. Past the 44pt floor, because these are pressed
  with gloves on.
- Icons are a vector set, never Unicode glyphs. A glyph that looks fine in an
  editor renders as an empty box on somebody's Android.
- `accessibilityLabel` and role on every icon-only control.
- Reduced motion is honoured by every entrance animation.
- Safe areas come from real insets. Hard-coded top padding is correct on exactly
  one phone.
- Contrast against the common surface: ink 13.9:1, steel 6.6:1, faint 4.7:1.

## Not built yet

Named so nobody has to go looking. **Add asset, Edit asset and Analytics were
on this list and are not any more** — all three shipped, and the Home grid
points at them.

- **History editing** — Activity shows what this phone sent, not the org's last
  24 hours, and there is no edit-within-24h path yet. This is the largest
  remaining gap on the handset: it needs two API endpoints and a rewrite of
  `app/history.tsx` to group by order across the whole organization.
- **Edit-by-scan** — the Edit tile routes through search, because correcting a
  record needs a barcode and `asset/edit/[barcode]` cannot render without one.
  Pointing the camera at a label and landing straight on its correction form is
  the shorter path and is not built.
- **Support tickets** — More links to email instead. One finished path beats two
  half-built ones.
- **Biometric unlock.**

## Removed, and why

- **Developer and test scanners** — six screens of scanner benchmarks in the
  legacy app's Settings. Not carried over. They belong in a dev build.
- **Customization** — the legacy screen expected modal props from a stack route
  and rendered blank. Not carried over until there is something real to
  customise.
- **User management** — belongs in the console, where roles and invitations
  already live, on a screen big enough to read a table.
