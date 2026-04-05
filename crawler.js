const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * GameJob Crawler v5.0
 *
 * [v5.0] Portfolio_BOT 개선사항 역적용:
 *   - 탭-어웨어 체크박스 그룹핑 (토글 버그 해결)
 *   - 검색 결과 갱신 감지 (beforeSearch → waitForFunction)
 *   - 카운트 버튼 갱신 대기 (0건→실제건수)
 *   - scrollIntoView + 다중 폴백 클릭 전략
 *   - Backbone-어웨어 페이지네이션 (AJAX 갱신 감지)
 *   - targets 파라미터화 (하드코딩 → 설정 가능)
 *
 * [v4.0] 기존 버그픽스 유지:
 *   [Bug Fix 1] new Function() CSP 차단 해결: 인라인 매핑 로직으로 전환
 *   [Bug Fix 2] dispatchEvent('click') → .click() 으로 변경 (프레임워크 호환성)
 *   [Bug Fix 3] 고정 대기시간 → waitForSelector/waitForLoadState 기반 스마트 대기
 *   [Bug Fix 4] 셀렉터 다변화: table(tr) + div 구조 모두 지원
 *   [Bug Fix 5] 진단 로깅 강화 + 실패 시 HTML 스냅샷 저장
 *   [기존 유지] 뉴스/노이즈 제거, 11개 항목 파싱, iframe 폴백
 */

// ─── 뉴스/노이즈 제거에 사용할 셀렉터 목록 ───
const NOISE_SELECTORS = [
  '.job-news-wrap', '.news-area', '.news-list', '.news-wrap',
  '.articl-list', '.article-list', '.corp-news', '.company-news',
  '[class*="news"]', '[id*="news"]',
  'footer', '.banner-area', '.job-sub-section', '.aside-banner',
  '.recruit-banner', '.ad-area', '[class*="banner"]',
  '.job-sub-content', '.sub-recruit-list', '.other-recruit',
  '#dev-gi-news', '.gi-news', '.news-section',
].join(', ');

// ─── 기본 정보(11개 항목) 키 매칭 헬퍼 ───
// (Node.js 측에서만 사용 — page.evaluate 안에서는 인라인 버전 사용)
function mapKey(rawKey) {
  const key = rawKey.trim();
  if (key.includes('모집분야') || key.includes('직종') || key.includes('담당업무')) return 'jobField';
  if (key.includes('키워드')) return 'keywords';
  if (key.includes('대표게임') || key.includes('게임명')) return 'mainGame';
  if (key.includes('게임분야') || key.includes('게임장르')) return 'gameCategory';
  if (key.includes('경력')) return 'experience';
  if (key.includes('고용형태') || key.includes('근무형태')) return 'employmentType';
  if (key.includes('학력')) return 'education';
  if (key.includes('직급') || key.includes('직책')) return 'position';
  if (key.includes('모집인원') || key.includes('인원')) return 'recruitCount';
  if (key.includes('급여') || key.includes('연봉') || key.includes('임금')) return 'salary';
  if (key.includes('마감') || key.includes('접수기간') || key.includes('지원기간')) return 'deadline';
  return null;
}

// ─── 디버그용 HTML 스냅샷 저장 ───
function saveDebugHtml(debugDir, filename, html) {
  try {
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, filename), html, 'utf-8');
    console.log(`[DEBUG] HTML 스냅샷 저장: ${filename}`);
  } catch (e) {
    console.error(`[DEBUG] HTML 스냅샷 저장 실패:`, e.message);
  }
}

// ─── all-jobs.json 실시간 적재 헬퍼 ───
// 건별 수집 완료 시마다 호출하여 통합 JSON을 즉시 업데이트
function appendToAllJobs(jobsDir, refinedData) {
  const allJobsPath = path.join(jobsDir, 'all-jobs.json');
  let allJobs = [];
  try {
    if (fs.existsSync(allJobsPath)) {
      allJobs = JSON.parse(fs.readFileSync(allJobsPath, 'utf-8'));
    }
  } catch {
    allJobs = [];
  }
  // 중복 방지: 동일 ID가 있으면 교체, 없으면 추가
  const idx = allJobs.findIndex(j => j.id === refinedData.id);
  if (idx >= 0) {
    allJobs[idx] = refinedData;
  } else {
    allJobs.push(refinedData);
  }
  fs.writeFileSync(allJobsPath, JSON.stringify(allJobs, null, 2), 'utf-8');
}

// ─── 실행 시 튜토리얼 배너 ───
function printTutorial(targets) {
  const line = '═'.repeat(60);
  console.log(`
${line}
  GameJob Crawler v5.0 — 게임잡 채용공고 자동 수집기
${line}

  사용법:
    node crawler.js                기본 태그로 크롤링
    node crawler.js 게임기획 신입    원하는 태그 지정
    node crawler.js --help         이 도움말 표시

  현재 검색 태그: [${targets.join(', ')}]

  데이터 저장 경로:
    data/raw/         원본 데이터 (건별 JSON)
    data/refined/     정제된 데이터 (건별 JSON)
    data/jobs/        ★ 통합 데이터 (all-jobs.json)
                      → 크롤링 중에도 실시간 업데이트!
                      → 중단해도 수집된 만큼 즉시 분석 가능

  조작법:
    Ctrl+C            안전 중단 (수집된 데이터 보존)
    Ctrl+C × 2회      강제 종료

  참고:
    • 게임잡 상세검색의 체크박스 이름과 동일하게 태그를 입력하세요
    • 예시: 게임기획, 게임프로그래밍, 게임아트, 신입, 1~3년, 경력무관
${line}
`);
}

