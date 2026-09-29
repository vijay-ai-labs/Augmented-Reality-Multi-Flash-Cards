# Project overview

## What this is

AR Multi Flashcards is a web app that turns printed flashcards into
augmented-reality (AR) experiences. A child opens the app in a phone browser,
picks a category (for example "Animals" or "Alphabets"), points the camera at
a matching printed card, and a 3D model of the subject appears on top of the
card. The model can be spun, resized, moved, and — with the "Place Here"
button — pinned in the room so the child can walk around it. Each card also
says its own name out loud.

There is no native app to install. It runs entirely in the browser, built with
[MindAR](https://hiukim.github.io/mind-ar-js-doc/) (image tracking) and
[three.js](https://threejs.org/) (3D rendering), bundled with
[Vite](https://vitejs.dev/).

## Who it is for

- **The end user**: a child roughly age 4–10, using a parent's or teacher's
  phone. They never type or read menus — everything is picture-first.
- **The person running the app**: a parent, teacher, or whoever printed the
  physical flashcards and hands the phone to the child.
- **The content maintainer**: whoever adds new decks (categories) of cards —
  sourcing card artwork, 3D models, and audio, then running the asset
  pipeline described in [14_Admin_Guide.md](14_Admin_Guide.md).
- **A future developer**: anyone picking up this codebase to fix a bug, add a
  feature, or take over maintenance. That is the main audience for the rest
  of this documentation set.

## Why it exists

Flashcards are a common tool for teaching young children vocabulary (letters,
animals, shapes, numbers, and so on). This project adds a "magic window" layer
on top of ordinary printed cards: instead of a static picture, the child sees
a 3D model appear, hears the word, and can play with it. The AR effect is the
hook that makes a paper flashcard interactive without needing any electronics
in the card itself — all the recognition happens by matching the camera image
against a pre-computed image target file.

## What it is not

- It is not a native iOS/Android app. It is a website, tested primarily as a
  home-screen bookmark or a browser tab.
- It has no accounts, no login, no server-side database, and no analytics
  wired in. Everything about "what the user is doing" lives in the browser
  tab for the current session (plus a small amount of `localStorage` state
  for remembered model positions — see
  [04_Data_Model.md](04_Data_Model.md)).
- It does not track a room in 3D (no SLAM, no WebXR). The "Place Here" feature
  is a deliberate, documented illusion using only the phone's gyroscope — see
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).

## How to navigate this documentation set

| If you want to... | Read... |
| --- | --- |
| Understand the business/user side, non-technically | [01_Product_or_Business_Overview.md](01_Product_or_Business_Overview.md), [13_User_Guide.md](13_User_Guide.md) |
| Understand what the system must do | [02_Requirements.md](02_Requirements.md) |
| Understand how the code is put together | [03_System_Architecture.md](03_System_Architecture.md), [06_Folder_Structure.md](06_Folder_Structure.md) |
| Understand the data files (manifest, placements) | [04_Data_Model.md](04_Data_Model.md) |
| Understand the small local "APIs" (receiver, CDN) | [05_API_Documentation.md](05_API_Documentation.md) |
| Get the app running on your machine | [07_Local_Setup_Guide.md](07_Local_Setup_Guide.md), [08_Environment_Variables.md](08_Environment_Variables.md) |
| Ship it to production | [09_Deployment_Guide.md](09_Deployment_Guide.md) |
| Check your changes didn't break anything | [10_Testing_Guide.md](10_Testing_Guide.md) |
| Fix something that's broken | [11_Troubleshooting.md](11_Troubleshooting.md) |
| Know what's unfinished or fragile | [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md) |
| Add or manage flashcard decks | [14_Admin_Guide.md](14_Admin_Guide.md) |
| See what's changed over time | [15_Change_Log.md](15_Change_Log.md) |
| See what's planned next | [16_Future_Roadmap.md](16_Future_Roadmap.md) |

<!-- prettier-ignore -->
> [!NOTE]
> The repository also has a detailed engineering design note at
> [docs/superpowers/specs/2026-09-09-vercel-r2-deploy-design.md](superpowers/specs/2026-09-09-vercel-r2-deploy-design.md)
> covering the exact deployment build-out (Vercel + Cloudflare R2). This docs
> set summarizes and reorganizes that material for a broader audience;
> the spec file is kept as the detailed engineering record and is not
> duplicated in full.
