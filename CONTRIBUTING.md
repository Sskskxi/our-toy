# 기여 가이드

우리의장난감에 관심 가져 주셔서 고맙습니다. 버그 제보, 문서 수정, 기능 제안, 코드 기여 모두 환영합니다.

## 이슈 올리기

[Issues](../../issues)에서 새 이슈를 만들어 주세요.

**버그 제보**에는 아래 내용을 적어 주시면 빨리 확인할 수 있습니다.

- 무엇을 했고, 무엇을 기대했고, 실제로 어떻게 됐는지
- 실행 방식 (`subscription` / `mock`)과 라운드 설정
- OS, `node --version`, `codex --version`, `claude --version`
- 오류 메시지나 스크린샷

> 올리기 전에 **API 키, 로그인 토큰, `.env.local` 내용, `data/` 안의 개인 연구 기록**이 들어 있지 않은지 꼭 확인하세요.

**기능 제안**에는 어떤 문제를 해결하고 싶은지, 어떻게 동작하면 좋을지 적어 주세요.

## 코드 기여 절차

### 1. Fork와 Clone

GitHub에서 저장소 오른쪽 위의 **Fork**를 누른 뒤, 내 계정으로 복사된 저장소를 받습니다.

```bash
git clone https://github.com/<내-계정>/our-toy.git
cd our-toy
git remote add upstream https://github.com/Sskskxi/our-toy.git
npm ci
cp -n .env.example .env.local
```

### 2. 브랜치 만들기

`main`에서 바로 작업하지 말고 브랜치를 만듭니다.

```bash
git fetch upstream
git checkout -b feat/짧은-설명 upstream/main
```

브랜치 이름 예시:

| 접두어 | 용도 |
|---|---|
| `feat/` | 새 기능 |
| `fix/` | 버그 수정 |
| `docs/` | 문서 |
| `refactor/` | 동작 변경 없는 구조 개선 |
| `test/` | 테스트 추가·수정 |

### 3. 개발하기

```bash
npm run dev   # http://127.0.0.1:3000
```

- 구독 사용량을 아끼려면 개발 중에는 **Mock 모드**나 **최소/최대 1라운드**로 확인하세요.
- 새 동작에는 `tests/`에 테스트를 추가해 주세요.
- 기존 코드 스타일(TypeScript, Zod 검증, 작은 모듈)을 따라 주세요.

### 4. 제출 전 확인

```bash
npm test
npm run typecheck
npm run build
```

세 명령이 모두 통과해야 합니다. 화면을 바꿨다면 `npm run dev` 상태에서 `npm run smoke`로 mock HTTP 흐름도 확인해 주세요.

### 5. 커밋과 Push

커밋 메시지는 무엇을 바꿨는지 짧게 적습니다.

```bash
git add <바꾼 파일>
git commit -m "fix: Claude 로그인 확인 오류 메시지 개선"
git push origin feat/짧은-설명
```

### 6. Pull Request 열기

GitHub의 내 Fork 저장소에서 **Compare & pull request**를 누르고 아래를 적어 주세요.

- **무엇을** 바꿨는지
- **왜** 바꿨는지 (관련 이슈가 있으면 `Closes #번호`)
- **어떻게 확인했는지** (테스트, mock 실행, 실제 구독 실행 여부)
- 화면 변경이면 스크린샷

리뷰에서 수정 요청이 오면 같은 브랜치에 커밋을 추가로 push하면 PR에 자동 반영됩니다.

## 지켜야 할 원칙

이 프로젝트는 **구독 로그인만 쓰고, API 키나 인증 정보를 앱이 다루지 않는다**는 원칙을 지킵니다. 아래에 해당하는 변경은 받지 않습니다.

- 자식 프로세스에 API 키나 OAuth 토큰을 전달하는 변경
- 구독 한도 초과 시 유료 API로 자동 전환하는 변경
- 사용자 인증 저장소를 읽거나 복사, 삭제하는 변경
- 모델이 쓴 URL이나 모델 간 합의를 "검증된 사실"로 표시하는 변경

## 라이선스

기여한 코드는 이 저장소의 [MIT 라이선스](LICENSE)로 배포되는 데 동의한 것으로 봅니다.
