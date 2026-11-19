# EtymoVocab

從**同義詞與反義詞**出發的英文單字探索工具。先比較意思，再挑一個感興趣的字，透過**橫向互動詞源地圖**追溯來源，找到整個字族。也可以從**推論練習**開始，用兩個例子學習構詞，再用不同的字與句子檢查理解。

1. **發現單字**：搜尋後並排顯示同義詞與反義詞，保留詞性、詞義和不同詞源詞條的區別；點 ↔ 可繼續查相關字的同反義詞。
2. **探索來源**：點單字後，先看「為什麼是這個意思？」摘要卡，用同樣三題回答：字面上是什麼、意思怎麼走到今天、為什麼是這種語感，每題一兩行，只從詞條資料挑選與排列。下方大地圖是證據，向右追溯語言演變與構詞。地圖可水平與垂直捲動，支援拖曳、方向鍵、按鈕或 ＋／− 縮放、顯示全圖與全螢幕。圖中只放來源、構詞及有詞源依據的關聯，不加入同義詞或反義詞。
3. **展開字族**：詞條明列的派生詞（Derived terms）、同族詞（Related terms）及同源異形詞（doublets）會分組顯示，每組先放 8 字，其餘可篩選加入。已確認的詞根會自動讀取字族，包含祖源詞條記載的詞根。分類會跨頁讀取最多 2,000 字，依 [wordfreq 詞頻](src/EtymoVocab.Web/wwwroot/data/README.md)（前 5 萬字，CC BY-SA 4.0）排序。詞根或字首有義項編號時會優先查對應分類；若字首有多個意思，使用者可選擇義項。也可展開構詞成分，例如從 `telephone` 的 `-phone` 找到 `microphone`。虛線的意義見分組標籤，每組關係附詞條修訂版或分類來源。
4. **推論練習**：`#/learn` 提供 10 個短課程，每課有兩個教學例子、一題詞義推論與一題線索判斷。先回報是否已熟悉，再選答案與把握程度；送出後顯示解說、推論界線及詞條來源。完成後七天開放另一個字的新題。
5. **批次掃描**：`#/bulk` 一次查詢最多 20 個不同的單字或片語，保留大小寫差異（例如 `Polish` 與 `polish`），以換行、逗號或分號分隔；並排呈現每個字的同反義詞，保留詞性與詞義分組。結果逐筆出現，可篩選字詞、只看同義／反義、停止或稍後重試未完成的查詢。上游要求等待時會暫停後續工作並保留已有結果。
6. **收藏單字**：在單字查詢或批次結果按「＋ 收藏」，到 `#/saved` 回看、篩選、移除及匯出。收藏保留選字時的查詢、詞義及來源線索，但不會建立詞源圖上的關係；儲存於本機瀏覽器，與學習記錄及地圖「記得」狀態分開。

同義、反義描述意思，同根詞描述來源，兩者不混為一談。同反義詞取自詞條內明確的 Wiktionary 模板與章節，若詞條將特定詞義指向 Thesaurus，單字與批次結果會在該組顯示可開啟的詞庫連結；數字只計算詞條直接列出的單字。

地圖也會從**反向詞源索引**找額外候選：目前索引包含 405,105 個英文詞、825,160 筆候選連結，來自 2026-10-01 Wiktionary 快照。先核對前 4 個候選，也可篩選指定單字或繼續核對；只有目前詞條的語言、來源詞與已確認詞源身分吻合，才加入「共同來源」或「共用構詞成分」分支。不同詞義的同形詞、不確定的演變推測、同反義詞或只共用泛用詞綴的字不會因此相連。一個字本身身分明確、但更古老歷史不確定時，仍可核對該字的身分，並停止往不確定的歷史延伸。索引分成 256 個小檔，查詢只讀需要的檔案；來源、授權、覆蓋範圍及重建方式見 [索引說明](docs/INDEX-SOURCES.md)。

