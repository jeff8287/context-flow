# 처음 공유한 뒤 바뀐 것

2026-11-25에 저장소를 처음 공유한 뒤 합쳐진 것을 정리했습니다. 화면에서 새로 할 수 있는 것, 기록을 읽는 법이 바뀐 것, 알아 둘 것의 순서입니다. 자세한 사용법은 각 줄의 문서에 있습니다.

## 갱신하는 법

```sh
git pull
npm install
npm run build
npm run service -- restart   # 서비스로 띄워 두었을 때. 아니면 npm run serve를 다시 돌립니다
```

데모는 `npm run demo`를 다시 돌리면 새 기록으로 시작합니다. 플러그인은 다시 설치하지 않아도 됩니다.

## 화면에서 새로 할 수 있는 것

| 무엇 | 어디서 | 자세히 | PR |
|---|---|---|---|
| 다른 창에서 나눈 대화가 1~2초 안에 화면에 따라옵니다. 세션이 끝나거나 나를 기다리기 시작하면 카드와 탭 제목, 시스템 알림으로 알려 줍니다 | 왼쪽 위 종 단추 | [USAGE.md](USAGE.md) 2절 '알림과 빠른 반영' | [#8](https://github.com/jeff8287/context-flow/pull/8), [#10](https://github.com/jeff8287/context-flow/pull/10) |
| 말에 그림과 파일을 붙이고, 그 말만 다른 모델로 보냅니다 | 입력칸의 클립 단추와 '모델' | [USAGE.md](USAGE.md) 3절, [DEMO.md](DEMO.md) 11절 | [#11](https://github.com/jeff8287/context-flow/pull/11) |
| 보낸 요청을 고쳐 다시 보냅니다. 원래 세션은 그대로 두고 그 요청 앞에서 새 세션이 갈라져 나옵니다. 마지막 답은 '다시 받기'로 한 번 더 받습니다 | 요청 말풍선에 마우스를 올리면 뜨는 '고쳐 보내기' | [DEMO.md](DEMO.md) 9절 | [#12](https://github.com/jeff8287/context-flow/pull/12) |
| 같은 자리에서 갈라진 갈래를 ‹ 1/3 ›으로 넘겨 봅니다 | 고쳐 보낸 요청 아래 | [DEMO.md](DEMO.md) 9절 | [#17](https://github.com/jeff8287/context-flow/pull/17) |
| 지난 대화에 붙어 갔던 그림이 보이고, 고쳐 보낼 때 그림과 파일이 입력칸에 다시 붙습니다 | 대화의 요청 말풍선 | [USAGE.md](USAGE.md) 3절 | [#16](https://github.com/jeff8287/context-flow/pull/16) |
| 화면을 Dock의 앱으로 설치합니다. 서버가 꺼져 있으면 그렇다고 알려 주고, 다시 뜨면 저절로 돌아옵니다 | 왼쪽 위 설치 단추 | [USAGE.md](USAGE.md) 5절 'Dock의 앱으로 쓰기' | [#13](https://github.com/jeff8287/context-flow/pull/13) |
| Codex 데스크톱 앱 없이 씁니다. Claude Code만 쓰거나 Codex를 CLI로만 써도, 세션이 일한 폴더(git 작업 폴더)가 프로젝트로 잡힙니다 | 왼쪽 위 프로젝트 고르기 | [USAGE.md](USAGE.md) 1절 '프로젝트와 세션이 정해지는 법' | [#30](https://github.com/jeff8287/context-flow/pull/30) |
| 읽을 세션이 하나도 없으면 빈 화면 대신 기록을 어디서 찾아봤는지와 할 일을 보여 주고, 첫 세션이 생기면 저절로 이어집니다. 새 세션 창은 이 컴퓨터에 없는 클라이언트를 '찾지 못함'으로 보입니다 | 지도 자리, 새 세션 창 | [USAGE.md](USAGE.md) 1절, 8절 | [#40](https://github.com/jeff8287/context-flow/pull/40) |
| 세션이 하나도 없을 때 화면에서 폴더를 골라 첫 세션을 시작합니다. 홈 폴더부터 폴더를 따라 내려가거나 경로를 적고, 홈 근처의 git 저장소는 바로 고릅니다 | 안내 카드의 '폴더를 골라 첫 세션 시작', 새 세션 | [USAGE.md](USAGE.md) 1절 | [#44](https://github.com/jeff8287/context-flow/pull/44) |
| 프로젝트가 있을 때도 새 세션 창의 '다른 폴더…'로 프로젝트 밖의 폴더(방금 만든 저장소 같은)에서 바로 시작합니다. 어느 프로젝트에도 없는 폴더는 새 프로젝트가 되어 지도에 함께 올라가고, 그 뒤로 프로젝트 목록에 남습니다 | 새 세션 창의 '폴더' | [USAGE.md](USAGE.md) 1절 | [#46](https://github.com/jeff8287/context-flow/pull/46) |
| 이렇게 더한 프로젝트를 목록에서 뺍니다. 한 번 더 묻고, 지도에서도 내립니다. 세션의 기록은 그대로입니다 | 프로젝트 목록의 × | [USAGE.md](USAGE.md) 1절 | [#48](https://github.com/jeff8287/context-flow/pull/48) |
| 목록에서 뺀 프로젝트를 잠시 뜨는 카드의 '되돌리기'로 원래 자리와 지도에 되돌립니다 | 빼고 난 뒤의 카드 | [USAGE.md](USAGE.md) 1절 | [#54](https://github.com/jeff8287/context-flow/pull/54) |
| 첫 세션 창에서 모델을 고릅니다. 그 클라이언트가 내주는 모델이 목록에 나오고, 고르지 않으면 기본 모델입니다 | 첫 세션 창의 '모델' | [USAGE.md](USAGE.md) 1절 | [#52](https://github.com/jeff8287/context-flow/pull/52) |
| 요청을 고치거나 대화를 되감기 전에 오간 말을, 대화가 갈린 자리에서 펼쳐 봅니다. 거기서도 조각을 담아 다른 세션이나 그 세션 자신에게 보냅니다 | 대화의 점선 줄 '고치기 전의 대화', '되감기 전의 대화' | [DEMO.md](DEMO.md) 10절 | [#26](https://github.com/jeff8287/context-flow/pull/26), [#32](https://github.com/jeff8287/context-flow/pull/32) |

## 기록을 읽는 법이 바뀐 것

같은 기록인데 전에는 틀리게 읽히던 것들입니다. 갱신하면 지도와 대화가 아래처럼 달라져 보일 수 있습니다.

| 기록 | 전 | 지금 | PR |
|---|---|---|---|
| Codex 앱에서 메시지를 고쳐 다시 보낸 스레드 | 고친 뒤의 턴만 읽혀서 앞선 대화가 사라져 보였습니다 | 기록이 여러 파일에 걸쳐 있는 것을 거슬러 읽어 앞선 대화가 모두 나옵니다 | [#21](https://github.com/jeff8287/context-flow/pull/21) |
| 갈라진 세션 | 어느 세션에서 갈라졌는지만 알았습니다 | 어느 요청 앞에서 갈라졌는지도 압니다. 역추적은 그 요청 앞에 나온 조각만 갈라진 세션으로 따라갑니다 | [#17](https://github.com/jeff8287/context-flow/pull/17) |
| 갈라진 세션에 붙여넣은 글 | 원래 세션이 갈라진 뒤에 한 말을 붙여넣어도 물려받은 것으로 쳐서 선이 없었습니다 | 갈라진 자리 뒤의 말을 붙여넣은 것은 붙여넣기 선으로 잡힙니다 | [#22](https://github.com/jeff8287/context-flow/pull/22) |
| Claude Code에서 되감은(`/rewind`) 세션 | 되감아 버린 요청과 답까지 대화로 읽혔습니다 | Claude가 지금 기억하는 대화만 읽힙니다 | [#24](https://github.com/jeff8287/context-flow/pull/24) |
| Claude Code가 대화를 요약한(`/compact`, 자동 요약) 세션 | 요약 글이 사용자의 요청으로 읽혔고, 그 세션에서 고쳐 보내기가 시작하지 못했습니다 | 요약은 요청이 아닙니다. 요약 뒤의 요청은 고쳐 보낼 수 있고, 요약 앞의 요청은 안 되는 까닭을 알려 줍니다 | [#24](https://github.com/jeff8287/context-flow/pull/24) |

## 알아 둘 것

- 보이는 세션이 없는 프로젝트(보관된 세션만 있는 것 등)를 지도에 함께 올리면 지도가 그려지지 않고 프로젝트 단추도 그대로이던 것을 고쳤습니다([#46](https://github.com/jeff8287/context-flow/pull/46)).
- 타일 아래 줄을 다시 짰습니다. 상태는 작업 중일 때 말고는 잘리지 않습니다. 작은 표시는 한 묶음에 담기고 수는 둘 이상일 때만 붙습니다. 클라이언트 이름 글자는 줄 끝의 모양으로 바뀌었습니다. 동그라미가 Codex, 네모가 Claude Code이고 지도 범례에도 있습니다([#42](https://github.com/jeff8287/context-flow/pull/42)).
- **담아 둔 조각을 다시 담아야 할 수 있습니다.** 앱에서 메시지를 고친 적이 있는 Codex 스레드는 항목 번호가 달라졌습니다. 그런 스레드에서 전에 담아 둔 조각을 보낼 때 "붙인 조각을 기록에서 찾지 못했습니다"가 나오면 그 글을 다시 골라 담으면 됩니다.
- **요청 수가 줄어 보일 수 있습니다.** 되감은 Claude Code 세션은 버려진 턴이 대화에서 빠지고 접힌 줄로 옮겨 갑니다.
- **접힌 말은 대화가 아닙니다.** 에이전트가 더는 기억하지 못하는 말이라서 고쳐 보낼 수 없고, 요청 수와 붙여넣기 찾기에 들어가지 않고, 내보낸 파일에 글이 들어가지 않습니다. 조각은 담아서 보낼 수 있습니다.
- **Codex 데스크톱 앱이 열어 둔 스레드**에는 여전히 이 화면에서 바로 보낼 수 없습니다(걸어 두기를 씁니다). 그런 스레드에서 세션을 갈라 내는 것, 곧 고쳐 보내기는 됩니다.
- 서비스가 떠 있는 채로 `npm run service -- install`을 다시 돌리면 실패하던 것을 고쳤습니다([#7](https://github.com/jeff8287/context-flow/pull/7)).

## 개발

- PR마다 타입 검사, 시험, 빌드가 돕니다([#7](https://github.com/jeff8287/context-flow/pull/7)). 시험은 60개이고 모두 지어낸 기록으로 돕니다.
- 데모의 그림을 `npm run demo:shots`로 다시 찍습니다. DEMO.md의 단계를 헤드리스 Chrome으로 차례대로 눌러 가며 찍으므로, 그림이 지금 화면과 같고 따라 하기의 단계가 실제로 되는지도 함께 확인됩니다. 이 명령으로 단계 그림을 모두 지금 화면으로 다시 찍었습니다. 데모의 Codex 대역이 화면의 서버가 스레드 목록을 읽는 순간과 겹치면 승인 뒤에 끝나 버리던 것도 고쳤습니다([#36](https://github.com/jeff8287/context-flow/pull/36)).
- Linux 컨테이너처럼 root로 도는 곳에서 `demo:shots`가 Chromium을 띄우지 못하던 것을 고쳤습니다. Chrome이 뜨지 않으면 Chrome이 남긴 말을 함께 알려 주고 뒷정리를 합니다([#39](https://github.com/jeff8287/context-flow/pull/39)).
- 실제 클라이언트로 확인한 것과 하지 못한 것은 [WHY.md의 6절](WHY.md#6-한계와-확인하지-못한-것)에 날짜와 함께 적어 두었습니다.
