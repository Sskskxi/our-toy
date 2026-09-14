# 커밋 컨벤션

이 저장소는 가장 널리 쓰이는 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ko/v1.0.0/) 규칙을 따릅니다. 타입 목록은 Angular 커밋 가이드라인에서 가져왔습니다.

## 형식

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **첫 줄(헤더)만 필수**입니다. 본문과 꼬리말은 필요할 때 씁니다.
- 헤더, 본문, 꼬리말 사이는 빈 줄 하나로 나눕니다.

### 예시

```
feat(ui): 구독 카드에 로그인 계정 ID와 플랜 표시
```

```
fix(engine): 이어서 실행 시 개입 메모가 재생 단계에 묻히는 문제 수정

저장된 단계를 재생하는 동안에는 inbox를 비우지 않고,
첫 실제 호출 단계에서 메모를 전달하도록 바꿨습니다.

Closes #12
```

```
feat(api)!: 쓰기 API에 JSON Content-Type 필수화

BREAKING CHANGE: Content-Type 없이 POST하던 스크립트는 415를 받습니다.
```

## type

| type | 언제 |
|---|---|
| `feat` | 사용자가 체감하는 새 기능 |
| `fix` | 버그 수정 |
| `docs` | 문서만 변경 |
| `style` | 동작에 영향 없는 서식 변경 (공백, 세미콜론 등) |
| `refactor` | 기능 추가나 버그 수정 없이 코드 구조 개선 |
| `perf` | 성능 개선 |
| `test` | 테스트 추가·수정 |
| `build` | 빌드 설정, 의존성 변경 (`package.json`, lockfile) |
| `ci` | CI 설정 변경 |
| `chore` | 그 밖의 잡무 (설정 파일, 스크립트 정리 등) |
| `revert` | 이전 커밋 되돌리기 |

한 커밋에 여러 성격이 섞이면 가장 중요한 변화를 기준으로 type을 고르고, 가능하면 커밋을 나눕니다.

## scope (선택)

바뀐 영역을 괄호 안에 적습니다. 이 저장소에서 쓰는 scope:

| scope | 대상 |
|---|---|
| `engine` | `lib/engine.ts` 협업 라운드, 원장, 이어서 실행 |
| `prompt` | `lib/provider.ts` 모델 지시문 |
| `cli` | `lib/subscription.ts`, `lib/account-usage.ts` Codex·Claude CLI 호출 |
| `api` | `app/api/**` 라우트 |
| `ui` | `app/page.tsx`, `app/debate.tsx`, `app/globals.css` |
| `pdf` | `app/pdf.ts` 첨부 추출 |
| `update` | `lib/updater.ts`, `scripts/launch.mjs` 자동 업데이트 |
| `security` | `lib/http.ts` 등 요청 검증·격리 |
| `worker` | `scripts/worker.ts` |
| `deps` | 의존성 (`build(deps)`) |

여러 영역에 걸치면 scope를 생략해도 됩니다.

## subject (제목)

- **type과 scope는 영어 소문자**, 제목은 **한국어**로 씁니다.
- `추가`, `수정`, `제거`, `변경`처럼 무엇을 했는지로 끝냅니다.
- **50자 안팎**으로 짧게 쓰고, 끝에 마침표를 찍지 않습니다.
- 왜 바꿨는지는 제목이 아니라 본문에 씁니다.

## body (본문, 선택)

- 한 줄 72자 안팎에서 줄을 바꿉니다.
- **무엇을, 왜** 바꿨는지 씁니다. 어떻게는 코드가 보여줍니다.
- 여러 항목이면 `- ` 목록을 씁니다.

## footer (꼬리말, 선택)

- 이슈 연결: `Closes #12`, `Refs #8`
- 호환성이 깨지는 변경: `BREAKING CHANGE: 설명` (헤더의 type 뒤에 `!`도 붙입니다)
- 공동 작성자: `Co-Authored-By: 이름 <email>`

## 체크리스트

- [ ] 헤더가 `type(scope): 제목` 형식인가
- [ ] 한 커밋에 한 가지 목적만 담았는가
- [ ] `npm test`, `npm run typecheck`가 통과하는가
- [ ] `.env.local`, `data/` 같은 개인 파일이 들어가지 않았는가