這仍不是完整字族：尚未支援的模板、自由敘述中的同源詞、同形詞缺少明確身分，以及來源本身的缺漏仍可能造成遺漏。查不到只表示目前未讀取到明確關係，不表示沒有關係。

搜尋時會依 Wiktionary 的詞形定義追查原形，例如 `walked → walk`、`went → go`，讓不同時態也能找到原形的同反義詞與詞源地圖。只有全部釋義都指向同一原形時才自動切換，並標示原查詢字與原形；若單字也有獨立意思（例如 `saw`），或可能對應多個原形，會保留原詞條並提供原形連結。

記住某個來源後按「記得」，它就會被遮住，讓你專心看還沒記住的部分；忘了的時候點一下就能回看。也可以開啟「測驗」模式，把所有來源都遮住。

詞源、釋義與翻譯**由瀏覽器即時查詢 Wiktionary**，每筆查詢結果都附上所引用的修訂版號。網站另附約 16.6 MiB 的分片候選索引，按需讀取，不包含完整字典內容；快照候選必須經即時核對才能成為圖中的關係。推論練習是隨網站提供的小型教學內容，可在查詢引擎或 Wiktionary 無法使用時繼續操作；例句與中文說明由本專案編寫，附來源連結。它不保證首次訪問時可離線載入網站。

練習記錄與地圖的「記得」狀態分開儲存於本機。總覽分別顯示首次詞義推論、線索判斷、七天後新題和高信心誤判；只計入使用者自述未熟悉的首次作答，跳過及重練不提高首次成績。結果可以回看逐次答案、信心、筆記和解說，並另列最近練習結果。可以匯出帶題目與答案文字的 JSON 供回顧（尚無匯入介面）；這些成績不是能力認證或學習效果的研究結論。規劃與取捨見 [docs/PLAN.md](docs/PLAN.md)。

未送出的答案使用獨立的分頁草稿，不計入成績，可在同一分頁重新整理或 Back／Forward 後恢復；送出後清除。總覽會優先推薦已到期回訪或未完成的課程。七天回訪顯示當地開放時間與時區。

課程出處、教材授權與維護方式見 [docs/LESSON-SOURCES.md](docs/LESSON-SOURCES.md)。
三個角色的實際瀏覽器測試、發現與修正見 [docs/USER-TESTS.md](docs/USER-TESTS.md)。

## 網站

透過 GitHub Pages 部署：`https://lapotist.me/EtymoVocab/`。Pages 的專案路徑區分大小寫，必須與 repo 名稱一致；若要使用 `lapotist.me/etymovocab`，需把 repo 改名為 `etymovocab`。

第一次部署前的一次性設定：

1. 到 **Settings → Pages → Build and deployment → Source**，選 **GitHub Actions**。
2. 合併到 `main` 後，`.github/workflows/pages.yml` 會執行測試、發佈並部署。Pull request 只會建置與測試，不會部署。

## 本機執行

