# EtymoVocab

從**同義詞與反義詞**出發的英文單字探索工具。先比較意思，再挑一個感興趣的字，透過**橫向互動詞源地圖**追溯來源，找到整個字族。

1. **發現單字**：搜尋後並排顯示同義詞與反義詞，保留詞性、詞義和不同詞源詞條的區別；點 ↔ 可繼續查相關字的同反義詞。
2. **探索來源**：點單字開啟大地圖，向右追溯語言演變與構詞。支援拖曳、方向鍵平移、按鈕或 ＋／− 縮放、顯示全圖與全螢幕。
3. **展開字族**：在詞根按「找同根詞」，將同一詞根分類的字加入同一張地圖，每次加入最多 8 個；也可開啟完整字族清單與篩選。虛線表示詞根關聯或同根詞，不代表直接演變關係。

同義、反義描述意思，同根詞描述來源，兩者不混為一談。同反義詞取自詞條內明確的 Wiktionary 模板與章節，不推測缺漏，也不自動追查 Thesaurus 子頁。

搜尋時會依 Wiktionary 的詞形定義追查原形，例如 `walked → walk`、`went → go`，讓不同時態也能找到原形的同反義詞與詞源地圖。只有全部釋義都指向同一原形時才自動切換，並標示原查詢字與原形；若單字也有獨立意思（例如 `saw`），或可能對應多個原形，會保留原詞條並提供原形連結。

記住某個來源後按「記得」，它就會被遮住，讓你專心看還沒記住的部分；忘了的時候點一下就能回看。也可以開啟「測驗」模式，把所有來源都遮住。

資料**由瀏覽器即時查詢 Wiktionary**，不打包詞庫，每筆結果都附上所引用的修訂版號。規劃與取捨見 [docs/PLAN.md](docs/PLAN.md)。

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
src/EtymoVocab.Web/    靜態網站：Core 編譯成 WebAssembly（engine.js），原生 JS UI（app.js）與橫向地圖排版（map-layout.js）
src/EtymoVocab.Api/    選用的 ASP.NET Core JSON API，使用同一個 Core（給未來的 Android 或集中快取）
tests/EtymoVocab.Core.Tests/
```

靜態網站不需要後端：每位訪客的瀏覽器以匿名 CORS（`origin=*`）直接呼叫 Wiktionary API，並送出 `Api-User-Agent` 標頭。

## 測試

```bash
dotnet test
npm test     # 地圖排版測試，需 Node.js 22+；不需安裝 npm 套件
```

.NET 測試使用 `tests/EtymoVocab.Core.Tests/Fixtures` 中錄下的真實 Wiktionary 頁面、合成詞形詞條，以及模擬的 HTTP 回應，不連網；涵蓋規則與不規則詞形、原形追查、歧義、缺頁、循環參照及請求上限。3 項 JavaScript 測試涵蓋分支不重疊、收合／展開和重複來源防循環。網站本身沒有新增 npm 執行時相依套件。

## 選用的 JSON API

```bash
dotnet run --project src/EtymoVocab.Api
```

| 端點 | 說明 |
|---|---|
| `GET /api/words/{word}` | 英文字的詞源樹資料、釋義、中文翻譯、來源修訂版 |
| `GET /api/words/{word}/relations` | 讀取單字頁並依明確詞形定義追查原形，取得依詞性與詞義分組的同反義詞、釋義與來源；不預先抓取祖源頁 |
| `GET /api/entries/{lang}/{term}?id=` | 任一語言的詞條（用來展開詞源樹的節點），例如 `/api/entries/la/speciō` |
| `GET /api/roots/family?lang=ine-pro&root=*speḱ-` | 同詞根字族 |
| `GET /api/suggest?q=insp` | 標題建議 |

部署 API 前，請把 `appsettings.json` 中的 `Wiktionary:UserAgent` 改成你的聯絡方式（Wikimedia User-Agent 政策要求）。Wiktionary 無法回應時，API 回傳 `503` 並附上 `Retry-After`；備援設計見規劃書 §5。

## 授權

- 程式碼：Apache-2.0（見 `LICENSE`）。
- 詞源、釋義與翻譯：來自 [Wiktionary](https://en.wiktionary.org/)，採 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授權。
