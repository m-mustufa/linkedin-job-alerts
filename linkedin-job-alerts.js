// linkedin-job-alerts.js
// Polls LinkedIn's public guest job search (no login) and pings WhatsApp via
// CallMeBot when a new matching job shows up. State (seen job IDs) lives in
// Supabase. Meant to run on a schedule via GitHub Actions — see
// job-alerts.yml. No npm dependencies (uses Node 18+ built-in fetch).

const KEYWORDS = 'Full Stack Engineer OR Frontend Engineer OR React Developer OR Next.js Developer OR Angular Developer';
const LOCATIONS = [
  'United Arab Emirates',
  'Saudi Arabia',
  'Qatar',
  'Malaysia',
  'Indonesia',
  'Thailand',
  'Taiwan'
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchJobs(location) {
  const url = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  url.searchParams.set('keywords', KEYWORDS);
  url.searchParams.set('location', location);
  url.searchParams.set('f_TPR', 'r600'); // last 10 min (buffer over the 5-min cron)
  url.searchParams.set('sortBy', 'DD');
  url.searchParams.set('start', '0');

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    console.error(`LinkedIn fetch failed for ${location}: ${res.status}`);
    return [];
  }
  const html = await res.text();
  return parseJobs(html, location);
}

function parseJobs(html, location) {
  const results = [];
  const seen = new Set();
  const idRegex = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  let m;
  while ((m = idRegex.exec(html)) !== null) {
    const jobId = m[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // job id is the stable anchor; title/company/location are best-effort,
    // read from a window of HTML right after the match
    const windowText = html.slice(m.index, m.index + 2000);
    const title = windowText.match(/base-search-card__title">\s*([\s\S]*?)\s*<\/h3>/)?.[1]?.trim() || 'New job posting';
    const company = windowText.match(/base-search-card__subtitle">[\s\S]*?>([\s\S]*?)<\/a>/)?.[1]?.trim() || '';
    const jobLocation = windowText.match(/job-search-card__location">\s*([\s\S]*?)\s*<\/span>/)?.[1]?.trim() || location;

    results.push({
      job_id: jobId,
      title,
      company,
      location: jobLocation,
      url: `https://www.linkedin.com/jobs/view/${jobId}`,
      query: KEYWORDS
    });
  }
  return results;
}

// Returns true only if this row was newly inserted (not a duplicate)
async function upsertNew(job) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/seen_jobs`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates'
    },
    body: JSON.stringify(job)
  });
  if (!res.ok) {
    console.error(`Supabase upsert failed for ${job.job_id}: ${res.status}`);
    return false;
  }
  const body = await res.json();
  return Array.isArray(body) && body.length > 0;
}

async function sendWhatsApp(job) {
  const text = `New match: ${job.title} — ${job.company} (${job.location})\n${job.url}`;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&apikey=${CALLMEBOT_APIKEY}&text=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) console.error(`CallMeBot send failed for ${job.job_id}: ${res.status}`);
}

async function main() {
  for (const location of LOCATIONS) {
    const jobs = await fetchJobs(location);
    for (const job of jobs) {
      const isNew = await upsertNew(job);
      if (isNew) {
        console.log(`New: ${job.title} @ ${job.company} (${job.location})`);
        await sendWhatsApp(job);
      }
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
