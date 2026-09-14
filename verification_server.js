/* ============================================================================
   SOCIAL FOLLOWER VERIFICATION SERVER
   ============================================================================
   Ye ek Node.js backend hai jo:
   1. User ka diya hua social link (YouTube/TikTok/Instagram) background mein
      headless browser se kholta hai
   2. Us page se actual follower/subscriber count nikalta hai
   3. User ne jo count claim kiya, us se compare karta hai
   4. Match ho to unique promo code generate karke Firebase mein save karta hai

   IMPORTANT NOTES:
   - Ye GitHub Pages (static hosting) pe NAHI chalega. Isko Node.js server
     chahiye hoga (Render.com / Railway.app free tier use kar sakte ho).
   - Instagram sabse zyada block/CAPTCHA dikhata hai automated visitors ko -
     kabhi-kabhi fail ho sakta hai, ye guaranteed 100% reliable nahi hoga.
   - YouTube sabse stable hai kyunki channel page bina login ke public hai.
   - Selectors (jo HTML element se number nikalte hain) waqt ke sath tootte
     rehte hain jab platform apni website ka design change karta hai - inhe
     occasionally update karna padega.

   SETUP:
   npm init -y
   npm install express playwright firebase-admin cors
   npx playwright install chromium
   node server.js
   ============================================================================ */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const admin = require('firebase-admin');

// Stealth plugin lagao - ye kai common "bot signals" chupata hai
// (jaise navigator.webdriver flag, missing plugins list, etc.)
chromium.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG - Firebase service account ab environment variable se aayega
// (Render/Railway ke "Variables" section mein FIREBASE_SERVICE_ACCOUNT
// naam se poori JSON paste karni hai - file upload nahi karni)
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://this-is-my-first-app-99e55-default-rtdb.firebaseio.com',
});

const db = admin.database();

// ---------------------------------------------------------------------------
// YOUTUBE: Official YouTube Data API use karte hain (scraping ki jagah)
// Ye zyada reliable hai kyunki Google khud data deta hai, koi bot-detection
// ka masla nahi hota.
// ---------------------------------------------------------------------------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

function extractYoutubeIdentifier(url) {
  // @handle format: youtube.com/@channelname
  const handleMatch = url.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };

  // /channel/UC... format
  const channelMatch = url.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/);
  if (channelMatch) return { type: 'id', value: channelMatch[1] };

  // /c/customname or /user/username format (legacy)
  const legacyMatch = url.match(/youtube\.com\/(?:c|user)\/([a-zA-Z0-9_-]+)/);
  if (legacyMatch) return { type: 'handle', value: legacyMatch[1] };

  return null;
}

async function getYoutubeSubscriberCount(url) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY environment variable set nahi hai');
  }

  const identifier = extractYoutubeIdentifier(url);
  if (!identifier) {
    throw new Error('YouTube link se channel handle/ID nahi mila');
  }

  let apiUrl;
  if (identifier.type === 'handle') {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=${identifier.value}&key=${YOUTUBE_API_KEY}`;
  } else {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${identifier.value}&key=${YOUTUBE_API_KEY}`;
  }

  const response = await fetch(apiUrl);
  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error('Channel nahi mila YouTube API se');
  }

  return parseInt(data.items[0].statistics.subscriberCount, 10);
}

