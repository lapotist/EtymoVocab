# EtymoVocab 規劃書 v0.1

> 狀態：草案（2026-10-20）。數字目標都是**建議門檻或待測假設**，不是實測結果。標示「待驗證」的項目在 Phase 0 確認。

## 0. 結論摘要

- **平台：先做 Web 服務**（ASP.NET Core API + SSR 網頁 / PWA），**之後再做 Kotlin Android 用戶端**，兩者共用同一份詞源資料庫。不建議一開始只做 Android（理由見 §2）。
- **核心資產是資料，不是 UI**：一條離線 ETL 把 Wiktionary（經 Wiktextract 抽取）轉成**詞源圖**（etymology graph），輸出唯讀、有版本號的 `lexicon.sqlite`。所有功能都建立在這張圖上。
- **主要用戶**：中高階學習者（學測後段、TOEFL / IELTS / GRE），以**拉丁語、希臘語來源的學術詞彙**為主。這類詞的詞素拆解最透明，學習槓桿最大。`get`、`set` 這類日耳曼基礎詞的收益較低，也不是主打。
- **LLM 只負責「解釋」，不負責「事實」**：詞源事實一律來自資料庫並附上出處。LLM 只能把既有詞源鏈改寫成敘述或記憶故事，並經過驗證器檢查（§7）。

## 1. 產品定位與核心假設

一般的背單字流程是「單字 → 中文意思 → 硬記」。EtymoVocab 改成：

```
單字 → 詞素拆解（字面義）→ 歷史路徑（語言演變與語意轉移）→ 今義
     → 同根詞家族擴展 → 以「詞根家族」為單位複習
```

範例（事實皆可在 Wiktionary 查證）：

- `inspect`、`respect`、`suspicious`、`despise`、`species`、`spectacle` 都來自拉丁語 *specere*（看），再往上是原始印歐語（Proto-Indo-European, PIE）\*speḱ-。學會一個詞根，就能推出整個家族。
- 同源異形詞（doublet）：`hospital` / `hostel` / `hotel`、`fragile` / `frail`。
- 形近陷阱：`pedestrian`（拉丁 *pes, pedis*「腳」）和 `pediatric`（希臘 *pais, paidos*「孩童」）表面上都有 `ped`，但不同源。
- 語意轉移：`nice` 源自拉丁 *nescius*（無知的），字面義與今義相去甚遠。

**待驗證假設（H1）**：以詞根家族為單位、搭配字面義推理的複習方式，在 7 天和 30 天的保留率上優於逐字孤立卡片。這是產品要用自己的資料驗證的假設，不是既有結論（§8.3）。

## 2. 平台決策：Web 服務 vs Kotlin Android

| 面向 | Web 服務（API + SSR / PWA） | Kotlin Android |
|---|---|---|
| 資料重用 | 一份 API 可同時供 Web、Android、iOS、AI Agent 使用 | 資料綁在 App 裡，之後做其他平台要重做 |
| 圖譜視覺化 | Cytoscape.js / D3 成熟，大螢幕適合呈現詞源樹 | Compose 沒有成熟的圖譜函式庫，要自己畫 |
| 「搜尋引擎」定位 | 每個字有固定 URL，可被搜尋引擎索引，也方便分享 | 無 SEO |
| 資料修正與迭代 | 重建 DB 後換檔即生效 | 要等商店審核與使用者更新 |
| 熟悉的技術棧 | 你熟 .NET / Blazor，交付最快 | 要學 Android 生命週期、Room、Compose |
| 離線、推播、每日習慣 | PWA 部分支援 | **原生優勢**，最適合間隔重複（SRS）的每日複習 |

**建議**：Phase 1–2 做 Web。Phase 3 再做 Android 薄用戶端，重用同一份 `lexicon.sqlite` 作為離線資料（Room `createFromAsset`），學習進度透過 API 同步。

**例外**：如果主要目的是**學 Kotlin / Android**，或者只給自己通勤離線刷題用，那就直接做 Android，並把 ETL 輸出的 SQLite 打包進 App。

**後端語言**：選 ASP.NET Core（.NET 10 LTS；.NET 8 的支援將於 2026-11 結束，新專案不要用 .NET 8）。如果你想全 Kotlin，Ktor + Kotlin Multiplatform 共用 model 也可行，但對你來說交付成本比較高。

