# context-flow 플러그인

맥락 흐름 화면에서 걸어 둔 조각을, 받는 세션에 **다음 말을 칠 때** 함께 실어 보내는 훅 하나입니다. Codex(데스크톱 앱, CLI)와 Claude Code가 같은 플러그인을 씁니다.

## 하는 일

1. 화면에서 조각을 붙이고 '다음 말에 싣기'를 누르면 서버가 조각을 `~/.context-flow/pending/<받는 세션 id>/<조각 id>.json`에 둡니다.
2. 그 세션에 말을 치면(어디서 치든) 클라이언트가 UserPromptSubmit 훅 `hooks/along.sh`를 부릅니다. 걸린 것이 하나도 없으면 여기서 바로 끝납니다. node를 띄우지 않습니다.
3. 걸린 것이 있으면 `hooks/along.mjs`가 그 세션의 조각을 가져가 `additionalContext`로 내고, `~/.context-flow/transfers.jsonl`에 한 줄씩 적습니다(`via: "hook"`).
4. 화면은 받은 세션의 기록에서 조각의 표식(`<context-piece id="…">`)을 찾았을 때만 실선을 그립니다. Codex는 developer 메시지로, Claude Code는 `hook_additional_context` 첨부로 남깁니다.

훅은 화면에서 조각을 걸어 둔 세션에서만 무언가를 합니다. 나머지 세션에서는 걸린 것이 있는지만 보고 끝나며, 아무것도 기록하지 않습니다.

## 설치

저장소의 `plugin` 폴더가 마켓플레이스입니다. 아래 경로를 저장소를 받아 둔 곳으로 바꿔 주세요.

Codex

```sh
codex plugin marketplace add /path/to/context-flow/plugin
codex plugin add context-flow@context-flow
```

그다음 훅을 한 번 승인해야 합니다. 터미널에서 `codex`를 열면 "Hooks need review"가 뜨고(또는 `/hooks`), 거기서 context-flow의 훅을 승인합니다. 승인 전부터 열려 있던 데스크톱 스레드는 앱을 끝냈다 다시 연 뒤부터 훅을 부릅니다. 스크립트나 `hooks.json`을 고치면 판 번호를 올려 다시 설치하고 다시 승인합니다. Codex는 승인한 뒤 정의가 바뀐 훅을 부르지 않습니다.

Claude Code

```sh
claude plugin marketplace add /path/to/context-flow/plugin
claude plugin install context-flow@context-flow
```

사용자 범위로 설치됩니다. 마켓플레이스와 켬 표시가 `~/.claude/settings.json`(`extraKnownMarketplaces`, `enabledPlugins`)에 적힙니다. Codex와 달리 훅을 따로 승인하는 단계는 없습니다. 다만 터미널에서 처음 여는 폴더는 Claude Code가 폴더를 신뢰하는지 먼저 묻습니다.

지우기

```sh
codex plugin remove context-flow@context-flow
codex plugin marketplace remove context-flow
claude plugin uninstall context-flow@context-flow
claude plugin marketplace remove context-flow
```

## 알아 둘 것

- **긴 조각.** Claude Code는 훅이 더한 글이 10,000자를 넘으면 짧은 미리보기로 바꿉니다. 그래서 훅이 9,000자 안에 맞춥니다. 제 몫을 넘는 조각은 앞부분만 싣고 전체를 `~/.context-flow/pieces/<조각 id>.txt`에 둔 뒤 그 경로를 적습니다. Codex는 46,000자를 통째로 받는 것을 확인했고 40,000자까지 그대로 싣습니다.
- **node.** 훅은 node로 돕니다. 화면의 서버가 조각을 걸어 둘 때 제가 도는 node의 경로를 `~/.context-flow/node`에 적어 두고, 훅이 그것을 먼저 씁니다. 데스크톱에서 시작한 클라이언트는 PATH에 node가 없을 수 있기 때문입니다. 찾지 못하면 `~/.context-flow/hook.log`에 한 줄 남기고 말은 그대로 갑니다.
- **말을 막지 않습니다.** 어떤 경우에도 그렇습니다. 잘못되면 조용히 끝나고 조각은 다음 말을 기다립니다.
- **환경 변수.** `CONTEXT_FLOW_HOME`으로 `~/.context-flow` 대신 다른 폴더를 쓸 수 있고, `CONTEXT_FLOW_NODE`로 훅이 돌 node를 정할 수 있습니다. 데모가 이 둘을 씁니다.

## 확인한 것 (2026-11-25, macOS)

- Codex CLI 0.166.0과 데스크톱 앱에 든 엔진 0.171.0-alpha.13이 플러그인의 UserPromptSubmit 훅을 부르고, 훅이 낸 `additionalContext`가 그 턴에 실립니다.
- Codex 데스크톱 앱이 쥔 스레드에서, 훅을 승인하고 앱을 끝냈다 다시 연 뒤의 첫 말에 걸어 둔 조각이 실렸습니다.
- Claude Code 2.1.331에 위 명령으로 설치했고, 터미널에서 대화형으로 연 세션에 걸어 둔 조각이 실렸습니다.
- 두 쪽 모두 받은 세션의 기록에 표식이 남고 화면에 실선이 생겼습니다.

저장소의 데모(`npm run demo`)는 클라이언트를 대역으로 바꾸되 이 훅 스크립트는 그대로 부릅니다.
