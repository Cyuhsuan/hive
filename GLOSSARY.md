# implement-swarm

A pane beside the chat that shows what the session's subagents are doing, and, when the work follows a workflow, how far its tickets have come.

## Language

**工作流（Workflow）**:
使用者明確選用的一組慣例，讓面板知道哪個 skill 代表開始、票來源是什麼、票怎麼寫。`mattpocock-skills` 是目前唯一的工作流。
_Avoid_: 流程、pipeline；也不是指 Claude Code 的 Workflow 工具

**票來源（Ticket source）**:
一批票實際存放的地方：專案內的 markdown 檔，或 GitHub 上的 issue。由專案的 tracker 設定決定，不由使用者在面板上選。
_Avoid_: tracker、後端、provider

**一批票（Feature）**:
同一個 spec 拆出來、一起畫在面板上的那些票。
_Avoid_: 專案、epic

**純觀察（Observe）**:
面板不套用任何工作流時的樣子：只呈現 lead、子代理與 session log，沒有票與時間步。
_Avoid_: 一般模式、無工作流模式

**票（Ticket）**:
工作流裡一份可獨立實作的工作，有編號、標題、狀態、驗收項目，以及擋住它的其他票。
_Avoid_: issue、任務

**票況（Ticket state）**:
面板上一張票當下的樣子：已併回、已完成、進行中、失敗、可開始、被擋住，六者之一。由票的狀態、是否已併回整合分支、是否有子代理正在做、擋住它的票是否完成推導而來。
_Avoid_: 狀態（那是票面上寫的 Status）、進度

**時間步（Step）**:
可以同時進行的一批票；一張票的時間步比擋住它的票都晚一步。
_Avoid_: 階段、波次

**Lead**:
派出子代理並把票的成果併回整合分支的主 session。
_Avoid_: 主代理、orchestrator

**子代理卡（Agent card）**:
面板上代表一個子代理的框，呈現它是誰、正在做什麼、是否出錯或結束。
_Avoid_: agent 列、卡片

**動畫（Animation）**:
面板上表示有子代理正在執行的循環動態；沒有子代理執行時面板靜止。
_Avoid_: 特效、轉場