## 3. 資料來源與授權

| 來源 | 用途 | 授權（已查證 / 待驗證） |
|---|---|---|
| Wiktionary 英文版，經 [Wiktextract](https://github.com/tatuylonen/wiktextract) 抽取（[kaikki.org raw JSONL](https://kaikki.org/dictionary/rawdata.html)） | 詞源鏈、詞素、同源詞、衍生詞、釋義 | 內容依 Wiktionary 採 CC BY-SA 4.0 / GFDL；Wiktextract 程式碼為 MIT。散布衍生資料庫時須**標示出處並以相同方式分享（ShareAlike）** |
| [ECDICT](https://github.com/skywind3000/ECDICT) | 中文釋義、詞頻（`bnc`、`frq`）、考試標籤（`tag`：`zk`、`gk`、`cet4`…）、詞形變化（`exchange`） | Repo 標示 MIT。**待驗證**：中文字體大概是簡體，要用 OpenCC `s2twp` 轉成台灣用語；部分內容的上游來源授權需要確認 |
| 大考中心《高中英文參考詞彙表》 | 台灣考試分級標籤 | 著作權屬大考中心基金會：**非營利使用須註明出處，營利使用須事先取得書面同意** |
| Open English WordNet | 同義詞、上下位關係（Phase 3） | CC BY 4.0 |
| Etymonline | **不作為資料來源**（受著作權保護，禁止爬取）；最多提供外部連結 | — |

**授權策略**：程式碼維持 Apache-2.0（現有 `LICENSE`）。資料另外放 `data/LICENSE`（CC BY-SA 4.0），每個詞條頁都附上對應的 Wiktionary 頁面連結，另設一頁集中列出出處。以上不是法律意見；若要商業化，請另外諮詢。

> kaikki.org 的單一語言資料檔已標示為 deprecated，因此直接用英文版完整 raw JSONL，再自行依 `lang_code` 篩選（en、enm、ang、fro、xno、la、grc、gem-pro、ine-pro 等）。

## 4. 資料模型：詞源圖

### 4.1 概念

- **節點（Lexeme）**：`(lang_code, entry_form, etymology_number)`。同形異源詞要拆開，例如 `bank`（河岸）和 `bank`（銀行）在 Wiktionary 分屬 Etymology 1 / 2。
- **詞素（Morpheme）**：詞根、前綴、後綴，例如 `trans-`、`-port-`、`-ion`。
- **邊（Edge）**：由 `etymology_templates` 的 template 名稱映射而來：

| 邊類型 | 來源 template（實際名稱以 Phase 0 統計為準） |
|---|---|
| INHERITED | `inh` |
| BORROWED（含子類型） | `bor`、`lbor`、`slbor`、`obor` |
| DERIVED | `der` |
| AFFIX（帶順序） | `af` / `affix`、`prefix`、`suffix`、`confix`、`compound` |
| ROOT | `root`（指向 PIE 等原始語詞根） |
| COGNATE | `cog`（注意：`ncog` 表示**非**同源，不能當成 COGNATE） |
| DOUBLET | `doublet` |
| CALQUE | `cal` / `calque`、`sl` |
| 不確定標記 | `unk`、`unc`，以及 `etymology_text` 中的 "possibly"、"uncertain" 等 |

`m` / `l`（mention / link）不建邊，只用來補充釋義。

### 4.2 Schema 草案（`lexicon.sqlite`，唯讀）

```sql
CREATE TABLE lexeme (
  id            INTEGER PRIMARY KEY,
  lang_code     TEXT NOT NULL,          -- 'en', 'la', 'grc', 'ine-pro' ...
  form          TEXT NOT NULL,          -- 顯示形（保留長音符號等）
  entry_key     TEXT NOT NULL,          -- 依語言規則正規化後的查詢鍵
  etym_no       INTEGER,                -- etymology_number，同形異源用
  gloss_en      TEXT,
  gloss_zh_tw   TEXT,
  zipf          REAL,                   -- 僅 en
  exam_tags     TEXT,                   -- 'gsat-l4 toefl gre'
  transparency  REAL,                   -- 字面義與今義的接近度 0..1，Phase 2
  source_url    TEXT NOT NULL,          -- Wiktionary 頁面
  UNIQUE (lang_code, entry_key, etym_no)
);

CREATE TABLE etym_edge (
  child_id      INTEGER NOT NULL REFERENCES lexeme(id),
  parent_id     INTEGER NOT NULL REFERENCES lexeme(id),
  kind          TEXT NOT NULL,          -- INHERITED / BORROWED / AFFIX / ROOT ...
  subkind       TEXT,                   -- 'learned', 'semi-learned' ...
  position      INTEGER,                -- AFFIX 的詞素順序
  uncertain     INTEGER NOT NULL DEFAULT 0,
  resolution    TEXT NOT NULL,          -- 'exact' | 'normalized' | 'chain-fallback' | 'ambiguous'
  PRIMARY KEY (child_id, parent_id, kind, position)
);

-- 預先算好的詞根家族；資料是靜態的，不必查詢時才遞迴
CREATE TABLE root_family (
  root_id       INTEGER NOT NULL REFERENCES lexeme(id),
  member_id     INTEGER NOT NULL REFERENCES lexeme(id),   -- 僅 en
  depth         INTEGER NOT NULL,       -- 1 = 直接詞素層，>1 = 深層（如 PIE）
  path          TEXT NOT NULL,          -- 邊 id 序列，供前端畫出路徑
  PRIMARY KEY (root_id, member_id)
);

CREATE VIRTUAL TABLE lexeme_fts USING fts5(form, gloss_en, gloss_zh_tw, tokenize = 'trigram');

CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT);  -- dump 日期、ETL 版本、統計
```

### 4.3 困難點與處理方式

1. **跨語言解析**：`{{bor|en|la|inspiciō}}` 必須對應到拉丁語詞條 `inspicio`。Wiktionary 頁面標題會去掉長音符號，所以要**依語言實作 entry-name 正規化**（la、grc、ang 規則不同），否則詞源鏈會斷。
2. **兩種建鏈策略併用**：
   (a) 遞迴：查到上游語言的詞條，再往上讀它自己的詞源；
   (b) 後備：英文詞條的單一詞源段落常已含完整鏈（"From ME …, from OF …, from Latin …"），依 template 出現順序串起來。優先用 (a)，查不到才用 (b)，並在 `resolution` 欄記錄採用哪一種。
3. **歧義不要猜**：上游有多個同形異源詞條、又無 `id=` 參數可辨識時，標成 `ambiguous`，前端顯示「多個可能來源」。
4. **家族分層**：預設只顯示淺層家族（同一拉丁 / 希臘詞幹）。深層（PIE）家族另行展開。例如 `scope` 與 `spectacle` 同屬 PIE \*speḱ-，這是有趣的知識，但對記憶幫助不大。
5. **沒有確切年代**：Wiktionary 大多沒有首次出現年代，所以「歷史」以**語言階段時間軸**呈現（PIE → 拉丁 → 古法語 → 中古英語 → 現代英語），各階段配上通行的大致年代區間，並標明是概略值。

## 5. 功能規格

### 5.1 搜尋模式

| 模式 | 輸入範例 | 實作 |
|---|---|---|
| 字詞 | `respect` | `entry_key` 精確比對 → FTS5 trigram 模糊比對 → 編輯距離容錯 |
| 詞素 / 詞根 | `spect`、`-logy`、`*bʰer-` | 詞素表 + `root_family`；**區分真同源與表面巧合**（用 `ped` 查詢時，把 `pedestrian` 和 `pediatric` 分組呈現） |
| 結構反查 | `trans- + port` | AFFIX 邊的多詞素交集 |
| 語意（Phase 3） | 「表示『搬運』的字」 | 用詞根釋義的 embedding 做向量檢索（sqlite-vec 或預先計算） |

### 5.2 詞條頁（核心頁面）

1. 拆解：`in-`（進入）+ `spicere`（看）→ 字面義「往裡面看」
2. 歷史路徑：語言階段時間軸 + 每一步的形式與釋義 + 不確定標記
3. 語意轉移說明：字面義 → 今義（Phase 3 由 LLM 改寫，§7）
4. 同根家族：依「詞頻 × 考試標籤 × 是否已會同家族詞 × 路徑深度」排序
5. 同源異形詞、形近陷阱
6. 透明度標示：透明度低時提醒「字面義與今義落差大，請記語意演變的故事，不要只靠拆解」
7. 出處：Wiktionary 連結與資料版本

### 5.3 學習功能（Phase 2）

- **詞根家族卡**：SRS 的排程單位是詞根，複習時展開成家族成員；排程演算法採 FSRS（開放演算法；先確認有無可用的 .NET 實作，沒有就從 py-fsrs / ts-fsrs 移植）。
- **拆解推理題**：給單字和詞素，先猜意思，再揭曉字面義與今義。
- **陷阱題**：形近但不同源的詞對。
- **覆蓋率地圖與推薦**：例如「SPEC 家族你已會 7/23 個」。下一個要學的字依「邊際效益」排序：高頻、與已會詞根共用、符合目標考試。

### 5.4 API 草案

```
GET  /api/v1/words/{lemma}?etym={n}
GET  /api/v1/words/{lemma}/graph?depth=3
GET  /api/v1/roots/{rootId}/family?maxDepth=1&minZipf=3.0&tag=toefl
GET  /api/v1/search?q={q}&mode=word|morpheme|structure
GET  /api/v1/lexicon/version
POST /api/v1/me/reviews                 (Phase 2)
GET  /api/v1/me/coverage?root={rootId}  (Phase 2)
```

## 6. 系統架構

```
┌─────────────── 離線 ETL（Python 3.12，批次）───────────────┐
│ kaikki raw JSONL ─┐                                        │
│ ECDICT ───────────┼→ 正規化 → 建邊 → 跨語言解析 → 家族預算 │
│ 大考詞彙表 ───────┤   → 中文轉換（OpenCC s2twp）           │
│ (OEWN, Phase 3) ──┘   → 品質報告 → lexicon-YYYYMMDD.sqlite │
└────────────────────────────────────────────────────────────┘
                         │ 版本化產物（不進 git）
┌─────────── 服務端：ASP.NET Core（.NET 10 LTS）─────────────┐
│ Lexicon：Microsoft.Data.Sqlite，唯讀、連線池               │
│ UserData：PostgreSQL + EF Core（帳號、複習紀錄）           │
│ REST API ＋ Blazor Web App：                               │
│   詞條頁 = Static SSR（可被索引）                          │
│   測驗 / SRS = Interactive WebAssembly + PWA               │
│   圖譜 = Cytoscape.js（JS interop）                        │
└────────────────────────────────────────────────────────────┘
                         │ 同一 API
               Android（Phase 3，Kotlin + Compose）
               離線：Room createFromAsset(lexicon 子集)
```

**為什麼詞源資料用 SQLite，而不是 PostgreSQL 或 Neo4j**：資料唯讀，而且由批次重建。單一檔案可以原子性地替換部署（藍綠切換），建置可重現；同一個產物還能直接當 Android 的離線資料。FTS5 trigram 足以支援子字串與詞素搜尋。詞源鏈深度通常不超過 10，用遞迴 CTE 加預先算好的家族表就夠，不需要圖資料庫。使用者資料會有並行寫入，所以另外放 PostgreSQL。

**Repo 結構（提案）**：

```
etl/                  Python ETL、單元測試、golden set
src/EtymoVocab.Lexicon/   唯讀查詢層
src/EtymoVocab.Learning/  SRS、推薦（Phase 2）
src/EtymoVocab.Api/
src/EtymoVocab.Web/
android/              Phase 3
data/LICENSE          CC BY-SA 4.0（建置產物另存，不進 git）
docs/
```

## 7. LLM 使用邊界

| 允許 | 禁止 |
|---|---|
| 把資料庫中的詞源鏈改寫成繁中敘述 | 補上資料庫沒有的詞源 |
| 說明語意如何從字面義轉到今義（以既有鏈為輸入） | 推測詞源未知或不確定的字 |
| 產生記憶故事（**明確標示為記憶法，不是史實**） | 線上即時生成事實內容 |
| 產生測驗干擾選項 | — |

機制：

1. **批次預先生成**高頻前 N 個字的內容並快取，快取鍵為 `(lexicon_version, lexeme_id, prompt_version)`。不在使用者請求時即時呼叫，以控制成本與延遲。
2. 輸出採結構化 JSON，每個論述都引用 `lexeme.id` / `etym_edge`。**驗證器**會檢查提到的每個形式和語言都存在於該字的詞源鏈中，不通過就丟棄。
3. 人工抽查樣本；前端標示「AI 生成的說明」。
4. 不綁定特定模型供應商，prompt 與評測集一起納入版本控管。

> 詞源是 LLM 很容易編造「民間詞源」（folk etymology）的領域，所以這一層是本專案最需要防守的地方。

## 8. 路線圖與驗收

時程假設：1 人兼職。

### Phase 0：資料可行性驗證（1–2 週）

- 以串流方式讀取完整 JSONL，依 `lang_code` 篩選；統計 template 名稱分布，修正 §4.1 的映射表。
- 實作建邊與跨語言解析的雛形，產出覆蓋率報告。
- 建立 **golden set**：人工核對 100–200 個字的詞源鏈，作為之後的回歸測試基準。
- **進場門檻（建議值）**：
  - 依 ECDICT 詞頻排序前 5,000 個英文字中，有至少 1 條詞源邊的比例 ≥ 90%
  - golden set 的邊抽取精確率（precision）≥ 95%
  - `ambiguous` 解析比例 ≤ 10%
- 若未達門檻：縮小範圍，只做拉丁 / 希臘來源的學術詞彙，或加強 (b) 後備策略。

### Phase 1：MVP 搜尋引擎（4–6 週）

- ETL v1 → `lexicon.sqlite`；Lexicon 查詢層 + API + 詞條頁 + 詞根家族頁 + 字詞 / 詞素搜尋；繁中釋義；考試標籤篩選；出處頁。
- 驗收：
  - golden set 全部通過
  - 單機詞條 API p95 < 100 ms（目標值）
  - 每頁都有 Wiktionary 出處連結
  - ETL 可重現（同一份 dump 產出的統計一致）

### Phase 2：學習迴圈（4–6 週）

- 帳號、FSRS、詞根家族卡、推理題 / 陷阱題、覆蓋率地圖與推薦、透明度分數（用詞素釋義與今義的 embedding 相似度計算，再以人工標註的 200 字校準）。
- 開始記錄複習事件，作為 H1 的資料。

### Phase 3：擴充

- LLM 敘述（§7）、語意搜尋、Android 用戶端（離線）、把 Lexicon 包成 MCP server 供 AI Agent 查詢（API 已就緒，成本低）。

### 8.3 評估方式

- **資料品質**：golden set 的邊精確率與召回率（recall）、依詞頻區間分組的覆蓋率、`ambiguous` 比例，每次 ETL 都輸出報告。
- **學習成效（H1）**：同一受試者內比較，兩組字集難度與詞源比例相互平衡，比較 7 天與 30 天的正確回想率。樣本小時只算探索性結果，不宣稱因果。

## 9. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| Wiktionary 詞源不完整或錯誤 | 錯誤知識被記住 | 顯示出處與不確定標記；golden set 回歸測試；提供使用者回報管道 |
| 跨語言解析斷鏈 | 家族不完整 | 依語言正規化 + 後備策略 + `resolution` 欄位監控 |
| CC BY-SA 的 ShareAlike 義務 | 資料無法閉源授權 | 程式與資料授權分離；出處頁；商業化前諮詢法律意見 |
| 大考詞彙表禁止營利使用 | 商業化受限 | 非營利階段註明出處；商業化前取得書面同意，或改用自建分級 |
| ECDICT 上游授權不明 | 商業風險 | Phase 0 釐清；必要時改用 Wiktionary 釋義自行翻譯並人工審核 |
| LLM 編造詞源 | 損害可信度 | §7 驗證器 + 標示 + 抽查 |
| 拆解誤導（透明度低的字） | 學錯意思 | 透明度分數與提示 |
| 原始 dump 很大 | ETL 需要大量記憶體 | 串流解析，避免整檔載入 |

## 10. 待你決定

1. **專案目的**：個人學習工具、作品集，還是公開或商業產品？這會影響授權處理（大考詞彙表、ECDICT）、部署方式，以及是否需要帳號系統。
2. **是否以學 Kotlin 為目標**：如果是，平台改成 Android 優先（見 §2 的例外）。
