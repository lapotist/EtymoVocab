# 引導課程的來源與維護

課程版本：2026-10-22.1。核對日期：2026-10-22。

資料檔為 [lessons.js](../src/EtymoVocab.Web/wwwroot/lessons.js)。這是教學內容，不是 Wiktionary 即時查詢結果。更新上游字典不會自動改動題目或標準答案；改題時需更新課程版本。

## 來源與授權

構詞及英文詞義均核對英文 Wiktionary 的對應詞條。每個例字及題目都有兩個來源連結，分別連到詞源／構詞段落和詞性段落。48 個詞條使用查得的修訂版永久連結；unfamiliar、unlock 的內容已從 Wiktionary 搜尋索引讀取，但原頁讀取遇到限流或逾時，未能取得修訂版號，因此保留可識別段落的現行頁面連結，不捏造版本。

詞義及構詞的整理、翻譯與改寫採 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)，原始貢獻者可由各詞條的歷史紀錄查閱。課程的繁體中文解說、選項及英文例句為本專案撰寫，未複製字典中的引文；課程文字同樣以 CC BY-SA 4.0 提供。載入及介面程式仍依專案的 Apache-2.0 授權。

下表連到構詞來源；現代詞義的精確段落連結存於每個項目的 sources 第二筆。它包含測驗答案用詞，是維護文件，不應直接出現在尚未作答的課程介面。

