import requests
from bs4 import BeautifulSoup

url = "https://www.gamejob.co.kr/Company/Detail?tabcode=1&M=43885377"
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0'
}
res = requests.get(url, headers=headers)
soup = BeautifulSoup(res.text, 'html.parser')

# extract readable text and structure
with open("C:\\tmp\\company_parsed.txt", "w", encoding="utf-8") as f:
    f.write(soup.get_text(separator='\n', strip=True))
    
    # Also dump some key divs if they exist
    info_box = soup.find('div', class_='company-info') or soup.find('div', class_='info') or soup.find(id='dev-company-info')
    if info_box:
        f.write("\n\n--- INFO BOX ---\n")
        f.write(info_box.text)
