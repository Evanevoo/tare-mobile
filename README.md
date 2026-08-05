# Tare — handset

One Expo app, both stores. One offline queue.

## Run it

```bash
npm install
npx expo start        # then press i (iOS) or a (Android), or scan the QR in Expo Go
```

Set the server it talks to in `.env`:

```
EXPO_PUBLIC_API_URL=https://your-app.vercel.app
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

## The shape of it

```
Mobile:  customer + order  →  batch SHIP/RETURN scans  →  POST /api/scans
             ↓
Web:     import invoice → match scans → assign / DNS·RNB·RNS → rentals → invoice
```

Mobile captures field truth. The console decides what it means. That split is
the whole design: a driver is never blocked by a validation rule, and a manager
can correct a driver without rewriting history.

## Why one queue

Scanified ran four overlapping sync layers and accumulated a file of comments
about sync bugs. Here there is exactly one: `src/outbox.ts` is a pure reducer,
`src/db.ts` persists it to SQLite, and nothing else writes scans.

`npm test` runs the queue's 33 assertions in plain node — including the one that
matters: a 400-scan shift uploaded twice posts exactly once.

## Store builds

```bash
npx eas build --platform ios --profile production
npx eas build --platform android --profile production
npx eas submit --platform ios --latest
```

Fill in `eas.json` first — Apple ID, team ID, App Store Connect app id.
