# Deploy VRO SEO Analyzer to Railway

Railway runs your Node.js server as-is — no code changes needed. You get a custom URL like `vro-seo-analyzer.up.railway.app`, or you can connect your own domain.

## Quick Deploy (5 minutes)

### Step 1: Push to GitHub

If you don't already have a repo for this, create one:

```bash
cd vro-seo-analyzer
git init
git add .
git commit -m "Initial commit"
```

Then create a repo on GitHub (private recommended since it has API config) and push:

```bash
git remote add origin https://github.com/YOUR-USERNAME/vro-seo-analyzer.git
git push -u origin main
```

### Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"** > **"Deploy from GitHub Repo"**
3. Select your `vro-seo-analyzer` repository
4. Railway auto-detects Node.js and starts building

### Step 3: Add Environment Variables

In the Railway dashboard, click on your service, then go to **Variables** tab. Add these:

| Variable | Value |
|----------|-------|
| `PAYLOAD_BASE_URL` | `https://www.vitalrecordsonline.com` |
| `PAYLOAD_API_PATH` | `/api-cms` |
| `PAYLOAD_EMAIL` | *(your Payload CMS email)* |
| `PAYLOAD_PASSWORD` | *(your Payload CMS password)* |
| `AHREFS_API_TOKEN` | *(your token, optional)* |
| `SEMRUSH_API_KEY` | *(your key, optional)* |
| `DEEPSEEK_API_KEY` | *(your key, optional — AI recommendations)* |

Railway automatically provides `PORT` — you don't need to set it.

### Step 4: Generate a Domain

In the Railway dashboard, go to **Settings** > **Networking** > click **"Generate Domain"**.

You'll get a URL like: `https://vro-seo-analyzer-production.up.railway.app`

That's it — your dashboard is live.

## Custom Domain (Optional)

To use your own domain like `seo.vrollc.com`:

1. In Railway: **Settings** > **Networking** > **Custom Domain** > enter `seo.vrollc.com`
2. Railway gives you a CNAME target (something like `your-service.up.railway.app`)
3. In your DNS provider, add a CNAME record:
   - **Name**: `seo` (or whatever subdomain)
   - **Type**: CNAME
   - **Value**: the target Railway gave you
4. Wait for DNS propagation (usually 5-15 minutes)
5. Railway auto-provisions an SSL certificate

## How It Works

Railway:
- Detects `package.json` and runs `npm install` automatically
- Runs `node server.js` (configured in `railway.json`)
- Assigns a random port via `PORT` env var (your app already reads this)
- Provides persistent storage for the `data/` folder between deploys
- Auto-deploys when you push to GitHub

## Costs

Railway's free tier gives you $5/month of usage, which is more than enough for this app since it only runs when you access it. After that, it's pay-as-you-go (typically $1-3/month for a light Node.js app).

## Updating

Just push to GitHub — Railway auto-deploys:

```bash
git add .
git commit -m "Update scoring engine"
git push
```

Railway rebuilds and redeploys in about 30 seconds.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Application failed to respond" | Check that env variables are set (especially PAYLOAD_EMAIL and PAYLOAD_PASSWORD) |
| Build fails | Make sure `package.json` and `server.js` are in the root of the repo (not in a subfolder) |
| Payload API returns 401 | Verify the credentials work by testing at `https://www.vitalrecordsonline.com/admin` |
| Data not persisting | Railway ephemeral storage resets on redeploy. For persistent data, add a Railway Volume in Settings > Volumes, mount it at `/app/data` |
