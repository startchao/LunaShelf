# 前景朗讀修復 — 0.7.4

背景聽書實驗已停用。`BACKGROUND_TTS_AVAILABLE=false` 同時控制播放入口與設定介面：即使本機仍保存 `backgroundTts=true`，也不會建立靜音 audio、呼叫 audio.play 或註冊實驗 Media Session 控制。選項顯示停用且不可切換；即使程式送入 change 事件，也不取消語音、不改寫原有設定。第一段 speak 仍同步在明確 Play 內執行。

## 程式碼診斷（不代表已在 iPhone 重現）

PR #6 的 `TtsBackgroundSession.start()` 在 audio.play 拒絕後呼叫失敗回呼；Play 已同步 speak，失敗回呼再呼叫 pause/cancel，可能取消剛排入的語音。audio.onpause 同樣直接呼叫控制器 pause，靜音 audio 與 Web Speech 競爭音訊工作階段時可能中止朗讀。舊選項 change 不論是否播放都呼叫 pause，已暫停狀態也再次執行 native cancel；WebKit 非同步 cancel 可能影響隨後的 Play（bug 191745）。generation guard 只能隔離 JS 回呼，無法阻止原生語音佇列被清除。

因此此版不嘗試重試音軌或調整 iOS 音訊路由，而是停用有問題的路徑。保留休眠期限、語音 generation、每次 Play 固定中英聲線、分段 checkpoint、前景 Wake Lock。隱藏／鎖屏時暫停，回來必須明確 Play，不自動續播。沒有背景播放承諾。

播放鈕與設定面板的 DOM 所有權也已追查：`readerTemplate()` 把 `#rfPlay` 放在工具列，`#panelRoot` 是其同層的獨立容器；`bindEvents()` 綁定工具列 click，依控制器狀態呼叫 Play／Pause。`openPanel()`、`closePanel()` 與 `renderPanel()` 僅替換 `#panelRoot.innerHTML` 並重綁面板事件，不替換或重綁工具列。`renderTtsState()` 按控制器狀態更新 ▶／⏸ 與提示。因此目前沒有原始碼證據指向「設定重繪把播放鈕事件弄丟」；已確認的中止路徑是舊切換事件與 companion audio 回呼進入 pause/native cancel。iOS 是否因音訊路由競爭或非同步取消而觸發使用者故障，仍需實機確認。

書籍、字體、閱讀版面與原有偏好不刪除。實驗 helper 與舊測試保留為診斷資料，不能把舊模擬測試通過解讀成目前提供背景功能，也不能只翻轉 gate 重新提供實驗：必須先修復競態並通過實機驗證。

## 目前實機檢查（尚未執行）

在 iPhone Safari 與主畫面 PWA 分別執行：

1. 強制更新至 `0.7.4-foreground-tts-hotfix`。先前保存 OFF 與 ON 的裝置都應顯示不可切換的實驗選項；點播放應立即朗讀，不啟動靜音音軌。
2. 播放／暫停後操作設定、再次 Play；確認聲線與中斷段落保持正常，沒有因設定事件額外取消語音。
3. 切換 App／鎖屏、返回，應保留位置但不自動恢復；明確 Play 後續播。試長段、跨章與中英文段落。
4. 試 AirPods／喇叭、來電／Siri 中斷；不承諾鎖屏 media controls。確認需要時可以手動 Pause／Play。
5. 定時 10/30/50/60 分鐘、換書與返回書庫仍正常。核對既有 TXT/MD、字體與閱讀設定不變。

自動化驗證涵蓋停用 gate、保存 ON/OFF、兩個方向的切換事件後 Play、播放／暫停中切換、同步首段 speak、沒有 audio.play／拒絕／onpause 入口、stale generation、休眠期限與無重試 watchdog。舊實驗測試故意以測試專用 gate 啟用 dormant branch，涵蓋原音軌拒絕、onpause、過期回呼與清理；不是生產設定或 iPhone 驗證。

播放鈕回歸測試使用 Node VM 與最小 DOM 替身，執行正式 `bindEvents()`、`renderTtsState()`、`panelTemplate()`、`renderPanel()`、`bindPanelEvents()` 與開關面板函式；透過 `#rfPlay` click 而非直接呼叫控制器，核對按鈕／提示／控制器一致、click 返回前已 speak、暫停只 cancel 一次、設定關閉／重開／重繪不遺失或重複 toolbar handler。停用選項的 change 是刻意注入的合成事件，不代表使用者能操作停用 checkbox。DOM 替身不驗證瀏覽器原生事件、可信任 user activation 或 iPhone 音訊行為；它只驗證正式 JS click 路徑保持同步。

此 hotfix 僅交 PR 審查；不由實作者合併或部署。版本回退可 revert hotfix 並重新部署，但會重新暴露 PR #6 的實驗競態，不建議作為播放故障的解法。

---

## 0.7.3 歷史實驗說明（以下不是目前提供的功能）

預設關閉；閱讀設定的聲線區上方可開啟「背景聽書（實驗）」。切換會暫停，之後須由使用者明確點播放。設定只在本機保存，不上傳書籍、不新增付費 TTS。

## 行為與限制

