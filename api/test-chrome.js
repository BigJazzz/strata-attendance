import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export default async function handler(req, res) {
  try {
    const browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox'],
      executablePath: await chromium.executablePath(),
      headless: 'new',
    });
    const page = await browser.newPage();
    await page.setContent('<h1>Hello from Puppeteer</h1>');
    const pdf = await page.pdf({ format: 'A4' });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (err) {
    console.error('[TEST CHROME ERROR]', err);
    res.status(500).json({ error: err.message });
  }
}
