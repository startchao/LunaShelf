# LunaShelf

TXT-first personal novel reader for Tony.

## Design decisions

- New project instead of patching InkTrace further.
- UI direction: InkTrace-style library/reader, light/dark theme, simple mobile-first controls.
- Core direction: tReader-inspired TXT-first parser and queue-based Web Speech TTS.
- EPUB is intentionally deferred.
- Custom fonts are supported via local font import (`.ttf`, `.otf`, `.woff`, `.woff2`) and stored locally in IndexedDB.
- No Service Worker cache is used. On boot, the app unregisters any existing Service Worker registrations under the origin and deletes CacheStorage entries to avoid stale Safari/PWA shells.
- The **強制更新** button reloads with a unique query string so Safari requests the latest deployed files.

## Current MVP features

- TXT import
- IndexedDB local book storage
- Light/dark theme
- Custom font import
- Font size / line height controls
- Queue-based Chinese TTS
- Silent HTMLAudioElement + Media Session setup to improve routing to system/car audio while CarPlay is active
- Manual force-refresh / cache clearing controls

## Local development

```bash
npm install
npm run dev
npm run build
```

## iPhone / car audio test

1. Open the deployed GitHub Pages URL in Safari.
2. Press **強制更新** once after each deployment.
3. Import a TXT file.
4. Connect iPhone to CarPlay / car Bluetooth.
5. Press **播放** inside LunaShelf.
6. Confirm audio routes through car speakers rather than the phone speaker.
7. Check Control Center / lock screen media state.

## Scope intentionally deferred

- EPUB
- cloud sync
- cloud TTS
- native iOS wrapper
- Service Worker offline cache
