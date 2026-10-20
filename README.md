# EtymoVocab

以詞源（etymology）為核心的英文單字搜尋引擎。查一個字，就能看到它的詞素拆解、從哪些語言一路演變而來（例如 PIE → 拉丁 → 古法語 → 中古英語 → 英語），再沿著詞根找到整個字族。目標是讓背單字變成理解單字。

資料**即時查詢 Wiktionary**，不打包詞庫，每筆結果都附上所引用的修訂版號。規劃與取捨見 [docs/PLAN.md](docs/PLAN.md)。

## 執行

需要 [.NET 10 SDK](https://dotnet.microsoft.com/download)。

```bash
dotnet run --project src/EtymoVocab.Api
# 開啟終端機顯示的網址（預設 http://localhost:5192）
```

部署前請在 `src/EtymoVocab.Api/appsettings.json` 把 `Wiktionary:UserAgent` 改成你的聯絡方式（URL 或 email），這是 Wikimedia 的 User-Agent 政策要求。

## 測試

```bash
dotnet test
```

測試只使用 `tests/EtymoVocab.Core.Tests/Fixtures` 中錄下的真實 Wiktionary 頁面，不連網。

## API

| 端點 | 說明 |
|---|---|
| `GET /api/words/{word}` | 詞源路徑、構詞、詞根、同源異形詞、釋義、中文翻譯、來源修訂版 |
| `GET /api/roots/family?lang=ine-pro&root=*speḱ-` | 同詞根字族（Wiktionary 分類） |
| `GET /api/suggest?q=insp` | 標題建議 |
| `GET /healthz` | 健康檢查 |

Wiktionary 無法回應或限流時，API 回傳 `503`，並附上 `Retry-After`。這個版本沒有備援資料來源，備援設計見規劃書 §5。

## 專案結構

```
src/EtymoVocab.Core/     Wikitext 解析、詞條解析、詞源鏈追溯（不依賴網路）
src/EtymoVocab.Api/      ASP.NET Core API、Wiktionary 用戶端、Web UI（wwwroot）
tests/EtymoVocab.Core.Tests/
docs/PLAN.md
```

## 授權

- 程式碼：Apache-2.0（見 `LICENSE`）。
- 詞源、釋義與翻譯：來自 [Wiktionary](https://en.wiktionary.org/)，採 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授權。
