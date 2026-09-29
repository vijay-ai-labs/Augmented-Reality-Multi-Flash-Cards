# Product / business overview

This page explains the app in plain language for a non-technical reader:
what value it delivers, who uses it, and how a typical session flows.

## The idea in one sentence

Print a flashcard, scan it with a phone, and a 3D model of the picture pops
up on screen and says its name.

## Who uses it

| User type | What they do |
| --- | --- |
| Child (the actual "user") | Points the phone at a card, watches/plays with the model, hears the word. Cannot read well, so the whole app relies on pictures and icons, not text menus. |
| Parent / teacher | Prints the cards, opens the app, hands the phone over, picks the category, supervises. |
| Content maintainer | Sources new card artwork, 3D models, and pronunciation audio, and runs the tools that turn them into a working "deck" (see [14_Admin_Guide.md](14_Admin_Guide.md)). |

## Business value

- **Makes static print material interactive** without adding any electronics,
  chips, or printing cost to the physical cards themselves — the "smarts" are
  entirely in the phone and the app.
- **Low running cost.** There's no server to operate for the app logic itself.
  The only recurring cost is hosting the asset library (card images, 3D
  models, audio, image-recognition files) on object storage — roughly 800 MB
  today (see [09_Deployment_Guide.md](09_Deployment_Guide.md)).
- **Content is data, not code.** Adding a new topic (a new "deck" of cards,
  such as "Ocean Animals") does not require writing software — it means
  dropping image/model/audio files into a folder structure and running a
  couple of commands (see [14_Admin_Guide.md](14_Admin_Guide.md)).

## Major workflows

### 1. Child's session (the core product experience)

1. Open the app on a phone.
2. See a grid of category tiles (Animals, Alphabets, Numbers, and so on),
   each with a picture, a name, and a card count.
3. Optionally search for a deck or a specific card by name.
4. Tap a category tile. The camera opens.
5. Point the camera at a printed card from that category.
6. The matching 3D model appears on the card, and its name is spoken aloud.
7. Play with the model: drag to spin it, pinch to resize it, press and hold
   to slide it, tap it to hear the word again.
8. Optionally tap **Place Here** to leave the model standing in the room and
   look around it by moving the phone; **Return to Card** puts it back.
9. Tap **Back** to return to the category grid and pick something else.

See [13_User_Guide.md](13_User_Guide.md) for the full, illustrated walkthrough
written for a non-technical reader (a parent or teacher), and
[00_Project_Overview.md](00_Project_Overview.md) for how "Place Here" works
under the hood.

### 2. Content maintainer's workflow (adding a new deck)

1. Collect card images (photos or scans of the printed cards), 3D models
   (`.glb` files), and short pronunciation clips for a new topic.
2. Drop them into `assets/cards/<topic>/`, `assets/models/<topic>/`, and
   `assets/audios/<topic>/` following the naming rules.
3. Run the validation and compression scripts.
4. Compile the topic's image-recognition file (the `.mind` file) using a
   browser-based tool page.
5. Tune where each model sits on its card using a second browser-based tool
   page (the "placement editor").
6. Check tracking quality with a script that flags cards unlikely to be
   recognized by the camera.
7. Push the new/updated asset files to the CDN (object storage) that serves
   them in production.

Full details: [14_Admin_Guide.md](14_Admin_Guide.md).

## Key outcomes / what "success" looks like

- A child can open the app unsupervised (after the first launch) and get a
  model to appear within a few seconds of pointing at a card, in normal
  indoor light.
- Every card in the library is reliably recognized by the camera — this is
  actively checked with `npm run check` (see
  [10_Testing_Guide.md](10_Testing_Guide.md)), because some card artwork
  (flat colors, plain text) simply does not photograph in a way image
  tracking can use.
- Every card has a spoken-word clip, so the "hear the word" behavior is
  consistent across the whole library. As of the last inventory in the
  project's memory notes, all 541 cards across 30 categories have audio.

## Constraints that shape the product

- **Camera access requires HTTPS.** This is a browser security rule, not a
  choice made by this project, and it affects both local testing on a phone
  and production hosting.
- **No positional AR (no SLAM/WebXR).** "Place Here" is a best-effort,
  gyroscope-only illusion that looks convincing while you turn on the spot,
  and is expected to drift if you walk a long way. This was a deliberate
  design decision, not a missing feature — see
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
- **Deck size affects recognition quality.** MindAR (the tracking library)
  compares the camera image against every card loaded for the open category,
  so categories are kept under roughly 25 cards to keep detection fast and
  reliable.
