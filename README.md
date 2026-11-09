# implement-swarm

implement-spec 實作階段的即時指揮台。當主 session 呼叫 `/implement-spec`，或派出任何 prompt 裡指到票檔（`…/issues/NN-*.md`）的子代理時，自動打開一個面板，用拓撲圖的方式呈現：

![面板畫面：九張票分成四個時間步，同時有執行中、審查中、啟動中、失敗與完成的子代理](docs/screenshot.png)

上圖是用 mod 實際畫出的內容轉成的示意圖：兩張票已 merge，四個子代理分別在測試、改碼、審查與啟動中，一個失敗，三個完成。

- **feature 框**：整體進度條（已 resolved 的票算整張，進行中的票按勾掉的驗收項目比例算）、票數與目前步驟，下面每個時間步一列。正在做的那一步會寫出票名與驗收數，其他步驟只畫「圖示 + 票號」。
- **lead 框**：主 session 與它的模型，以及已派出幾個子代理、已 merge 幾張票。
- **子代理卡**（掛在 lead 底下）：標題是票號與票名、所在步驟與耗時；第二行是階段進度條（讀碼 → 改碼 → 測試 → merge → commit）；第三行是最近一次工具呼叫。有錯誤時標題會出現 `⚠ N err`。失敗的卡排最前、紅框；完成的卡縮成一行、綠框。
- **session log**：最近 5 筆派出、完成、失敗、merge 與票面 resolved；階段切換只顯示在卡片上。

票的圖示與顏色，和負責它的子代理卡的狀態點與框色是同一套：

| 圖示 | 意思 |
| --- | --- |
| `◆` 綠 | 已 merge 進整合分支 |
| `✓` 綠 | 票面 resolved／子代理完成 |
| `●` 黃 | 進行中 |
| `✗` 紅 | 失敗 |
| `○` | 可以開始 |
| `·` 灰 | 被前面的票擋住 |

面板窄於 40 欄時自動精簡：卡片標題只留票號與階段，log 只留票號，框與拓撲線都保留。

階段是從子代理的工具呼叫推估的：名稱含 edit／write／replace／insert 的工具算改碼，`dotnet test`、`npm test` 等算測試，`git merge` 算 merge，`git commit` 算 commit。類型名稱含 review 的子代理一律顯示為審查。

## 相依

沒有。這個 mod 只用 Claude Code 引擎提供的 `claude-code` 模組，不需要 npm 套件、其他 plugin、特定的 agent 類型或 MCP 伺服器，也不呼叫任何作業系統指令，macOS、Linux、Windows 都能用（路徑的 `\` 與 `/` 都認得）。

## 使用

- 進入 implement 階段時自動打開；也可以隨時輸入 `/swarm` 打開，`/swarm reset` 清空上一輪的紀錄。
- 面板寬度用滑鼠拖曳面板邊界調整，面板內容會跟著重排。
- 狀態列會顯示「swarm N 跑 · M 完」。
- 狀態存在 session 的 `$.state`，熱重載不會遺失。

## 安裝

在終端機 session 的提示列輸入：

```
/plugin install implement-swarm --marketplace Cyuhsuan/implement-swarm
```

接著按 `y` 加入 marketplace，再選安裝範圍（預設是 user）。

也可以從 shell 安裝：

```bash
claude plugin install implement-swarm --marketplace Cyuhsuan/implement-swarm
```

桌面 app 不能執行 `/plugin`：點提示框旁的 +，選 Plugins，用 `Cyuhsuan/implement-swarm` 加入 marketplace，再加入 plugin。

這是私有 repository。安裝的人必須在 GitHub 上有讀取權限，而且電腦上已有 github.com 的 git 憑證（SSH key，或先執行 `gh auth login` 再 `gh auth setup-git`）；安裝過程不會跳出登入提示。
