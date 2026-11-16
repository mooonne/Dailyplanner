# 오늘의 나

폰에서 쓰는 하루 일과 기록 앱(PWA)과 동기화/알림 서버(Cloudflare Worker + D1)예요.

## 서버 두 개

| 구분 | 브랜치 | 앱 주소 | API 서버 | DB |
|---|---|---|---|---|
| 운영 (Production) | `main` | https://today-me-ad0.pages.dev | https://today-me-api.md8044.workers.dev | today-me-db |
| 개발 (Dev) | `dev` | https://dev.today-me-ad0.pages.dev | https://today-me-api-dev.md8044.workers.dev | today-me-db-dev |

앱은 접속한 주소를 보고 운영/개발 서버를 자동으로 골라요. 두 서버는 DB가 따로라서 개발 중에 운영 기록이 섞이지 않아요.

## 업데이트 순서

1. 수정은 항상 `dev` 브랜치에 올려요. 올리면 GitHub Actions가 개발 서버로 자동 배포해요.
2. https://dev.today-me-ad0.pages.dev 에서 확인해요.
3. 문제없으면 `dev` -> `main` Pull Request를 만들고 Merge해요. 그러면 운영 서버로 자동 배포돼요.

## 작업 규칙

- 앱을 수정하면 `dev` 브랜치에 커밋해요. 커밋 메시지는 무엇을 바꿨는지 한국어로 짧게 적어요.
- 바뀐 내용은 `CHANGELOG.md` 맨 위에 한 줄씩 추가해요.
- 그날 작업 메모는 `docs/devlog/날짜.md`에 남겨요.
- `main`에는 직접 올릴 수 없고 `dev` -> `main` Pull Request로만 반영돼요.

## 폴더 구조

- `app/` 앱 화면 (Cloudflare Pages `today-me`)
- `worker/` API 서버 코드와 설정 (`wrangler.toml`)
- `.github/workflows/deploy.yml` 자동 배포 설정
- `docs/devlog/` 날짜별 개발 노트
- `CHANGELOG.md` 변경 기록

## 필요한 GitHub Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`