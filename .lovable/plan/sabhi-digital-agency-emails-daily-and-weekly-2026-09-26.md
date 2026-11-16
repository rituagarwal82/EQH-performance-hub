# Sabhi Digital agency emails — daily and weekly

Two automated reports to aditya@sabhidigital.com, with the owner copied on every send. They go from the same sender as now (EQH Engine), with replies to connect@energyqueenshub.com. **Both schedules stay switched off until you have checked the two test emails.**

## What gets built

1. **Only Sabhi's women.** A woman counts only if her first registration came through a Sabhi advertisement. Sabhi means exactly three sources, each reported on its own line: Meta accounts 1249430309131428 and 1109475161619539, plus Google Ads.
   - **1488704194840585 ("Ritu Ad manager")** shows as "no spend this month" when it has none, never as an account with zero results.
   - **587640350334915 ("Ritu-Sabhi Digital-3")** is left out entirely, by its account number. It sells a different product (the Daily Energizer), so it can never appear, even if it restarts.
   - **699110549552181 ("EQH_SD")** is left out of all registration figures. At most it appears as one line: "Page Likes campaign only — no form, so it cannot produce registrations."
   - **Google Ads** reads as paused, last spent 26 August 2026. Any Google sales in a later period are labelled "women who registered before the pause and bought later", never as this month's advertising working. The missing-click-identifier item is worded as "to fix before Google restarts".
   - **No other agency's figures** appear anywhere: no comparisons and no combined totals. No screen carries a buyer comparison for each account while the dispute with the other agency is open.
2. **Account taken from the advertisement.** For every date, the account comes from the advertisement she registered through, never from the account saved on her record. One review item will name the date the saved account stopped being written (21 September).
3. **Money.** Return is cash actually collected, with the 18% GST taken out, divided by spend. The GST-free figure uses the price already stored on each product. The advertising platform's own purchase counts are never read. The target (₹75,000 of spend a day, return 0.60–0.70x) is printed beside every actual figure.
4. **Daily email, 6:30 p.m. India time, every day.** Sections come in the order you set, with the chain table showing whether each row is final. A money figure that is not yet final reads "₹X or better" or "₹X or more". The email refuses to send if it runs over 300 words.
5. **Weekly email, Wednesday 10:00 a.m. India time.** It covers Monday to Sunday just closed, in the sections you listed:
   - return by advertisement over the last 30 days
   - registrations per 100 page visits for each advertisement
   - a direct Ads Manager link for each advertisement
   - "What we are still missing from you": a numbered list, oldest first, starting with your seven items, each with the date it was first raised and never silently dropped
6. **Correction request.** It sits at the bottom of both emails: large and bold in the email itself, and in capitals with blank lines around it in the plain-text copy.
7. **Refusals built into the generator.** A figure with no source label, or a comparison of two periods where one is final and one is not, stops the send or prints "not comparable yet".
   - No percentages on fewer than 20 women.
   - An advertisement with fewer than 8 sales shows its return tagged "too thin to judge".
   - No per-advertisement figures for periods that touch dates before 1 July.
   - No other agency is ever named or counted.
   - If the accounts sheet has gone more than 48 hours without an update, the money rows are replaced by one sentence.
   - None of our own internal figures appear.
8. **Acceptance.** I will build the daily for 20 September and the weekly for 14–20 September, paste both here in full and send nothing. Where my figures differ from yours, I will explain where the difference comes from rather than adjust them. Then I will add both jobs to the job list with plain labels and consequences, switched off.

## Two things that differ from the spec — please confirm

- **Replies raising a review item.** The app can only send email. It cannot read the connect@energyqueenshub.com inbox, so it cannot turn Sabhi's replies into review items by itself. What I propose instead: a small form on the "Can I trust the numbers?" screen where whoever reads that inbox logs a Sabhi reply in one step, and it becomes a review item. Automatic capture would need that inbox connected (Gmail); I can add that later if you want it.
- **"Clicked" and "reached the page"** use the advertising platform's own click and page-visit counts, labelled as such. These are the only visit figures we hold for every Sabhi advertisement. I believe your 13-per-100 figure comes from the same counts.

## Technical details

- New server-side modules: an agency data reader, a daily email builder and a weekly email builder. Each builder runs its refusals before sending and returns the reasons if it refuses.
- New database functions:
  - Sabhi registrations: first-touch registrations, with the account resolved by matching the registration's advertisement to the advertisement in the spend table.
  - A chain of figures for each account and each date range: spend, clicks, page visits, registrations, attended, still there at the price, buyers, cash with and without GST, and whether the money is final (payments posted up to the covered date).
  - Return by advertisement over 30 days.
  - Registrations per 100 page visits for each advertisement.
- New table for the "still missing" list, seeded with your seven items and each item's first-raised date. The migration grants access and enables row-level security.
- Two new job routes, each checked by the existing job sign-in check. Each has a dry-run option for a given date that returns the full email without sending. Both are declared in the job list and in the job manifest, inactive until you approve the tests.
- Sending uses the existing email path, extended so the reply-to address can be set per send. A log table keeps it to one send per day for the daily and one per week for the weekly.
