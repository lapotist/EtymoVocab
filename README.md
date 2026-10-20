# EtymoVocab

以詞源（etymology）為核心的英文單字搜尋引擎。查一個字會展開它的**詞源樹**：怎麼拆解、從哪些語言一路演變而來（例如 PIE → 拉丁 → 古法語 → 中古英語 → 英語），再沿著詞根找到整個字族。

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
src/EtymoVocab.Web/    靜態網站：Core 編譯成 WebAssembly 在瀏覽器執行（engine.js），UI 是原生 JS（app.js）
src/EtymoVocab.Api/    選用的 ASP.NET Core JSON API，使用同一個 Core（給未來的 Android 或集中快取）
tests/EtymoVocab.Core.Tests/
```

靜態網站不需要後端：每位訪客的瀏覽器以匿名 CORS（`origin=*`）直接呼叫 Wiktionary API，並送出 `Api-User-Agent` 標頭。

## 測試

```bash
dotnet test
```

測試只使用 `tests/EtymoVocab.Core.Tests/Fixtures` 中錄下的真實 Wiktionary 頁面，以及模擬的 HTTP 回應，不連網。

## 選用的 JSON API

```bash
dotnet run --project src/EtymoVocab.Api
```

| 端點 | 說明 |
|---|---|
| `GET /api/words/{word}` | 英文字的詞源樹資料、釋義、中文翻譯、來源修訂版 |
| `GET /api/entries/{lang}/{term}?id=` | 任一語言的詞條（用來展開詞源樹的節點），例如 `/api/entries/la/speciō` |
| `GET /api/roots/family?lang=ine-pro&root=*speḱ-` | 同詞根字族 |
| `GET /api/suggest?q=insp` | 標題建議 |

部署 API 前，請把 `appsettings.json` 中的 `Wiktionary:UserAgent` 改成你的聯絡方式（Wikimedia User-Agent 政策要求）。Wiktionary 無法回應時，API 回傳 `503` 並附上 `Retry-After`；備援設計見規劃書 §5。

## 授權

- 程式碼：Apache-2.0（見 `LICENSE`）。
- 詞源、釋義與翻譯：來自 [Wiktionary](https://en.wiktionary.org/)，採 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授權。