- 關閉：沿用原來的明確續播模型。背景時保存分段位置、取消舊語音；返回不會自動播放。
- 開啟：每次明確播放，同步啟動一個本機生成的一秒靜音 WAV 循環及首段 Web Speech，不等待音訊 Promise、聲線或 Wake Lock。聲線仍鎖定在本次播放，中文／英文分別選擇。
- 隱藏：保存位置、釋放前景 Wake Lock，不取消正在播放的語音；隱藏期間不以五秒啟動 watchdog 誤判被節流的事件。不新增心跳、重試迴圈或自動恢復音軌。
- 返回前景：只檢查定時期限與更新介面，不呼叫播放、不重啟音軌、不重新要求 Wake Lock。若 iOS 已凍結／中斷但未通知網頁，請先暫停，再明確點播放；單純返回前景不會復活聽書。
- `pagehide.persisted=true`：視為 bfcache 隱藏，實驗播放僅保存位置；瀏覽器可能凍結整頁，不能保證繼續。`persisted=false`：視為離開／導覽，停止並釋放音軌與 Media Session，保留書籍分段位置。返回仍不自動播放。瀏覽器未送達 unload 類事件時無法由 JS 保證清理。
- 暫停、語音錯誤、音軌播放拒絕／中斷、定時到期：取消舊 generation，釋放音軌並撤銷 Blob URL；保留暫停 metadata/Play handler 供明確續播。停止、自然播完、換書、離開頁面：同時清除本功能擁有的 metadata/actions。
- Media Session 顯示書名與目前朗讀章節（以聽書分段位置，不以畫面頁碼）；play/pause/stop 走相同控制器，不支援的 action 忽略。已有其他 metadata、播放中的 media session，或 DOM 中正在播放的 audio/video 時，不建立實驗音軌。若其他播放器後來接管 metadata，本功能不覆寫其狀態或 handlers；不處理其音訊元素。
- 定時期限在每次新語音分段、明確 Play、返回／隱藏時檢查。iOS 若凍結 JS，無法保證在壁鐘期限立刻停止正在播放的片段／音軌；恢復執行後不得自動再開新段。定時到期之後再次明確 Play 是新的使用者指令，不是自動恢復。
- 靜音 WAV 與 Media Session 只是可回退的實驗。它們不授予可靠的 PWA 背景執行權，也不證明 AirPods/CarPlay 一定會呈現控制。實機上音軌可能反而中斷 Web Speech；遇到此情況關閉實驗恢復原有模型。

## 原始碼基準

基準為 `origin/main` 的 `d3fa960`。本基準沒有本機有聲書播放器：`c899543`（PR #4）已刪除 `bc07805` 新增的 `book-audio-player.js` 與 UI。本變更不復活已刪功能，也不更動其他真正音訊播放器。

## iPhone 實機檢查（尚未執行，Node 測試不能代替）

每項分別在 iPhone Safari 分頁與「加入主畫面」PWA 進行。記錄 iOS 版本、使用聲線、語速、耳機／喇叭路由、實際時間及失敗時的段落。

1. 強制更新，確認 `0.7.3-background-tts-experiment`。先保持 OFF：播放、鎖屏、解鎖，應暫停並需要明確 Play；不得自動恢復。
2. ON，使用至少 30 分鐘的 TXT（600 字以上長段、跨數章、含英文段落）。點 Play，鎖屏連續 30 分鐘，核對跨分段／跨章是否繼續，聲線不應中途漂移，記錄重複／漏讀或中止點。
3. 控制中心／鎖屏應在平台支援時顯示書名、當前朗讀章節。AirPods 或鎖屏 Pause 後至少等 30 秒；不得自行恢復。明確 Play 應從中斷分段繼續；Stop 應移除本功能媒體狀態。這些硬體事件未送達網頁時需記錄，不宣稱通過。
4. 測來電、Siri、導航提示、AirPods 斷線／重連：中斷後不應陷入音軌自動重播／語音重試迴圈。若無聲但狀態仍播放中，手動 Pause 再 Play，核對位置。
5. 設定 10 分定時，鎖屏跨過期限；檢查到期停止的實際延遲。解鎖或 media Play 的首次到期檢查不得復活朗讀／開新段。另測 30 分定時與 30 分鎖屏。
6. Safari 導覽離開並返回（含返回快取）、PWA 切換 App／返回、關閉再重開、換書、返回書庫，核對 checkpoint、沒有舊 callbacks 推進新書、沒有舊音軌繼續。bfcache 保活屬 best-effort，冻结不得被誤報為通過。
7. ON/OFF 切換並完整 reload，核對設定記憶；OFF 恢復原有模式。原有 TXT/MD、字體、閱讀版面、中文／英文聲線、語速及定時 10/30/50/60 保持正常。

## 驗證與回退

自動化涵蓋真實 WAV bytes、OFF/ON 隱藏模型、同步啟動順序、拒絕／中斷清理、過期回呼、定時期限、章節 metadata、bfcache／導覽、所有權、選項持久化標記與 Wake Lock 非同步競態。測試使用模擬媒體與語音事件，不證明 iPhone 背景成功。

最小回退：關閉實驗選項。部署回退：revert 本功能合併提交，再由正常 Pages 工作流程部署。不刪 IndexedDB 或 localStorage，既有書籍、字體及閱讀設定保留；舊版會忽略 `backgroundTts`。