/**
 * GameJob 크롤러 실행
 * @param {Object} [options]
 * @param {string[]} [options.targets=['게임기획', '신입', '경력무관', '1~3년']] - 필터 태그 목록
 */
async function runCrawler({ targets = ['게임기획', '신입', '경력무관', '1~3년'] } = {}) {
  // ─── 중단(Ctrl+C) 시 기수집 데이터 보존 핸들러 ───
  let interrupted = false;
  let successCount = 0;
  let failCount = 0;
  let allJobsCount = 0;

  const onInterrupt = () => {
    if (interrupted) {
      console.log('\n[FORCE] 강제 종료...');
      process.exit(1);
    }
    interrupted = true;
    console.log(`\n[INTERRUPTED] Ctrl+C 감지! 현재까지 수집된 데이터를 정리 중...`);
    console.log(`  성공: ${successCount}건 | 실패: ${failCount}건 | 전체: ${allJobsCount}건`);
    console.log(`  ★ 이미 수집된 ${successCount}건은 data/ 폴더에 저장되어 있습니다.`);
  };
  process.on('SIGINT', onInterrupt);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const baseDataDir = path.join(__dirname, 'data');
  const rawDataDir  = path.join(baseDataDir, 'raw');
  const refinedDataDir = path.join(baseDataDir, 'refined');
  const jobsDir = path.join(baseDataDir, 'jobs');
  const debugDir = path.join(baseDataDir, 'debug');

  [baseDataDir, rawDataDir, refinedDataDir, jobsDir, debugDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  try {
    // ═══════════════════════════════════════════════
    // 1단계: 상세 검색 & 필터 설정
    // ═══════════════════════════════════════════════
    console.log(`[INFO] 상세 검색 페이지 접속 및 필터 적용 중... (tags: [${targets.join(', ')}])`);
    await page.goto('https://www.gamejob.co.kr/Recruit/joblist?menucode=searchdetail', { waitUntil: 'networkidle', timeout: 30000 });
    await page.keyboard.press('Escape');

    // ── [v5.0] 탭-어웨어 체크박스 그룹핑 ──
    // ★ 문제: 사이트가 Backbone.js 이벤트 위임을 사용 → page.click() 필수
    // ★ 문제: 상세검색 탭이 접혀있으면 체크박스가 height:0 → page.click() 실패
    //   해결: 체크박스가 속한 탭(dt)을 먼저 클릭하여 열고, 그 다음 체크박스를 클릭
    // ★ 탭 버튼은 토글이므로, 같은 탭을 두 번 열면 닫힘.
    //   따라서 탭별로 한 번만 열고, 해당 탭의 모든 체크박스를 순차 클릭해야 함.
    const checkboxInfoList = await page.evaluate((tgts) => {
      const results = [];
      const labels = Array.from(document.querySelectorAll('label'));
      const allTabs = Array.from(document.querySelectorAll('.detailSearch .dev-tab'));

      tgts.forEach(t => {
        const l = labels.find(label => label.innerText.replace(/\s/g, '').includes(t));
        if (!l) return;
        const forAttr = l.getAttribute('for');
        if (!forAttr) return;
        const cb = document.getElementById(forAttr);
        if (!cb) return;

        const parentTab = cb.closest('.dev-tab');
        const tabIdx = parentTab ? allTabs.indexOf(parentTab) : -1;
        const tabBtnText = parentTab
          ? (parentTab.querySelector('dt button.btnTit span') || parentTab.querySelector('dt button.btnTit'))?.innerText?.trim() || ''
          : '';

        results.push({ cbId: forAttr, tabIdx, tabBtnText });
      });
      return results;
    }, targets);

    console.log(`[INFO] 체크박스 탐색 완료: ${checkboxInfoList.length}개 항목 (요청: ${targets.length}개)`);
    if (checkboxInfoList.length < targets.length) {
      const found = checkboxInfoList.map(info => info.cbId);
      console.warn(`[WARN] 일부 태그를 찾지 못했습니다. 요청: [${targets.join(', ')}], 발견: [${found.join(', ')}]`);
    }

    // 탭별 그룹화: { tabIdx → { tabBtnText, cbIds: [cbId, ...] } }
    const tabGroups = new Map();
    for (const info of checkboxInfoList) {
      const key = info.tabIdx;
      if (!tabGroups.has(key)) {
        tabGroups.set(key, { tabIdx: info.tabIdx, tabBtnText: info.tabBtnText, cbIds: [] });
      }
      tabGroups.get(key).cbIds.push(info.cbId);
    }

    // 탭별로: ① 탭 열기(필요 시) → ② 해당 탭의 모든 체크박스 순차 클릭
    for (const [, group] of tabGroups) {
      // ① 탭이 닫혀있으면 열기 (현재 실시간 상태로 확인)
      const needOpen = await page.evaluate((tabIdx) => {
        const tabs = document.querySelectorAll('.detailSearch .dev-tab');
        return tabs[tabIdx] ? !tabs[tabIdx].classList.contains('on') : false;
      }, group.tabIdx);

      if (needOpen && group.tabIdx >= 0) {
        console.log(`[INFO] 탭 열기: "${group.tabBtnText}" (idx: ${group.tabIdx})`);
        await page.evaluate((tabText, tabIdx) => {
          const allBtns = document.querySelectorAll('.detailSearch .dev-tab dt button.btnTit');
          const matched = Array.from(allBtns).find(b => b.innerText.trim().includes(tabText));
          if (matched) { matched.click(); return; }
          const tabs = document.querySelectorAll('.detailSearch .dev-tab');
          if (tabs[tabIdx]) {
            const btn = tabs[tabIdx].querySelector('dt button.btnTit');
            if (btn) btn.click();
          }
        }, group.tabBtnText, group.tabIdx);
        await page.waitForTimeout(800);
      }

      // ② 이 탭의 모든 체크박스를 순차 클릭 (탭을 다시 건드리지 않음)
      for (const cbId of group.cbIds) {
        const sel = `#${cbId}`;
        try {
          // 1차: Playwright 기본 클릭 (가시성 확인 포함)
          await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
          await page.click(sel);
          console.log(`[INFO]   ✓ 체크박스 클릭: ${cbId}`);
        } catch {
          try {
            // 2차: 라벨로 클릭
            await page.waitForSelector(`label[for="${cbId}"]`, { state: 'visible', timeout: 2000 });
            await page.click(`label[for="${cbId}"]`);
            console.log(`[INFO]   ✓ 라벨 클릭: ${cbId}`);
          } catch {
            // 3차: 탭이 닫혔을 수 있으므로 강제 오픈 후 클릭
            await page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return;
              const tab = el.closest('.dev-tab');
              if (tab && !tab.classList.contains('on')) {
                const btn = tab.querySelector('dt button.btnTit');
                if (btn) btn.click();
              }
            }, cbId);
            await page.waitForTimeout(500);
            try {
              await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
              await page.click(sel);
              console.log(`[INFO]   ✓ 재오픈 후 클릭: ${cbId}`);
            } catch {
              // 4차 (최종 폴백): evaluate + jQuery trigger
              await page.evaluate((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (!el.checked) el.checked = true;
                if (typeof jQuery !== 'undefined') jQuery(el).trigger('change');
              }, cbId);
              console.log(`[INFO]   ✓ evaluate 폴백 클릭: ${cbId}`);
            }
          }
        }
        await page.waitForTimeout(300);
      }
    }

    // ── [v5.0] 카운트 버튼 갱신 대기 (0건 → 실제 건수) ──
    try {
      await page.waitForSelector('#dev-btn-cnt', { timeout: 10000 });
    } catch {
      console.warn('[WARN] #dev-btn-cnt 셀렉터를 찾지 못함. 대체 셀렉터 탐색...');
      await page.waitForSelector('button[class*="search"], button[class*="btn-search"], .btn-search', { timeout: 5000 }).catch(() => {});
    }

    // ★ 카운트가 "0건"에서 벗어날 때까지 최대 5초 대기 (Backbone 비동기 이벤트 처리 대응)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('#dev-btn-cnt');
        if (!btn) return true; // 버튼 없으면 진행
        const text = btn.innerText || '';
        const match = text.match(/(\d+)/);
        return match && parseInt(match[1]) > 0;
      },
      { timeout: 5000 }
    ).catch(() => {});

    const searchCountText = await page.innerText('#dev-btn-cnt').catch(() => '(버튼 텍스트 읽기 실패)');
    console.log(`[INFO] 검색 버튼 상태: ${searchCountText.trim()}`);

    // ── [v5.0] 검색 전 기존 목록의 상태 기록 (갱신 감지용) ──
    const beforeSearch = await page.evaluate(() => {
      const links = document.querySelectorAll('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="]');
      const firstLink = links[0];
      let firstId = '';
      if (firstLink) {
        try {
          const url = new URL(firstLink.href, window.location.origin);
          firstId = url.searchParams.get('GI_No') || url.searchParams.get('GiNo') || '';
        } catch {}
      }
      return { firstId, count: links.length };
    });

    // ── [v5.0] scrollIntoView + 다중 폴백 클릭 (검색 버튼) ──
    await page.evaluate(() => {
      const btn = document.querySelector('#dev-btn-cnt');
      if (btn) btn.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);

    try {
      await page.locator('#dev-btn-cnt').click({ timeout: 5000 });
    } catch {
      console.warn('[WARN] #dev-btn-cnt 클릭 실패. 대체 셀렉터 시도...');
      try {
        await page.locator('button[class*="search"], button[class*="btn-search"], .btn-search').first().click({ timeout: 5000 });
      } catch {
        await page.evaluate(() => {
          const btn = document.querySelector('#dev-btn-cnt');
          if (btn) btn.click();
        });
      }
    }

    // ── [v5.0] 검색 결과 목록이 실제로 갱신될 때까지 대기 ──
    //   기존 목록의 firstId/count가 변하면 갱신 완료로 판단
    try {
      await page.waitForFunction(
        (prevFirstId, prevCount) => {
          const links = document.querySelectorAll('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="]');
          if (links.length === 0) return false; // 아직 로딩 중
          if (links.length !== prevCount) return true; // 공고 수 변경 → 갱신됨
          // 첫 번째 ID 변경 확인
          try {
            const url = new URL(links[0].href, window.location.origin);
            const newId = url.searchParams.get('GI_No') || url.searchParams.get('GiNo') || '';
            return newId !== prevFirstId;
          } catch { return false; }
        },
        { timeout: 15000 },
        beforeSearch.firstId,
        beforeSearch.count
      );
      console.log('[INFO] 검색 결과 갱신 확인!');
    } catch {
      console.warn('[WARN] 검색 결과 갱신 감지 타임아웃. 폴백 대기 적용...');
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(1000);

    // ═══════════════════════════════════════════════
    // 2단계: 목록 전체 수집 (페이지네이션)
    // ═══════════════════════════════════════════════
    let allJobs = [];
    let currentPage = 1;
    let lastFirstJobId = '';

    while (true) {
      // ── 첫 공고 ID 감지: 다중 URL 패턴 + 다중 DOM 구조 지원 ──
      const currentFirstJobId = await page.evaluate(() => {
        // 1순위: GI_No / GiNo 쿼리 파라미터가 있는 링크
        let firstLink = document.querySelector('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="]');
        if (firstLink) {
          try {
            const url = new URL(firstLink.href);
            return url.searchParams.get('GI_No') || url.searchParams.get('GiNo') || '';
          } catch { return ''; }
        }
        // 2순위: /Recruit/ 경로 기반 URL (모바일/리뉴얼 대응)
        firstLink = document.querySelector('#dev-gi-list a[href*="/Recruit/"]');
        if (firstLink) {
          const match = firstLink.href.match(/\/Recruit\/(\d+)/);
          return match ? match[1] : '';
        }
        // 3순위: 임의의 data-* 속성에서 ID 추출
        const anyItem = document.querySelector('#dev-gi-list [data-gi-no], #dev-gi-list [data-gino], #dev-gi-list [data-id]');
        if (anyItem) {
          return anyItem.dataset.giNo || anyItem.dataset.gino || anyItem.dataset.id || '';
        }
        return '';
      });

      if (currentPage > 1 && (!currentFirstJobId || currentFirstJobId === lastFirstJobId)) break;
      lastFirstJobId = currentFirstJobId;

      // ── 공고 목록 수집: table(tr) + div 구조 + 다중 URL 패턴 ──
      const jobsOnPage = await page.evaluate(() => {
        const results = [];

        // ID 추출 헬퍼: 다양한 URL 형식에서 공고 ID를 추출
        function extractJobId(href) {
          try {
            const url = new URL(href, window.location.origin);
            // 1순위: ?GI_No= 또는 ?GiNo= 쿼리 파라미터
            const fromParam = url.searchParams.get('GI_No') || url.searchParams.get('GiNo');
            if (fromParam) return fromParam;
            // 2순위: /Recruit/12345 경로 패턴
            const pathMatch = url.pathname.match(/\/Recruit\/(?:GI_Read\/View\/)?(\d+)/i);
            if (pathMatch) return pathMatch[1];
            // 3순위: URL 내 숫자 ID 패턴 (최후의 수단)
            const numMatch = href.match(/(\d{5,})/);
            if (numMatch) return numMatch[1];
          } catch {}
          return null;
        }

        // ─ 수집 전략 A: 기존 table 구조 (#dev-gi-list tr) ─
        const tableRows = document.querySelectorAll('#dev-gi-list tr');
        tableRows.forEach(item => {
          if (item.classList.contains('sword') || item.classList.contains('gold') || (item.id && item.id.includes('premium'))) return;

          const linkEl = item.querySelector('a[href*="GI_No="], a[href*="GiNo="], a[href*="/Recruit/"]');
          if (linkEl) {
            const title   = linkEl.innerText.trim();
            const href    = linkEl.href;
            const company = (item.querySelector('.name, .corp, .company, td.tplCo, [class*="company"], [class*="corp"]') || {}).innerText?.trim() || 'Unknown';
            const id      = extractJobId(href);

            const careerEl = item.querySelector('.career, .experience, td.tplCareer, [class*="career"]');
            const career   = careerEl ? careerEl.innerText.trim() : '';

            if (id && title) results.push({ id, title, company, link: href, careerFromList: career });
          }
        });

        // ─ 수집 전략 B: div 기반 리스트 구조 (리뉴얼 대응) ─
        if (results.length === 0) {
          const divItems = document.querySelectorAll(
            '#dev-gi-list li, #dev-gi-list .recruit-list-item, #dev-gi-list [class*="list-item"], #dev-gi-list > div > div, #dev-gi-list .list-item'
          );
          divItems.forEach(item => {
            if (item.classList.contains('sword') || item.classList.contains('gold') || (item.id && item.id.includes('premium'))) return;
            if (item.querySelector('[class*="ad-"], [class*="premium"], [class*="sponsor"]')) return;

            const linkEl = item.querySelector('a[href*="GI_No="], a[href*="GiNo="], a[href*="/Recruit/"]');
            if (linkEl) {
              const title   = linkEl.innerText.trim();
              const href    = linkEl.href;
              const company = (item.querySelector('.name, .corp, .company, [class*="company"], [class*="corp"]') || {}).innerText?.trim() || 'Unknown';
              const id      = extractJobId(href);

              const careerEl = item.querySelector('.career, .experience, [class*="career"]');
              const career   = careerEl ? careerEl.innerText.trim() : '';

              if (id && title) results.push({ id, title, company, link: href, careerFromList: career });
            }
          });
        }

        // ─ 수집 전략 C: 최후의 수단 — 모든 채용 링크 수집 ─
        if (results.length === 0) {
          const allLinks = document.querySelectorAll('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="], #dev-gi-list a[href*="/Recruit/"]');
          allLinks.forEach(linkEl => {
            const href = linkEl.href;
            const id = extractJobId(href);
            const title = linkEl.innerText.trim();
            if (id && title && title.length > 2) {
              if (!results.some(r => r.id === id)) {
                results.push({ id, title, company: 'Unknown', link: href, careerFromList: '' });
              }
            }
          });
        }

        return results;
      });

      allJobs = allJobs.concat(jobsOnPage.filter(newJob => !allJobs.some(oldJob => oldJob.id === newJob.id)));
      console.log(`[INFO] ${currentPage}페이지 완료 (이번 페이지: ${jobsOnPage.length}개, 누적: ${allJobs.length}개)`);

      // ── 0건 수집 시 진단 HTML 저장 ──
      if (jobsOnPage.length === 0 && currentPage === 1) {
        console.warn('[WARN] 첫 페이지에서 공고를 찾지 못했습니다! 진단 HTML 저장 중...');
        const html = await page.content();
        saveDebugHtml(debugDir, `page1_debug_${Date.now()}.html`, html);

        const diagnosis = await page.evaluate(() => ({
          hasDevGiList: !!document.querySelector('#dev-gi-list'),
          devGiListChildCount: document.querySelector('#dev-gi-list')?.children.length || 0,
          devGiListInnerHtml: (document.querySelector('#dev-gi-list')?.innerHTML || '').substring(0, 500),
          hasTableRows: document.querySelectorAll('#dev-gi-list tr').length,
          hasAnchors: document.querySelectorAll('#dev-gi-list a').length,
          allAnchorsHref: Array.from(document.querySelectorAll('#dev-gi-list a')).slice(0, 5).map(a => a.href),
          bodyText: document.body.innerText.substring(0, 300),
        }));
        console.log('[DIAG] 페이지 진단 결과:', JSON.stringify(diagnosis, null, 2));
      }

      // ── [v5.0] Backbone-어웨어 페이지네이션 ──
      // ★ 사이트 Backbone 이벤트: 'click .pagination a' → 'onGIListPageSelect'
      //   page.click() 필수이나, 페이지네이션이 뷰포트 밖(top:4000+)이므로
      //   scrollIntoView로 노출 후 클릭해야 함
      const hasNextPage = await page.evaluate((targetPage) => {
        const pagEl = document.querySelector('.pagination, .tplPagination, [class*="paging"], [class*="pagination"]');
        if (!pagEl) return false;
        // 해당 페이지 번호 또는 '다음' 버튼이 있는지
        const byDataPage = pagEl.querySelector(`a[data-page="${targetPage}"]`);
        if (byDataPage) return true;
        const byText = Array.from(pagEl.querySelectorAll('a'))
          .find(a => a.innerText.trim() === String(targetPage));
        if (byText) return true;
        const nextBtn = pagEl.querySelector('a.btnNext, a[class*="next"], [class*="btn-next"]');
        return !!nextBtn;
      }, currentPage + 1);

      if (!hasNextPage) {
        console.log(`[INFO] ${currentPage}페이지가 마지막. 수집 종료.`);
        break;
      }

      currentPage++;

      // ── [v5.0] 페이지네이션을 뷰포트로 스크롤 → 클릭 대상 결정 ──
      await page.evaluate(() => {
        const pagEl = document.querySelector('.pagination, .tplPagination, [class*="paging"], [class*="pagination"]');
        if (pagEl) pagEl.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);

      // 클릭 대상 결정: data-page 매칭 → 텍스트 매칭 → btnNext
      const clicked = await page.evaluate((targetPage) => {
        const pagEl = document.querySelector('.pagination, .tplPagination, [class*="paging"], [class*="pagination"]');
        if (!pagEl) return false;
        // 1순위: data-page로 직접 매칭
        const byData = pagEl.querySelector(`a[data-page="${targetPage}"]`);
        if (byData) { byData.scrollIntoView({ block: 'center' }); return 'data'; }
        // 2순위: 텍스트로 매칭
        const byText = Array.from(pagEl.querySelectorAll('a'))
          .find(a => a.innerText.trim() === String(targetPage));
        if (byText) { byText.scrollIntoView({ block: 'center' }); return 'text'; }
        // 3순위: btnNext (다음 10페이지 그룹)
        const nextBtn = pagEl.querySelector('a.btnNext, a[class*="next"], [class*="btn-next"]');
        if (nextBtn) { nextBtn.scrollIntoView({ block: 'center' }); return 'next'; }
        return false;
      }, currentPage);

      if (!clicked) {
        console.log(`[INFO] 페이지네이션 클릭 대상을 찾을 수 없음. 수집 종료.`);
        break;
      }
      await page.waitForTimeout(200);

      // page.click()으로 실제 클릭 (Backbone 이벤트 전파)
      try {
        if (clicked === 'data') {
          await page.click(`.pagination a[data-page="${currentPage}"], .tplPagination a[data-page="${currentPage}"]`);
        } else if (clicked === 'next') {
          await page.click('.pagination a.btnNext, .tplPagination a.btnNext, [class*="paging"] a[class*="next"]');
        } else {
          // 텍스트 매칭 — data-page가 없는 경우 evaluate로 클릭
          await page.evaluate((targetPage) => {
            const pagEl = document.querySelector('.pagination, .tplPagination, [class*="paging"], [class*="pagination"]');
            const link = Array.from(pagEl.querySelectorAll('a'))
              .find(a => a.innerText.trim() === String(targetPage));
            if (link) link.click();
          }, currentPage);
        }
      } catch {
        // 최종 폴백: evaluate 직접 클릭
        await page.evaluate((targetPage) => {
          const pagEl = document.querySelector('.pagination, .tplPagination, [class*="paging"], [class*="pagination"]');
          if (!pagEl) return;
          const link = pagEl.querySelector(`a[data-page="${targetPage}"]`)
            || pagEl.querySelector('a.btnNext, a[class*="next"]');
          if (link) link.click();
        }, currentPage);
      }

      // ── [v5.0] AJAX 목록 로딩 대기 — 첫 번째 공고 ID가 변경될 때까지 ──
      try {
        await page.waitForFunction(
          (prevFirstId) => {
            const link = document.querySelector('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="]');
            if (!link) return false;
            try {
              const url = new URL(link.href, window.location.origin);
              const id = url.searchParams.get('GI_No') || url.searchParams.get('GiNo') || '';
              return id && id !== prevFirstId;
            } catch { return false; }
          },
          { timeout: 10000 },
          lastFirstJobId
        );
      } catch {
        // 폴백: 고정 대기
        await page.waitForTimeout(1500);
      }
      await page.waitForTimeout(500);

      // 이동 후 실제로 새 공고가 있는지 확인 (무한루프 방지)
      const newFirstId = await page.evaluate(() => {
        const link = document.querySelector('#dev-gi-list a[href*="GI_No="], #dev-gi-list a[href*="GiNo="], #dev-gi-list a[href*="/Recruit/"]');
        if (!link) return '';
        try {
          const url = new URL(link.href);
          const fromParam = url.searchParams.get('GI_No') || url.searchParams.get('GiNo');
          if (fromParam) return fromParam;
          const pathMatch = link.href.match(/\/Recruit\/(\d+)/);
          return pathMatch ? pathMatch[1] : '';
        } catch { return ''; }
      });
      console.log(`[INFO] ${currentPage}페이지 첫 공고 ID: ${newFirstId}`);
      if (!newFirstId || newFirstId === lastFirstJobId) {
        console.log(`[INFO] 페이지 이동 실패 또는 동일 공고. 수집 종료.`);
        break;
      }
    }

    console.log(`[SUCCESS] 총 ${allJobs.length}개의 공고 확보! 정밀 수집 시작!`);

    // 수집된 공고가 0개일 때 조기 경고
    if (allJobs.length === 0) {
      console.error('[ERROR] 수집된 공고가 0개입니다! 사이트 구조가 변경되었을 수 있습니다.');
      console.error('[ERROR] data/debug/ 폴더의 HTML 스냅샷을 확인하세요.');
      const html = await page.content();
      saveDebugHtml(debugDir, `empty_result_${Date.now()}.html`, html);
    }

    // ═══════════════════════════════════════════════
    // 3단계: 각 공고 상세 페이지 수집
    // ═══════════════════════════════════════════════
    allJobsCount = allJobs.length;

    for (let i = 0; i < allJobs.length; i++) {
      // 중단 감지: Ctrl+C 시 즉시 루프 탈출 (기수집 데이터는 이미 저장됨)
      if (interrupted) {
        console.log(`[INFO] 중단 요청으로 상세 수집 중지. (${i}/${allJobs.length} 완료)`);
        break;
      }

      const job = allJobs[i];
      console.log(`[PROCESS] ${i + 1}/${allJobs.length}: ${job.company} - ${job.title} 수집 중...`);

      try {
        await page.goto(job.link, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(300);

        // ────────────────────────────────────────
        // 기본 정보 11개 항목 파싱
        // [Bug Fix 1] new Function()으로 mapKey를 브라우저에 전달 → CSP 차단 위험
        //   수정: 매핑 로직을 evaluate 내에 인라인으로 직접 작성
        // ────────────────────────────────────────
        const basicInfo = await page.evaluate(() => {
          // ── 인라인 mapKey (new Function() 제거 — CSP 안전) ──
          function mapKey(rawKey) {
            const key = rawKey.trim();
            if (key.includes('모집분야') || key.includes('직종') || key.includes('담당업무')) return 'jobField';
            if (key.includes('키워드')) return 'keywords';
            if (key.includes('대표게임') || key.includes('게임명')) return 'mainGame';
            if (key.includes('게임분야') || key.includes('게임장르')) return 'gameCategory';
            if (key.includes('경력')) return 'experience';
            if (key.includes('고용형태') || key.includes('근무형태')) return 'employmentType';
            if (key.includes('학력')) return 'education';
            if (key.includes('직급') || key.includes('직책')) return 'position';
            if (key.includes('모집인원') || key.includes('인원')) return 'recruitCount';
            if (key.includes('급여') || key.includes('연봉') || key.includes('임금')) return 'salary';
            if (key.includes('마감') || key.includes('접수기간') || key.includes('지원기간')) return 'deadline';
            return null;
          }

          const info = {};

          // ── 1순위: 리뉴얼 후 실제 DOM 구조 (recruit-data-item)
          const newStyleItems = document.querySelectorAll('.recruit-data-item, .recruit-data-item.flex');
          newStyleItems.forEach(item => {
            const dt = item.querySelector('dt');
            const dd = item.querySelector('dd');
            if (dt && dd) {
              const fieldKey = mapKey(dt.innerText);
              if (fieldKey) info[fieldKey] = dd.innerText.trim();
            }
          });

          // ── 2순위: 구버전 호환 (view-info-area, tplViewInfo, tb-list 등)
          if (Object.keys(info).length < 3) {
            const items = document.querySelectorAll(
              '.view-info-area dl > div, .view-info-area tr, .tplViewInfo tr, .info-wrap tr, .recruit-info tr, .tb-list tr, .tplTable tr'
            );
            items.forEach(item => {
              const th = item.querySelector('dt, th');
              const td = item.querySelector('dd, td');
              if (th && td) {
                const fieldKey = mapKey(th.innerText);
                if (fieldKey) info[fieldKey] = td.innerText.trim();
              }
            });
          }

          // ── 3순위: dl 전체 순회 (dt/dd가 형제로 나열된 경우)
          if (Object.keys(info).length < 3) {
            const dls = document.querySelectorAll('.recruit-data dl, .view-info-area dl, .info-wrap dl, .recruit-info dl');
            dls.forEach(dl => {
              const dts = dl.querySelectorAll('dt');
              const dds = dl.querySelectorAll('dd');
              dts.forEach((dt, idx) => {
                const fieldKey = mapKey(dt.innerText);
                if (fieldKey && dds[idx]) info[fieldKey] = dds[idx].innerText.trim();
              });
            });
          }

          // ── 4순위 (신규): 임의의 key-value 구조 탐색 ──
          if (Object.keys(info).length < 3) {
            const allDts = document.querySelectorAll('dt, th, .info-label, .data-label, [class*="label"], [class*="title"]');
            allDts.forEach(dt => {
              const fieldKey = mapKey(dt.innerText);
              if (fieldKey && !info[fieldKey]) {
                const dd = dt.nextElementSibling;
                if (dd) {
                  const text = dd.innerText?.trim();
                  if (text && text.length < 500) info[fieldKey] = text;
                }
              }
            });
          }

          return info;
        });

        // 수집된 필드 수 로깅
        const fieldCount = Object.keys(basicInfo).filter(k => basicInfo[k]).length;
        if (fieldCount === 0) {
          console.warn(`[WARN] "${job.title}" - 기본정보 0개 수집. 상세페이지 구조 변경 가능성.`);
          // 첫 실패 건만 디버그 저장
          if (failCount === 0) {
            const pageHtml = await page.content();
            saveDebugHtml(debugDir, `detail_debug_${job.id}.html`, pageHtml);
          }
        }

        // ────────────────────────────────────────
        // 모집요강 수집 (#gj-tab01 전용 탐색)
        // ────────────────────────────────────────
        let realDescription = '';

        const tab01 = await page.$('#gj-tab01') || await page.$('[id*="tab01"], .recruit-detail-content, .detail-content, #recruit-detail');
        if (tab01) {
          const iframes = await tab01.$$('iframe');
          let combinedText = '';

          for (const iframe of iframes) {
            const frameObj = await iframe.contentFrame();
            if (frameObj) {
              const text = await frameObj.innerText('body').catch(() => '');
              combinedText += text.trim() + '\n\n';
            }
          }

          combinedText = combinedText.trim();

          if (combinedText.length >= 50) {
            realDescription = combinedText;
          } else {
            const directText = await tab01.innerText().catch(() => '');
            if (directText.trim().length >= 50) {
              realDescription = directText.trim();
            } else {
              const imgElement = await tab01.$('img');
              if (imgElement) {
                realDescription = '이미지 본문 (상세 텍스트 기재 없음)';
              }
            }
          }
        }

        // 폴백: tab01을 못 찾았을 때 페이지 전체에서 상세 내용 추출 시도
        if (!realDescription || realDescription.length < 50) {
          const fallbackDesc = await page.evaluate(() => {
            const candidates = document.querySelectorAll(
              '.recruit-detail, .detail-content, .view-content, [class*="detail-body"], [class*="recruit-content"]'
            );
            for (const el of candidates) {
              const text = el.innerText.trim();
              if (text.length >= 50) return text;
            }
            return '';
          });
          if (fallbackDesc.length >= 50) {
            realDescription = fallbackDesc;
          }
        }

        if (!realDescription || realDescription.length < 50) {
          realDescription = '상세 내용을 가져올 수 없습니다.';
        }

        // ────────────────────────────────────────
        // 최종 데이터 구성 & 저장
        // ────────────────────────────────────────
        const refinedData = {
          id:             `crawled-${job.id}`,
          title:          job.title,
          company:        job.company,
          jobField:       basicInfo.jobField       || '',
          keywords:       basicInfo.keywords       || '',
          mainGame:       basicInfo.mainGame        || '',
          gameCategory:   basicInfo.gameCategory    || '',
          experience:     basicInfo.experience      || job.careerFromList || '',
          employmentType: basicInfo.employmentType  || '',
          education:      basicInfo.education       || '',
          position:       basicInfo.position        || '',
          recruitCount:   basicInfo.recruitCount    || '',
          salary:         basicInfo.salary          || '',
          deadline:       basicInfo.deadline        || '',
          description:    realDescription,
          updatedAt:      new Date().toISOString().split('T')[0],
          link:           job.link,
          source:         'GameJob',
        };

        // raw: 원본 데이터 전체 보존
        const rawData = { ...job, ...basicInfo, realDescription };
        fs.writeFileSync(path.join(rawDataDir,     `raw-${job.id}.json`), JSON.stringify(rawData,     null, 2), 'utf-8');
        fs.writeFileSync(path.join(refinedDataDir, `job-${job.id}.json`), JSON.stringify(refinedData, null, 2), 'utf-8');

        // ★ all-jobs.json 실시간 적재 (중단해도 여기까지 수집된 데이터 즉시 사용 가능)
        appendToAllJobs(jobsDir, refinedData);

        successCount++;
        console.log(`[OK] "${job.title}" 저장 완료 (필드 ${fieldCount}개) → all-jobs.json 업데이트`);

        // 최소 랜덤 딜레이 (0.2~0.5초)
        await page.waitForTimeout(Math.floor(Math.random() * 300) + 200);
      } catch (e) {
        failCount++;
        console.error(`[ERROR] "${job.title}" 수집 실패:`, e.message);
        // 첫 3건의 실패에 대해 디버그 HTML 저장
        if (failCount <= 3) {
          const html = await page.content().catch(() => '');
          if (html) saveDebugHtml(debugDir, `error_${job.id}_${Date.now()}.html`, html);
        }
      }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  [COMPLETED] 전수 수집 완료!`);
    console.log(`  성공: ${successCount}건 | 실패: ${failCount}건 | 전체: ${allJobs.length}건`);
    console.log(`  ★ 통합 데이터: data/jobs/all-jobs.json (${successCount}건)`);
    console.log(`${'═'.repeat(60)}`);

  } catch (err) {
    console.error('[ERROR] 치명적 오류:', err.message);
    // 치명적 오류 시에도 HTML 저장
    const html = await page.content().catch(() => '');
    if (html) saveDebugHtml(debugDir, `fatal_${Date.now()}.html`, html);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await browser.close();
    if (interrupted) {
      console.log(`\n[SUMMARY] 중단된 크롤링 결과:`);
      console.log(`  성공: ${successCount}건 | 실패: ${failCount}건 | 전체: ${allJobsCount}건`);
      console.log(`  ★ data/jobs/all-jobs.json 에 ${successCount}건이 실시간 저장되었습니다.`);
      console.log(`  ★ 중단된 시점까지의 데이터를 바로 분석에 사용할 수 있습니다.`);
    }
  }
}

// ─── CLI 실행 ───
const cliArgs = process.argv.slice(2);

// --help 플래그 처리
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  printTutorial(['게임기획', '신입', '경력무관', '1~3년']);
  process.exit(0);
}

// 태그 추출 (-- 플래그가 아닌 인수만)
const cliTargets = cliArgs.filter(a => !a.startsWith('-'));
const targets = cliTargets.length > 0 ? cliTargets : ['게임기획', '신입', '경력무관', '1~3년'];

// 튜토리얼 배너 표시
printTutorial(targets);

// 크롤링 시작
runCrawler({ targets });