需要 [.NET 10 SDK](https://dotnet.microsoft.com/download)。

```bash
dotnet publish src/EtymoVocab.Web -c Release -o publish
python3 -m http.server 8080 -d publish/wwwroot   # 任何靜態伺服器都可以
# 開啟 http://localhost:8080
```

## 架構

```
src/EtymoVocab.Core/   Wikitext 解析、詞條解析、詞源鏈追溯、MediaWiki 用戶端（純 .NET，可離線測試）
src/EtymoVocab.Web/    靜態網站：Core 編譯成 WebAssembly（engine.js），原生 JS UI（app.js）、詞源地圖、批次查詢／收藏（vocabulary.js / bulk-lookup.js / saved-words.js）與推論練習
src/EtymoVocab.Api/    選用的 ASP.NET Core JSON API，使用同一個 Core（給未來的 Android 或集中快取）
tests/EtymoVocab.Core.Tests/
```

靜態網站不需要後端：每位訪客的瀏覽器以匿名 CORS（`origin=*`）直接呼叫 Wiktionary API，並送出 `Api-User-Agent` 標頭。WebAssembly 在需要查字時才載入；首頁與推論練習不依賴它。

搜尋欄取得焦點或進入批次查詢時會預先暖啟動引擎，將下載時間和輸入／閱讀重疊。輸入至少兩個字元並停頓 300 毫秒後會查詢標題建議，並預先載入第一個建議的同反義詞；送出同一個字時會沿用進行中的查詢或分頁快取。一次只預查一個字，限流時暫停背景查詢。批次查詢以 5 個字一組取得起始詞條，最多兩組同時進行；20 個新字的起始請求由 20 次減為 4 次，詞形原形可能需要另外取得。已完成的字詞／同反義詞結果在分頁中快取最多 100 筆、5 分鐘，錯誤與不完整結果不快取。結果卡只更新變動的項目，保留其他卡片與鍵盤焦點。

## 測試

```bash
dotnet test
npm test     # 地圖、學習記錄與課程驗證，需 Node.js 22+；不需安裝 npm 套件
```

.NET 測試使用 `tests/EtymoVocab.Core.Tests/Fixtures` 中錄下的真實 Wiktionary 頁面、合成詞形詞條，以及模擬的 HTTP 回應，不連網；涵蓋規則與不規則詞形、原形追查、歧義、缺頁、循環參照及請求上限。JavaScript 測試涵蓋地圖排版、首次作答計分、已知道跳過、重練、七天門檻、損壞或不可用的儲存、草稿恢復、可讀匯出，以及課程題目與來源的一致性。網站沒有 npm 執行時相依套件。

批次與收藏的測試另涵蓋去重、片語、上限、並行控制、分組回應對應、個別失敗、停止／限流、結果快取與大小寫隔離、收藏持久化與刪除、詞義來源，以及詞源圖排除語意關係。可選的 `npm run test:browser` 需要已安裝的 Playwright 與 Chromium；若套件不在專案中，可用 `PLAYWRIGHT_MODULE` 指定 Playwright 套件目錄，`CHROMIUM_EXECUTABLE_PATH` 指定瀏覽器。此檢查操作真實瀏覽器介面，以固定查詢回應驗證互動與卡片／焦點保留，不測即時上游可用性。

## 選用的 JSON API

```bash
dotnet run --project src/EtymoVocab.Api
```

| 端點 | 說明 |
|---|---|
| `GET /api/words/{word}` | 英文字的詞源樹資料、釋義、中文翻譯、來源修訂版 |
| `GET /api/words/{word}/relations` | 讀取單字頁並依明確詞形定義追查原形，取得依詞性與詞義分組的同反義詞、釋義與來源；不預先抓取祖源頁 |
| `GET /api/entries/{lang}/{term}?id=` | 任一語言的詞條（用來展開詞源樹的節點），例如 `/api/entries/la/speciō` |
| `GET /api/roots/family?lang=ine-pro&root=*speḱ-` | 同詞根字族，可用 `id` 指定詞根義項 |
| `GET /api/prefixes/family?lang=en&prefix=in-&id=not` | 指定字首及義項的字族清單，`id` 可省略 |
| `GET /api/suggest?q=insp` | 標題建議 |

部署 API 前，請把 `appsettings.json` 中的 `Wiktionary:UserAgent` 改成你的聯絡方式（Wikimedia User-Agent 政策要求）。Wiktionary 限流時，API 回傳 `429`；其他上游連線錯誤回傳 `503`。上游指定等待時間時，API 會附上 `Retry-After`；備援設計見規劃書 §5。

## 授權

- 程式碼：Apache-2.0（見 `LICENSE`）。
- 詞源、釋義與翻譯：來自 [Wiktionary](https://en.wiktionary.org/)，採 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授權。
- 推論課程文字與原創例句：CC BY-SA 4.0，詳見 [課程來源與維護](docs/LESSON-SOURCES.md)。
