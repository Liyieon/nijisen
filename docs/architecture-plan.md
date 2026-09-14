# 虹線 NIJISEN — 架構計畫（草案 v1）

目標：在做模組 02 之前，把「單一工具頁」整理成「一個殼 + 多個模組 + 共用核心」，讓第二個工具不必複製第一個工具的程式碼。

---

## 現況（2026-09 盤點）

| 項目 | 狀態 | 問題 |
|---|---|---|
| 頁面 | 單一 `index.html` 就是模組 01 | 沒有地方放模組 02 |
| JS 載入 | 10 支 `<script>` 依序載入，共用 `window.AM` 全域 | 靠載入順序維持依賴，順序錯就壞 |
| `main.js` | 約 1,400 行，UI／渲染迴圈／狀態／I/O 全在一起 | 改一處容易波及別處 |
| CSS | 單一 `style.css` 約 800 行，色票＋元件＋模組版面混在一起 | 模組 02 無法只拿元件 |
| 建置 | 無建置，GitHub Pages 直接發佈靜態檔 | 這是優點，建議保留 |
| 測試 | 無自動測試，每次靠手動在瀏覽器跑驗證腳本 | 回歸只能靠人工 |
| 除錯出口 | `window.AMESEN`（舊專案名） | 名稱過時 |

**已經先做好的準備（本次）**
- `recorder.js` / `midi.js` / `state.js` 寫成與模組無關的獨立檔，未來直接搬進 `core/`
- 狀態格式帶 `app: 'nijisen'`、`mod: 'threshold'`、`v: 1`：分享連結日後搬家時能被正確轉送
- localStorage 已用命名空間 `nijisen.threshold.*`，多模組不會互相覆蓋

---

## 需要你決定的三件事

| 決策 | 建議 | 理由 |
|---|---|---|
| 要不要導入建置工具（Vite 等） | **先不要**，改用瀏覽器原生 ES modules | 目前沒有任何 npm 依賴；無建置 = 部署零設定、除錯看到的就是原始碼。等真的需要套件（例如 three.js 打包）再導入 |
| 模組是「各自一頁」還是「單頁切換」 | **各自一頁**（多頁式） | 每個工具的 AudioContext、畫布、事件完全隔離，一個模組出錯不會拖垮另一個；GitHub Pages 天生適合 |
| 網址結構 | `/nijisen/` 首頁、`/nijisen/threshold/` 模組 01 | 語意清楚；舊網址由首頁轉送（見階段 1） |

---

## 分階段計畫

每一階段結束時網站都必須是可用的，不做「大爆炸式」重構。

### 階段 1 — 目錄重排＋首頁殼（約半天）
```
/index.html                  首頁：模組清單（目前只有 01）
/core/css/tokens.css         色票、深淺主題、字體
/core/css/components.css     sq-btn · seg · stepper · knob · panel · drawer · toast
/core/js/                    palette · knob · recorder · midi · state
/threshold/index.html        模組 01
/threshold/css/threshold.css 模組 01 專屬版面
/threshold/js/               audio-engine · detector · spectro · main
/fonts/
```
- **舊分享連結相容**：首頁讀到 `#s=...` 時，解碼看 `mod` 欄位，轉送到 `/threshold/#s=...`
- **路徑陷阱**：Pages 專案站台根路徑是 `/nijisen/`，不能用 `/core/...` 絕對路徑，一律用相對路徑 `../core/...`

### 階段 2 — 拆解 `main.js`（約 1 天）
拆成職責單一的檔案，**行為零改變**：
`rails.js`（音階／量化／音色／效果）· `params.js`（旋鈕、偵測設定）· `lines.js`（選取、增刪、上色）· `stage.js`（全屏模式）· `io.js`（錄製、MIDI、狀態）· `loop.js`（渲染迴圈）

### 階段 3 — 改用 ES modules（約半天）
`<script type="module">` + `import/export`，移除 `window.AM` 全域與載入順序依賴。除錯出口改名 `window.NIJISEN`。

### 階段 4 — 模組契約（約半天）
每個模組附一份描述檔，首頁據此產生清單：
```json
{ "id": "threshold", "no": "01", "title": "Video Threshold Sequencer",
  "path": "threshold/", "thumb": "threshold/thumb.png", "status": "live" }
```
共用的頂欄／頁尾／主題切換放進 `core/`，模組只寫自己的內容。

### 階段 5 — 煙霧測試頁（約半天）
`/tests/smoke.html`：開啟即自動跑一輪檢查（狀態往返與惡意輸入、MIDI 位元組、WAV 檔頭、配色 ramp、版面溢出），綠燈／紅燈顯示。**把這幾週手動跑過的驗證固化下來**，之後每次改動都能一鍵確認沒有退步。

### 階段 6 — 用模組 02 驗證契約
做第二個工具時，如果還需要複製模組 01 的程式碼，代表 `core/` 切得不夠，回頭修契約。

---

## 建議順序與時程
1 → 5 → 2 → 3 → 4 → 6

煙霧測試（5）排在拆檔（2、3）**之前**：先有安全網，再動大手術。總計約 3 天工作量，可分批進行，每批獨立上線。

## 風險
| 風險 | 對策 |
|---|---|
| 已分享出去的連結失效 | 首頁轉送 `#s=`；狀態格式已帶 `mod` 與 `v` |
| 使用者的自動保存遺失 | localStorage 鍵名不變（已命名空間化） |
| 相對路徑在 Pages 上錯位 | 階段 1 完成後先部署到分支預覽再合併 |
| 拆檔引入回歸 | 階段 5 的煙霧測試先行 |
