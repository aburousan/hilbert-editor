const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('lsp') || t.includes('hover') || t.includes('error') || t.includes('Error'))
      console.log('BROWSER:', t);
  });
  
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));
  
  // Find #import token  
  const tokenPos = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.monaco-editor .view-line span span'));
    for (const s of spans) {
      if (s.textContent && s.textContent.includes('#import')) {
        const r = s.getBoundingClientRect();
        return { x: r.x + 10, y: r.y + 5 };
      }
    }
    return null;
  });
  
  if (tokenPos) {
    console.log('Moving mouse to', tokenPos);
    await page.mouse.move(tokenPos.x, tokenPos.y);
    await new Promise(r => setTimeout(r, 3000));
    
    // Get ALL elements that look like hover widgets
    const result = await page.evaluate(() => {
      const allHovers = document.querySelectorAll('[class*="hover"]');
      const info = [];
      allHovers.forEach(el => {
        const rect = el.getBoundingClientRect();
        info.push({
          className: el.className,
          width: rect.width,
          height: rect.height,
          text: el.innerText?.slice(0, 100),
          display: getComputedStyle(el).display,
          visibility: getComputedStyle(el).visibility,
          opacity: getComputedStyle(el).opacity,
        });
      });
      return info;
    });
    console.log('All hover elements:', JSON.stringify(result, null, 2));
  }
  
  await browser.close();
})();