| 構詞成分 | 教學例字 | 立即遷移 | 邊界／語境 | 七日後的新詞 |
|---|---|---|---|---|
| un- | [unhappy](https://en.wiktionary.org/w/index.php?title=unhappy&oldid=91405996#Etymology)、[unusual](https://en.wiktionary.org/w/index.php?title=unusual&oldid=93150319#Etymology) | [unfamiliar](https://en.wiktionary.org/wiki/unfamiliar#Etymology) | [unlock](https://en.wiktionary.org/wiki/unlock#Etymology) | [uninteresting](https://en.wiktionary.org/w/index.php?title=uninteresting&oldid=91329554#Etymology) |
| re- | [reread](https://en.wiktionary.org/w/index.php?title=reread&oldid=92644223#Etymology)、[rebuild](https://en.wiktionary.org/w/index.php?title=rebuild&oldid=91194823#Etymology) | [repaint](https://en.wiktionary.org/w/index.php?title=repaint&oldid=91569192#Etymology) | [resign](https://en.wiktionary.org/w/index.php?title=resign&oldid=93458407#Etymology_1) | [rewrite](https://en.wiktionary.org/w/index.php?title=rewrite&oldid=92478393#Etymology) |
| -less | [powerless](https://en.wiktionary.org/w/index.php?title=powerless&oldid=91418680#Etymology)、[harmless](https://en.wiktionary.org/w/index.php?title=harmless&oldid=89280230#Etymology) | [tireless](https://en.wiktionary.org/w/index.php?title=tireless&oldid=90600639#Etymology_1) | [priceless](https://en.wiktionary.org/w/index.php?title=priceless&oldid=92144776#Etymology) | [countless](https://en.wiktionary.org/w/index.php?title=countless&oldid=91689225#Etymology) |
| -ful | [hopeful](https://en.wiktionary.org/w/index.php?title=hopeful&oldid=93608599#Etymology)、[joyful](https://en.wiktionary.org/w/index.php?title=joyful&oldid=92522925#Etymology) | [fearful](https://en.wiktionary.org/w/index.php?title=fearful&oldid=92672627#Etymology) | [awful](https://en.wiktionary.org/w/index.php?title=awful&oldid=93678577#Etymology) | [doubtful](https://en.wiktionary.org/w/index.php?title=doubtful&oldid=92729513#Etymology) |
| pre- | [preheat](https://en.wiktionary.org/w/index.php?title=preheat&oldid=90606162#Etymology)、[prepay](https://en.wiktionary.org/w/index.php?title=prepay&oldid=90588761#Etymology) | [prerecord](https://en.wiktionary.org/w/index.php?title=prerecord&oldid=90623671#Etymology) | [prelaunch](https://en.wiktionary.org/w/index.php?title=prelaunch&oldid=81168750#Etymology) | [prebook](https://en.wiktionary.org/w/index.php?title=prebook&oldid=88051821#Etymology) |
| inter- | [intercity](https://en.wiktionary.org/w/index.php?title=intercity&oldid=92753019#Etymology)、[international](https://en.wiktionary.org/w/index.php?title=international&oldid=93561052#Etymology) | [interdepartmental](https://en.wiktionary.org/w/index.php?title=interdepartmental&oldid=84806072#Etymology) | [interface](https://en.wiktionary.org/w/index.php?title=interface&oldid=91806381#Etymology) | [interschool](https://en.wiktionary.org/w/index.php?title=interschool&oldid=91077358#Etymology) |
| trans- | [transatlantic](https://en.wiktionary.org/w/index.php?title=transatlantic&oldid=92157496#Etymology)、[transcontinental](https://en.wiktionary.org/w/index.php?title=transcontinental&oldid=93112755#Etymology) | [transpacific](https://en.wiktionary.org/w/index.php?title=transpacific&oldid=93112830#Etymology) | [transparent](https://en.wiktionary.org/w/index.php?title=transparent&oldid=93729025#Etymology_1) | [transnational](https://en.wiktionary.org/w/index.php?title=transnational&oldid=91121595#Etymology) |
| bio- | [biology](https://en.wiktionary.org/w/index.php?title=biology&oldid=92735907#Etymology)、[biosphere](https://en.wiktionary.org/w/index.php?title=biosphere&oldid=92523867#Etymology) | [biodegradable](https://en.wiktionary.org/w/index.php?title=biodegradable&oldid=93601973#Etymology) | [biological](https://en.wiktionary.org/w/index.php?title=biological&oldid=93574752#Etymology) | [biofuel](https://en.wiktionary.org/w/index.php?title=biofuel&oldid=90534989#Etymology) |
| phono-／-phone | [telephone](https://en.wiktionary.org/w/index.php?title=telephone&oldid=93653059#Etymology)、[microphone](https://en.wiktionary.org/w/index.php?title=microphone&oldid=91535807#Etymology) | [phonograph](https://en.wiktionary.org/w/index.php?title=phonograph&oldid=93738974#Etymology) | [homophone](https://en.wiktionary.org/w/index.php?title=homophone&oldid=92638743#Etymology) | [megaphone](https://en.wiktionary.org/w/index.php?title=megaphone&oldid=93662880#Etymology_1) |
| micro- | [microscope](https://en.wiktionary.org/w/index.php?title=microscope&oldid=93505816#Etymology)、[microorganism](https://en.wiktionary.org/w/index.php?title=microorganism&oldid=93145897#Etymology) | [microclimate](https://en.wiktionary.org/w/index.php?title=microclimate&oldid=88585115#Etymology) | [microwave](https://en.wiktionary.org/w/index.php?title=microwave&oldid=93554978#Etymology) | [microplastic](https://en.wiktionary.org/w/index.php?title=microplastic&oldid=92459132#Etymology) |

## 教學與標記的界線

- 這裡的字族包含可延伸的英語詞綴和希臘語來源的構詞成分，不宣稱同一課所有詞都由同一個英語單字直接演變。
- biology、biosphere 和 microscope 的拆解標為字面分析；例字解說或來源保留其借詞背景。沒有用推測的原始印歐語祖根解釋現代意思。
- resign、awful、priceless、transparent 和 microwave 用來練習歷史構詞、慣用義、詞性或語境的限制。unlock 用來區分否定和逆轉；homophone 用來區分同音與同源。
- prelaunch、interface、biological 三題的正解是需要更多上下文，其餘邊界題有可由句子支持的具體答案。
- 每個 sense 為本專案穩定的詞義識別字，不是 Wiktionary 的義項編號。context-undetermined 表示刻意保留多義、需要語境判斷的題型。
- 例句的情境是教學用虛構內容；定義有來源不代表來源記載過例句中的事件。

## 避免提前教到測驗詞

十堂課共有 20 個教學詞、20 個立即題目詞及 10 個延後題目詞，50 個目標詞互不重複。立即題的目標詞不放入該課的教學卡；延後題的目標詞不放入任何課程的初始教學或立即題內容。題目會提示必要的底字意思，評量的是將學到的構詞線索用在新組合上的表現。

教學前不得顯示延後題；作答前也不得顯示 sense、explanation、clue、boundary 或 sources，以免洩漏詞義或答案。這是介面呈現規則：靜態網站的原始資料仍可被檢視，不能宣稱是安全封存的試題。

「新詞」只表示未在這套課程的前置內容教過，不保證學習者以前從未見過。先前知識、底字提示和猜測都會影響結果；這些題目尚未做難度等化或心理計量驗證，也沒有證明本方法優於其他學習法。維護時應保留首次作答與重練的區別，不把重練高分當成首次遷移證據。

## 檢查

執行 node --test tests/web/lessons.test.mjs 驗證公開資料格式、來源、唯一識別字、50 個詞的隔離，以及三種題組的答案位置分散。內容改動後仍須人工檢查每題是否只有一個可支持的答案、來源段落是否支持解說，以及前置內容有沒有洩漏測驗詞。