// ---------------------------------------------------------------------------
// HELPER: random insaan jaisa delay (bots hamesha same-speed hote hain,
// asli insaan ki speed random hoti hai)
// ---------------------------------------------------------------------------
function randomDelay(min = 800, max = 2500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HELPER: "1.2M", "45.3K", "12,340" jaise text ko number mein convert karo
// ---------------------------------------------------------------------------
function parseCount(text) {
  if (!text) return 0;
  text = text.replace(/,/g, '').trim().toUpperCase();
  const match = text.match(/([\d.]+)\s*([KM]?)/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  if (match[2] === 'K') num *= 1000;
  if (match[2] === 'M') num *= 1000000;
  return Math.round(num);
}

// ---------------------------------------------------------------------------
// SCRAPER: YouTube channel subscriber count
// ---------------------------------------------------------------------------
async function scrapeYoutube(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // YouTube "about" page pe subscriber count dikhata hai
  const aboutUrl = url.replace(/\/$/, '') + '/about';
  await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const text = await page.evaluate(() => {
    const el = document.querySelector('yt-formatted-string#subscriber-count') ||
               document.querySelector('#subscriber-count');
    return el ? el.textContent : null;
  });

  return parseCount(text);
}

// ---------------------------------------------------------------------------
// SCRAPER: TikTok profile follower count
// ---------------------------------------------------------------------------
async function scrapeTiktok(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const text = await page.evaluate(() => {
    const el = document.querySelector('[data-e2e="followers-count"]');
    return el ? el.textContent : null;
  });

  return parseCount(text);
}

// ---------------------------------------------------------------------------
// SCRAPER: Instagram follower count
// ---------------------------------------------------------------------------
// NOTE: Instagram ki normal webpage logged-out visitors ko jaan-boojh kar
// galat/randomized follower numbers dikhati hai. Isliye humein unka internal
// JSON data endpoint use karna hai (jo unka khud ka web-app use karta hai) -
// ye zyada accurate hota hai. Bilkul free hai, koi API key nahi chahiye.
// Fir bhi 100% guarantee nahi hai - Instagram kabhi bhi is endpoint ko
// block/change kar sakta hai.
async function scrapeInstagram(page, url) {
  const usernameMatch = url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
  if (!usernameMatch) return 0;
  const username = usernameMatch[1];

  try {
    // Instagram ka internal API endpoint - unke apne web app ka backend
    const response = await page.request.get(
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
      {
        headers: {
          'x-ig-app-id': '936619743392459', // Instagram web client ki public constant ID
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      }
    );

    if (response.ok()) {
      const data = await response.json();
      const count = data?.data?.user?.edge_followed_by?.count;
      if (count) return count;
    }
  } catch (err) {
    console.log('Instagram JSON endpoint fail hua, purani method try kar rahe hain:', err.message);
  }

  // ===== FALLBACK: agar upar wala fail ho jaye, purani webpage scraping try karo =====
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const text = await page.evaluate(() => {
      const metaTag = document.querySelector('meta[property="og:description"]');
      return metaTag ? metaTag.content : null;
    });

    if (!text) return 0;
    const match = text.match(/([\d.,]+[KM]?)\s*Followers/i);
    return match ? parseCount(match[1]) : 0;
  } catch (err) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// MAIN VERIFICATION ENDPOINT
// ---------------------------------------------------------------------------
app.post('/verify-social', async (req, res) => {
  const { platform, url, claimedCount, name, email } = req.body;

  if (!platform || !url || !claimedCount || !name || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let actualCount = 0;

  try {
    // ===== YOUTUBE: Official API use karo, browser ki zaroorat nahi =====
    if (platform === 'youtube') {
      actualCount = await getYoutubeSubscriberCount(url);
    } else {
      // ===== TIKTOK / INSTAGRAM: Headless browser se scrape karo =====
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--disable-blink-features=AutomationControlled'],
        });

        const page = await browser.newPage({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'Asia/Karachi',
        });

        await randomDelay(500, 1500);

        if (platform === 'tiktok') {
          actualCount = await scrapeTiktok(page, url);
        } else if (platform === 'instagram') {
          actualCount = await scrapeInstagram(page, url);
        } else {
          await browser.close();
          return res.status(400).json({ error: 'Invalid platform' });
        }

        await browser.close();
      } catch (err) {
        if (browser) await browser.close();
        throw err;
      }
    }

    if (actualCount === 0) {
      return res.status(422).json({
        verified: false,
        reason: 'Could not read the count from this page. Link check karein ya manually verify karein.',
      });
    }

    // Claimed count actual count se zyada nahi hona chahiye
    // (thoda tolerance rakha hai kyunki numbers real-time change hote hain)
    const tolerance = 0.9; // claimed count ka 90% ya usse zyada match hona chahiye
    const isVerified = actualCount >= claimedCount * tolerance;

    if (!isVerified) {
      return res.json({
        verified: false,
        actualCount,
        claimedCount,
        reason: `Account par sirf ${actualCount} followers/subscribers hain, lekin ${claimedCount} claim kiya gaya.`,
      });
    }

    // ===== VERIFIED - unique promo code generate karo =====
    const code = generatePromoCode(name);

    await db.ref(`youtubers/${code}`).set({
      name,
      email,
      code,
      platform,
      profileUrl: url,
      verifiedFollowerCount: actualCount,
      totalCommission: 0,
      createdAt: Date.now(),
    });

    return res.json({
      verified: true,
      actualCount,
      promoCode: code,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Verification failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// HELPER: unique promo code banao (naam + random digits)
// ---------------------------------------------------------------------------
function generatePromoCode(name) {
  const cleanName = name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 8);
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `YT_${cleanName}${randomDigits}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verification server running on port ${PORT}`));
