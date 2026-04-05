# GameJob Crawler v5.0

게임잡(GameJob) 채용공고를 자동 수집하여 JSON 데이터로 만들어주는 크롤링 봇입니다.
수집된 데이터는 포트폴리오 봇(`Portpolio_BOT`)의 채용 분석 기능에 활용됩니다.

## 수집 항목

- **기본 정보**: 공고 제목, 기업명, 채용 직무, 주요 게임 장르/카테고리
- **자격 요건**: 요구 경력, 학력 구분, 고용 형태
- **근무 조건**: 모집 직급, 영입 인원, 급여 수준, 마감일
- **핵심 요강**: 모집요강 본문 텍스트 전체

## 설치

```bash
npm install
npx playwright install chromium
```

## 실행

```bash
# 기본 태그 [게임기획, 신입, 경력무관, 1~3년]
node crawler.js

# 원하는 태그 지정
node crawler.js 게임기획 신입

# 도움말
node crawler.js --help

# Windows 원클릭 실행 (.bat)
start-crawler.bat
start-crawler.bat 게임기획 신입 1~3년
```

실행하면 튜토리얼 배너가 표시되며, `Ctrl+C`로 안전하게 중단할 수 있습니다.

## 데이터 구조

```
data/
  raw/            원본 데이터 (건별 JSON)
  refined/        정제된 데이터 (건별 JSON)
  jobs/           ★ 통합 데이터
    all-jobs.json   → 크롤링 중 실시간 업데이트
                    → 중단해도 수집된 만큼 즉시 분석 가능
  debug/          디버그용 HTML 스냅샷
```

## v5.0 변경사항

- 탭-어웨어 체크박스 그룹핑 (필터 토글 버그 해결)
- 검색 결과 갱신 감지 (Backbone 비동기 처리 대응)
- scrollIntoView + 다중 폴백 클릭 전략
- Backbone-어웨어 페이지네이션 (AJAX 갱신 감지)
- targets CLI 파라미터화 (하드코딩 제거)
- `data/jobs/all-jobs.json` 실시간 적재 (중단 시에도 데이터 보존)
- 실행 시 튜토리얼 배너
- Ctrl+C 안전 중단 + 요약 출력
- 크롤링 딜레이 최소화 (0.2~0.5초)

## 유의 사항

- 게임잡 사이트 DOM 구조에 의존하므로, 대규모 개편 시 셀렉터 업데이트가 필요할 수 있습니다.
- 하루 1~2회 상식적인 수준의 정기 수집을 권장합니다.
