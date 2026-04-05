const { chromium } = require('playwright');
const fs = require('fs');

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 1. Get a job list page
  await page.goto('https://www.gamejob.co.kr/Recruit/joblist?menucode=searchdetail');
  await page.waitForTimeout(2000);
  
  const listHtml = await page.evaluate(() => {
    const listItems = document.querySelectorAll('#dev-gi-list tr');
    if (listItems.length > 0) {
      return listItems[0].outerHTML + '\n\n' + (listItems[1] ? listItems[1].outerHTML : '');
    }
    return 'No list items';
  });
  fs.writeFileSync('C:\\tmp\\list_html.txt', listHtml);

  // 2. Get a company link from the list and visit it
  const companyUrl = await page.evaluate(() => {
    const listItems = document.querySelectorAll('#dev-gi-list tr');
    for (const item of listItems) {
      if (item.classList.contains('sword') || item.classList.contains('gold') || item.id.includes('premium')) continue;
      const coLink = item.querySelector('.name a, .corp a, .company a, td.tplCo a');
      if (coLink) return coLink.href;
    }
    return null;
  });

  if (companyUrl) {
    await page.goto(companyUrl);
    await page.waitForTimeout(2000);
    const companyHtml = await page.evaluate(() => document.body.innerHTML);
    fs.writeFileSync('C:\\tmp\\company_html.txt', companyHtml.substring(0, 10000)); // Just a sample
  } else {
    fs.writeFileSync('C:\\tmp\\company_html.txt', 'No company URL found');
  }

  await browser.close();
}

test();
