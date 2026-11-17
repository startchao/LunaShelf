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
- Separate, persistent novel and English reading layouts (font, size, line height, paragraph spacing, margins, and table mode)
- English comfort typography with left alignment and an iPhone-friendly serif stack
- Queue-based Chinese/English TTS with independently selected voices
- Foreground-only TTS with explicit resume after hiding/locking. 背景聽書（實驗） is disabled in 0.7.4 because companion media may interrupt Web Speech; saved preferences and books are retained. See [hotfix diagnosis and real-device QA](docs/background-tts-experiment.md).
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

## 內建字體

閱讀設定內建三款 SIL OFL 1.1 開源字體，第一次選用時才下載：

- 芫荽體（Iansui，ButTaiwan）— 經 Google Fonts 載入
- 馬路口圓體（Maruko Gothic，max32002）— 經作者官方 webfont（jsDelivr）載入
- 白鷺楷（BailuKai，Hu Yen-Chuan，衍生自原俠正楷）— 子集化 woff2 自托管於 `public/fonts/bailu/`（字集：Big5 常用字＋本站書庫實際用字；授權全文見該目錄 OFL.txt）
